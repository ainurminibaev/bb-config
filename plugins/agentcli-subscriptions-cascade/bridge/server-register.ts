// Регистрация исполнителя хода на сервере плагина. В server.ts — одна строка:
//   const executor = registerExecutor(bb, { … });
// и executor.provider(…) поверх объявления провайдера.
//
// Что регистрируется:
// - RPC executorRpcContract: routeTurn / finishTurn (их вызывает запускатель
//   по REST сервера BB) и threadStatus (паспорт треда для других плагинов);
// - CLI `bb subscriptions-cascade status --thread <id> --json` и
//   `bb subscriptions-cascade adopt --stuck|--thread <id>|--project <id> [--dry-run]`;
// - фоновая проверка штатных мостов (digest, версия) — для providerOptions и настроек.
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { formatGc, type GcOptions, type GcReport } from '../sync/gc.ts';
import { formatThreadTestQuota, parseTestQuotaSpec, withThreadTestQuota } from '../test-quota.ts';
import type { CascadeConfig, DiscoveredAccount, Step, TestQuotaEntry, WizardMachineState } from '../contract.ts';
import type { HealthLookup } from '../engine.ts';
import { formatAdopt, parseAdoptArgs, runAdopt, type AdoptPorts, type AdoptThread } from './adopt.ts';
import { formatResolve, resolveRequest } from '../resolve.ts';
import { createRouteJobs } from './route-jobs.ts';
import { DEFAULT_ADOPT_PROMPT, formatNativeAdopt, runNativeAdopt, seedFor, sessionFromEvents, type AdoptSeed, type NativeAdoptPorts, type SeedStore } from './adopt-native.ts';
import { randomUUID } from 'node:crypto';
import { digestMap, nativeBridgeStatus, type NativeBridgeStatus } from './digests.ts';
import { executorRpcContract, PROVIDER_RETRY_AVAILABILITY, retryAvailabilityContract, type LimitObservation } from './route-contract.ts';
import type { Consent } from '../consent.ts';
import type { ThreadEventRow } from './handoff.ts';
import { createRouteService, rememberMachineLabels, type RouteDeps, type RouteService, type StoredThreadState, type SyncPort, type ThreadInfo } from './route-service.ts';

export interface ExecutorDeps {
  providerId: string;
  loadConfig(): Promise<CascadeConfig>;
  /** 0.3.5: `limits` — по каждой ступени состояние, процент/остаток, источник, причина unknown. */
  limits?(): Promise<StepLimitLine[]>;
  /** 0.3.5: `check` — готовность ступеней (по ступени или машине). */
  check?(filter: { stepIds?: string[]; hostIds?: string[] }): Promise<StepCheck[]>;
  /** Сборка брошенных реплик единиц-worktree (sync/gc.ts). */
  gc?(options: GcOptions): Promise<GcReport>;
  /** Пометить модель недоступной на аккаунте машины (видно в таблице моделей). */
  blockModel?(hostId: string, modelId: string, reason: string): Promise<void>;
  /** Мастер «Настроить» на сервере (CLI setup, ленивая настройка при ходе). */
  setup?(input: { hostIds?: string[]; dryRun?: boolean; recheck?: boolean; reset?: boolean; allowSsh?: string[] }): Promise<{ wizard: WizardMachineState[]; notes: string[] }>;
  /** Записать конфигурацию (тестовая квота треда из CLI/RPC). */
  saveConfig?(config: CascadeConfig): Promise<void>;
  accounts(): readonly DiscoveredAccount[];
  /** Машины BB из обнаружения (имя → ID) — для `resolve`, в том числе не из каскада. */
  hosts?(): readonly { hostId: string; name: string }[];
  /** Модель недоступна на аккаунте машины (таблица моделей, на сутки). */
  blockedModel?(hostId: string, modelId: string): boolean;
  /** Обнаружение аккаунтов, если ещё не было (движку нужны модели машин). */
  ensureDiscovered(): Promise<void>;
  /** Лимиты ступени для движка (реальные; тестовый источник подставляется здесь). */
  health(config: CascadeConfig, threadId: string): HealthLookup;
  refreshLimits(config: CascadeConfig, steps: readonly Step[]): Promise<void>;
  observeLimit(config: CascadeConfig, step: Step, event: unknown): void;
  sync: SyncPort | null;
}

import { formatCheck, formatLimits, type StepCheck, type StepLimitLine } from '../readiness.ts';

const STATE_KEY = (threadId: string) => `exec:thread:${threadId}`;
const NOTES_KEY = (threadId: string) => `exec:notes:${threadId}`;
const CONSENTS_KEY = (projectId: string) => `exec:consents:${projectId}`;

/**
 * Порты карточки подтверждения и перехода между провайдерами: правила
 * «навсегда» проекта в kv плагина, события треда для сводки/дельты.
 */
/** Предел страницы событий треда у BB (`Thread event limit cannot exceed 100`). */
export const THREAD_EVENTS_PAGE = 100;

/**
 * События треда для сводки перехода: только нужные типы, страницами по 100,
 * не больше 4000. Ошибка — наружу (мост покажет честную сводку без событий).
 */
export async function readThreadEvents(list: (args: Record<string, unknown>) => Promise<unknown>, threadId: string, afterSeq: number): Promise<ThreadEventRow[]> {
  const rows: ThreadEventRow[] = [];
  let after = afterSeq;
  let filtered = true;
  const page = async (since: number) => {
    const base = { threadId, afterSeq: String(since), limit: String(THREAD_EVENTS_PAGE), order: 'asc' };
    if (!filtered) return list(base);
    // Фильтр типов уменьшает число страниц; не принят — без него.
    try { return await list({ ...base, types: ['client/turn/requested', 'item/completed'] }); } catch { filtered = false; return list(base); }
  };
  for (let n = 0; n < 40; n += 1) {
    const batch = await page(after);
    const items = Array.isArray(batch) ? batch as unknown[] : [];
    for (const item of items) {
      const row = rec(item);
      const seq = Number(row.seq);
      if (Number.isFinite(seq) && typeof row.type === 'string') rows.push({ seq, type: row.type, data: row.data });
    }
    if (items.length < THREAD_EVENTS_PAGE || rows.length === 0) break;
    after = rows[rows.length - 1]!.seq;
  }
  return rows;
}

function consentAndHandoffPorts(bb: BbPluginApi): Pick<RouteDeps, 'projectConsents' | 'saveProjectConsents' | 'threadEvents'> {
  return {
    projectConsents: async projectId => (await bb.storage.kv.get<Consent[]>(CONSENTS_KEY(projectId))) ?? [],
    saveProjectConsents: async (projectId, consents) => { await bb.storage.kv.set(CONSENTS_KEY(projectId), consents); },
    threadEvents: (threadId, afterSeq) => readThreadEvents(list => bb.sdk.threads.events.list(list as never) as Promise<unknown>, threadId, afterSeq),
  };
}

/** Ручки штатного моста Claude (ключи providerOptions — внутренний контракт моста BB 0.50). */
export function claudeBridgeKnobs(promptMode: string | undefined): Record<string, string | boolean> {
  return {
    memoryEnabled: false, providerSubagentsEnabled: true, workflowsEnabled: false, chromeEnabled: false,
    disable1MContext: false, artifactsEnabled: false, sandboxEnabled: true, fullAccessApprovalsEnabled: false,
    commandDescriptionsEnabled: false,
    ...(promptMode === 'plan' ? { claudeCodePermissionMode: 'plan' } : {}),
  };
}

function rec(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
}

function toAdoptThread(raw: unknown): AdoptThread | null {
  const r = rec(raw);
  const t = rec(r.thread ?? r);
  if (typeof t.id !== 'string') return null;
  const runtime = rec(t.runtime);
  return {
    id: t.id, title: typeof t.title === 'string' ? t.title : '', providerId: typeof t.providerId === 'string' ? t.providerId : '',
    projectId: typeof t.projectId === 'string' ? t.projectId : '', archived: t.archivedAt !== null && t.archivedAt !== undefined,
    status: typeof runtime.displayStatus === 'string' ? runtime.displayStatus : typeof t.status === 'string' ? t.status : null,
  };
}

/** Ответ threads.get → сведения для маршрута (читается терпимо: окружение рядом с тредом или внутри). */
export function threadInfoFrom(response: unknown): ThreadInfo | null {
  const raw = rec(response);
  const thread = rec(raw.thread ?? raw);
  if (typeof thread.id !== 'string') return null;
  const environment = rec(raw.environment ?? thread.environment);
  const selection = rec(rec(environment.environmentProviderSelection).machine);
  const hostId = [environment.hostId, selection.hostId, rec(thread.host).id].find((v): v is string => typeof v === 'string' && v !== '') ?? null;
  const provision = typeof environment.workspaceProvisionType === 'string' ? environment.workspaceProvisionType : null;
  return {
    projectId: String(thread.projectId ?? ''),
    hostId,
    parentThreadId: typeof thread.parentThreadId === 'string' ? thread.parentThreadId : null,
    providerId: String(thread.providerId ?? ''),
    environmentId: typeof thread.environmentId === 'string' ? thread.environmentId : null,
    // Своя рабочая папка треда (worktree, копия): ход не должен писать в общий checkout.
    isolatedWorkspace: provision === null ? null : /worktree|copy|clone|isolated/iu.test(provision),
  };
}

const STEP_TITLES: Record<string, string> = { probe: 'Машина', folder: 'Папка', mutagen: 'Mutagen', ssh: 'SSH до опоры', verify: 'Проверка' };
const STATUS_MARK: Record<string, string> = { done: '✓', skipped: '–', failed: '✗', manual: '!', pending: '·', running: '…' };

/** Статус мастера по шагам для CLI; согласие — с командой. */
export function formatSetup(config: CascadeConfig, result: { wizard: WizardMachineState[]; notes: string[] }): string {
  const lines: string[] = [...result.notes.map(n => `• ${n}`)];
  for (const w of result.wizard) {
    const label = config.machines.find(m => m.hostId === w.hostId)?.label ?? w.hostId;
    lines.push(`${label}:`);
    for (const [id, st] of Object.entries(w.steps)) lines.push(`  ${STATUS_MARK[st.status] ?? st.status} ${STEP_TITLES[id] ?? id}${st.message ? ` — ${st.message}` : ''}`);
    if (w.pendingConsent) lines.push(`  ${w.pendingConsent.text}`, `  Разрешить: bb subscriptions-cascade setup --machine ${label} --allow-ssh`);
  }
  return `${lines.join('\n')}\n`;
}

export interface ExecutorRegistration {
  routes: RouteService;
  /** providerOptions для штатного моста и для нашей обёртки (синхронно, из кэша). */
  deriveProviderOptions(ctx: { threadId: string; model: string; promptMode?: string }): Record<string, unknown>;
  /** Состояние штатных мостов для экрана настроек. */
  nativeBridges(): readonly NativeBridgeStatus[];
  refreshNativeBridges(): Promise<readonly NativeBridgeStatus[]>;
  /** Перечитать тестовые переключатели после изменения настроек. */
  refreshTestFlags(): Promise<void>;
  /** Схема профиля треда для метки ступени. */
  scheme(threadId: string): ReturnType<RouteService['threadScheme']>;
  /** Предупреждения для настроек: мост не найден, версия не читается. */
  issues(): string[];
}

export function registerExecutor(bb: BbPluginApi, deps: ExecutorDeps): ExecutorRegistration {
  const threadProvider = new Map<string, string>();
  /** Тестовый переключатель S13 (testQuota.bridgeIncompatible), кэш для синхронного deriveProviderOptions. */
  let bridgeIncompatible = false;
  const refreshTestFlags = () => deps.loadConfig().then(c => { bridgeIncompatible = c.testQuota.bridgeIncompatible === true; }).catch(() => undefined);
  void refreshTestFlags();
  let bridges: readonly NativeBridgeStatus[] = [];
  let bridgesAt = 0;

  async function refreshNativeBridges(): Promise<readonly NativeBridgeStatus[]> {
    bridges = await nativeBridgeStatus(async () => {
      const result = rec(await bb.sdk.plugins.list());
      const plugins = Array.isArray(result.plugins) ? result.plugins as unknown[] : [];
      return plugins.map(p => {
        const e = rec(p);
        return { id: String(e.id), rootDir: String(e.rootDir ?? ''), enabled: e.enabled === true, version: typeof e.version === 'string' ? e.version : null };
      });
    });
    bridgesAt = Date.now();
    for (const b of bridges) if (b.problem) bb.log.warn(`штатный мост ${b.providerId}: ${b.problem}`);
    return bridges;
  }
  void refreshNativeBridges().catch(error => bb.log.warn(`проверка штатных мостов: ${String(error)}`));
  // Обновление BB меняет мост: перепроверка раз в 10 минут, по таймеру без нагрузки на CLI.
  // Таймер снимается при перезагрузке, выключении и удалении плагина: иначе
  // прежний экземпляр продолжает звать устаревший handle bb.
  let disposed = false;
  const timer = setInterval(() => { if (!disposed) void refreshNativeBridges().catch(() => {}); }, 10 * 60_000);
  timer.unref?.();
  // Сборка брошенных реплик: после архивации/удаления треда каскада (через минуту,
  // пачкой) и раз в сутки. Один вызов списка тредов за запуск (AGENTS.md).
  const gcThreads = new Set<string>();
  let gcTimer: ReturnType<typeof setTimeout> | null = null;
  const runAutoGc = (threads: string[] | null) => {
    if (disposed || !deps.gc) return;
    void deps.loadConfig().then(async config => {
      if (!config.files.autoGc) return;
      const report = await deps.gc!({ dryRun: false, ...(threads ? { onlyThreads: threads } : {}) });
      const retired = report.units.filter(u => u.verdict.action === 'retire');
      if (retired.length || report.errors.length) bb.log.info(`gc${threads ? ` (${threads.join(', ')})` : ' (сутки)'}: собрано ${retired.length}${report.errors.length ? `, ошибки: ${report.errors.join('; ')}` : ''}`);
    }).catch(error => bb.log.warn(`gc: ${String(error)}`));
  };
  const onGone = (payload: { thread?: { id?: unknown; providerId?: unknown } }) => {
    const thread = payload.thread;
    if (!thread || typeof thread.id !== 'string' || thread.providerId !== deps.providerId) return;
    gcThreads.add(thread.id);
    if (gcTimer) return;
    gcTimer = setTimeout(() => { gcTimer = null; const ids = [...gcThreads]; gcThreads.clear(); runAutoGc(ids); }, 60_000);
    gcTimer.unref?.();
  };
  bb.events.on('thread.archived', onGone as never);
  bb.events.on('thread.deleted', onGone as never);
  const dailyGc = setInterval(() => runAutoGc(null), 24 * 3_600_000);
  dailyGc.unref?.();
  bb.onDispose(() => { disposed = true; clearInterval(timer); clearInterval(dailyGc); if (gcTimer) clearTimeout(gcTimer); });

  // Окружение треда приходит только с include: без него hostId пуст, и ход в
  // worktree на опоре ушёл бы в основную папку проекта (живой S1 на 0.1.7).
  const threadInfo = async (threadId: string): Promise<ThreadInfo | null> => threadInfoFrom(await bb.sdk.threads.get({ threadId, include: 'environment' } as never));

  // Посев `adopt --native`: одноразовый ключ (метаданные треда) → посев (kv плагина).
  const SEED_PENDING = (nonce: string) => `adopt:pending:${nonce}`;
  const SEED_THREAD = (threadId: string) => `adopt:thread:${threadId}`;
  const seedStore: SeedStore = {
    pending: async nonce => (await bb.storage.kv.get<AdoptSeed>(SEED_PENDING(nonce))) ?? null,
    claim: async (nonce, threadId, seed) => { await bb.storage.kv.set(SEED_THREAD(threadId), seed); await bb.storage.kv.delete(SEED_PENDING(nonce)); },
    claimed: async threadId => (await bb.storage.kv.get<AdoptSeed>(SEED_THREAD(threadId))) ?? null,
  };
  const adoptSeed = async (threadId: string) => {
    const meta = rec(await bb.sdk.threads.getPluginMetadata({ threadId } as never).catch(() => null));
    // BB 0.50 отдаёт сами метаданные плагина (JSON-объект); обёртку читаем терпимо.
    const values = typeof meta.adoptNonce === 'string' ? meta : rec(meta.metadata ?? meta.value);
    const nonce = typeof values.adoptNonce === 'string' && /^[0-9a-f-]{16,64}$/u.test(values.adoptNonce) ? values.adoptNonce : null;
    return seedFor(seedStore, threadId, nonce, Date.now());
  };

  // Имена машин, убранных из каскада, — из памяти синхронизации (`sync:machine:*`), читается терпимо.
  const loadRetiredLabels = async () => {
    const keys = await bb.storage.kv.list('sync:machine:').catch(() => [] as string[]);
    const found: { hostId: string; label: string }[] = [];
    for (const key of keys) {
      const m = await bb.storage.kv.get<{ hostId?: unknown; label?: unknown }>(key).catch(() => undefined);
      if (typeof m?.hostId === 'string' && typeof m.label === 'string') found.push({ hostId: m.hostId, label: m.label });
    }
    rememberMachineLabels(found);
  };
  void loadRetiredLabels();
  const routes = createRouteService({
    adoptSeed,
    hostName: hostId => deps.hosts?.().find(h => h.hostId === hostId)?.name ?? null,
    threadTitle: async threadId => {
      const r = rec(await bb.sdk.threads.get({ threadId }).catch(() => null));
      const t = rec(r.thread ?? r);
      return typeof t.title === 'string' && t.title ? t.title : null;
    },
    loadConfig: deps.loadConfig,
    accounts: deps.accounts,
    health: deps.health,
    refreshLimits: async (config, steps) => { await deps.ensureDiscovered(); await deps.refreshLimits(config, steps); },
    observeLimit: (config, step, observation: LimitObservation) => {
      // 0.3.5: уведомление app-server Codex — адаптеру Codex как есть (codexEventReading).
      const raw = observation.raw as { method?: unknown } | undefined;
      if (step.providerId === 'codex' && raw && typeof raw === 'object' && raw.method === 'account/rateLimits/updated') { deps.observeLimit(config, step, raw); return; }
      deps.observeLimit(config, step, { type: 'rate_limit_event', rate_limit_info: observation.raw ?? { status: observation.status, resetsAt: observation.resetsAt ? observation.resetsAt / 1000 : undefined, rateLimitType: observation.windowType ?? undefined } });
    },
    threadInfo,
    // 0.3.4: строки для ленты родителя подтреда («Codex недоступен … — подтред на Claude»).
    pushThreadNote: async (threadId, message) => {
      const list = (await bb.storage.kv.get<string[]>(NOTES_KEY(threadId))) ?? [];
      await bb.storage.kv.set(NOTES_KEY(threadId), [...(Array.isArray(list) ? list : []), message].slice(-20));
    },
    takeThreadNotes: async threadId => {
      const list = await bb.storage.kv.get<string[]>(NOTES_KEY(threadId));
      if (!Array.isArray(list) || list.length === 0) return [];
      await bb.storage.kv.delete(NOTES_KEY(threadId));
      return list.filter((m): m is string => typeof m === 'string');
    },
    load: async threadId => bb.storage.kv.get<StoredThreadState>(STATE_KEY(threadId)),
    save: async (threadId, state) => {
      if (state.lastRun) threadProvider.set(threadId, state.lastRun.providerId);
      await bb.storage.kv.set(STATE_KEY(threadId), state);
    },
    sync: deps.sync,
    blockModel: deps.blockModel,
    ensureMachine: deps.setup ? async hostId => {
      const result = await deps.setup!({ hostIds: [hostId] });
      const state = result.wizard.find(w => w.hostId === hostId);
      if (!state) return { ok: false, message: 'машина выключена в каскаде', consent: null };
      if (state.pendingConsent) return { ok: false, message: 'нужно разрешение', consent: state.pendingConsent.text };
      const bad = Object.entries(state.steps).find(([, st]) => st.status !== 'done' && st.status !== 'skipped');
      return bad ? { ok: false, message: `${bad[0]}: ${bad[1].message ?? bad[1].status}`, consent: null } : { ok: true, message: '', consent: null };
    } : undefined,
    now: Date.now,
    warn: message => bb.log.warn(message),
    ...consentAndHandoffPorts(bb),
  });
  const routeJobs = createRouteJobs((input: Parameters<RouteService['routeTurn']>[0]) => routes.routeTurn(input));

  /** Подмена квоты треда: `spec` пустой — только показать; clear — снять перед записью. */
  async function applyTestQuota(threadId: string, spec: string, clear: boolean): Promise<{ config: CascadeConfig } | { error: string }> {
    let config = await deps.loadConfig();
    if (!spec.trim() && !clear) return { config };
    if (!deps.saveConfig) return { error: 'запись конфигурации недоступна' };
    let entries: Record<string, TestQuotaEntry> | undefined;
    if (spec.trim()) {
      const parsed = parseTestQuotaSpec(config, spec, Date.now());
      if ('error' in parsed) return parsed;
      entries = parsed.entries;
    }
    config = withThreadTestQuota(config, threadId, { entries, clear });
    await deps.saveConfig(config);
    bb.log.info(`тестовая квота треда ${threadId}: ${clear ? 'снята' : ''}${entries ? ` ${Object.entries(entries).map(([k, v]) => `${k}=${v.state}`).join(', ')}` : ''}`);
    return { config };
  }

  bb.rpc.register(executorRpcContract, {
    testQuota: async ({ threadId, set, clear }) => {
      const result = await applyTestQuota(threadId, set ?? '', clear);
      if ('error' in result) throw new Error(result.error);
      return { threadId, steps: result.config.testQuota.threads[threadId] ?? null };
    },
    // С `async` (запускатель 0.3.0+) — ответ не дольше ~20 с, дальше опрос по билету.
    routeTurn: input => (input.async ? routeJobs.start(input) : routes.routeTurn(input)),
    routeTurnResult: ({ ticket }) => routeJobs.result(ticket),
    finishTurn: input => routes.finishTurn(input),
    threadStatus: ({ threadId }) => routes.threadStatus(threadId),
    turnProgress: async ({ threadId }) => ({ note: routes.turnProgress(threadId) }),
    turnLimits: input => routes.turnLimits(input),
    turnModelUnavailable: input => routes.turnModelUnavailable(input),
    syncTurn: input => routes.syncTurn(input),
    answerConfirmation: input => routes.answerConfirmation(input),
    peekProvider: input => routes.peekProvider(input),
    handoffBrief: input => routes.handoffBrief(input),
    nativeSessions: async ({ threadId, sessions }) => {
      const result = await routes.nativeSessions(threadId, sessions);
      if (result.sessions) threadProvider.set(threadId, result.sessions.active);
      return result;
    },
  }, { experimental_discoverable: true, experimental_description: 'Каскад подписок: паспорт треда (threadStatus), тестовая квота треда (testQuota), ход исполнителя (routeTurn/finishTurn).' });

  // Штатный provider-retry спрашивает доступность после ошибки лимита у всех
  // плагинов с этим методом: свои треды каскад отправляет на следующую ступень.
  bb.rpc.register(retryAvailabilityContract, {
    [PROVIDER_RETRY_AVAILABILITY]: async ({ threadId }: { threadId: string }) => routes.retryAvailability(threadId).catch(error => {
      bb.log.warn(`доступность для provider-retry ${threadId}: ${String(error)}`);
      return { kind: 'not-routed' as const };
    }),
  }, { experimental_discoverable: true, experimental_description: 'Каскад подписок: доступность ступени для повтора хода после лимита (provider-retry).' });

  // ---- CLI ----
  const adoptPorts: AdoptPorts = {
    async listThreads(filter) {
      const raw = rec(await bb.sdk.threads.list({ ...(filter.projectId ? { projectId: filter.projectId } : {}) } as never));
      const items = Array.isArray(raw.threads) ? raw.threads : Array.isArray(raw.items) ? raw.items : Array.isArray(raw) ? raw as unknown[] : [];
      return (items as unknown[]).map(toAdoptThread).filter((t): t is AdoptThread => t !== null);
    },
    async getThread(threadId) { return toAdoptThread(await bb.sdk.threads.get({ threadId }).catch(() => null)); },
    async pendingRetries() {
      const out = await adoptPorts.runPluginCli('provider-retry', ['status', '--json']);
      try {
        const json = JSON.parse(out.stdout) as { retries?: { threadId?: string }[] };
        return (json.retries ?? []).map(r => r.threadId).filter((id): id is string => typeof id === 'string');
      } catch { return []; }
    },
    async runPluginCli(pluginId, argv) {
      const response = await fetch(`${bb.server.loopbackBaseUrl.replace(/\/+$/u, '')}/api/v1/plugins/${encodeURIComponent(pluginId)}/cli`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ argv, cwd: '/' }), signal: AbortSignal.timeout(300_000),
      });
      const json = rec(await response.json().catch(() => null));
      return { exitCode: typeof json.exitCode === 'number' ? json.exitCode : 1, stdout: String(json.stdout ?? ''), stderr: String(json.stderr ?? json.error ?? '') };
    },
  };

  const nativeAdoptPorts: NativeAdoptPorts = {
    async getThread(threadId) {
      const r = rec(await bb.sdk.threads.get({ threadId }).catch(() => null));
      const t = rec(r.thread ?? r);
      if (typeof t.id !== 'string') return null;
      const str = (v: unknown) => typeof v === 'string' && v ? v : null;
      return {
        id: t.id, title: str(t.title) ?? '', providerId: str(t.providerId) ?? '', projectId: str(t.projectId) ?? '',
        environmentId: str(t.environmentId), parentThreadId: str(t.parentThreadId), archived: t.archivedAt !== null && t.archivedAt !== undefined,
        status: str(t.status), queued: typeof t.queuedMessageCount === 'number' ? t.queuedMessageCount : 0,
      };
    },
    async sessionId(threadId) {
      const base = { threadId, order: 'desc', limit: String(THREAD_EVENTS_PAGE) };
      const types = ['thread/identity', 'thread/started', 'turn/completed', 'turn/started', 'turn/input/accepted'];
      const list = (args: Record<string, unknown>) => bb.sdk.threads.events.list(args as never) as Promise<unknown>;
      const raw = await list({ ...base, types }).catch(() => list(base)).catch(() => []);
      const rows = (Array.isArray(raw) ? raw : []).map(item => { const row = rec(item); return { type: String(row.type ?? ''), data: row.data }; });
      return sessionFromEvents(rows);
    },
    saveSeed: async (nonce, seed) => { await bb.storage.kv.set(SEED_PENDING(nonce), seed); },
    dropSeed: async nonce => { await bb.storage.kv.delete(SEED_PENDING(nonce)); },
    async spawn(args) {
      const r = rec(await bb.sdk.threads.spawn({
        projectId: args.projectId, environment: { type: 'reuse', environmentId: args.environmentId }, providerId: deps.providerId, model: args.model,
        title: args.title, prompt: args.prompt, ...(args.parentThreadId ? { parentThreadId: args.parentThreadId } : {}), pluginMetadata: { adoptNonce: args.nonce },
      } as never));
      const t = rec(r.thread ?? r);
      if (typeof t.id !== 'string') throw new Error('BB не вернул ID нового треда');
      return t.id;
    },
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    now: Date.now,
    randomId: () => randomUUID(),
  };

  bb.cli.register({
    name: 'subscriptions-cascade',
    summary: 'Каскад подписок: паспорт треда и перевод тредов в каскад',
    commands: [
      { name: 'status', summary: 'Ступень, машина и копия файлов треда', usage: 'bb subscriptions-cascade status --thread <id> [--json]' },
      { name: 'test-quota', summary: 'Тестовая квота ступеней для одного треда (сценарии S1–S13)', usage: "bb subscriptions-cascade test-quota --thread <id> [--set '<ступень>=exhausted|ok|unknown|unavailable[,<сброс ISO|+30m>];…'] [--clear] [--json]" },
      { name: 'setup', summary: 'Мастер «Настроить»: продолжить, перепроверить, настроить с нуля; разрешить вход на опору по ключу', usage: 'bb subscriptions-cascade setup [--machine <hostId|имя>] [--recheck] [--reset] [--allow-ssh] [--dry-run] [--json]' },
      { name: 'gc', summary: 'Убрать реплики и сессии Mutagen архивированных и удалённых тредов (опора не трогается)', usage: 'bb subscriptions-cascade gc [--dry-run] [--machine <hostId|имя>] [--json]' },
      { name: 'test-bridge', summary: 'Приёмка S13: считать штатный мост несовместимым (без правки BB)', usage: 'bb subscriptions-cascade test-bridge --incompatible|--compatible' },
      { name: 'resolve', summary: 'Просьба «Codex 6.2 на Tru», «на аккаунте vclaude» → закреплённая ступень каскада (pin:…), кандидаты или запасной путь', usage: 'bb subscriptions-cascade resolve "<просьба>" [--json]' },
      { name: 'limits', summary: 'Лимиты по ступеням: состояние, процент или остаток, источник, причина «неизвестно» — то, что видит каскад', usage: 'bb subscriptions-cascade limits [--json]' },
      { name: 'check', summary: 'Готовность ступеней: машина, CLI и вход, лимиты и сверка с Thread Account Usage, модели, общий путь, Mutagen, SSH', usage: 'bb subscriptions-cascade check [--step <id>|--host <id|имя>] [--json]' },
      { name: 'adopt', summary: 'Перевести треды в каскад (Handoff) и снять автоповтор у исходных', usage: 'bb subscriptions-cascade adopt --stuck|--thread <id>|--project <id> [--dry-run] [--model <профиль>] [--json] · --native --thread <id> [--model <профиль>] [--prompt <текст>] [--wait <сек>] [--dry-run] — та же сессия Claude в треде каскада, то же окружение' },
    ],
    async run(argv, ctx) {
      const [command, ...rest] = argv;
      if (command === 'status') {
        const i = rest.indexOf('--thread');
        const threadId = i !== -1 ? rest[i + 1] : ctx.threadId;
        if (!threadId) return { exitCode: 2, stderr: 'укажите --thread <id>\n' };
        const status = await routes.threadStatus(threadId);
        if (rest.includes('--json')) return { exitCode: 0, stdout: `${JSON.stringify(status)}\n` };
        if (!status.cascade) return { exitCode: 0, stdout: 'Тред не в каскаде.\n' };
        return { exitCode: 0, stdout: `Профиль: ${status.profileId ?? '—'}\nСтупень: ${status.step ? `${status.step.hostId} · ${status.step.providerId} · ${status.step.model ?? 'по умолчанию'}` : 'ход ещё не выбран'}\nОпора: ${status.anchorHostId ?? '—'}, синхронизация: ${status.syncMode}\nСвежая копия: ${status.freshCopyHostId ?? '—'}\n` };
      }
      if (command === 'test-quota') {
        const i = rest.indexOf('--thread');
        const threadId = i !== -1 ? rest[i + 1] : ctx.threadId;
        if (!threadId) return { exitCode: 2, stderr: 'укажите --thread <id>\n' };
        const sets = rest.flatMap((arg, n) => arg === '--set' && rest[n + 1] ? [rest[n + 1]!] : arg.startsWith('--set=') ? [arg.slice(6)] : []);
        const result = await applyTestQuota(threadId, sets.join(';'), rest.includes('--clear'));
        if ('error' in result) return { exitCode: 2, stderr: `${result.error}\n` };
        if (rest.includes('--json')) return { exitCode: 0, stdout: `${JSON.stringify({ threadId, steps: result.config.testQuota.threads[threadId] ?? null })}\n` };
        return { exitCode: 0, stdout: formatThreadTestQuota(result.config, threadId) };
      }
      if (command === 'setup') {
        if (!deps.setup) return { exitCode: 2, stderr: 'мастер недоступен\n' };
        const config = await deps.loadConfig();
        const i = rest.indexOf('--machine');
        const ref = i !== -1 ? rest[i + 1] : undefined;
        const machine = ref ? config.machines.find(m => m.hostId === ref || m.label.toLowerCase() === ref.toLowerCase()) : undefined;
        if (ref && !machine) return { exitCode: 2, stderr: `машина «${ref}» не найдена в каскаде (${config.machines.map(m => m.label).join(', ')})\n` };
        const hostIds = machine ? [machine.hostId] : undefined;
        const result = await deps.setup({
          hostIds, dryRun: rest.includes('--dry-run'), recheck: rest.includes('--recheck'), reset: rest.includes('--reset'),
          allowSsh: rest.includes('--allow-ssh') ? (hostIds ?? config.machines.map(m => m.hostId)) : [],
        });
        if (rest.includes('--json')) return { exitCode: 0, stdout: `${JSON.stringify(result)}\n` };
        return { exitCode: result.wizard.some(w => Object.values(w.steps).some(st => st.status === 'failed')) ? 1 : 0, stdout: formatSetup(config, result) };
      }
      if (command === 'gc') {
        if (!deps.gc) return { exitCode: 2, stderr: 'сборка недоступна\n' };
        const config = await deps.loadConfig();
        const i = rest.indexOf('--machine');
        const ref = i !== -1 ? rest[i + 1] : undefined;
        const machine = ref ? config.machines.find(m => m.hostId === ref || m.label.toLowerCase() === ref.toLowerCase()) : undefined;
        if (ref && !machine) return { exitCode: 2, stderr: `машина «${ref}» не найдена в каскаде\n` };
        if (machine?.anchor) return { exitCode: 2, stderr: `${machine.label} — опора: реплик там нет, gc её не трогает\n` };
        const report = await deps.gc({ dryRun: rest.includes('--dry-run'), hostId: machine?.hostId ?? null });
        if (rest.includes('--json')) return { exitCode: 0, stdout: `${JSON.stringify(report)}\n` };
        return { exitCode: report.units.some(u => u.machines.some(m => m.error)) ? 1 : 0, stdout: formatGc(report) };
      }
      if (command === 'test-bridge') {
        const on = rest.includes('--incompatible');
        if (!on && !rest.includes('--compatible')) return { exitCode: 0, stdout: `Тестовый переключатель S13: мост ${bridgeIncompatible ? 'несовместим' : 'совместим'}.\n` };
        if (!deps.saveConfig) return { exitCode: 2, stderr: 'запись конфигурации недоступна\n' };
        const config = await deps.loadConfig();
        await deps.saveConfig({ ...config, testQuota: { ...config.testQuota, bridgeIncompatible: on } });
        bridgeIncompatible = on;
        return { exitCode: 0, stdout: on ? 'Мост помечен несовместимым: ходы каскада отклоняются с подсказкой, штатные провайдеры работают. Снять: --compatible.\n' : 'Тестовый переключатель снят.\n' };
      }
      if (command === 'resolve') {
        // Только чтение настроек, таблицы моделей и уже обнаруженных каталогов — без вызова моделей.
        const text = rest.filter(a => a !== '--json').join(' ').trim();
        if (!text) return { exitCode: 2, stderr: 'укажите просьбу: bb subscriptions-cascade resolve "Codex 6.2 на Tru" [--json]\n' };
        const result = resolveRequest({ config: await deps.loadConfig(), accounts: deps.accounts(), hosts: deps.hosts?.() ?? [], blocked: deps.blockedModel, text });
        if (rest.includes('--json')) return { exitCode: 0, stdout: `${JSON.stringify(result)}\n` };
        return { exitCode: 0, stdout: formatResolve(result) };
      }
      if (command === 'limits') {
        if (!deps.limits) return { exitCode: 2, stderr: 'отчёт о лимитах недоступен\n' };
        const lines = await deps.limits();
        if (rest.includes('--json')) return { exitCode: 0, stdout: `${JSON.stringify({ steps: lines })}\n` };
        return { exitCode: 0, stdout: formatLimits(lines) };
      }
      if (command === 'check') {
        if (!deps.check) return { exitCode: 2, stderr: 'проверка недоступна\n' };
        const config = await deps.loadConfig();
        const si = rest.indexOf('--step');
        const hi = rest.indexOf('--host');
        const stepId = si !== -1 ? rest[si + 1] : undefined;
        const hostRef = hi !== -1 ? rest[hi + 1] : undefined;
        if (stepId && !config.steps.some(s => s.id === stepId)) return { exitCode: 2, stderr: `ступень «${stepId}» не найдена (${config.steps.map(s => s.id).join(', ')})\n` };
        const machine = hostRef ? config.machines.find(m => m.hostId === hostRef || m.label.toLowerCase() === hostRef.toLowerCase()) : undefined;
        if (hostRef && !machine) return { exitCode: 2, stderr: `машина «${hostRef}» не найдена в каскаде\n` };
        const checks = await deps.check({ ...(stepId ? { stepIds: [stepId] } : {}), ...(machine ? { hostIds: [machine.hostId] } : {}) });
        const exitCode = checks.some(c => !c.ready) ? 1 : 0;
        if (rest.includes('--json')) return { exitCode, stdout: `${JSON.stringify({ steps: checks })}\n` };
        return { exitCode, stdout: formatCheck(checks) };
      }
      if (command === 'adopt') {
        const parsed = parseAdoptArgs(rest);
        if ('error' in parsed) return { exitCode: 2, stderr: `${parsed.error}\n` };
        if (parsed.native) {
          const result = await runNativeAdopt(nativeAdoptPorts, {
            threadId: parsed.threadId!, dryRun: parsed.dryRun, model: parsed.model, prompt: parsed.prompt ?? DEFAULT_ADOPT_PROMPT,
            waitSeconds: parsed.waitSeconds ?? 600, providerId: deps.providerId,
          });
          const failed = Boolean(result.error) || result.action === 'skip';
          if (rest.includes('--json')) return { exitCode: failed ? 1 : 0, stdout: `${JSON.stringify({ dryRun: parsed.dryRun, native: true, item: result })}\n` };
          return { exitCode: failed ? 1 : 0, stdout: formatNativeAdopt(result, parsed.dryRun) };
        }
        const options = { ...parsed, providerId: deps.providerId };
        const items = await runAdopt(adoptPorts, options);
        if (rest.includes('--json')) return { exitCode: items.some(i => i.error) ? 1 : 0, stdout: `${JSON.stringify({ dryRun: options.dryRun, items })}\n` };
        return { exitCode: items.some(i => i.error) ? 1 : 0, stdout: formatAdopt(items, options.dryRun) };
      }
      return { exitCode: 2, stderr: 'команды: status, resolve, limits, check, setup, gc, test-quota, test-bridge, adopt\n' };
    },
  });

  return {
    routes,
    refreshTestFlags,
    deriveProviderOptions(ctx) {
      if (!disposed && Date.now() - bridgesAt > 10 * 60_000) void refreshNativeBridges().catch(() => {});
      return {
        ...claudeBridgeKnobs(ctx.promptMode),
        requestedModel: ctx.model,
        cascade: { provider: threadProvider.get(ctx.threadId) ?? 'claude-code', digests: digestMap(bridges), ...(bridgeIncompatible ? { testBridgeIncompatible: true } : {}) },
      };
    },
    nativeBridges: () => bridges,
    scheme: threadId => routes.threadScheme(threadId),
    refreshNativeBridges,
    issues: () => bridges.filter(b => b.problem && b.providerId === 'claude-code').map(b => `Штатный мост Claude Code: ${b.problem}. Каскад не сможет запускать ходы.`),
  };
}
