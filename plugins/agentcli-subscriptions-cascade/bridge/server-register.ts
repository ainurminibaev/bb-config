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
import { formatThreadTestQuota, parseTestQuotaSpec, withThreadTestQuota } from '../test-quota.ts';
import type { CascadeConfig, DiscoveredAccount, Step, TestQuotaEntry } from '../contract.ts';
import type { HealthLookup } from '../engine.ts';
import { formatAdopt, parseAdoptArgs, runAdopt, type AdoptPorts, type AdoptThread } from './adopt.ts';
import { digestMap, nativeBridgeStatus, type NativeBridgeStatus } from './digests.ts';
import { executorRpcContract, type LimitObservation } from './route-contract.ts';
import type { Consent } from '../consent.ts';
import type { ThreadEventRow } from './handoff.ts';
import { createRouteService, type RouteDeps, type RouteService, type StoredThreadState, type SyncPort, type ThreadInfo } from './route-service.ts';

export interface ExecutorDeps {
  providerId: string;
  loadConfig(): Promise<CascadeConfig>;
  /** Записать конфигурацию (тестовая квота треда из CLI/RPC). */
  saveConfig?(config: CascadeConfig): Promise<void>;
  accounts(): readonly DiscoveredAccount[];
  /** Обнаружение аккаунтов, если ещё не было (движку нужны модели машин). */
  ensureDiscovered(): Promise<void>;
  /** Лимиты ступени для движка (реальные; тестовый источник подставляется здесь). */
  health(config: CascadeConfig, threadId: string): HealthLookup;
  refreshLimits(config: CascadeConfig, steps: readonly Step[]): Promise<void>;
  observeLimit(config: CascadeConfig, step: Step, event: unknown): void;
  sync: SyncPort | null;
}

const STATE_KEY = (threadId: string) => `exec:thread:${threadId}`;
const CONSENTS_KEY = (projectId: string) => `exec:consents:${projectId}`;

/**
 * Порты карточки подтверждения и перехода между провайдерами: правила
 * «навсегда» проекта в kv плагина, события треда для сводки/дельты.
 */
function consentAndHandoffPorts(bb: BbPluginApi): Pick<RouteDeps, 'projectConsents' | 'saveProjectConsents' | 'threadEvents'> {
  return {
    projectConsents: async projectId => (await bb.storage.kv.get<Consent[]>(CONSENTS_KEY(projectId))) ?? [],
    saveProjectConsents: async (projectId, consents) => { await bb.storage.kv.set(CONSENTS_KEY(projectId), consents); },
    threadEvents: async (threadId, afterSeq) => {
      // Постранично, не больше 4000 событий: сводка всё равно режет ранние.
      const rows: ThreadEventRow[] = [];
      let after = afterSeq;
      for (let page = 0; page < 8; page += 1) {
        const batch = await bb.sdk.threads.events.list({ threadId, afterSeq: String(after), limit: '500', order: 'asc' }) as unknown;
        const items = Array.isArray(batch) ? batch as unknown[] : [];
        for (const item of items) {
          const row = rec(item);
          const seq = Number(row.seq);
          if (Number.isFinite(seq) && typeof row.type === 'string') rows.push({ seq, type: row.type, data: row.data });
        }
        if (items.length < 500 || rows.length === 0) break;
        after = rows[rows.length - 1]!.seq;
      }
      return rows;
    },
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

export interface ExecutorRegistration {
  routes: RouteService;
  /** providerOptions для штатного моста и для нашей обёртки (синхронно, из кэша). */
  deriveProviderOptions(ctx: { threadId: string; model: string; promptMode?: string }): Record<string, unknown>;
  /** Состояние штатных мостов для экрана настроек. */
  nativeBridges(): readonly NativeBridgeStatus[];
  refreshNativeBridges(): Promise<readonly NativeBridgeStatus[]>;
  /** Схема профиля треда для метки ступени. */
  scheme(threadId: string): ReturnType<RouteService['threadScheme']>;
  /** Предупреждения для настроек: мост не найден, версия не читается. */
  issues(): string[];
}

export function registerExecutor(bb: BbPluginApi, deps: ExecutorDeps): ExecutorRegistration {
  const threadProvider = new Map<string, string>();
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
  const timer = setInterval(() => { void refreshNativeBridges().catch(() => {}); }, 10 * 60_000);
  timer.unref?.();

  const threadInfo = async (threadId: string): Promise<ThreadInfo | null> => {
    const raw = rec(await bb.sdk.threads.get({ threadId }));
    const thread = rec(raw.thread ?? raw);
    const environment = rec(raw.environment);
    if (typeof thread.id !== 'string') return null;
    return {
      projectId: String(thread.projectId ?? ''),
      hostId: typeof environment.hostId === 'string' ? environment.hostId : null,
      parentThreadId: typeof thread.parentThreadId === 'string' ? thread.parentThreadId : null,
      providerId: String(thread.providerId ?? ''),
    };
  };

  const routes = createRouteService({
    loadConfig: deps.loadConfig,
    accounts: deps.accounts,
    health: deps.health,
    refreshLimits: async (config, steps) => { await deps.ensureDiscovered(); await deps.refreshLimits(config, steps); },
    observeLimit: (config, step, observation: LimitObservation) => {
      deps.observeLimit(config, step, { type: 'rate_limit_event', rate_limit_info: observation.raw ?? { status: observation.status, resetsAt: observation.resetsAt ? observation.resetsAt / 1000 : undefined, rateLimitType: observation.windowType ?? undefined } });
    },
    threadInfo,
    load: async threadId => bb.storage.kv.get<StoredThreadState>(STATE_KEY(threadId)),
    save: async (threadId, state) => {
      if (state.lastRun) threadProvider.set(threadId, state.lastRun.providerId);
      await bb.storage.kv.set(STATE_KEY(threadId), state);
    },
    sync: deps.sync,
    now: Date.now,
    warn: message => bb.log.warn(message),
    ...consentAndHandoffPorts(bb),
  });

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
    routeTurn: input => routes.routeTurn(input),
    finishTurn: input => routes.finishTurn(input),
    threadStatus: ({ threadId }) => routes.threadStatus(threadId),
    answerConfirmation: input => routes.answerConfirmation(input),
    peekProvider: input => routes.peekProvider(input),
    handoffBrief: input => routes.handoffBrief(input),
    nativeSessions: async ({ threadId, sessions }) => {
      const result = await routes.nativeSessions(threadId, sessions);
      if (result.sessions) threadProvider.set(threadId, result.sessions.active);
      return result;
    },
  }, { experimental_discoverable: true, experimental_description: 'Каскад подписок: паспорт треда (threadStatus), тестовая квота треда (testQuota), ход исполнителя (routeTurn/finishTurn, answerConfirmation, peekProvider, handoffBrief, nativeSessions).' });

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

  bb.cli.register({
    name: 'subscriptions-cascade',
    summary: 'Каскад подписок: паспорт треда и перевод тредов в каскад',
    commands: [
      { name: 'status', summary: 'Ступень, машина и копия файлов треда', usage: 'bb subscriptions-cascade status --thread <id> [--json]' },
      { name: 'test-quota', summary: 'Тестовая квота ступеней для одного треда (сценарии S1–S13)', usage: "bb subscriptions-cascade test-quota --thread <id> [--set '<ступень>=exhausted|ok|unknown|unavailable[,<сброс ISO|+30m>];…'] [--clear] [--json]" },
      { name: 'adopt', summary: 'Перевести треды в каскад (Handoff) и снять автоповтор у исходных', usage: 'bb subscriptions-cascade adopt --stuck|--thread <id>|--project <id> [--dry-run] [--model <профиль>] [--json]' },
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
      if (command === 'adopt') {
        const parsed = parseAdoptArgs(rest);
        if ('error' in parsed) return { exitCode: 2, stderr: `${parsed.error}\n` };
        const options = { ...parsed, providerId: deps.providerId };
        const items = await runAdopt(adoptPorts, options);
        if (rest.includes('--json')) return { exitCode: items.some(i => i.error) ? 1 : 0, stdout: `${JSON.stringify({ dryRun: options.dryRun, items })}\n` };
        return { exitCode: items.some(i => i.error) ? 1 : 0, stdout: formatAdopt(items, options.dryRun) };
      }
      return { exitCode: 2, stderr: 'команды: status, test-quota, adopt\n' };
    },
  });

  return {
    routes,
    deriveProviderOptions(ctx) {
      if (Date.now() - bridgesAt > 10 * 60_000) void refreshNativeBridges().catch(() => {});
      return {
        ...claudeBridgeKnobs(ctx.promptMode),
        requestedModel: ctx.model,
        cascade: { provider: threadProvider.get(ctx.threadId) ?? 'claude-code', digests: digestMap(bridges) },
      };
    },
    nativeBridges: () => bridges,
    scheme: threadId => routes.threadScheme(threadId),
    refreshNativeBridges,
    issues: () => bridges.filter(b => b.problem && b.providerId === 'claude-code').map(b => `Штатный мост Claude Code: ${b.problem}. Каскад не сможет запускать ходы.`),
  };
}
