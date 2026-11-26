import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { PluginCliError, cliCommand, defineCli } from '@get-bb/plugin-sdk';
import { rpcContract, type DescriptionView } from './contract';
import {
  applyReply, bounded, buildPrompt, decide, emptyEntry, extractMessages, lowestEffort, parseReply, pickModel, readEntry,
  type Entry, type Message, type Mode,
} from './logic';

const WORKER_TIMEOUT_MS = 3 * 60_000;
const MAX_QUEUE = 50;
const WORKER_TITLE = 'Thread description worker';
const key = (threadId: string) => `d:${threadId}`;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

type Execution = { hostId: string; providerId: string; model: string; reasoningLevel: string | null };
type WorkerResult = { ok: true; text: string } | { ok: false; error: string };

export default async function threadDescription(bb: BbPluginApi) {
  const settings = bb.settings.define({
    enabled: { type: 'boolean', label: 'Обновлять описания автоматически', default: true },
    subthreads: { type: 'boolean', label: 'Описывать и подтреды', default: true },
    providerId: { type: 'string', label: 'Провайдер (например claude-code); недоступен — берётся любой доступный', default: 'claude-code' },
    model: { type: 'string', label: 'Модель; нет на машине — берётся небольшая модель провайдера', default: 'claude-haiku-5-5' },
    fallbackHostId: { type: 'string', label: 'ID запасной машины, если на машине треда нет провайдеров (необязательно)', default: '' },
    refreshMinutes: { type: 'number', label: 'Обновлять не чаще, минут', default: 60 },
    shortWords: { type: 'number', label: 'Первая задача короче стольких слов дописывается после ответа агента', default: 15 },
    concurrency: { type: 'number', label: 'Одновременных генераций', default: 2 },
    language: { type: 'string', label: 'Язык описаний; пусто — язык треда', default: '' },
  });

  // --- storage -------------------------------------------------------------
  const load = async (threadId: string): Promise<Entry | null> => {
    const raw = await bb.storage.kv.get<unknown>(key(threadId));
    return raw === undefined ? null : readEntry(raw);
  };
  const running = new Map<string, Promise<void>>();
  const changed = (threadId: string) => bb.realtime.publish('changed', { threadId });
  // Read-modify-write is serialized per thread: an edit made while a worker runs must survive.
  const locks = new Map<string, Promise<unknown>>();
  function update(threadId: string, change: (entry: Entry) => Entry): Promise<Entry> {
    const next = (locks.get(threadId) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      const entry = change((await load(threadId)) ?? emptyEntry());
      await bb.storage.kv.set(key(threadId), entry);
      changed(threadId);
      return entry;
    });
    locks.set(threadId, next);
    void next.catch(() => undefined).finally(() => { if (locks.get(threadId) === next) locks.delete(threadId); });
    return next;
  }
  async function view(threadId: string): Promise<DescriptionView> {
    const entry = (await load(threadId)) ?? emptyEntry();
    return {
      description: entry.description, manual: entry.manual, recap: entry.recap,
      recapUnseen: entry.recapAt !== null && entry.recapAt > (entry.recapSeenAt ?? 0),
      generatedAt: entry.generatedAt, model: entry.model, tokens: entry.lastTokens, busy: running.has(threadId), error: entry.error,
    };
  }

  // --- hidden worker thread -------------------------------------------------
  const waiting = new Map<string, (result: WorkerResult) => void>();
  // A worker can finish before spawn() returns its id to us.
  const early = new Map<string, WorkerResult>();
  /** Workers spawned by this load of the plugin. */
  const mine = new Set<string>();
  const isOwn = (thread: { originPluginId: string | null }) => thread.originPluginId === bb.pluginId;
  function settle(threadId: string, result: WorkerResult) {
    const resolve = waiting.get(threadId);
    if (resolve) { waiting.delete(threadId); resolve(result); return; }
    if (early.size < 100) early.set(threadId, result);
  }

  let personalProject: string | null = null;
  async function personalProjectId(): Promise<string> {
    if (personalProject) return personalProject;
    const projects = await bb.sdk.projects.list({ includePersonal: true });
    const found = projects.find((project) => (project as { kind?: string }).kind === 'personal');
    if (!found) throw new Error('Нет личного проекта BB для служебного треда.');
    return (personalProject = found.id);
  }

  /** What can run on this machine: the wanted provider first, then any other available one. */
  async function executionsOn(hostId: string, wantedProvider: string, wantedModel: string): Promise<Execution[]> {
    const base = await bb.sdk.providers.models({ hostId, preferCached: true });
    const ids = base.providers.filter((provider) => provider.available).map((provider) => provider.id);
    ids.sort((left, right) => Number(right === wantedProvider) - Number(left === wantedProvider));
    const result: Execution[] = [];
    for (const providerId of ids.slice(0, 4)) {
      try {
        const catalog = await bb.sdk.providers.models({ hostId, providerId, preferCached: true });
        const model = pickModel(catalog.models, providerId === wantedProvider ? wantedModel : '');
        if (model) result.push({ hostId, providerId, model: model.model, reasoningLevel: lowestEffort(model) });
      } catch (error) { bb.log.warn(`Thread Description: models of ${providerId}: ${message(error)}`); }
      if (result.length === 2) break;
    }
    return result;
  }

  async function candidates(environmentId: string | null): Promise<Execution[]> {
    const values = await settings.get();
    const hosts: string[] = [];
    if (environmentId) {
      const environment = await bb.sdk.environments.get({ environmentId });
      if (environment.hostId) hosts.push(environment.hostId);
    }
    const spare = values.fallbackHostId.trim();
    if (spare && !hosts.includes(spare)) hosts.push(spare);
    for (const hostId of hosts) {
      try {
        const found = await executionsOn(hostId, values.providerId.trim(), values.model.trim());
        if (found.length) return found;
      } catch (error) { bb.log.warn(`Thread Description: machine ${hostId}: ${message(error)}`); }
    }
    return [];
  }

  async function runWorker(execution: Execution, prompt: string): Promise<{ text: string; tokens: number | null }> {
    // The personal workspace has no project instructions and none of the user's files.
    const worker = await bb.sdk.threads.spawn({
      projectId: await personalProjectId(),
      environment: { type: 'host', hostId: execution.hostId, workspace: { type: 'personal' } },
      providerId: execution.providerId,
      model: execution.model,
      ...(execution.reasoningLevel ? { reasoningLevel: execution.reasoningLevel as never } : {}),
      permissionMode: 'accept-edits',
      title: WORKER_TITLE,
      visibility: 'hidden',
      prompt,
    });
    mine.add(worker.id);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const ready = early.get(worker.id);
      early.delete(worker.id);
      const result = ready ?? await new Promise<WorkerResult>((resolve) => {
        waiting.set(worker.id, resolve);
        timer = setTimeout(() => settle(worker.id, { ok: false, error: 'модель не ответила за 3 минуты' }), WORKER_TIMEOUT_MS);
      });
      if (!result.ok) throw new Error(result.error);
      let tokens: number | null = null;
      try { tokens = (await bb.sdk.threads.context({ threadId: worker.id })).usage?.usedTokens ?? null; } catch { /* usage is optional */ }
      await countRun(tokens);
      return { text: result.text, tokens };
    } finally {
      clearTimeout(timer);
      waiting.delete(worker.id);
      mine.delete(worker.id);
      try { await bb.sdk.threads.stop({ threadId: worker.id }); } catch { /* already stopped */ }
      try { await bb.sdk.threads.delete({ threadId: worker.id, childThreadsConfirmed: false }); } catch (error) { bb.log.warn(`Thread Description: cleanup ${worker.id}: ${message(error)}`); }
    }
  }

  // Daily totals for `bb thread-description stats`: what the plugin costs.
  const day = (at = Date.now()) => new Date(at).toISOString().slice(0, 10);
  let statsLock: Promise<unknown> = Promise.resolve();
  function countRun(tokens: number | null) {
    statsLock = statsLock.catch(() => undefined).then(async () => {
      const stored = await bb.storage.kv.get<{ runs?: number; tokens?: number; measured?: number }>(`stats:${day()}`);
      await bb.storage.kv.set(`stats:${day()}`, {
        runs: (stored?.runs ?? 0) + 1,
        tokens: (stored?.tokens ?? 0) + (tokens ?? 0),
        measured: (stored?.measured ?? 0) + (tokens === null ? 0 : 1),
      });
    });
    return statsLock.catch((error) => bb.log.warn(`Thread Description: stats: ${message(error)}`));
  }

  // --- generation ------------------------------------------------------------
  async function readMessages(threadId: string): Promise<Message[]> {
    const page = await bb.sdk.threads.timeline({ threadId });
    return extractMessages(page.rows);
  }

  async function firstTask(threadId: string, entry: Entry, messages: readonly Message[]): Promise<string> {
    if (entry.firstTask) return entry.firstTask;
    try {
      const outline = await bb.sdk.threads.conversationOutline({ threadId });
      const preview = outline.items.find((item) => item.role === 'user')?.preview.trim() ?? '';
      // The page holds the full text when it reaches back to the first message.
      const full = messages.find((item) => item.role === 'user' && preview && item.text.startsWith(preview.replace(/(…|\.\.\.)$/u, '').slice(0, 40)));
      if (full) return full.text;
      if (preview) return preview;
    } catch { /* fall through to the loaded page */ }
    return messages.find((item) => item.role === 'user')?.text ?? '';
  }

  async function generate(threadId: string): Promise<void> {
    const [values, thread, messages, stored] = await Promise.all([settings.get(), bb.sdk.threads.get({ threadId }), readMessages(threadId), load(threadId)]);
    const entry = stored ?? emptyEntry();
    const task = await firstTask(threadId, entry, messages);
    if (!task && !messages.length) throw new Error('В треде ещё нет сообщений.');
    const options = await candidates(thread.environmentId);
    if (!options.length) throw new Error('Нет доступной модели на машине треда.');
    const prompt = buildPrompt({ title: thread.title ?? '', firstTask: task, previous: entry.description, messages, language: values.language.trim() });
    let failure: unknown;
    for (const execution of options) {
      try {
        const run = await runWorker(execution, prompt);
        const reply = parseReply(run.text);
        if (!reply) throw new Error('модель вернула не JSON');
        await update(threadId, (current) => applyReply(current, reply, {
          now: Date.now(), firstTask: task, lastMessageId: messages[messages.length - 1]?.id ?? null,
          hasReply: messages.some((item) => item.role === 'assistant'),
          shortWords: bounded(values.shortWords, 15, 0, 200), model: `${execution.providerId}/${execution.model}`, tokens: run.tokens,
        }));
        return;
      } catch (error) {
        failure = error;
        bb.log.warn(`Thread Description: ${threadId} via ${execution.providerId}/${execution.model}: ${message(error)}`);
      }
    }
    throw failure;
  }

  const queue: Array<() => void> = [];
  let active = 0;
  async function slot<T>(work: () => Promise<T>): Promise<T> {
    const limit = bounded((await settings.get()).concurrency, 2, 1, 5);
    if (active >= limit) {
      if (queue.length >= MAX_QUEUE) throw new Error('Очередь генераций переполнена.');
      await new Promise<void>((resolve) => queue.push(resolve));
    } else active += 1;
    // A waiter inherits the finished job's slot, so `active` only drops when nobody waits.
    try { return await work(); } finally { const next = queue.shift(); if (next) next(); else active -= 1; }
  }

  function start(threadId: string): Promise<void> {
    const existing = running.get(threadId);
    if (existing) return existing;
    const job = slot(() => generate(threadId)).catch(async (error) => {
      const text = message(error).slice(0, 300);
      await update(threadId, (entry) => ({ ...entry, error: text, errorAt: Date.now() }));
    }).catch((error) => bb.log.warn(`Thread Description: ${threadId}: ${message(error)}`))
      .finally(() => { running.delete(threadId); changed(threadId); });
    running.set(threadId, job);
    changed(threadId);
    return job;
  }

  async function consider(event: 'active' | 'idle', thread: { id: string; visibility: string; originPluginId: string | null; parentThreadId: string | null; archivedAt: number | null }) {
    if (thread.visibility !== 'visible' || isOwn(thread) || thread.archivedAt !== null || running.has(thread.id)) return;
    const values = await settings.get();
    if (!values.enabled || (thread.parentThreadId && !values.subthreads)) return;
    const entry = await load(thread.id);
    const refreshMs = bounded(values.refreshMinutes, 60, 5, 24 * 60) * 60_000;
    // Cheap exit before reading the timeline: most events come well inside the interval.
    if (entry?.generatedAt && !entry.needsImprove && (event === 'active' || Date.now() - entry.generatedAt < refreshMs)) return;
    const mode: Mode | null = decide({ event, entry, messages: await readMessages(thread.id), now: Date.now(), refreshMs });
    if (mode) void start(thread.id);
  }
  const guarded = (event: 'active' | 'idle', thread: Parameters<typeof consider>[1]) =>
    void consider(event, thread).catch((error) => bb.log.warn(`Thread Description: ${event} ${thread.id}: ${message(error)}`));

  bb.events.on('thread.active', ({ thread }) => { if (!isOwn(thread)) guarded('active', thread); });
  bb.events.on('thread.idle', ({ thread, lastAssistantText }) => {
    // An idle without text can precede the worker's first turn; the timeout covers a truly empty reply.
    if (!isOwn(thread)) guarded('idle', thread);
    else if (lastAssistantText) settle(thread.id, { ok: true, text: lastAssistantText });
  });
  bb.events.on('thread.failed', ({ thread, error }) => { if (isOwn(thread)) settle(thread.id, { ok: false, error: error ?? 'ошибка модели' }); });
  bb.events.on('thread.deleted', ({ thread }) => { early.delete(thread.id); if (!isOwn(thread)) void bb.storage.kv.delete(key(thread.id)); });

  // Workers left by a restart mid-generation: nothing waits for them any more.
  bb.background.service('cleanup', {
    async start(signal) {
      const left = await bb.sdk.threads.list({ originPluginId: bb.pluginId, includeHidden: true, limit: 100 });
      for (const thread of left) {
        if (signal.aborted) return;
        if (thread.visibility !== 'hidden' || thread.title !== WORKER_TITLE || mine.has(thread.id)) continue;
        try { await bb.sdk.threads.stop({ threadId: thread.id }); } catch { /* already stopped */ }
        await bb.sdk.threads.delete({ threadId: thread.id, childThreadsConfirmed: false }).catch((error: unknown) => bb.log.warn(`Thread Description: cleanup ${thread.id}: ${message(error)}`));
      }
    },
  });

  // --- surfaces ----------------------------------------------------------------
  const setDescription = (threadId: string, text: string) => update(threadId, (entry) => {
    const value = text.trim();
    return value ? { ...entry, description: value, manual: true } : { ...entry, manual: false };
  });

  bb.rpc.register(rpcContract, {
    get: ({ threadId }) => view(threadId),
    // Returns at once: progress and the result arrive through the realtime signal.
    refresh: async ({ threadId }) => { await bb.sdk.threads.get({ threadId }); void start(threadId); return view(threadId); },
    setDescription: async ({ threadId, text }) => { await setDescription(threadId, text); return view(threadId); },
    markSeen: async ({ threadId }) => {
      await update(threadId, (entry) => ({ ...entry, recapSeenAt: Date.now() }));
      return view(threadId);
    },
  });

  const threadArg = { type: 'string', description: 'ID треда', required: true } as const;
  const print = async (threadId: string) => {
    const value = await view(threadId);
    return [
      `Описание${value.manual ? ' (ручное)' : ''}: ${value.description || '—'}`,
      `Сводка: ${value.recap || '—'}`,
      `Обновлено: ${value.generatedAt ? new Date(value.generatedAt).toISOString() : 'ещё нет'}${value.model ? `, ${value.model}` : ''}${value.tokens ? `, ${value.tokens} токенов` : ''}${value.busy ? ', идёт обновление' : ''}`,
      ...(value.error ? [`Ошибка: ${value.error}`] : []),
    ].join('\n');
  };
  bb.cli.register(defineCli({
    name: 'thread-description',
    summary: 'Описания и краткие сводки тредов',
    commands: {
      show: cliCommand({ summary: 'Описание и сводка треда', options: { thread: threadArg }, async run({ options }) { return { exitCode: 0, stdout: await print(options.thread) }; } }),
      refresh: cliCommand({
        summary: 'Обновить сейчас и дождаться результата', options: { thread: threadArg },
        async run({ options }) {
          await bb.sdk.threads.get({ threadId: options.thread });
          await start(options.thread);
          const { error } = await view(options.thread);
          if (error) throw new PluginCliError(error, { code: 'generation_failed' });
          return { exitCode: 0, stdout: await print(options.thread) };
        },
      }),
      set: cliCommand({
        summary: 'Задать описание вручную; пустой текст возвращает автообновление',
        options: { thread: threadArg, text: { type: 'string', description: 'Текст описания', required: true } },
        async run({ options }) { await setDescription(options.thread, options.text.slice(0, 2000)); return { exitCode: 0, stdout: await print(options.thread) }; },
      }),
      stats: cliCommand({
        summary: 'Сколько генераций и токенов ушло по дням',
        options: { days: { type: 'integer', min: 1, max: 90, description: 'За сколько дней (по умолчанию 7)' } },
        async run({ options }) {
          const days = bounded(options.days, 7, 1, 90);
          const lines: string[] = [];
          let runs = 0; let tokens = 0;
          for (let index = days - 1; index >= 0; index -= 1) {
            const date = day(Date.now() - index * 86_400_000);
            const item = await bb.storage.kv.get<{ runs?: number; tokens?: number; measured?: number }>(`stats:${date}`);
            if (!item?.runs) continue;
            runs += item.runs; tokens += item.tokens ?? 0;
            const average = item.measured ? Math.round((item.tokens ?? 0) / item.measured) : null;
            lines.push(`${date}  генераций ${item.runs}, токенов ${item.tokens ?? 0}${average ? ` (в среднем ${average})` : ''}`);
          }
          lines.push(`Итого за ${days} дн.: генераций ${runs}, токенов ${tokens}.`);
          return { exitCode: 0, stdout: lines.join('\n') };
        },
      }),
      models: cliCommand({
        summary: 'Какой моделью и на какой машине будет создано описание треда', options: { thread: threadArg },
        async run({ options }) {
          const thread = await bb.sdk.threads.get({ threadId: options.thread });
          const found = await candidates(thread.environmentId);
          return { exitCode: 0, stdout: found.map((item, index) => `${index + 1}. ${item.hostId}  ${item.providerId}/${item.model}${item.reasoningLevel ? ` (${item.reasoningLevel})` : ''}`).join('\n') || 'Нет доступной модели.' };
        },
      }),
    },
  }));
}
