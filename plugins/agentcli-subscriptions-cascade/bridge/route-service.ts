// Маршрутизатор хода на сервере плагина: решение движка до запуска CLI,
// синхронизация файлов до и после хода, состояние треда, паспорт треда.
// Все обращения к BB и sync/ — через зависимости: тестируется без SDK.
import { bindingEpoch } from '../config.ts';
import { grant, pruneConsents, type Consent } from '../consent.ts';
import type { CascadeConfig, DiscoveredAccount, Step } from '../contract.ts';
import { explainProfile, nextThreadState, selectStep, type Decision, type HealthLookup, type ThreadCascadeState } from '../engine.ts';
import { previewText, usesTestQuota } from '../profiles.ts';
import { buildHandoff, type ThreadEventRow } from './handoff.ts';
import type {
  AnswerConfirmationInput, AnswerConfirmationOutput, ConfirmPrompt, FinishTurnInput, LimitObservation, NativeProvider, NativeSessions,
  RetryAvailability, RouteNote, RouteTurnInput, RouteTurnOutput, StageLabel, ThreadStatus,
} from './route-contract.ts';
import { answerConfirmationInputSchema, finishTurnInputSchema, handoffBriefInputSchema, nativeSessionsSchema, routeTurnInputSchema } from './route-contract.ts';
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
  /**
   * Лимит, полученный в самом ходе (rate_limit_event rejected, «You've hit your
   * weekly limit»): stepId → до когда ступень исчерпана. Главнее тестовой квоты
   * и показаний монитора, пока не прошёл срок.
   */
  observed?: Record<string, { until: number; at: number }> | null;
  /** Модель недоступна на аккаунте ступени: `stepId|modelId` → до когда и почему. */
  modelBlocks?: Record<string, { until: number; reason: string }> | null;
  /**
   * Согласие «на этот ход», которое должно пережить автоповтор того же хода
   * (смена провайдера внутри хода): ступень и срок; используется один раз.
   */
  carryConsent?: { stepId: string; until: number } | null;
  /** Ход, к которому относятся «Пропустить ступень» (skippedStepIds); у нового хода пропуски сброшены. */
  skipTurnKey?: string | null;
  /** Нативные сессии треда по провайдерам (переход Claude ↔ Codex). */
  native?: NativeSessions | null;
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
  /** Бюджет ответа provider-retry (его таймаут — 5 с). По умолчанию 1,5 с. */
  availabilityBudgetMs?: number;
  /** Пауза ожидания занятой рабочей папки (тесты подменяют). */
  sleep?(ms: number): Promise<void>;
  /** Сколько ждать, пока другой живой тред пишет рабочую папку. По умолчанию 10 мин. */
  busyWaitMs?: number;
  /** Повторы шага подготовки при сбое (обрыв SSH, ошибка Mutagen). По умолчанию 2, пауза 5 с. */
  prepRetries?: number;
  prepRetryPauseMs?: number;
  /**
   * Ленивая настройка машины ступени при первом ходе (мастер без шагов, требующих
   * согласия). consent — текст разрешения, если без него не обойтись.
   */
  /** Пометить ячейку модели × машина недоступной (видно в таблице моделей). */
  blockModel?(hostId: string, modelId: string, reason: string): Promise<void>;
  ensureMachine?(hostId: string): Promise<{ ok: boolean; message: string; consent: string | null }>;
  /** Постоянные правила «навсегда» проекта (карточка подтверждения). Нет порта — правил нет. */
  projectConsents?(projectId: string): Promise<Consent[]>;
  saveProjectConsents?(projectId: string, consents: Consent[]): Promise<void>;
  /** События треда после seq (по возрастанию) — для сводки и дельты другой нативной сессии. */
  threadEvents?(threadId: string, afterSeq: number): Promise<ThreadEventRow[]>;
}

/** Что сделать владельцу, если ход не начался (рядом со строкой отказа). */
export const REFUSAL_ACTIONS = 'Что сделать: повторите ход · пропустить ступень — выключите её в настройках «Каскада» · Настроить: Настройки → Плагины → «Каскад подписок» → «Настроить» или bb subscriptions-cascade setup';

/** «Ход не запущен: Каскад подписок → <источник>: <причина>». */
export function refusalText(source: string, reason: string): string {
  return `Ход не запущен: Каскад подписок → ${source}: ${reason}`;
}

/** Ошибка прежнего экземпляра плагина после переустановки. */
export const RETIRED = /generation \S+ is retired|stale API handle|was reloaded or disabled/iu;

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

const utcTime = (at: number) => `${new Date(at).toISOString().slice(11, 16)} UTC`;

/** Причина в карточке подтверждения: коротко, без точки. */
function confirmReason(decision: Extract<Decision, { kind: 'confirm' }>, from: StageLabel | null): string {
  if (decision.continuing) return 'разовое согласие на прошлый ход закончилось';
  if (from && decision.triggerResetAt !== null) return `лимит ${from.machine} исчерпан до ${utcTime(decision.triggerResetAt)}`;
  if (from) return `${from.machine} сейчас недоступна`;
  return 'ступень спрашивает подтверждение при входе';
}

/** Ступень без известного сброса после исчерпания в ходе считается исчерпанной столько. */
export const OBSERVED_UNKNOWN_RESET_MS = 60 * 60_000;

/** Лимиты треда с учётом исчерпаний, полученных в его ходах. */
export function withObserved(base: HealthLookup, observed: StoredThreadState['observed'], now: number, modelBlocks: StoredThreadState['modelBlocks'] = null): HealthLookup {
  if (!observed && !modelBlocks) return base;
  return (stepId, modelId) => {
    const blocked = modelBlocks?.[`${stepId}|${modelId}`];
    if (blocked && now < blocked.until) return { available: false, exhausted: false, unknown: false, resetsAt: null, reason: `модель недоступна: ${blocked.reason}` };
    const mark = observed?.[stepId];
    if (mark && now < mark.until) return { available: true, exhausted: true, unknown: false, resetsAt: mark.until, reason: 'исчерпан в ходе' };
    return base(stepId, modelId);
  };
}

/** Новые отметки исчерпания из событий лимита хода; устаревшие убираются. */
export function mergeObserved(prev: StoredThreadState['observed'], stepId: string, limits: readonly LimitObservation[], now: number): StoredThreadState['observed'] {
  const out: Record<string, { until: number; at: number }> = {};
  for (const [id, mark] of Object.entries(prev ?? {})) if (now < mark.until) out[id] = mark;
  const rejected = limits.filter(l => l.status === 'rejected');
  if (rejected.length > 0) {
    const resets = rejected.map(l => l.resetsAt).filter((t): t is number => t !== null && t > now);
    out[stepId] = { until: resets.length ? Math.max(...resets) : now + OBSERVED_UNKNOWN_RESET_MS, at: now };
  } else if (limits.some(l => l.status === 'allowed' || l.status === 'allowed_warning')) {
    delete out[stepId]; // ступень снова отвечает — отметка снята
  }
  return Object.keys(out).length ? out : null;
}

export interface RouteService {
  routeTurn(input: RouteTurnInput): Promise<RouteTurnOutput>;
  finishTurn(input: FinishTurnInput): Promise<{ notes: RouteNote[] }>;
  /** Ответ карточки подтверждения: согласие со сроком, пропуск ступени, ожидание, отмена. */
  answerConfirmation(input: AnswerConfirmationInput): Promise<AnswerConfirmationOutput>;
  /** Провайдер следующего хода без побочных эффектов (мост выбирает штатный мост). */
  peekProvider(input: { threadId: string; projectId?: string | null; requestedModel?: string | null }): Promise<{ providerId: NativeProvider | null; modelId: string | null; stage: StageLabel | null }>;
  /** Сводка или дельта для другой нативной сессии треда. */
  handoffBrief(input: { threadId: string; afterSeq: number; mode: 'snapshot' | 'delta'; from: string; to: string; currentRequestId?: string | null }): Promise<{ text: string; throughSeq: number }>;
  /** Нативные сессии треда: чтение (sessions = null) и запись. */
  nativeSessions(threadId: string, sessions: NativeSessions | null): Promise<{ sessions: NativeSessions | null }>;
  threadStatus(threadId: string): Promise<ThreadStatus>;
  /** Идущая подготовка хода треда для строки ленты; null — не готовится. */
  turnProgress(threadId: string): PrepNote | null;
  /** Модель недоступна на аккаунте ступени («requires usage credits»). */
  turnModelUnavailable(input: { threadId: string; stepId: string; modelId: string | null; reason: string }): Promise<{ ok: boolean }>;
  /** Лимит, полученный в ходе: ступень помечается исчерпанной сразу. */
  turnLimits(input: { threadId: string; stepId: string; limits: LimitObservation[] }): Promise<{ exhausted: boolean }>;
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
  async function projectConsentsOf(projectId: string): Promise<Consent[]> {
    if (!projectId || !deps.projectConsents) return [];
    return deps.projectConsents(projectId).catch(error => { warn(`правила «навсегда»: ${String(error)}`); return []; });
  }

  /** Машина дома треда: у подтреда — машина родителя; у обычного — машина моста. */
  async function homeOf(info: ThreadInfo | null, stored: StoredThreadState, bridgeHost: string | null): Promise<{ hostId: string | null; refuse: boolean }> {
    if (!info?.parentThreadId) return { hostId: stored.engine.homeHostId ?? bridgeHost, refuse: false };
    const parent = await deps.threadInfo(info.parentThreadId).catch(() => null);
    const hostId = parent?.hostId ?? info.hostId ?? null;
    return { hostId, refuse: hostId === null };
  }

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
      // S11: дом подтреда — машина родителя (каждый ход заново: прежнее состояние могло
      // сохранить пустую машину). Неизвестна — подтред не тратит чужие лимиты: отказ.
      const home = await homeOf(info, stored, bridgeHost);
      if (home.refuse && !config.policies.subthreadsUseOtherMachines) {
        const message = refusalText('подтреды', `машина родителя не определена, а «Подтреды могут тратить лимит других машин» выключено — ход не уходит на чужую машину.`);
        return { action: 'refuse', retryable: true, message, notes: [{ kind: 'problem', message: message.slice(0, 300), note: REFUSAL_ACTIONS }] };
      }
      // «Пропустить ступень» действует только на свой ход (тот же turnKey); ступени, на которых
      // подготовка этого хода не удалась, тоже не идут в выбор.
      const cardSkipped = input.turnKey !== null && stored.skipTurnKey === input.turnKey ? stored.engine.skippedStepIds : [];
      const engine: ThreadCascadeState = {
        ...stored.engine, projectId, isSubthread: Boolean(info?.parentThreadId) || stored.engine.isSubthread, homeHostId: home.hostId,
        turnId: input.turnKey ?? `turn-${now}`, skippedStepIds: cardSkipped,
      };
      const forever = await projectConsentsOf(projectId);
      // Согласие «на ход», данное до автоповтора (смена провайдера внутри хода), — и на повтор.
      const carry = stored.carryConsent && stored.carryConsent.until > now ? config.steps.find(st => st.id === stored.carryConsent!.stepId) : undefined;
      if (carry) forever.push(grant('turn', { stepId: carry.id, bindingEpoch: bindingEpoch(carry), threadId: input.threadId, turnId: engine.turnId, projectId, now }, null));
      const decision: Decision = selectStep({
        config, requestedModel: profileId, accounts: deps.accounts(), thread: { ...engine, skippedStepIds: [...cardSkipped, ...skipped], consents: [...engine.consents, ...forever] }, health: withObserved(deps.health(config, input.threadId), stored.observed, now, stored.modelBlocks), now,
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
        // Карточка подтверждения: её показывает исполнитель (мост, timeline/
        // requestConfirmation) в этом же ходе; ответ — answerConfirmation, затем routeTurn снова.
        const to = stageLabel(config, decision);
        const prev = stored.lastRun;
        const from = prev ? stageLabel(config, prev) : null;
        const order = (stepId: string) => config.steps.findIndex(s => s.id === stepId);
        const crossProvider = prev !== null && prev.providerId !== decision.providerId;
        const nativeSession = stored.native?.sessions[decision.providerId];
        const prompt: ConfirmPrompt = {
          stepId: decision.stepId,
          continuing: decision.continuing,
          returning: prev !== null && !decision.continuing && order(decision.stepId) < order(prev.stepId),
          from: decision.continuing ? null : from,
          to,
          reason: confirmReason(decision, from).slice(0, 300),
          handoff: crossProvider
            ? (nativeSession ? `${providerLabel(decision.providerId)}: прежняя сессия + события треда после неё` : `${providerLabel(decision.providerId)}: новая сессия со сводкой треда`)
            : null,
          threadUntil: decision.triggerResetAt,
          allowForever: true,
        };
        return { action: 'confirm', prompt, providerId: decision.providerId, notes: [{ kind: 'state', phase: 'waiting', stage: to, stepId: decision.stepId, profileId }] };
      }

      // decision.kind === 'run'
      const notes: RouteNote[] = [];
      const to = stageLabel(config, decision);
      if (!input.probe && decision.providerId !== input.provider) {
        // Другой провайдер (Claude ↔ Codex): его ход ведёт штатный мост другого
        // провайдера со своей нативной сессией — мост каскада переключает его на
        // turn/start (peekProvider). Сюда попадает только гонка (например,
        // «Пропустить ступень» в карточке привёл к ступени другого провайдера):
        // ход не идёт, следующее сообщение мост отдаст нужному провайдеру.
        // Ход уже в мосту другого провайдера: отказ уходит штатному мосту как лимит,
        // provider-retry спрашивает доступность (ready) и повторяет ход — мост каскада
        // отдаёт повтор мосту ${decision.providerId}; согласие на ступень переживает повтор.
        const message = `Переход на ${to.provider ?? decision.providerId} · ${to.machine}: ход повторится автоматически уже на ${to.provider ?? decision.providerId}.`;
        await save({ ...stored, carryConsent: stored.carryConsent && stored.carryConsent.stepId === decision.stepId ? stored.carryConsent : null });
        return { action: 'refuse', retryable: true, retryAs: 'limit', message, notes: [{ kind: 'switch', reason: 'limit', from: stored.lastRun ? stageLabel(config, stored.lastRun) : null, to, stepId: decision.stepId }] };
      }
      const prev = stored.lastRun;
      const local = bridgeHost !== null && decision.hostId === bridgeHost;
      const fromStage = prev ? stageLabel(config, prev) : null;
      const fromHealth = prev ? withObserved(deps.health(config, input.threadId), stored.observed, now)(prev.stepId, prev.modelId) : null;
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
        let consentNeeded: { machine: string; hostId: string; text: string } | null = null;
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
        // Плагин переустановлен посреди подготовки: прежний экземпляр больше не может звать
        // машины. Повтор хода штатным автоповтором уже на новой версии.
        if (!outcome.ok && RETIRED.test(outcome.message)) {
          const message = 'Плагин «Каскад подписок» обновился во время подготовки хода — ход повторится автоматически на новой версии.';
          return { action: 'refuse', retryable: true, retryAs: 'overload', message, notes: [{ kind: 'problem', message, stage: to, stepId: decision.stepId }] };
        }
        // Машина не настроена (нет SSH, Mutagen, папки) — недостающие шаги мастера сейчас, затем ещё раз.
        if (!outcome.ok && (outcome.reason === 'not-configured' || outcome.reason === 'error') && deps.ensureMachine) {
          prep.attempt(input.threadId, `настройка ${to.machine}: мастер`);
          const ensured = await deps.ensureMachine(decision.hostId).catch((error: unknown) => ({ ok: false, message: String(error), consent: null as string | null }));
          if (ensured.ok) outcome = await prepare();
          else if (ensured.consent) {
            outcome = { ok: false, reason: 'not-configured', message: `Нужно разрешение: ${ensured.consent}`, conflicts: [], timings: [], notices: [] };
            consentNeeded = { machine: to.machine, hostId: decision.hostId, text: ensured.consent };
          } else outcome = { ...outcome, message: `${outcome.message} · мастер: ${ensured.message}`.slice(0, 600) };
        }
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
            const skipNote: RouteNote = consentNeeded
              ? { kind: 'problem', message: `Нужно разрешение для ${consentNeeded.machine} — ступень пропущена в этом ходе`, stage: to, stepId: decision.stepId, note: `${consentNeeded.text} Разрешить: Настройки → «Каскад подписок» → Машины → «Настроить» или bb subscriptions-cascade setup --machine ${consentNeeded.machine} --allow-ssh`.slice(0, 300) }
              : { kind: 'problem', message: `${to.machine}: подготовка не удалась (${outcome.message.slice(0, 200)}) — ступень пропущена, беру следующую`.slice(0, 300), stage: to, stepId: decision.stepId };
            prep.attempt(input.threadId, `${to.machine} пропущена → следующая ступень`);
            const next = await routeOnce(input, [...skipped, decision.stepId]);
            if (next.action === 'run') return { ...next, notes: [...notes, skipNote, ...next.notes] };
          }
          const message = refusalText(`синхронизация ${to.machine}`, outcome.message);
          notes.push({ kind: 'problem', message: message.slice(0, 300), stage: to, stepId: decision.stepId, note: consentNeeded ? `Разрешить: bb subscriptions-cascade setup --machine ${consentNeeded.machine} --allow-ssh · или Настройки → «Каскад подписок» → «Настроить»` : REFUSAL_ACTIONS });
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
        carryConsent: stored.carryConsent && stored.carryConsent.stepId === decision.stepId ? null : stored.carryConsent ?? null,
      });
      return { action: 'run', stepId: decision.stepId, hostId: decision.hostId, providerId: decision.providerId, modelId: decision.modelId, local, cwd, env, stage: to, notes };
    }
  }

  /** Модель недоступна на аккаунте ступени: попытка ступень × модель снимается на сутки. */
  async function turnModelUnavailable(input: { threadId: string; stepId: string; modelId: string | null; reason: string }): Promise<{ ok: boolean }> {
    return serial(input.threadId, async () => {
      const stored = await deps.load(input.threadId).catch(() => undefined);
      if (!stored) return { ok: false };
      const now = deps.now();
      const blocks = Object.fromEntries(Object.entries(stored.modelBlocks ?? {}).filter(([, b]) => b.until > now));
      blocks[`${input.stepId}|${input.modelId}`] = { until: now + 24 * 3_600_000, reason: input.reason.slice(0, 200) };
      await deps.save(input.threadId, { ...stored, modelBlocks: blocks });
      const config = await deps.loadConfig();
      const step = config.steps.find(st => st.id === input.stepId);
      if (step && input.modelId) await deps.blockModel?.(step.hostId, input.modelId, input.reason).catch(() => undefined);
      return { ok: true };
    });
  }

  /** Быстрая отметка лимита сразу по концу хода (до ответа мосту): provider-retry увидит исчерпание. */
  async function turnLimits(input: { threadId: string; stepId: string; limits: LimitObservation[] }): Promise<{ exhausted: boolean }> {
    return serial(input.threadId, async () => {
      const config = await deps.loadConfig();
      const step = config.steps.find(s => s.id === input.stepId);
      for (const observation of input.limits) if (step) deps.observeLimit(config, step, observation);
      const stored = await deps.load(input.threadId).catch(() => undefined);
      if (!stored) return { exhausted: false };
      const observed = mergeObserved(stored.observed, input.stepId, input.limits, deps.now());
      await deps.save(input.threadId, { ...stored, observed });
      return { exhausted: Boolean(observed?.[input.stepId]) };
    });
  }

  async function finishTurn(raw: FinishTurnInput): Promise<{ notes: RouteNote[] }> {
    const input = finishTurnInputSchema.parse(raw);
    return serial(input.threadId, async () => {
      const config = await deps.loadConfig();
      const step = config.steps.find(s => s.id === input.stepId);
      for (const observation of input.limits) if (step) deps.observeLimit(config, step, observation);
      const notes: RouteNote[] = [];
      if (input.probe) return { notes };
      let stored = await deps.load(input.threadId).catch(() => undefined);
      if (stored && input.limits.length) {
        stored = { ...stored, observed: mergeObserved(stored.observed, input.stepId, input.limits, deps.now()) };
        await deps.save(input.threadId, stored).catch(error => warn(`лимит хода: ${String(error)}`));
      }
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
        // accountKey: ключ аккаунта ступени; у шлюза vclaude без ключа — «vclaude» (по нему
        // thread-account-usage показывает пакет VClaude, а не квоту машины).
        accountKey: step?.account ?? (step?.quotaSource === 'vclaude' ? 'vclaude' : null), kind: step?.authority ?? 'subscription',
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
    const explained = explainProfile({ config, requestedModel: profileId, accounts: deps.accounts(), thread: stored.engine, health: withObserved(deps.health(config, threadId), stored.observed, now), now });
    const profile = config.profiles.find(p => p.id === profileId);
    return {
      name: profile?.name ?? profileId,
      text: previewText(config, explained.decision, explained.attempts, now),
      test: usesTestQuota(config, threadId),
      attempts: explained.attempts,
      config,
    };
  }

  /**
   * Ответ provider-retry (BB зовёт его с таймаутом 5 с; не успели — «pool-unavailable»,
   * автоповтора нет). Только уже имеющееся состояние: сохранённое состояние треда,
   * отметки исчерпания, лимиты из кэша монитора. Ни обнаружения, ни опроса лимитов,
   * ни запросов треда — перепроверит следующий ход. Свой тред узнаётся по
   * сохранённому состоянию каскада; чужой — сразу `not-routed`. Бюджет — 1,5 с.
   */
  async function retryAvailability(threadId: string): Promise<RetryAvailability> {
    let ours: boolean | null = null; // null — ещё не знаем, свой ли тред
    const budget = new Promise<RetryAvailability>(resolve => {
      const t = setTimeout(() => resolve(ours === true ? { kind: 'ready' } : { kind: 'not-routed' }), deps.availabilityBudgetMs ?? 1_500);
      (t as { unref?: () => void }).unref?.();
    });
    const fast = (async (): Promise<RetryAvailability> => {
      const stored = await deps.load(threadId).catch(() => undefined);
      ours = Boolean(stored);
      if (!stored) return { kind: 'not-routed' };
      const config = await deps.loadConfig();
      if (config.policies.executionMode !== 'provider') return { kind: 'not-routed' };
      const now = deps.now();
      const decision = selectStep({
        config, requestedModel: stored.profileId ?? config.profiles.find(p => p.enabled)?.id ?? 'auto', accounts: deps.accounts(),
        thread: { ...stored.engine, turnId: `retry-${now}` }, health: withObserved(deps.health(config, threadId), stored.observed, now, stored.modelBlocks), now,
      });
      switch (decision.kind) {
        case 'run':
        case 'confirm': return { kind: 'ready' };
        case 'wait': return decision.reason === 'exhausted' ? { kind: 'blocked', retryAt: Math.max(now, Math.round(decision.until)) } : { kind: 'unavailable', reason: 'reset-unknown' };
        // Ждать дольше порога или сброс неизвестен — решает владелец, автоповтора нет.
        case 'ask-owner': return { kind: 'unavailable', reason: 'reset-unknown' };
        default: return { kind: 'unavailable', reason: 'no-enabled-account' };
      }
    })().catch(error => { warn(`доступность для provider-retry ${threadId}: ${String(error)}`); return (ours ? { kind: 'ready' } : { kind: 'not-routed' }) as RetryAvailability; });
    // Свой тред и не успели — `ready`: следующий ход сам выберет ступень (или откажет с причиной).
    return Promise.race([fast, budget]);
  }

  async function answerConfirmation(raw: AnswerConfirmationInput): Promise<AnswerConfirmationOutput> {
    const input = answerConfirmationInputSchema.parse(raw);
    return serial(input.threadId, async () => {
      const config = await deps.loadConfig();
      const info = await deps.threadInfo(input.threadId).catch(() => null);
      const stored = (await deps.load(input.threadId).catch(() => undefined)) ?? freshState(input.threadId, info);
      const step = config.steps.find(s => s.id === input.stepId);
      const now = deps.now();
      const projectId = input.projectId ?? info?.projectId ?? stored.engine.projectId;
      const save = (next: StoredThreadState) => deps.save(input.threadId, next).catch(error => warn(`состояние треда: ${String(error)}`));
      const label = step ? stageLabel(config, { stepId: step.id, hostId: step.hostId, providerId: step.providerId, modelId: null }) : null;

      switch (input.action) {
        case 'go': {
          if (!step) return { next: 'refuse', message: 'Ступень из карточки больше не настроена — отправьте сообщение снова.', retryable: false, notes: [] };
          const scope = input.scope ?? 'turn';
          const consent = grant(scope, {
            stepId: step.id, bindingEpoch: bindingEpoch(step), threadId: input.threadId, turnId: input.turnKey ?? '', projectId, now,
          }, scope === 'thread' ? input.threadUntil : null);
          const epochs = new Map(config.steps.map(s => [s.id, bindingEpoch(s)] as const));
          if (scope === 'forever' && deps.saveProjectConsents && projectId) {
            const current = pruneConsents(await projectConsentsOf(projectId), epochs, now).filter(c => c.stepId !== step.id);
            await deps.saveProjectConsents(projectId, [...current, consent]);
          } else {
            // Разовые согласия прошлых ходов больше не нужны; тредовые живут до сброса.
            const kept = pruneConsents(stored.engine.consents, epochs, now)
              .filter(c => !(c.stepId === step.id && c.scope === consent.scope))
              .filter(c => c.scope !== 'turn' || c.turnId === input.turnKey);
            // «На этот ход» переживает автоповтор того же хода (смена провайдера): 15 минут, один раз.
            await save({ ...stored, carryConsent: scope === 'turn' ? { stepId: step.id, until: now + 15 * 60_000 } : stored.carryConsent ?? null, engine: { ...stored.engine, projectId, consents: [...kept, consent] } });
          }
          return { next: 'continue', message: '', retryable: false, notes: [] };
        }
        case 'skip': {
          const same = input.turnKey !== null && stored.skipTurnKey === input.turnKey;
          const skippedStepIds = [...new Set([...(same ? stored.engine.skippedStepIds : []), input.stepId])];
          await save({ ...stored, skipTurnKey: input.turnKey, engine: { ...stored.engine, projectId, skippedStepIds } });
          return { next: 'continue', message: '', retryable: false, notes: [] };
        }
        case 'wait': {
          const until = input.threadUntil;
          const note = `Жду сброса лимита прежней ступени${until ? ` (до ${utcTime(until)})` : ''} — ход повторится после него.`;
          return {
            next: 'refuse', message: note, retryable: true,
            notes: [{ kind: 'wait', cause: 'reset', until, note, stepId: input.stepId }, { kind: 'state', phase: 'waiting', stage: label, stepId: input.stepId }],
          };
        }
        case 'cancel': {
          const message = 'Ход отменён в карточке подтверждения.';
          return { next: 'refuse', message, retryable: false, notes: [{ kind: 'state', phase: 'idle', stage: null }] };
        }
        default: {
          const message = 'Карточка подтверждения закрыта без ответа — ход не начат. Отправьте сообщение снова, когда будете готовы.';
          return { next: 'refuse', message, retryable: false, notes: [{ kind: 'state', phase: 'idle', stage: null }] };
        }
      }
    });
  }

  async function peekProvider(input: { threadId: string; projectId?: string | null; requestedModel?: string | null }): Promise<{ providerId: NativeProvider | null; modelId: string | null; stage: StageLabel | null }> {
    const none = { providerId: null, modelId: null, stage: null };
    const config = await deps.loadConfig();
    if (config.policies.executionMode !== 'provider') return none;
    const [info, stored] = await Promise.all([deps.threadInfo(input.threadId).catch(() => null), deps.load(input.threadId).catch(() => undefined)]);
    const state = stored ?? freshState(input.threadId, info);
    const projectId = input.projectId ?? info?.projectId ?? state.engine.projectId;
    const profileId = input.requestedModel ?? state.profileId ?? config.profiles.find(p => p.enabled)?.id ?? 'auto';
    const now = deps.now();
    const forever = await projectConsentsOf(projectId);
    const decision = selectStep({
      config, requestedModel: profileId, accounts: deps.accounts(), health: withObserved(deps.health(config, input.threadId), state.observed, now, state.modelBlocks), now,
      thread: { ...state.engine, projectId, homeHostId: state.engine.homeHostId ?? info?.hostId ?? null, turnId: `peek-${now}`, skippedStepIds: [], consents: [...state.engine.consents, ...forever] },
    });
    if (decision.kind !== 'run' && decision.kind !== 'confirm') return none;
    const providerId: NativeProvider | null = decision.providerId === 'codex' || decision.providerId === 'claude-code' ? decision.providerId : null;
    return { providerId, modelId: decision.modelId, stage: stageLabel(config, decision) };
  }

  async function handoffBrief(raw: { threadId: string; afterSeq: number; mode: 'snapshot' | 'delta'; from: string; to: string; currentRequestId?: string | null }) {
    const input = handoffBriefInputSchema.parse(raw);
    const events = deps.threadEvents ? await deps.threadEvents(input.threadId, input.afterSeq) : [];
    return buildHandoff(events, input);
  }

  async function nativeSessions(threadId: string, sessions: NativeSessions | null) {
    if (sessions === null) {
      const stored = await deps.load(threadId).catch(() => undefined);
      return { sessions: stored?.native ?? null };
    }
    const value = nativeSessionsSchema.parse(sessions);
    return serial(threadId, async () => {
      const info = await deps.threadInfo(threadId).catch(() => null);
      const stored = (await deps.load(threadId).catch(() => undefined)) ?? freshState(threadId, info);
      await deps.save(threadId, { ...stored, native: value });
      return { sessions: value };
    });
  }

  return { routeTurn, finishTurn, answerConfirmation, peekProvider, handoffBrief, nativeSessions, threadStatus, threadScheme, retryAvailability, turnLimits, turnModelUnavailable, turnProgress: threadId => prep.note(threadId) };
}
