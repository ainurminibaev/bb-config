// Маршрутизатор хода на сервере плагина: решение движка до запуска CLI,
// синхронизация файлов до и после хода, состояние треда, паспорт треда.
// Все обращения к BB и sync/ — через зависимости: тестируется без SDK.
import type { CascadeConfig, DiscoveredAccount, Step } from '../contract.ts';
import { explainProfile, nextThreadState, selectStep, type Decision, type HealthLookup, type ThreadCascadeState } from '../engine.ts';
import { previewText, usesTestQuota } from '../profiles.ts';
import type {
  FinishTurnInput, LimitObservation, RetryAvailability, RouteNote, RouteTurnInput, RouteTurnOutput, StageLabel, ThreadStatus,
} from './route-contract.ts';
import { finishTurnInputSchema, routeTurnInputSchema } from './route-contract.ts';
import { PrepTracker, type PrepNote } from './prep-progress.ts';
import type { SyncProgressEvent } from '../sync/orchestrator.ts';

/** Ответ sync/ (SyncService.prepareTurn/finishTurn) в нужном здесь объёме. */
export type SyncOutcome =
  | { ok: true; cwd: string; env: Record<string, string>; timings: { step: string; hostId: string; from?: string; to?: string; seconds: number; ok: boolean; detail?: string }[]; notices: string[] }
  | { ok: false; reason: string; message: string; conflicts: string[]; timings: { step: string; hostId: string; from?: string; to?: string; seconds: number; ok: boolean; detail?: string }[]; notices: string[] };

export interface SyncPort {
  /** workspace — рабочая папка треда на опоре (worktree): своя единица синхронизации и блокировка. */
  prepareTurn(thread: { threadId: string; projectId: string; workspace?: string | null }, step: { hostId: string }, progress?: (event: SyncProgressEvent) => void): Promise<SyncOutcome>;
  finishTurn(thread: { threadId: string; projectId: string; workspace?: string | null }, step: { hostId: string }): Promise<SyncOutcome>;
  /** Режим синхронизации проекта для паспорта. */
  modeOf?(config: CascadeConfig, projectId: string): string;
}

export interface ThreadInfo {
  projectId: string;
  /** Машина окружения треда — там работает мост. */
  hostId: string | null;
  parentThreadId: string | null;
  providerId: string;
  environmentId?: string | null;
  /** У треда своя рабочая папка (worktree): true; общий checkout проекта: false; неизвестно: null. */
  isolatedWorkspace?: boolean | null;
}

/** Состояние треда в хранилище плагина: состояние движка + последний ход. */
export interface StoredThreadState {
  engine: ThreadCascadeState;
  profileId: string | null;
  lastRun: { stepId: string; hostId: string; providerId: string; modelId: string | null; at: number } | null;
  /** Ход на машине не-опоре ещё не вернул файлы (finishTurn не прошёл). */
  pendingFlushHostId: string | null;
  /** Рабочая папка треда на опоре (cwd моста, если мост на опоре); null — основная папка проекта. */
  workspace?: string | null;
}

export interface RouteDeps {
  loadConfig(): Promise<CascadeConfig>;
  accounts(): readonly DiscoveredAccount[];
  /** Лимиты, которые движок видит в этом треде (тестовый источник — внутри). */
  health(config: CascadeConfig, threadId: string): HealthLookup;
  /** Освежить лимиты ступеней перед ходом в пределах бюджета. Ошибки не бросает. */
  refreshLimits(config: CascadeConfig, steps: readonly Step[]): Promise<void>;
  /** Событие лимита из потока CLI → монитор лимитов. */
  observeLimit(config: CascadeConfig, step: Step, observation: LimitObservation): void;
  threadInfo(threadId: string): Promise<ThreadInfo | null>;
  load(threadId: string): Promise<StoredThreadState | undefined>;
  save(threadId: string, state: StoredThreadState): Promise<void>;
  sync: SyncPort | null;
  now(): number;
  warn?(message: string): void;
  /** Пауза ожидания занятой рабочей папки (тесты подменяют). */
  sleep?(ms: number): Promise<void>;
  /** Сколько ждать, пока другой живой тред пишет рабочую папку. По умолчанию 10 мин. */
  busyWaitMs?: number;
  /** Повторы шага подготовки при сбое (обрыв SSH, ошибка Mutagen). По умолчанию 2, пауза 5 с. */
  prepRetries?: number;
  prepRetryPauseMs?: number;
}

/** Что сделать владельцу, если ход не начался (рядом со строкой отказа). */
export const REFUSAL_ACTIONS = 'Что сделать: повторите ход · пропустить ступень — выключите её в настройках «Каскада» · настройки: Настройки → Плагины → «Каскад подписок»';

/** «Ход не запущен: Каскад подписок → <источник>: <причина>». */
export function refusalText(source: string, reason: string): string {
  return `Ход не запущен: Каскад подписок → ${source}: ${reason}`;
}

/** Сбои подготовки, после которых ступень пропускается и берётся следующая (конфликт файлов — нет). */
const FALLBACK_REASONS = new Set(['error', 'not-configured', 'unsupported', 'sync-off']);

export const PROVIDER_ID_LOCAL = 'subscriptions-cascade';

function machineLabel(config: CascadeConfig, hostId: string): string {
  return config.machines.find(m => m.hostId === hostId)?.label ?? hostId;
}

function providerLabel(providerId: string): string {
  return providerId === 'claude-code' ? 'Claude' : providerId === 'codex' ? 'Codex' : providerId;
}

export function stageLabel(config: CascadeConfig, target: { stepId: string; hostId: string; providerId: string; modelId: string | null }): StageLabel {
  const step = config.steps.find(s => s.id === target.stepId);
  const model = target.modelId ? config.models.find(r => r.providerId === target.providerId && Object.values(r.cells).some(c => c.modelId === target.modelId))?.displayName ?? target.modelId : undefined;
  return {
    machine: machineLabel(config, target.hostId).slice(0, 80),
    provider: providerLabel(target.providerId),
    ...(step?.label ? { account: step.label.slice(0, 80) } : {}),
    ...(model ? { model: model.slice(0, 80) } : {}),
  };
}

function anchorHostId(config: CascadeConfig): string | null {
  return config.machines.find(m => m.anchor)?.hostId ?? null;
}

function freshState(threadId: string, info: ThreadInfo | null): StoredThreadState {
  return {
    engine: {
      threadId, projectId: info?.projectId ?? '', turnId: '', isSubthread: Boolean(info?.parentThreadId),
      homeHostId: info?.hostId ?? null, currentStepId: null, switchedAt: null, waitingSince: null, consents: [], skippedStepIds: [],
    },
    profileId: null, lastRun: null, pendingFlushHostId: null,
  };
}

function syncNotes(config: CascadeConfig, outcome: SyncOutcome): RouteNote[] {
  const notes: RouteNote[] = [];
  for (const t of outcome.timings) {
    if (t.step !== 'flush' && t.step !== 'align') continue;
    notes.push({ kind: 'sync', from: machineLabel(config, t.from ?? t.hostId), to: machineLabel(config, t.to ?? t.hostId), ms: Math.round(t.seconds * 1000), ok: t.ok, ...(t.detail ? { detail: t.detail.slice(0, 300) } : {}) });
  }
  // Уведомления синхронизации (пропущенные при сканировании пути, карантин,
  // режим symlink) — предупреждением в строке синхронизации, ход не блокируют.
  const notices = outcome.notices.filter(Boolean);
  const last = [...notes].reverse().find(n => n.kind === 'sync');
  if (notices.length && last && last.kind === 'sync') {
    last.detail = [last.detail, ...notices].filter(Boolean).join(' · ').slice(0, 300);
  } else if (notices.length) {
    notes.push({ kind: 'problem', message: `Синхронизация: ${notices.join(' · ')}`.slice(0, 300) });
  }
  return notes;
}

const REFUSE_TEXT: Record<string, string> = {
  'no-steps': 'В профиле нет доступных ступеней (машины выключены или модель не сопоставлена).',
  'profile-disabled': 'Профиль каскада выключен в настройках.',
  'unknown-profile': 'Профиль каскада не найден — выберите модель «Каскада» заново.',
  'unknown-model': 'Модель не найдена в таблице ассоциаций каскада.',
};

export interface RouteService {
  routeTurn(input: RouteTurnInput): Promise<RouteTurnOutput>;
  finishTurn(input: FinishTurnInput): Promise<{ notes: RouteNote[] }>;
  threadStatus(threadId: string): Promise<ThreadStatus>;
  /** Идущая подготовка хода треда для строки ленты; null — не готовится. */
  turnProgress(threadId: string): PrepNote | null;
  /** Ответ provider-retry после ошибки лимита: можно ли повторить ход сейчас (S2, S14). */
  retryAvailability(threadId: string): Promise<RetryAvailability>;
  /** Схема профиля треда для метки ступени (timeline.provideScheme): тот же движок и то же состояние. */
  threadScheme(threadId: string): Promise<{ name: string; text: string; test: boolean; attempts: unknown[]; config: unknown } | null>;
}

export function createRouteService(deps: RouteDeps): RouteService {
  const warn = deps.warn ?? (() => {});
  // Один ход треда за раз: параллельные запуски CLI одного треда (пробы
  // контекста) не должны одновременно двигать синхронизацию.
  const locks = new Map<string, Promise<unknown>>();
  function serial<T>(threadId: string, job: () => Promise<T>): Promise<T> {
    const prev = locks.get(threadId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(job);
    locks.set(threadId, next);
    void next.finally(() => { if (locks.get(threadId) === next) locks.delete(threadId); }).catch(() => {});
    return next;
  }

  let lastConfig: CascadeConfig | null = null;
  const prep = new PrepTracker(deps.now, hostId => (lastConfig ? machineLabel(lastConfig, hostId) : hostId));

  async function routeTurn(raw: RouteTurnInput): Promise<RouteTurnOutput> {
    const input = routeTurnInputSchema.parse(raw);
    return serial(input.threadId, async () => {
      try { return await routeOnce(input, []); } finally { prep.end(input.threadId); }
    });
  }

  /** Решение и подготовка хода; skipped — ступени, пропущенные в этом ходе после сбоя подготовки. */
  async function routeOnce(input: ReturnType<typeof routeTurnInputSchema.parse>, skipped: string[]): Promise<RouteTurnOutput> {
    {
      const config = await deps.loadConfig();
      lastConfig = config;
      const info = await deps.threadInfo(input.threadId).catch(() => null);
      const stored = (await deps.load(input.threadId).catch(() => undefined)) ?? freshState(input.threadId, info);
      const now = deps.now();
      const profileId = input.requestedModel ?? stored.profileId ?? config.profiles.find(p => p.enabled)?.id ?? 'auto';
      const projectId = input.projectId ?? info?.projectId ?? stored.engine.projectId;
      const bridgeHost = info?.hostId ?? stored.engine.homeHostId;

      // Проба моста (без сохранения сессии): там же, где прошлый ход; без синхронизации.
      if (input.probe && stored.lastRun) {
        const last = stored.lastRun;
        return {
          action: 'run', stepId: last.stepId, hostId: last.hostId, providerId: last.providerId, modelId: last.modelId,
          local: bridgeHost !== null && last.hostId === bridgeHost, cwd: null, env: {}, stage: stageLabel(config, last), notes: [],
        };
      }

      if (config.policies.executionMode !== 'provider') {
        const message = refusalText('настройки', 'каскад выключен (режим исполнения «Выключено»). Включите «Свой провайдер» в «Дополнительно» или выберите штатный провайдер.');
        return { action: 'refuse', retryable: false, message, notes: [{ kind: 'problem', message: message.slice(0, 300), note: REFUSAL_ACTIONS }] };
      }

      const plannedSteps = config.steps.filter(s => s.enabled);
      await deps.refreshLimits(config, plannedSteps).catch(error => warn(`лимиты перед ходом: ${String(error)}`));
      const engine: ThreadCascadeState = { ...stored.engine, projectId, homeHostId: stored.engine.homeHostId ?? bridgeHost, turnId: `turn-${now}` };
      // Ступени, на которых подготовка этого хода уже не удалась, в выбор не идут (сохраняется прежнее состояние).
      const decision: Decision = selectStep({
        config, requestedModel: profileId, accounts: deps.accounts(), thread: { ...engine, skippedStepIds: [...engine.skippedStepIds, ...skipped] }, health: deps.health(config, input.threadId), now,
      });

      const save = (next: StoredThreadState) => deps.save(input.threadId, next).catch(error => warn(`состояние треда: ${String(error)}`));

      if (decision.kind === 'unavailable') {
        const message = refusalText('настройки', REFUSE_TEXT[decision.reason] ?? 'не найдена ступень для хода.');
        return { action: 'refuse', retryable: false, message, notes: [{ kind: 'problem', message: message.slice(0, 300), note: REFUSAL_ACTIONS }] };
      }
      if (decision.kind === 'wait') {
        await save({ ...stored, profileId, engine: nextThreadState(engine, decision, now) });
        const note = decision.reason === 'exhausted' ? 'Лимиты исчерпаны на всех ступенях — жду сброса.' : 'Квота ступеней неизвестна — перепроверю позже.';
        return { action: 'refuse', retryable: true, message: refusalText('лимиты', `${note} До ${new Date(decision.until).toISOString()}.`), notes: [{ kind: 'wait', cause: decision.reason === 'exhausted' ? 'reset' : 'recheck', until: decision.until, note, ...(decision.stepId ? { stepId: decision.stepId } : {}) }] };
      }
      if (decision.kind === 'ask-owner') {
        const message = decision.reason === 'wait-too-long'
          ? 'Все ступени исчерпаны, а ближайший сброс позже порога ожидания — нужен ваш выбор.'
          : 'Все ступени недоступны, срок сброса неизвестен — нужен ваш выбор.';
        const text = refusalText('лимиты', message);
        return { action: 'refuse', retryable: false, message: text, notes: [{ kind: 'problem', message: text.slice(0, 300), note: REFUSAL_ACTIONS }] };
      }
      if (decision.kind === 'confirm') {
        // Карточка подтверждения (timeline/) показывается мостом; пока она не
        // подключена — ход останавливается с понятной причиной, без перехода.
        const to = stageLabel(config, decision);
        const message = refusalText('подтверждение', `переход на ${to.machine} · ${to.provider ?? ''} требует подтверждения владельца.`);
        return { action: 'refuse', retryable: false, message, notes: [{ kind: 'problem', message: message.slice(0, 300), stage: to, stepId: decision.stepId, note: REFUSAL_ACTIONS }] };
      }

      // decision.kind === 'run'
      const notes: RouteNote[] = [];
      const to = stageLabel(config, decision);
      if (!input.probe && decision.providerId !== input.provider) {
        // Другой провайдер (Claude ↔ Codex): нужна новая нативная сессия со сводкой
        // (bridge/context-brief.ts). Запуск чужого CLI внутри сессии штатного моста
        // этой версией не поддержан — ход останавливается с понятной причиной.
        const message = `Следующая ступень — ${to.provider ?? decision.providerId} на ${to.machine}: переход между провайдерами в этой версии каскада ещё не исполняется. Выберите профиль только с ${input.provider === 'codex' ? 'Codex' : 'Claude'} или дождитесь сброса лимита.`;
        return { action: 'refuse', retryable: false, message, notes: [{ kind: 'problem', message: message.slice(0, 300), stage: to, stepId: decision.stepId }] };
      }
      const prev = stored.lastRun;
      const local = bridgeHost !== null && decision.hostId === bridgeHost;
      const fromStage = prev ? stageLabel(config, prev) : null;
      const fromHealth = prev ? deps.health(config, input.threadId)(prev.stepId, prev.modelId) : null;
      const switchReason = skipped.length > 0 ? 'unavailable' : prev === null ? 'start' : decision.returning ? 'return' : fromHealth?.exhausted ? 'limit' : fromHealth && !fromHealth.available ? 'unavailable' : 'error';
      if (decision.switched || prev === null && !local || skipped.length > 0) {
        notes.push({ kind: 'switch', reason: switchReason, from: fromStage, to, resetAt: fromHealth?.resetsAt ?? null, stepId: decision.stepId });
      }

      let cwd: string | null = null;
      let env: Record<string, string> = {};
      const anchor = anchorHostId(config);
      // Опора на чужой машине (мост не на опоре) тоже готовится через sync: так ход
      // получает папку проекта на опоре, а не путь машины моста.
      const needsSync = deps.sync !== null && projectId !== '' && (decision.hostId !== anchor || stored.pendingFlushHostId !== null || !local);
      // Единица синхронизации — рабочая папка треда (cwd моста), а не папка проекта:
      // ход треда никогда не пишет в чужой checkout. Мост на опоре — его cwd и есть
      // папка на опоре. Определить её нельзя — отказ, а не основная папка проекта.
      const workspace = bridgeHost !== null && bridgeHost === anchor ? input.cwd : null;
      if (needsSync) {
        const unknownWorkspace = bridgeHost === null
          ? 'машина треда не определена (нет окружения треда)'
          : bridgeHost !== anchor && info?.isolatedWorkspace !== false
            ? `рабочая папка треда на ${machineLabel(config, bridgeHost)}, а синхронизация идёт от опоры ${anchor ? machineLabel(config, anchor) : '—'}: отдельный worktree не на опоре пока не синхронизируется`
            : null;
        if (unknownWorkspace) {
          const message = refusalText('синхронизация', `рабочая папка треда не определена — ${unknownWorkspace}. Чужую папку ход не трогает.`);
          return { action: 'refuse', retryable: false, message, notes: [...notes, { kind: 'problem', message: message.slice(0, 300), stage: to, stepId: decision.stepId, note: REFUSAL_ACTIONS }] };
        }
        // Строка подготовки в ленте: запускатель опрашивает turnProgress, пока ждёт решения.
        prep.begin(input.threadId, { reason: switchReason, from: fromStage, to, stepId: decision.stepId });
        const prepareOnce = () => deps.sync!.prepareTurn({ threadId: input.threadId, projectId, workspace }, { hostId: decision.hostId }, event => prep.event(input.threadId, event)).catch(error => ({
          ok: false as const, reason: 'error', message: error instanceof Error ? error.message : String(error), conflicts: [], timings: [], notices: [],
        }));
        const sleep = deps.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
        // Сбой шага (обрыв SSH, ошибка Mutagen, машина уснула) — повтор с паузой, без молчаливого ожидания.
        const retries = deps.prepRetries ?? 2;
        const prepare = async (): Promise<SyncOutcome> => {
          let result: SyncOutcome = await prepareOnce();
          for (let attempt = 1; attempt <= retries && !result.ok && result.reason === 'error'; attempt += 1) {
            prep.attempt(input.threadId, `повтор ${attempt + 1}/${retries + 1}: ${result.message.slice(0, 100)}`);
            await sleep(deps.prepRetryPauseMs ?? 5_000);
            result = await prepareOnce();
          }
          prep.attempt(input.threadId, null);
          return result;
        };
        let outcome: SyncOutcome = await prepare();
        // Папку пишет другой живой тред: ждём его конца с таймаутом, а не роняем ход.
        const waitStarted = deps.now();
        const busyWaitMs = deps.busyWaitMs ?? 10 * 60_000;
        while (!outcome.ok && outcome.reason === 'busy' && deps.now() - waitStarted < busyWaitMs) {
          prep.attempt(input.threadId, `жду освобождения рабочей папки · ${Math.round((deps.now() - waitStarted) / 1000)} с`);
          await sleep(10_000);
          outcome = await prepare();
        }
        const waited = deps.now() - waitStarted;
        if (!outcome.ok && outcome.reason === 'busy') {
          const message = `${refusalText(`синхронизация ${to.machine}`, outcome.message)} — не освободилась за ${Math.round(waited / 60_000)} мин. Повторите ход, когда тот тред закончит.`;
          notes.push(...syncNotes(config, outcome), { kind: 'problem', message: message.slice(0, 300), stage: to, stepId: decision.stepId, note: REFUSAL_ACTIONS });
          return { action: 'refuse', retryable: true, message, notes };
        }
        if (waited >= 10_000) notes.push({ kind: 'wait', cause: 'recheck', until: null, note: `Ждал освобождения рабочей папки ${Math.round(waited / 1000)} с`, stepId: decision.stepId });
        notes.push(...syncNotes(config, outcome));
        if (!outcome.ok) {
          // Подготовка на этой ступени не удалась и не из-за конфликта файлов:
          // ступень пропускается в этом ходе, берётся следующая разрешённая (сколько ни есть).
          if (FALLBACK_REASONS.has(outcome.reason) && skipped.length < config.steps.length) {
            const skipNote: RouteNote = { kind: 'problem', message: `${to.machine}: подготовка не удалась (${outcome.message.slice(0, 200)}) — ступень пропущена, беру следующую`.slice(0, 300), stage: to, stepId: decision.stepId };
            prep.attempt(input.threadId, `${to.machine} пропущена → следующая ступень`);
            const next = await routeOnce(input, [...skipped, decision.stepId]);
            if (next.action === 'run') return { ...next, notes: [...notes, skipNote, ...next.notes] };
          }
          const message = refusalText(`синхронизация ${to.machine}`, outcome.message);
          notes.push({ kind: 'problem', message: message.slice(0, 300), stage: to, stepId: decision.stepId, note: REFUSAL_ACTIONS });
          // Ход не передан (S9): ступень и состояние треда не меняются.
          return { action: 'refuse', retryable: false, message, notes };
        }
        if (!local) cwd = outcome.cwd;
        env = outcome.env;
      }

      if (!local && cwd === null) {
        // Чужая машина без общего пути: папки моста там нет (ENOENT при запуске).
        const why = projectId === '' ? 'проект треда не определён' : deps.sync === null ? 'синхронизация файлов недоступна' : 'общий путь проекта не подготовлен';
        const message = refusalText('маршрут', `ход на ${to.machine}: ${why}. Проверьте «Файлы» и «Машины» в настройках каскада.`);
        notes.push({ kind: 'problem', message: message.slice(0, 300), stage: to, stepId: decision.stepId, note: REFUSAL_ACTIONS });
        return { action: 'refuse', retryable: false, message, notes };
      }
      notes.push({ kind: 'run', stage: to, stepId: decision.stepId });
      notes.push({ kind: 'state', phase: 'running', stage: to, stepId: decision.stepId, profileId });
      await save({
        ...stored, profileId,
        engine: nextThreadState(engine, decision, now),
        lastRun: { stepId: decision.stepId, hostId: decision.hostId, providerId: decision.providerId, modelId: decision.modelId, at: now },
        pendingFlushHostId: decision.hostId !== anchor && needsSync ? decision.hostId : stored.pendingFlushHostId,
        workspace,
      });
      return { action: 'run', stepId: decision.stepId, hostId: decision.hostId, providerId: decision.providerId, modelId: decision.modelId, local, cwd, env, stage: to, notes };
    }
  }

  async function finishTurn(raw: FinishTurnInput): Promise<{ notes: RouteNote[] }> {
    const input = finishTurnInputSchema.parse(raw);
    return serial(input.threadId, async () => {
      const config = await deps.loadConfig();
      const step = config.steps.find(s => s.id === input.stepId);
      for (const observation of input.limits) if (step) deps.observeLimit(config, step, observation);
      const notes: RouteNote[] = [];
      if (input.probe) return { notes };
      const stored = await deps.load(input.threadId).catch(() => undefined);
      const projectId = input.projectId ?? stored?.engine.projectId ?? '';
      const anchor = anchorHostId(config);
      if (deps.sync && projectId && input.hostId !== anchor && stored?.pendingFlushHostId === input.hostId) {
        const outcome = await deps.sync.finishTurn({ threadId: input.threadId, projectId, workspace: stored.workspace ?? null }, { hostId: input.hostId }).catch(error => ({
          ok: false as const, reason: 'error', message: error instanceof Error ? error.message : String(error), conflicts: [], timings: [], notices: [],
        }));
        notes.push(...syncNotes(config, outcome));
        if (outcome.ok) await deps.save(input.threadId, { ...stored, pendingFlushHostId: null }).catch(() => {});
        else notes.push({ kind: 'problem', message: `Файлы после хода не вернулись на опору: ${outcome.message}`.slice(0, 300), stepId: input.stepId });
      }
      const rejected = input.limits.find(l => l.status === 'rejected');
      if (rejected) notes.push({ kind: 'problem', message: `Лимит ступени исчерпан${rejected.resetsAt ? ` до ${new Date(rejected.resetsAt).toISOString()}` : ''} — следующий ход пойдёт на следующую ступень.`, stepId: input.stepId });
      if (input.transportError) notes.push({ kind: 'problem', message: `Связь с машиной ступени: ${input.transportError}`.slice(0, 300), stepId: input.stepId });
      notes.push({ kind: 'state', phase: 'idle', stage: step ? stageLabel(config, { stepId: step.id, hostId: step.hostId, providerId: step.providerId, modelId: stored?.lastRun?.modelId ?? null }) : null, stepId: input.stepId });
      return { notes };
    });
  }

  async function threadStatus(threadId: string): Promise<ThreadStatus> {
    const [config, info, stored] = await Promise.all([
      deps.loadConfig(), deps.threadInfo(threadId).catch(() => null), deps.load(threadId).catch(() => undefined),
    ]);
    if (info && info.providerId !== PROVIDER_ID_LOCAL && !stored) return { cascade: false };
    if (!info && !stored) return { cascade: false };
    const last = stored?.lastRun ?? null;
    const step = last ? config.steps.find(s => s.id === last.stepId) : undefined;
    const anchor = anchorHostId(config);
    const projectId = info?.projectId ?? stored?.engine.projectId ?? '';
    const machine = config.machines.find(m => m.hostId === (anchor ?? ''));
    return {
      cascade: true,
      profileId: stored?.profileId ?? null,
      step: last ? {
        hostId: last.hostId, providerId: last.providerId, model: last.modelId,
        accountKey: step?.account ?? null, kind: step?.authority ?? 'subscription',
      } : null,
      anchorHostId: anchor,
      syncMode: deps.sync?.modeOf?.(config, projectId) ?? config.files.projectSyncModes[projectId] ?? config.files.defaultSyncMode,
      path: machine ? machine.sharedPath : null,
      freshCopyHostId: stored?.pendingFlushHostId ?? anchor,
    };
  }

  async function threadScheme(threadId: string) {
    const [config, stored] = await Promise.all([deps.loadConfig(), deps.load(threadId).catch(() => undefined)]);
    if (!stored) return null;
    const profileId = stored.profileId ?? config.profiles.find(p => p.enabled)?.id ?? 'auto';
    const now = deps.now();
    const explained = explainProfile({ config, requestedModel: profileId, accounts: deps.accounts(), thread: stored.engine, health: deps.health(config, threadId), now });
    const profile = config.profiles.find(p => p.id === profileId);
    return {
      name: profile?.name ?? profileId,
      text: previewText(config, explained.decision, explained.attempts, now),
      test: usesTestQuota(config, threadId),
      attempts: explained.attempts,
      config,
    };
  }

  async function retryAvailability(threadId: string): Promise<RetryAvailability> {
    const [config, info, stored] = await Promise.all([
      deps.loadConfig(), deps.threadInfo(threadId).catch(() => null), deps.load(threadId).catch(() => undefined),
    ]);
    // Чужой тред (штатный Claude/Codex) — политика provider-retry не меняется.
    if (info ? info.providerId !== PROVIDER_ID_LOCAL : !stored) return { kind: 'not-routed' };
    if (config.policies.executionMode !== 'provider') return { kind: 'not-routed' };
    const now = deps.now();
    await deps.refreshLimits(config, config.steps.filter(s => s.enabled)).catch(() => {});
    const base = stored ?? freshState(threadId, info);
    const decision = selectStep({
      config, requestedModel: base.profileId ?? config.profiles.find(p => p.enabled)?.id ?? 'auto', accounts: deps.accounts(),
      thread: { ...base.engine, turnId: `retry-${now}` }, health: deps.health(config, threadId), now,
    });
    switch (decision.kind) {
      case 'run':
      case 'confirm': return { kind: 'ready' };
      case 'wait': return decision.reason === 'exhausted' ? { kind: 'blocked', retryAt: Math.max(now, Math.round(decision.until)) } : { kind: 'unavailable', reason: 'reset-unknown' };
      // Ждать дольше порога или сброс неизвестен — решает владелец, автоповтора нет.
      case 'ask-owner': return { kind: 'unavailable', reason: 'reset-unknown' };
      default: return { kind: 'unavailable', reason: 'no-enabled-account' };
    }
  }

  return { routeTurn, finishTurn, threadStatus, threadScheme, retryAvailability, turnProgress: threadId => prep.note(threadId) };
}
