import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { PluginCliError, cliCommand, defineCli } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import {
  agentRules, assess, blockingReset, classifyWindow, normalizeThresholds, notification, render, setTimeZone, shouldNotify, stuckText,
  type Assessment, type QuotaWindow, type StuckThread, type Thresholds,
} from './logic.ts';

const SUPPORTED = new Set(['claude-code', 'codex']);
const CACHE_MS = 60_000;

const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const text = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

interface HostUsage { at: number; fetchedAt: string | null; raw: Record<string, unknown> }

export interface Status {
  threadId: string;
  providerId: string;
  model: string | null;
  hostId: string | null;
  hostName: string | null;
  fetchedAt: string | null;
  thresholds: Thresholds;
  assessment: Assessment;
}

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    economyPercent: {
      type: 'number', label: 'Экономный режим с, %', default: 70,
      description: 'С этого процента любого окна лимита агент работает маленькими шагами и сохраняет каждый.',
    },
    finishPercent: {
      type: 'number', label: 'Режим финиша с, %', default: 90,
      description: 'С этого процента агент не начинает новое, сохраняет работу и пишет, что дальше.',
    },
    onLimit: {
      type: 'select', label: 'Когда тред упёрся в лимит', options: ['suggest', 'off'], default: 'suggest',
      experimental_optionLabels: { suggest: 'Уведомить и предложить передачу другому сервису', off: 'Ничего не делать' },
      description: 'Передачу плагин только предлагает; сам тред не переносит.',
    },
    notifyAfterMinutes: {
      type: 'number', label: 'Уведомлять, если ждать дольше, мин', default: 60,
      description: 'Короткую паузу BB переждёт сам (provider-retry); уведомление приходит, только если ждать дольше или автоповтора нет.',
    },
    timeZone: {
      type: 'string', label: 'Часовой пояс для времени в уведомлениях', default: '',
      description: 'Например Europe/Moscow. Пусто — пояс сервера BB.',
    },
  });
  let thresholds: Thresholds = { economy: 70, finish: 90 };
  let onLimit = 'suggest';
  let notifyAfterMinutes = 60;
  const loadThresholds = (v: { economyPercent: number; finishPercent: number; onLimit: string; notifyAfterMinutes: number; timeZone: string }) => {
    thresholds = normalizeThresholds({ economy: v.economyPercent, finish: v.finishPercent });
    onLimit = v.onLimit;
    notifyAfterMinutes = Number.isFinite(v.notifyAfterMinutes) ? Math.max(0, v.notifyAfterMinutes) : 60;
    setTimeZone(v.timeZone);
  };
  void settings.get().then(loadThresholds).catch(() => undefined);
  settings.onChange(next => loadThresholds(next));

  // Usage per host, in memory only: no account identities are persisted.
  const cache = new Map<string, HostUsage>();
  const pending = new Map<string, Promise<HostUsage>>();

  async function hostUsage(hostId: string, refresh: boolean): Promise<HostUsage> {
    const saved = cache.get(hostId);
    if (!refresh && saved && Date.now() - saved.at < CACHE_MS) return saved;
    const running = pending.get(hostId);
    if (running) return running;
    const job = (async () => {
      try {
        const raw = record(await bb.sdk.system.usageLimits({ hostId, refresh: true, signal: AbortSignal.timeout(20_000) }));
        const value = { at: Date.now(), fetchedAt: new Date().toISOString(), raw };
        cache.set(hostId, value);
        return value;
      } catch (error) {
        if (saved) return saved;
        throw error;
      }
    })();
    pending.set(hostId, job);
    try { return await job; } finally { pending.delete(hostId); }
  }

  async function threadModel(threadId: string): Promise<string | null> {
    try {
      const events = await bb.sdk.threads.events.list({ threadId, types: ['client/turn/requested'], order: 'desc', limit: '1' });
      return text(record(record(events[0]?.data).execution).model);
    } catch { return null; }
  }

  async function status(threadId: string, refresh: boolean): Promise<Status> {
    const thread = await bb.sdk.threads.get({ threadId });
    const base = { threadId, providerId: thread.providerId, model: null as string | null, hostId: null as string | null,
      hostName: null as string | null, fetchedAt: null as string | null, thresholds };
    const unknown = (reason: string): Status => ({ ...base, assessment: assess([], null, thresholds, reason) });
    if (!SUPPORTED.has(thread.providerId)) return unknown('этот провайдер не сообщает лимиты подписки');
    if (!thread.environmentId) return unknown('у треда ещё нет рабочей машины');
    const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
    base.hostId = environment.hostId;
    try { base.hostName = (await bb.sdk.hosts.get({ hostId: environment.hostId })).name; } catch { /* name is cosmetic */ }
    base.model = await threadModel(threadId);
    let usage: HostUsage;
    try { usage = await hostUsage(environment.hostId, refresh); }
    catch (error) { return unknown(`машина не ответила: ${error instanceof Error ? error.message : String(error)}`); }
    base.fetchedAt = usage.fetchedAt;
    const entry = record(usage.raw[thread.providerId]);
    if (entry.status !== 'ok') return unknown(text(entry.message) ?? `лимиты недоступны (${String(entry.status ?? 'нет данных')})`);
    const windows: QuotaWindow[] = (Array.isArray(entry.windows) ? entry.windows : []).flatMap(item => {
      const w = record(item);
      if (typeof w.label !== 'string' || typeof w.usedPercent !== 'number' || !Number.isFinite(w.usedPercent)) return [];
      return [{ label: w.label, kind: classifyWindow(w.label, w.kind, w.model), model: text(w.model),
        usedPercent: w.usedPercent, resetsAt: text(w.resetsAt) }];
    });
    let reason: string | null = null;
    try {
      const plugins = await bb.sdk.plugins.list();
      if (plugins.plugins.some(p => (p.id === 'account-pool' || p.id === 'account-pool-balanced') && p.enabled)) {
        reason = 'включён пул аккаунтов: цифры относятся к аккаунту машины, не обязательно к этому треду';
      }
    } catch { /* optional hint */ }
    return { ...base, assessment: assess(windows, base.model, thresholds, reason) };
  }

  // ---------- A turn already hit the limit ----------
  // Stuck threads live in plugin storage so a restart does not repeat notifications.
  const stuck = new Map<string, StuckThread>();
  const stuckReady = (async () => {
    for (const key of await bb.storage.kv.list('stuck:')) {
      const value = await bb.storage.kv.get<StuckThread>(key);
      if (value) stuck.set(value.threadId, value);
    }
  })().catch(error => bb.log.warn(`Limit Guard: could not load stuck threads: ${String(error)}`));
  async function forget(threadId: string) {
    await stuckReady;
    if (stuck.delete(threadId)) await bb.storage.kv.delete(`stuck:${threadId}`);
  }
  const loose = z.any();
  async function retryDecision(threadId: string, requestId: string): Promise<number | null> {
    // provider-retry records its decision after queueing; give it up to a minute.
    for (let attempt = 0; attempt < 6; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10_000));
      try {
        const raw = record(await bb.sdk.plugins.callRpc({ pluginId: 'provider-retry', method: 'decision.get', input: { threadId }, outputSchema: loose }));
        if (text(raw.requestId) !== requestId) continue;
        const decision = record(raw.decision);
        if (decision.kind !== 'retry') return null;
        const at = Number(decision.sendAt ?? decision.retryAt);
        return Number.isFinite(at) ? at : null;
      } catch { return null; }
    }
    return null;
  }
  async function alternativeFor(providerId: string, hostId: string): Promise<StuckThread['alternative']> {
    const other = [...SUPPORTED].find(id => id !== providerId);
    if (!other) return null;
    try {
      const usage = await hostUsage(hostId, false);
      const entry = record(usage.raw[other]);
      if (entry.status !== 'ok') return { providerId: other, mode: 'unknown', percent: null };
      const windows: QuotaWindow[] = (Array.isArray(entry.windows) ? entry.windows : []).flatMap(item => {
        const w = record(item);
        if (typeof w.label !== 'string' || typeof w.usedPercent !== 'number') return [];
        return [{ label: w.label, kind: classifyWindow(w.label, w.kind, w.model), model: text(w.model), usedPercent: w.usedPercent, resetsAt: text(w.resetsAt) }];
      });
      const a = assess(windows.filter(w => w.kind !== 'model'), null, thresholds);
      return { providerId: other, mode: a.mode, percent: a.driver?.usedPercent ?? null };
    } catch { return { providerId: other, mode: 'unknown', percent: null }; }
  }
  async function onTurnFailed(event: { threadId: string; requestId: string; errorInfo: { category?: string } | null; rateLimits: unknown }) {
    if (onLimit === 'off' || event.errorInfo?.category !== 'rate-limit') return;
    const thread = await bb.sdk.threads.get({ threadId: event.threadId });
    if (!SUPPORTED.has(thread.providerId) || !thread.environmentId) return;
    await stuckReady;
    const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
    const windows = Array.isArray(record(event.rateLimits).windows) ? record(event.rateLimits).windows as { usedPercent?: number | null; resetsAtMs?: number | null }[] : [];
    const previous = stuck.get(event.threadId);
    const entry: StuckThread = {
      threadId: event.threadId, title: thread.title || (thread as { titleFallback?: string | null }).titleFallback || 'Тред без названия',
      providerId: thread.providerId, failedAt: Date.now(), resetAt: blockingReset(windows),
      retryAt: await retryDecision(event.threadId, event.requestId),
      alternative: await alternativeFor(thread.providerId, environment.hostId),
      notified: previous?.notified ?? false,
    };
    if (shouldNotify(entry, Date.now(), notifyAfterMinutes)) {
      const message = notification(entry, Date.now());
      try {
        await bb.sdk.plugins.callRpc({ pluginId: 'push-notifications', method: 'notifications.send', input: { ...message, threadId: event.threadId }, outputSchema: loose });
        entry.notified = true;
      } catch (error) { bb.log.warn(`Limit Guard: notification failed: ${String(error)}`); }
    }
    stuck.set(entry.threadId, entry);
    await bb.storage.kv.set(`stuck:${entry.threadId}`, entry);
  }
  bb.events.on('turn.failed', event => { void onTurnFailed(event as never).catch(error => bb.log.warn(`Limit Guard: turn.failed handler: ${String(error)}`)); });
  // A thread that runs again, or is archived, is no longer waiting on a limit.
  bb.events.on('thread.active', ({ thread }) => { void forget(thread.id); });
  bb.events.on('thread.archived', ({ thread }) => { void forget(thread.id); });
  bb.events.on('thread.deleted', ({ thread }) => { void forget(thread.id); });

  const describe = (s: Status) => render(s.assessment, Date.now(), {
    provider: s.providerId, model: s.model, host: s.hostName, fetchedAt: s.fetchedAt,
  });

  bb.agents.registerTool({
    name: 'limit_status',
    description: 'Остаток лимита подписки для этого треда и режим работы: обычный, экономный или финиш. Вызывай перед большой задачей и после каждого законченного шага.',
    presentation: { label: { pending: 'Проверяю лимит', completed: 'Проверил лимит' }, suppress: true },
    parameters: z.object({ refresh: z.boolean().optional().describe('Запросить свежие данные, а не кэш за минуту') }),
    async execute({ refresh }, ctx) {
      try { return describe(await status(ctx.threadId, refresh ?? false)); }
      catch (error) { return { content: [{ type: 'text', text: `Лимит не удалось узнать: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    },
  });

  bb.agents.configure(context => SUPPORTED.has(context.provider.id)
    ? { tools: ['limit_status'], skills: [], instructions: agentRules(thresholds) }
    : { tools: [], skills: [] });

  bb.cli.register(defineCli({
    name: 'limit',
    summary: 'Остаток лимита подписки треда и режим работы (limit-guard)',
    commands: {
      stuck: cliCommand({
        summary: 'Треды, которые упёрлись в лимит: до когда ждать и кому можно передать',
        options: { json: { type: 'boolean', description: 'Вывод в JSON' } },
        async run(input) {
          await stuckReady;
          const list = [...stuck.values()].sort((a, b) => b.failedAt - a.failedAt);
          if (input.options.json) return { exitCode: 0, stdout: JSON.stringify(list, null, 2) };
          const now = Date.now();
          return { exitCode: 0, stdout: list.length ? list.map(item => stuckText(item, now)).join('\n') : 'Тредов, ждущих лимит, нет.' };
        },
      }),
      status: cliCommand({
        summary: 'Показать лимит и режим: обычный, экономный, финиш',
        options: {
          thread: { type: 'string', description: 'ID треда; внутри треда можно не указывать' },
          self: { type: 'boolean', description: 'Текущий тред (по умолчанию внутри треда)' },
          refresh: { type: 'boolean', description: 'Не брать кэш за последнюю минуту' },
          json: { type: 'boolean', description: 'Вывод в JSON' },
        },
        async run(input, ctx) {
          const threadId = input.options.thread ?? ctx.threadId;
          if (!threadId) throw new PluginCliError('не указан тред', { code: 'thread_required', hint: 'Добавьте --thread <id> или запустите команду внутри треда.' });
          const s = await status(threadId, input.options.refresh ?? false);
          return { exitCode: 0, stdout: input.options.json ? JSON.stringify(s, null, 2) : describe(s) };
        },
      }),
    },
  }));
}
