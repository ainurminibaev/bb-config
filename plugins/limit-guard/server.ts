import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { PluginCliError, cliCommand, defineCli } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { hostContract, type SnapshotResult } from './contract.ts';
import {
  agentRules, assess, blockingReset, classifyWindow, DEFAULT_THRESHOLDS, etaMinutes, normalizeThresholds, notification, render,
  setTimeZone, shouldNotify, stuckText, thresholdMessage,
  type Assessment, type Mode, type QuotaWindow, type RetryState, type StuckThread, type Thresholds,
} from './logic.ts';
import { snapshotMessage, snapshotRef } from './snapshot-logic.ts';

const SUPPORTED = new Set(['claude-code', 'codex']);
const CACHE_MS = 60_000;
const RANK: Record<Mode, number> = { unknown: -1, normal: 0, economy: 1, finish: 2 };

const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const text = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

interface HostUsage { at: number; fetchedAt: string | null; raw: Record<string, unknown> }
type ThreadRow = { id: string; status: string; providerId: string; projectId: string | null; title: string | null; titleFallback?: string | null;
  environmentId: string | null; environmentHostId: string | null; environmentPath: string | null; environmentIsWorktree?: boolean | null;
  environmentBranchName?: string | null; originPluginId?: string | null; archivedAt?: number | null };
interface SnapshotRecord {
  environmentId: string; hostId: string; path: string; ref: string; at: number; reason: string; threadIds: string[];
  result: SnapshotResult;
}

export interface Status {
  threadId: string; providerId: string; model: string | null; hostId: string | null; hostName: string | null;
  fetchedAt: string | null; thresholds: Thresholds; assessment: Assessment;
}

export default function plugin(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: hostContract });
  const settings = bb.settings.define({
    shortEconomy: { type: 'number', label: '5-часовое окно: экономный режим с, %', default: DEFAULT_THRESHOLDS.short.economy },
    shortFinish: { type: 'number', label: '5-часовое окно: финиш с, %', default: DEFAULT_THRESHOLDS.short.finish },
    longEconomy: { type: 'number', label: 'Недельное окно и окно модели: экономный с, %', default: DEFAULT_THRESHOLDS.long.economy },
    longFinish: { type: 'number', label: 'Недельное окно и окно модели: финиш с, %', default: DEFAULT_THRESHOLDS.long.finish },
    etaEconomy: { type: 'number', label: 'Экономный, если до упора меньше, мин', default: DEFAULT_THRESHOLDS.etaEconomyMinutes,
      description: 'По темпу расхода 5-часового окна за последние полчаса (соседние треды тоже его тратят).' },
    etaFinish: { type: 'number', label: 'Финиш, если до упора меньше, мин', default: DEFAULT_THRESHOLDS.etaFinishMinutes },
    steer: { type: 'boolean', label: 'Сообщать агенту в идущий ход, когда режим ухудшился', default: true },
    snapshots: {
      type: 'select', label: 'Снимки незаконченной работы', options: ['local', 'push-private', 'off'], default: 'local',
      experimental_optionLabels: {
        'push-private': 'Сохранять и отправлять в приватный репозиторий (если нет похожих на секреты файлов)',
        local: 'Только на машине треда', off: 'Выключено',
      },
      description: 'Снимок — коммит состояния папки под refs/wip/bb/<окружение>; файлы, ветка и индекс не меняются. Папка с файлом .bb/hands-off не трогается.',
    },
    onLimit: {
      type: 'select', label: 'Когда тред упёрся в лимит', options: ['suggest', 'off'], default: 'suggest',
      experimental_optionLabels: { suggest: 'Уведомить и предложить другой сервис или модель', off: 'Ничего не делать' },
      description: 'Передачу плагин только предлагает; сам тред не переносит.',
    },
    notifyAfterMinutes: {
      type: 'number', label: 'Уведомлять, если ждать дольше, мин', default: 60,
      description: 'Короткую паузу BB переждёт сам (provider-retry). Если автоповтора нет, уведомление приходит всегда.',
    },
    timeZone: { type: 'string', label: 'Часовой пояс для времени в уведомлениях', default: '', description: 'Например Europe/Moscow. Пусто — пояс сервера BB.' },
  });
  let thresholds: Thresholds = DEFAULT_THRESHOLDS;
  let cfg = { steer: true, snapshots: 'local', onLimit: 'suggest', notifyAfterMinutes: 60 };
  const load = (v: Awaited<ReturnType<typeof settings.get>>) => {
    thresholds = normalizeThresholds({ shortEconomy: v.shortEconomy, shortFinish: v.shortFinish, longEconomy: v.longEconomy, longFinish: v.longFinish, etaEconomy: v.etaEconomy, etaFinish: v.etaFinish });
    cfg = { steer: v.steer, snapshots: v.snapshots, onLimit: v.onLimit, notifyAfterMinutes: Number.isFinite(v.notifyAfterMinutes) ? Math.max(0, v.notifyAfterMinutes) : 60 };
    setTimeZone(v.timeZone);
  };
  void settings.get().then(load).catch(() => undefined);
  settings.onChange(next => load(next));

  // ---------- Usage, cached per machine in memory; recent samples give the pace ----------
  const cache = new Map<string, HostUsage>();
  const pending = new Map<string, Promise<HostUsage>>();
  const samples = new Map<string, { at: number; used: number }[]>();
  function remember(hostId: string, raw: Record<string, unknown>, at: number) {
    for (const [providerId, value] of Object.entries(raw)) {
      const entry = record(value);
      if (entry.status !== 'ok' || !Array.isArray(entry.windows)) continue;
      for (const item of entry.windows) {
        const w = record(item);
        if (typeof w.label !== 'string' || typeof w.usedPercent !== 'number') continue;
        const used = w.usedPercent;
        const key = `${hostId}|${providerId}|${w.label}`;
        // A drop means the window was reset: start the pace over.
        const list = (samples.get(key) ?? []).filter(s => at - s.at < 60 * 60_000 && s.used <= used);
        list.push({ at, used });
        samples.set(key, list.slice(-40));
      }
    }
  }
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
        remember(hostId, raw, value.at);
        return value;
      } catch (error) {
        if (saved) return saved;
        throw error;
      }
    })();
    pending.set(hostId, job);
    try { return await job; } finally { pending.delete(hostId); }
  }
  function windowsOf(usage: HostUsage, hostId: string, providerId: string): { windows: QuotaWindow[]; error: string | null } {
    const entry = record(usage.raw[providerId]);
    if (entry.status !== 'ok') return { windows: [], error: text(entry.message) ?? `лимиты недоступны (${String(entry.status ?? 'нет данных')})` };
    const windows = (Array.isArray(entry.windows) ? entry.windows : []).flatMap(item => {
      const w = record(item);
      if (typeof w.label !== 'string' || typeof w.usedPercent !== 'number' || !Number.isFinite(w.usedPercent)) return [];
      return [{ label: w.label, kind: classifyWindow(w.label, w.kind, w.model), model: text(w.model), usedPercent: w.usedPercent,
        resetsAt: text(w.resetsAt), etaMinutes: etaMinutes(samples.get(`${hostId}|${providerId}|${w.label}`) ?? []) } satisfies QuotaWindow];
    });
    return { windows, error: null };
  }
  async function threadModel(threadId: string): Promise<string | null> {
    try {
      const events = await bb.sdk.threads.events.list({ threadId, types: ['client/turn/requested'], order: 'desc', limit: '1' });
      return text(record(record(events[0]?.data).execution).model);
    } catch { return null; }
  }
  let poolNote: { at: number; text: string | null } = { at: 0, text: null };
  async function poolReason() {
    if (Date.now() - poolNote.at < 5 * 60_000) return poolNote.text;
    try {
      const plugins = await bb.sdk.plugins.list();
      poolNote = { at: Date.now(), text: plugins.plugins.some(p => (p.id === 'account-pool' || p.id === 'account-pool-balanced') && p.enabled)
        ? 'включён пул аккаунтов: цифры относятся к аккаунту машины, не обязательно к этому треду' : null };
    } catch { poolNote = { at: Date.now(), text: null }; }
    return poolNote.text;
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
    try { base.hostName = (await bb.sdk.hosts.get({ hostId: environment.hostId })).name; } catch { /* cosmetic */ }
    base.model = await threadModel(threadId);
    let usage: HostUsage;
    try { usage = await hostUsage(environment.hostId, refresh); }
    catch (error) { return unknown(`машина не ответила: ${message(error)}`); }
    base.fetchedAt = usage.fetchedAt;
    const { windows, error } = windowsOf(usage, environment.hostId, thread.providerId);
    if (error) return unknown(error);
    return { ...base, assessment: assess(windows, base.model, thresholds, await poolReason()) };
  }
  const describe = (s: Status) => render(s.assessment, Date.now(), { provider: s.providerId, model: s.model, host: s.hostName, fetchedAt: s.fetchedAt });

  // ---------- Snapshots of unfinished work ----------
  const lastSnapshotAt = new Map<string, number>();
  async function snapshot(row: { environmentId: string | null; environmentHostId: string | null; environmentPath: string | null; environmentBranchName?: string | null },
    reason: string, threadIds: string[], minIntervalMs = 0): Promise<SnapshotRecord | null> {
    if (cfg.snapshots === 'off' || !row.environmentId || !row.environmentHostId || !row.environmentPath) return null;
    const last = lastSnapshotAt.get(row.environmentId) ?? 0;
    if (minIntervalMs && Date.now() - last < minIntervalMs) return null;
    lastSnapshotAt.set(row.environmentId, Date.now());
    const ref = snapshotRef(row.environmentId);
    const result = await host.call('snapshot', {
      path: row.environmentPath, ref, push: cfg.snapshots === 'push-private',
      message: snapshotMessage({ reason, branch: row.environmentBranchName ?? null, at: Date.now() }),
    }, { hostId: row.environmentHostId, timeoutMs: 300_000 });
    const entry: SnapshotRecord = { environmentId: row.environmentId, hostId: row.environmentHostId, path: row.environmentPath, ref, at: Date.now(), reason, threadIds, result };
    if (result.changed || result.removed || result.error || result.nested.some(n => n.commit)) {
      if (result.removed) await bb.storage.kv.delete(`snap:${row.environmentId}`);
      else await bb.storage.kv.set(`snap:${row.environmentId}`, entry);
    }
    if (result.error) bb.log.warn(`Limit Guard: snapshot of ${row.environmentPath} failed: ${result.error}`);
    return entry;
  }
  /** Thread facts from the thread and its environment; works for archived threads too. */
  async function threadRow(threadId: string): Promise<ThreadRow | null> {
    const thread = await bb.sdk.threads.get({ threadId }) as unknown as Record<string, unknown>;
    if (!thread) return null;
    const environmentId = text(thread.environmentId);
    const env = environmentId ? record(await bb.sdk.environments.get({ environmentId }).catch(() => null)) : {};
    return {
      id: threadId, status: String(thread.status ?? ''), providerId: String(thread.providerId ?? ''), projectId: text(thread.projectId),
      title: text(thread.title), titleFallback: text(thread.titleFallback), environmentId,
      environmentHostId: text(env.hostId), environmentPath: text(env.path), environmentIsWorktree: env.isWorktree === true,
      environmentBranchName: text(env.branchName), originPluginId: text(thread.originPluginId),
    };
  }
  const snapshotLater = (threadId: string, reason: string, minIntervalMs = 0, onlyWorktree = false) => {
    void threadRow(threadId).then(row => row && (!onlyWorktree || row.environmentIsWorktree)
      ? snapshot(row, reason, [threadId], minIntervalMs) : null)
      .catch(error => bb.log.warn(`Limit Guard: snapshot (${reason}) failed: ${message(error)}`));
  };

  // ---------- Steer a short note into running turns when their mode gets worse ----------
  // One note per thread, window and reset: kept in storage so restarts and new turns do not repeat it.
  type Sent = { key: string; mode: Mode; at: number };
  async function sentFor(threadId: string) { return (await bb.storage.kv.get<Sent[]>(`sent:${threadId}`)) ?? []; }
  async function markSent(threadId: string, entry: Sent) {
    const list = (await sentFor(threadId)).filter(item => item.key !== entry.key && Date.now() - item.at < 8 * 24 * 60 * 60_000);
    await bb.storage.kv.set(`sent:${threadId}`, [...list, entry].slice(-20));
  }
  async function poll() {
    const all = await bb.sdk.threads.list({ archived: false, limit: 500, includeHidden: true }) as unknown;
    const rows = ((Array.isArray(all) ? all : record(all).threads ?? []) as ThreadRow[])
      .filter(row => row.status === 'active' && SUPPORTED.has(row.providerId) && row.environmentHostId);
    const hosts = [...new Set(rows.map(row => row.environmentHostId!))];
    const usage = new Map<string, HostUsage>();
    await Promise.all(hosts.map(async hostId => { try { usage.set(hostId, await hostUsage(hostId, true)); } catch { /* offline */ } }));
    for (const row of rows) {
      const u = usage.get(row.environmentHostId!);
      if (!u) continue;
      const { windows } = windowsOf(u, row.environmentHostId!, row.providerId);
      const a = assess(windows, await threadModel(row.id), thresholds);
      if (!a.driver || a.mode === 'unknown' || a.mode === 'normal') continue;
      // The reset time jitters by seconds between reads: round it so one window stays one key.
      const resetKey = a.driver.resetsAt ? Math.round(Date.parse(a.driver.resetsAt) / 600_000) : '';
      const key = `${a.driver.label}|${resetKey}`;
      const earlier = (await sentFor(row.id)).find(item => item.key === key);
      if (earlier && RANK[a.mode] <= RANK[earlier.mode]) continue;
      if (a.mode === 'finish') void snapshot(row, 'финиш по лимиту', [row.id]).catch(() => undefined);
      if (!cfg.steer) { await markSent(row.id, { key, mode: a.mode, at: Date.now() }); continue; }
      try {
        // steer-if-active joins the running turn; our dispatch hook refuses it if the turn has just ended.
        await bb.sdk.threads.send({ threadId: row.id, mode: 'steer-if-active', input: [{ type: 'text', text: thresholdMessage(a, Date.now(), row.providerId), mentions: [] }] });
        await markSent(row.id, { key, mode: a.mode, at: Date.now() });
      } catch (error) { bb.log.warn(`Limit Guard: could not message ${row.id}: ${message(error)}`); }
    }
  }
  // A limit note must never start a turn of its own.
  bb.experimental_hooks.on('message.dispatch', ctx => (ctx.originPluginId === bb.pluginId && ctx.attempt === 'start-turn'
    ? { action: 'reject', message: 'limit-guard: тред уже не работает — сообщение о лимите не нужно' }
    : { action: 'proceed' }));
  bb.background.schedule('poll', '*/2 * * * *', async () => { await poll(); });

  // ---------- A turn already hit the limit ----------
  const stuck = new Map<string, StuckThread>();
  const stuckReady = (async () => {
    for (const key of await bb.storage.kv.list('stuck:')) {
      const value = await bb.storage.kv.get<StuckThread>(key);
      if (value) stuck.set(value.threadId, value);
    }
  })().catch(error => bb.log.warn(`Limit Guard: could not load stuck threads: ${message(error)}`));
  async function forget(threadId: string) {
    await stuckReady;
    if (stuck.delete(threadId)) await bb.storage.kv.delete(`stuck:${threadId}`);
  }
  const loose = z.any();
  async function retryDecision(threadId: string, requestId: string): Promise<{ state: RetryState; at: number | null }> {
    // provider-retry records its decision after queueing; give it up to a minute.
    for (let attempt = 0; attempt < 6; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10_000));
      try {
        const raw = record(await bb.sdk.plugins.callRpc({ pluginId: 'provider-retry', method: 'decision.get', input: { threadId }, outputSchema: loose }));
        if (text(raw.requestId) !== requestId) continue;
        const decision = record(raw.decision);
        if (decision.kind !== 'retry') return { state: 'none', at: null };
        const at = Number(decision.sendAt ?? decision.retryAt);
        return { state: 'queued', at: Number.isFinite(at) ? at : null };
      } catch { return { state: 'unknown', at: null }; }
    }
    return { state: 'unknown', at: null };
  }
  async function alternativeFor(providerId: string, hostId: string): Promise<StuckThread['alternative']> {
    const other = [...SUPPORTED].find(id => id !== providerId);
    if (!other) return null;
    try {
      const { windows, error } = windowsOf(await hostUsage(hostId, false), hostId, other);
      if (error) return { providerId: other, mode: 'unknown', percent: null };
      const a = assess(windows.filter(w => w.kind !== 'model'), null, thresholds);
      return { providerId: other, mode: a.mode, percent: a.driver?.usedPercent ?? null };
    } catch { return { providerId: other, mode: 'unknown', percent: null }; }
  }
  async function onTurnFailed(event: { threadId: string; requestId: string; errorInfo: { category?: string } | null; rateLimits: unknown }) {
    const row = await threadRow(event.threadId);
    if (!row) return;
    // Whatever stopped the turn, and whichever agent ran it, keep what it left in the folder.
    void snapshot(row, `ход прервался (${event.errorInfo?.category ?? 'ошибка'})`, [row.id]).catch(error => bb.log.warn(`Limit Guard: snapshot failed: ${message(error)}`));
    if (!SUPPORTED.has(row.providerId) || cfg.onLimit === 'off' || event.errorInfo?.category !== 'rate-limit' || !row.environmentHostId) return;
    await stuckReady;
    const windows = Array.isArray(record(event.rateLimits).windows) ? record(event.rateLimits).windows as { usedPercent?: number | null; resetsAtMs?: number | null; label?: string }[] : [];
    const model = await threadModel(row.id);
    let modelLimited: string | null = null;
    try {
      const { windows: current } = windowsOf(await hostUsage(row.environmentHostId, true), row.environmentHostId, row.providerId);
      const full = current.filter(w => w.usedPercent >= 100);
      if (full.length && full.every(w => w.kind === 'model') && model) modelLimited = full[0]!.label;
    } catch { /* keep null */ }
    const decision = await retryDecision(row.id, event.requestId);
    const previous = stuck.get(row.id);
    const entry: StuckThread = {
      threadId: row.id, title: row.title || row.titleFallback || 'Тред без названия', providerId: row.providerId, failedAt: Date.now(),
      resetAt: blockingReset(windows), retry: decision.state, retryAt: decision.at, modelLimited,
      alternative: modelLimited ? null : await alternativeFor(row.providerId, row.environmentHostId), notified: previous?.notified ?? false,
    };
    if (shouldNotify(entry, Date.now(), cfg.notifyAfterMinutes)) {
      try {
        await bb.sdk.plugins.callRpc({ pluginId: 'push-notifications', method: 'notifications.send', input: { ...notification(entry, Date.now()), threadId: row.id }, outputSchema: loose });
        entry.notified = true;
      } catch (error) { bb.log.warn(`Limit Guard: notification failed: ${message(error)}`); }
    }
    stuck.set(entry.threadId, entry);
    await bb.storage.kv.set(`stuck:${entry.threadId}`, entry);
  }
  /** A handoff of a stuck thread: drop the source's automatic retry so two agents do not do the same work. */
  async function onHandoffStarted(threadId: string) {
    await stuckReady;
    if (!stuck.size || await bb.storage.kv.get<boolean>(`handoff:${threadId}`)) return;
    await bb.storage.kv.set(`handoff:${threadId}`, true);
    const thread = await bb.sdk.threads.get({ threadId }) as unknown as { createdAt?: number; sourceThreadId?: string | null };
    const createdAt = typeof thread.createdAt === 'number' ? thread.createdAt : Date.now();
    const first = await bb.sdk.threads.events.list({ threadId, types: ['client/turn/requested'], order: 'asc', limit: '1' });
    const body = JSON.stringify(first[0]?.data ?? '');
    for (const source of [...stuck.keys()]) {
      const named = thread.sourceThreadId ? thread.sourceThreadId === source : new RegExp(`@thread:${source}\\b|\\b${source}\\b`).test(body);
      if (!named || (stuck.get(source)?.failedAt ?? Infinity) > createdAt) continue;
      const queued = await bb.sdk.threads.queuedMessages.list({ threadId: source }) as unknown;
      const rows = (Array.isArray(queued) ? queued : record(queued).queuedMessages ?? record(queued).messages ?? []) as { id: string; payload?: { kind?: string } }[];
      for (const q of rows) if (q.payload?.kind === 'retry') await bb.sdk.threads.queuedMessages.delete({ threadId: source, queuedMessageId: q.id });
      bb.log.info(`Limit Guard: ${source} handed off to ${threadId}; automatic retry cancelled`);
      await forget(source);
    }
  }

  bb.events.on('turn.failed', event => { void onTurnFailed(event as never).catch(error => bb.log.warn(`Limit Guard: turn.failed handler: ${message(error)}`)); });
  bb.events.on('thread.active', ({ thread }) => {
    void forget(thread.id);
    if ((thread as { originPluginId?: string | null }).originPluginId === 'handoff') void onHandoffStarted(thread.id).catch(error => bb.log.warn(`Limit Guard: handoff check: ${message(error)}`));
  });
  // A thread that went quiet with changes left in its folder: at most every 10 minutes per folder.
  bb.events.on('thread.idle', ({ thread }) => { snapshotLater(thread.id, 'тред затих с правками', 10 * 60_000); });
  // A worktree is removed five minutes after its last thread is archived: keep its state first.
  bb.events.on('thread.archived', ({ thread }) => {
    void forget(thread.id);
    snapshotLater(thread.id, 'перед удалением worktree', 0, true);
  });
  bb.events.on('thread.deleted', ({ thread }) => { void forget(thread.id); });

  // ---------- Agent surface ----------
  bb.agents.registerTool({
    name: 'limit_status',
    description: 'Остаток лимита подписки для этого треда и режим работы: обычный, экономный или финиш. Плагин сам сообщает о переходе порога; вызывай, например, перед большой задачей.',
    presentation: { label: { pending: 'Проверяю лимит', completed: 'Проверил лимит' }, suppress: true },
    parameters: z.object({ refresh: z.boolean().optional().describe('Запросить свежие данные, а не кэш за минуту') }),
    async execute({ refresh }, ctx) {
      try { return describe(await status(ctx.threadId, refresh ?? false)); }
      catch (error) { return { content: [{ type: 'text', text: `Лимит не удалось узнать: ${message(error)}` }], isError: true }; }
    },
  });
  bb.agents.configure(context => SUPPORTED.has(context.provider.id)
    ? { tools: ['limit_status'], skills: [], instructions: agentRules() }
    : { tools: [], skills: [] });

  // ---------- CLI ----------
  const threadOption = { type: 'string', description: 'ID треда; внутри треда можно не указывать' } as const;
  const jsonOption = { type: 'boolean', description: 'Вывод в JSON' } as const;
  const requireThread = (value: string | undefined, ctx: { threadId?: string }) => {
    const threadId = value ?? ctx.threadId;
    if (!threadId) throw new PluginCliError('не указан тред', { code: 'thread_required', hint: 'Добавьте --thread <id> или запустите команду внутри треда.' });
    return threadId;
  };
  const describeSnapshot = (s: SnapshotRecord) => {
    const r = s.result;
    const state = r.kind === 'hands-off' ? 'папка помечена .bb/hands-off — не трогаю'
      : r.kind === 'missing' ? 'папка не найдена' : r.kind === 'error' ? `ошибка: ${r.error}`
      : r.kind === 'skipped' ? 'не сохранено'
      : r.removed ? 'работа уже в ветке — снимок не нужен (старый убран)'
      : r.kept ? `папка чистая, но работа из прошлого снимка ${r.commit?.slice(0, 8)} не в ветке — снимок сохранён`
      : !r.commit ? 'изменений нет' : `${r.commit.slice(0, 8)}, файлов: ${r.files}${r.skippedFiles ? ` (пропущено крупных/лишних: ${r.skippedFiles})` : ''}${r.pushed ? ', отправлен на сервер' : ''}`;
    return `${new Date(s.at).toISOString().slice(0, 16).replace('T', ' ')} UTC  ${s.path}\n  ${s.reason}: ${state}${r.pushNote ? `\n  ${r.pushNote}` : ''}${r.secrets.length ? `\n  похоже на секреты: ${r.secrets.slice(0, 5).join(', ')}` : ''}${r.kind === 'git' && r.commit ? `\n  ссылка: ${s.ref}` : ''}${r.nested.map(n => `\n  внутри ${n.path}/: ${n.error ? `ошибка: ${n.error}` : n.commit ? `${n.commit.slice(0, 8)}, файлов: ${n.files}` : 'изменений нет'}`).join('')}`;
  };
  bb.cli.register(defineCli({
    name: 'limit',
    summary: 'Лимиты подписки и снимки незаконченной работы (limit-guard)',
    commands: {
      status: cliCommand({
        summary: 'Показать лимит и режим: обычный, экономный, финиш',
        options: { thread: threadOption, refresh: { type: 'boolean', description: 'Не брать кэш за последнюю минуту' }, json: jsonOption },
        async run(input, ctx) {
          const s = await status(requireThread(input.options.thread, ctx), input.options.refresh ?? false);
          return { exitCode: 0, stdout: input.options.json ? JSON.stringify(s, null, 2) : describe(s) };
        },
      }),
      stuck: cliCommand({
        summary: 'Треды, которые упёрлись в лимит: до когда ждать и что можно сделать',
        options: { json: jsonOption },
        async run(input) {
          await stuckReady;
          const list = [...stuck.values()].sort((a, b) => b.failedAt - a.failedAt);
          if (input.options.json) return { exitCode: 0, stdout: JSON.stringify(list, null, 2) };
          return { exitCode: 0, stdout: list.length ? list.map(item => stuckText(item, Date.now())).join('\n') : 'Тредов, ждущих лимит, нет.' };
        },
      }),
      snapshot: cliCommand({
        summary: 'Сделать снимок незаконченной работы в папке треда сейчас (файлы, ветка и индекс не меняются)',
        options: { thread: threadOption, json: jsonOption },
        async run(input, ctx) {
          const threadId = requireThread(input.options.thread, ctx);
          const row = await threadRow(threadId);
          if (!row) throw new PluginCliError('тред не найден', { code: 'thread_not_found' });
          if (cfg.snapshots === 'off') throw new PluginCliError('снимки выключены в настройках', { code: 'snapshots_off', hint: 'bb plugin config limit-guard set snapshots local' });
          const done = await snapshot(row, 'вручную', [threadId]);
          if (!done) throw new PluginCliError('у треда нет папки', { code: 'no_environment' });
          return { exitCode: 0, stdout: input.options.json ? JSON.stringify(done, null, 2) : describeSnapshot(done) };
        },
      }),
      snapshots: cliCommand({
        summary: 'Последние снимки по папкам: где, когда, почему и куда сохранены',
        options: { json: jsonOption },
        async run(input) {
          const list: SnapshotRecord[] = [];
          for (const key of await bb.storage.kv.list('snap:')) { const value = await bb.storage.kv.get<SnapshotRecord>(key); if (value) list.push(value); }
          list.sort((a, b) => b.at - a.at);
          if (input.options.json) return { exitCode: 0, stdout: JSON.stringify(list, null, 2) };
          return { exitCode: 0, stdout: list.length ? list.map(describeSnapshot).join('\n') : 'Снимков нет.' };
        },
      }),
      restore: cliCommand({
        summary: 'Разложить снимок другой папки как незакоммиченные правки в чистой папке треда (только если она на той же базе)',
        options: {
          thread: threadOption,
          from: { type: 'string', description: 'ID окружения, чей снимок взять (см. bb limit snapshots)' },
          json: jsonOption,
        },
        async run(input, ctx) {
          const threadId = requireThread(input.options.thread, ctx);
          if (!input.options.from) throw new PluginCliError('не указан снимок', { code: 'from_required', hint: 'Добавьте --from <environmentId> из `bb limit snapshots`.' });
          const row = await threadRow(threadId);
          if (!row?.environmentHostId || !row.environmentPath) throw new PluginCliError('у треда нет папки', { code: 'no_environment' });
          const result = await host.call('restore', { path: row.environmentPath, ref: snapshotRef(input.options.from) }, { hostId: row.environmentHostId, timeoutMs: 180_000 });
          return { exitCode: result.ok ? 0 : 1, stdout: input.options.json ? JSON.stringify(result) : result.message };
        },
      }),
    },
  }));
}
