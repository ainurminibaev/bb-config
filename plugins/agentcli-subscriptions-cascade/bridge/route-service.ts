// Маршрутизатор хода на сервере плагина: решение движка до запуска CLI,
// синхронизация файлов до и после хода, состояние треда, паспорт треда.
// Все обращения к BB и sync/ — через зависимости: тестируется без SDK.
import { profileName } from '../pins.ts';
import { bindingEpoch } from '../config.ts';
import { grant, pruneConsents, type Consent } from '../consent.ts';
import type { CascadeConfig, DiscoveredAccount, Step } from '../contract.ts';
import { BUSY_RECHECK_MS, explainNoSteps, resolveProfile, explainProfile, parentHomeMissing, nextThreadState, selectStep, type Decision, type HealthLookup, type ThreadCascadeState } from '../engine.ts';
import { previewText, usesTestQuota } from '../profiles.ts';
import { buildHandoff, type ThreadEventRow } from './handoff.ts';
import { briefRefusalText, briefTextFromEvents, checkBrief, BRIEF_PART_TITLES } from '../brief.ts';
import { SUBTHREAD_CODEX_ID } from '../contract.ts';
import { MAX_ANCESTOR_DEPTH, SUBTHREAD_FALLBACK_PROFILE_ID, codexFallbackReason, codexUnavailableLine, descendantsRule, inheritsRule, isSubthreadCodexId, type DescendantsRule } from '../subthreads.ts';
import { subthreadsPreview } from '../profiles.ts';
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
  /** Кто пишет рабочую папку на исполнителе (0.3.0): второй тред идёт на ту же машину. */
  writerOf?(thread: { threadId: string; projectId: string; workspace?: string | null }): Promise<{ hostId: string; threadIds: string[] } | null>;
  /** Папка рабочей копии треда на машине (0.3.3) — для паспорта: открыть папку, файлы, код. */
  folderOn?(thread: { threadId: string; projectId: string; workspace?: string | null }, hostId: string): Promise<string | null>;
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
  /**
   * `adopt --native`: исходная сессия Claude, которую продолжает первый ход
   * треда. `done` — ход Claude с ней завершился успешно, копия больше не нужна.
   */
  seed?: { sessionId: string; sourceThreadId: string; done: boolean } | null;
  /** 0.3.4: задание Codex-подтреда проверено (или проверка пропущена) — больше не проверяется. */
  briefAccepted?: boolean;
  /** 0.3.4: Codex-подтред сейчас идёт на «Авто» (Codex недоступен) — строка в ленту только при переходе. */
  codexFallback?: boolean;
  /**
   * 0.3.5: правило потомков, унаследованное от предка (профиль = self + descendants).
   * Повтор после сбоя и схема берут его отсюда, без запроса предков.
   */
  inherited?: (DescendantsRule & { ownerThreadId: string }) | null;
  /** 0.3.5: подтреды, о запуске которых мимо каскада родитель уже предупреждён. */
  bypassNoted?: string[];
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
  /** Сколько ждать места на занятой ступени (maxConcurrent, onBusy: wait). По умолчанию 30 мин. */
  stepBusyWaitMs?: number;
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
  /** Имя машины BB (для машины, которой уже нет в настройках каскада). */
  hostName?(hostId: string): string | null;
  /** Название треда для строк ленты («Жду: папку держит тред <название> на Mac»). */
  threadTitle?(threadId: string): Promise<string | null>;
  /** Посев `adopt --native` для нового треда (одноразовый ключ в метаданных треда → хранилище плагина). */
  adoptSeed?(threadId: string): Promise<{ sourceSessionId: string; sourceThreadId: string } | null>;
  /**
   * 0.3.7: профиль треда из выбора модели BB (deriveProviderOptions → ctx.model). Нужен,
   * когда CLI запускается без `--model` (app-server Codex на открытии сессии): иначе
   * свежий тред на `pin:<Codex>` шёл по «Авто» и сессия не открывалась.
   */
  profileHint?(threadId: string): string | null;
  /** 0.3.7: настроек ещё нет (переустановка) — профиль ждёт их появления, а не отказывает. */
  configSeeded?(): Promise<boolean>;
  /** Сколько ждать появления настроек с профилем хода, мс. По умолчанию 30 с. */
  settingsWaitMs?: number;
  /** 0.3.6: строка журнала с замером шагов маршрута до подготовки («ход thr: config 0,01 с …»). */
  trace?(line: string): void;
  /**
   * 0.3.4: строки для ленты другого треда (родителя подтреда) — показываются
   * в его следующем ходе. Нет портов — очередь в памяти сервера.
   */
  pushThreadNote?(threadId: string, message: string): Promise<void>;
  takeThreadNotes?(threadId: string): Promise<string[]>;
}

/** Что сделать владельцу, если ход не начался (рядом со строкой отказа). */
export const REFUSAL_ACTIONS = 'Что сделать: повторите ход · пропустить ступень — выключите её в настройках «Каскада» · Настроить: Настройки → Плагины → «Каскад подписок» → «Настроить» или bb subscriptions-cascade setup';

/**
 * Окружение CLI ступени: профиль треда (`auto`, `pin:…`) и ступень. Подтред,
 * запущенный из такого треда, берёт профиль отсюда (`bb thread spawn … --provider
 * subscriptions-cascade --model "$BB_CASCADE_PROFILE"`).
 */
export function cascadeEnv(profileId: string, stepId: string): Record<string, string> {
  return { BB_CASCADE_PROFILE: profileId, BB_CASCADE_STEP: stepId };
}

/** Профиль хода не разрешается в настройках (нет такого профиля и это не `pin:`/`m:`/синтетика). */
function unknownProfile(config: CascadeConfig, id: string): boolean {
  const p = resolveProfile(config, id);
  return 'kind' in p && p.kind === 'unavailable' && p.reason === 'unknown-profile';
}

/** 0.3.5: строка ленты родителя о подтреде, запущенном штатным провайдером. */
export function bypassLine(title: string): string {
  return `Подтред «${title.slice(0, 80)}» запущен мимо каскада: лимиты не переключаются`;
}

/** «Ход не запущен: Каскад подписок → <источник>: <причина>». */
export function refusalText(source: string, reason: string): string {
  return `Ход не запущен: Каскад подписок → ${source}: ${reason}`;
}

/** Ошибка прежнего экземпляра плагина после переустановки. */
export const RETIRED = /generation \S+ is retired|stale API handle|was reloaded or disabled/iu;

/** Сбои подготовки, после которых ступень пропускается и берётся следующая (конфликт файлов — нет). */
const FALLBACK_REASONS = new Set(['error', 'not-configured', 'unsupported', 'sync-off']);

export const PROVIDER_ID_LOCAL = 'subscriptions-cascade';

/**
 * Имена машин, которых уже нет в настройках (убраны из каскада): каскад помнит их
 * по ходам (`sync:machine:*`). Без этого в ленте вместо «Mac» стоял ID хоста (0.3.3).
 */
const retiredLabels = new Map<string, string>();
export function rememberMachineLabels(machines: readonly { hostId: string; label: string }[]): void {
  for (const m of machines) if (m.hostId && m.label) retiredLabels.set(m.hostId, m.label);
}

function machineLabel(config: CascadeConfig, hostId: string): string {
  return config.machines.find(m => m.hostId === hostId)?.label ?? retiredLabels.get(hostId) ?? 'машина вне каскада';
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
  // Уведомления синхронизации (карантин, пропущенное при сканировании, режим
  // symlink) — каждое отдельной строкой: ход не блокируют, но в подробностях
  // успешного flush лента их не показывает (S8: «Отложено файлов» терялось).
  for (const notice of outcome.notices.filter(Boolean)) {
    notes.push({ kind: 'notice', message: `Синхронизация: ${notice}`.slice(0, 300) });
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
  /** Синхронизация хода на закреплённой машине (app-server Codex). */
  syncTurn(input: { threadId: string; stepId: string; hostId: string; phase: 'prepare' | 'finish' }): Promise<{ ok: boolean; message: string; cwd: string | null; notes: RouteNote[] }>;
  /** Модель недоступна на аккаунте ступени («requires usage credits»). */
  turnModelUnavailable(input: { threadId: string; stepId: string; modelId: string | null; reason: string }): Promise<{ ok: boolean }>;
  /** Лимит, полученный в ходе: ступень помечается исчерпанной сразу. */
  turnLimits(input: { threadId: string; stepId: string; limits: LimitObservation[] }): Promise<{ exhausted: boolean }>;
  /** Ответ provider-retry после ошибки лимита: можно ли повторить ход сейчас (S2, S14). */
  retryAvailability(threadId: string): Promise<RetryAvailability>;
  /**
   * 0.3.5: подтред создан штатным провайдером (`--provider codex|claude-code`) при
   * установленном каскаде. Родитель на каскаде получает строку в следующем ходе, один
   * раз на подтред. parentOnCascade: false — родитель не на каскаде (строка не доставлена).
   */
  subthreadBypass(input: { threadId: string; parentThreadId: string; title: string | null; providerId: string }): Promise<{ noted: boolean; parentOnCascade: boolean }>;
  /** Схема профиля треда для метки ступени (timeline.provideScheme): тот же движок и то же состояние. */
  threadScheme(threadId: string): Promise<{ name: string; text: string; test: boolean; attempts: unknown[]; config: unknown; subthreads?: { attempts: unknown[]; text: string; note: string } } | null>;
}

/**
 * Идущие ходы по ступеням (для `maxConcurrent`): ступень → тред → начало хода.
 * У треда один ход: новый ход снимает прежний. Ход без finishTurn (упал
 * запускатель) перестаёт считаться через 3 часа. Хранится в памяти сервера:
 * после перезагрузки плагина счёт начинается заново.
 */
export class ActiveTurns {
  private readonly steps = new Map<string, Map<string, number>>();
  static readonly STALE_MS = 3 * 3_600_000;
  start(stepId: string, threadId: string, now: number): void {
    for (const turns of this.steps.values()) turns.delete(threadId);
    const turns = this.steps.get(stepId) ?? new Map<string, number>();
    turns.set(threadId, now);
    this.steps.set(stepId, turns);
  }
  finish(stepId: string, threadId: string): void { this.steps.get(stepId)?.delete(threadId); }
  /** Ходы других тредов на ступени. */
  count(stepId: string, exceptThreadId: string, now: number): number {
    const turns = this.steps.get(stepId);
    if (!turns) return 0;
    let n = 0;
    for (const [threadId, since] of turns) {
      if (now - since > ActiveTurns.STALE_MS) { turns.delete(threadId); continue; }
      if (threadId !== exceptThreadId) n += 1;
    }
    return n;
  }
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
  const activeTurns = new ActiveTurns();
  const prep = new PrepTracker(deps.now, hostId => (lastConfig ? machineLabel(lastConfig, hostId) : hostId));
  async function projectConsentsOf(projectId: string): Promise<Consent[]> {
    if (!projectId || !deps.projectConsents) return [];
    return deps.projectConsents(projectId).catch(error => { warn(`правила «навсегда»: ${String(error)}`); return []; });
  }

  // Строки для ленты другого треда (0.3.4): порт хранилища или очередь в памяти.
  const memoryNotes = new Map<string, string[]>();
  async function pushThreadNote(threadId: string, message: string): Promise<void> {
    if (deps.pushThreadNote) { await deps.pushThreadNote(threadId, message).catch(error => warn(`строка для треда ${threadId}: ${String(error)}`)); return; }
    memoryNotes.set(threadId, [...(memoryNotes.get(threadId) ?? []), message].slice(-20));
  }
  async function takeThreadNotes(threadId: string): Promise<string[]> {
    if (deps.takeThreadNotes) return deps.takeThreadNotes(threadId).catch(error => { warn(`строки треда ${threadId}: ${String(error)}`); return []; });
    const out = memoryNotes.get(threadId) ?? [];
    memoryNotes.delete(threadId);
    return out;
  }

  /**
   * 0.3.5: правило потомков ближайшего предка (профиль = self + descendants).
   * Ищется вверх по parentThreadId (не глубже MAX_ANCESTOR_DEPTH) среди сохранённых
   * профилей предков в каскаде. Применяется, только если подтред не выбрал профиль
   * явно (`inheritsRule`). Явный выбор — только на этот тред: его потомки снова
   * найдут правило выше. Предок вне каскада пропускается.
   */
  async function inheritedRule(config: CascadeConfig, threadId: string, info: ThreadInfo | null, requested: string | null): Promise<(DescendantsRule & { ownerThreadId: string }) | null> {
    if (!info?.parentThreadId) return null;
    const parentState = await deps.load(info.parentThreadId).catch(() => undefined);
    const seen = new Set<string>([threadId]);
    let current: string | null = info.parentThreadId;
    let state = parentState;
    for (let depth = 0; current && depth < MAX_ANCESTOR_DEPTH && !seen.has(current); depth += 1) {
      seen.add(current);
      if (depth > 0) state = await deps.load(current).catch(() => undefined);
      const rule = descendantsRule(config, state?.profileId);
      if (rule && state?.profileId) {
        const inherit = inheritsRule(requested, {
          defaultProfileId: config.profiles.find(p => p.enabled)?.id ?? null, parentProfileId: parentState?.profileId ?? null,
          ownerProfileId: state.profileId, ruleProfileId: rule.profileId,
        });
        return inherit ? { ...rule, ownerThreadId: current } : null;
      }
      const up: ThreadInfo | null = await deps.threadInfo(current).catch(() => null);
      current = up?.parentThreadId ?? null;
    }
    return null;
  }

  /**
   * Выбор ступени по профилю потомков с режимом исчерпания (0.3.5): `fallback` —
   * правило исчерпано/выключено → ход по «Авто» без S11; `wait` — решение как есть.
   */
  function selectWithFallback(input: Omit<Parameters<typeof selectStep>[0], 'requestedModel'>, profileId: string, rule: DescendantsRule | null = null): { decision: Decision; profileId: string; fallback: string | null } {
    const codex = isSubthreadCodexId(profileId);
    const decision = selectStep({ ...input, requestedModel: profileId, ignoreHome: codex });
    const reason = rule?.onExhausted === 'fallback' && rule.profileId === profileId ? codexFallbackReason(decision, utcTime) : null;
    if (!reason) return { decision, profileId, fallback: null };
    // Откат на «Авто» — без S11 (0.3.5), как и сам маршрут Codex-подтреда.
    return { decision: selectStep({ ...input, requestedModel: SUBTHREAD_FALLBACK_PROFILE_ID, ignoreHome: true }), profileId: SUBTHREAD_FALLBACK_PROFILE_ID, fallback: codexUnavailableLine(reason) };
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
  /** «Жду: папку держит тред <название> на <машина>». */
  async function holderLine(threadId: string, projectId: string, workspace: string | null, config: CascadeConfig): Promise<string> {
    const holder = await deps.sync?.writerOf?.({ threadId, projectId, workspace }).catch(() => null);
    const other = holder?.threadIds.find(t => t !== threadId);
    if (!holder || !other) return 'Жду освобождения рабочей папки';
    const title = await deps.threadTitle?.(other).catch(() => null);
    return `Жду: папку держит тред ${title ? `«${title.slice(0, 60)}»` : other} на ${machineLabel(config, holder.hostId)}`;
  }

  /**
   * Посев `adopt --native`: уже записанный в состоянии треда или (только до первого
   * хода треда) по одноразовому ключу из метаданных. Ошибка чтения — без посева.
   */
  async function adoptSeedOf(threadId: string, stored: StoredThreadState): Promise<NonNullable<StoredThreadState['seed']> | null> {
    if (stored.seed) return stored.seed.done ? null : stored.seed;
    if (stored.lastRun !== null || !deps.adoptSeed) return null;
    const found = await deps.adoptSeed(threadId).catch(error => { warn(`посев adopt --native: ${String(error)}`); return null; });
    return found ? { sessionId: found.sourceSessionId, sourceThreadId: found.sourceThreadId, done: false } : null;
  }

  async function routeOnce(input: ReturnType<typeof routeTurnInputSchema.parse>, skipped: string[]): Promise<RouteTurnOutput> {
    {
      let config = await deps.loadConfig();
      const info = await deps.threadInfo(input.threadId).catch(() => null);
      // 0.3.7: профиль хода не найден, а настроек нет (каскад по умолчанию после
      // переустановки) — ждём появления настроек до settingsWaitMs, затем «Авто» со строкой.
      let settingsNote: string | null = null;
      if (input.requestedModel && !input.probe && unknownProfile(config, input.requestedModel) && deps.configSeeded && await deps.configSeeded().catch(() => false)) {
        const sleep = deps.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
        const started = deps.now();
        prep.attempt(input.threadId, 'Жду настройки каскада (плагин переустановлен?)');
        while (deps.now() - started < (deps.settingsWaitMs ?? 30_000)) {
          await sleep(1_000);
          config = await deps.loadConfig();
          if (!unknownProfile(config, input.requestedModel) || !(await deps.configSeeded().catch(() => false))) break;
        }
        prep.attempt(input.threadId, null);
        if (unknownProfile(config, input.requestedModel) && await deps.configSeeded().catch(() => false)) {
          settingsNote = `Настроек каскада нет — профиль «${input.requestedModel}» не найден, ход по «Авто» каскада по умолчанию.`;
          input = { ...input, requestedModel: null };
        }
      }
      lastConfig = config;
      let stored = (await deps.load(input.threadId).catch(() => undefined)) ?? freshState(input.threadId, info);
      const now = deps.now();
      // 0.3.6: замер шагов до подготовки — в журнал сервера, если всё вместе дольше 1 с.
      const marks: string[] = [];
      let lastMark = performance.now();
      const startMark = lastMark;
      const mark = (label: string) => { const t = performance.now(); marks.push(`${label} ${((t - lastMark) / 1000).toFixed(2)} с`); lastMark = t; };
      const flushMarks = (to: string) => { if (performance.now() - startMark > 1_000) deps.trace?.(`ход ${input.threadId} до подготовки (${to}): ${marks.join(', ')}`); };
      mark('состояние');
      const requestedProfileId = input.requestedModel ?? stored.profileId ?? deps.profileHint?.(input.threadId) ?? config.profiles.find(p => p.enabled)?.id ?? 'auto';
      const projectId = input.projectId ?? info?.projectId ?? stored.engine.projectId;
      const bridgeHost = info?.hostId ?? stored.engine.homeHostId;

      // Проба моста (model/list, контекст; без сохранения сессии) — всегда на машине моста:
      // на чужой машине у неё нет папки (ENOENT), и она не должна трогать процесс сессии
      // ступени. Модель прошлого хода — только если он был здесь же (у чужой машины свои ID).
      if (input.probe) {
        const last = stored.lastRun;
        const here = last !== null && bridgeHost !== null && last.hostId === bridgeHost;
        return {
          action: 'run', stepId: last?.stepId ?? '', hostId: bridgeHost ?? last?.hostId ?? '', providerId: last?.providerId ?? input.provider,
          modelId: here ? last!.modelId : null, local: true, cwd: null, env: {}, stage: { machine: bridgeHost ? machineLabel(config, bridgeHost) : 'машина треда' }, notes: [],
        };
      }

      if (config.policies.executionMode !== 'provider') {
        const message = refusalText('настройки', 'каскад выключен (режим исполнения «Выключено»). Включите «Свой провайдер» в «Дополнительно» или выберите штатный провайдер.');
        return { action: 'refuse', retryable: false, message, notes: [{ kind: 'problem', message: message.slice(0, 300), note: REFUSAL_ACTIONS }] };
      }

      // 0.3.5: профиль — правило на дерево. Потомок без явного профиля идёт по
      // descendants ближайшего предка; явный выбор — только на этот тред. Деревья
      // без правила — как раньше, по своему профилю.
      const rule = await inheritedRule(config, input.threadId, info, input.requestedModel);
      let profileId = rule ? rule.profileId : requestedProfileId;
      const codexChild = rule !== null && isSubthreadCodexId(rule.profileId);
      // Первый ход потомка на правиле Codex — только с заданием из 4 частей.
      if (codexChild && stored.lastRun === null && !stored.briefAccepted) {
        const events = deps.threadEvents ? await deps.threadEvents(input.threadId, 0).catch(error => { warn(`задание подтреда ${input.threadId}: ${String(error)}`); return null; }) : null;
        const text = events ? briefTextFromEvents(events) : null;
        if (text !== null) {
          const check = checkBrief(text);
          if (!check.ok) {
            const message = briefRefusalText(check);
            const short = `Задание Codex-подтреда не принято — не хватает: ${check.missing.map(part => BRIEF_PART_TITLES[part].split(' — ')[0]).join(', ')}`;
            return { action: 'refuse', retryable: false, message, notes: [{ kind: 'problem', message: short.slice(0, 300), note: 'Пришлите подтреду полное задание: /goal, «Контекст», «Как делать», «Критерии приёмки»' }] };
          }
        } else {
          // Задание не прочитать (нет порта, сбой чтения событий) — ход не блокируется.
          warn(`задание подтреда ${input.threadId} не прочитано — проверка пропущена`);
        }
        stored = { ...stored, briefAccepted: true };
        await deps.save(input.threadId, stored).catch(error => warn(`состояние треда: ${String(error)}`));
      }

      mark('профиль и задание');
      const plannedSteps = config.steps.filter(s => s.enabled);
      // Бюджет держится и при медленном источнике лимитов (0.3.6): ход идёт по последнему показанию.
      const budget = config.policies.preTurnBudgetMs;
      await Promise.race([
        deps.refreshLimits(config, plannedSteps).catch(error => warn(`лимиты перед ходом: ${String(error)}`)),
        new Promise<void>(resolve => { const t = setTimeout(resolve, budget); (t as { unref?: () => void }).unref?.(); }),
      ]);
      mark('лимиты');
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
        lastRunAt: stored.lastRun && stored.lastRun.stepId === stored.engine.currentStepId ? stored.lastRun.at : null,
      };
      const forever = await projectConsentsOf(projectId);
      // Согласие «на ход», данное до автоповтора (смена провайдера внутри хода), — и на повтор.
      const carry = stored.carryConsent && stored.carryConsent.until > now ? config.steps.find(st => st.id === stored.carryConsent!.stepId) : undefined;
      if (carry) forever.push(grant('turn', { stepId: carry.id, bindingEpoch: bindingEpoch(carry), threadId: input.threadId, turnId: engine.turnId, projectId, now }, null));
      // Папку уже пишет тред на исполнителе: второй тред предпочитает ту же машину
      // (писатели одной машины не ждут друг друга), если она есть в его профиле и доступна.
      const anchorNow = anchorHostId(config);
      const unitWorkspace = bridgeHost !== null && bridgeHost === anchorNow ? input.cwd : null;
      const holder = deps.sync?.writerOf && projectId
        ? await deps.sync.writerOf({ threadId: input.threadId, projectId, workspace: unitWorkspace }).catch(() => null)
        : null;
      const preferHostId = holder && holder.hostId !== anchorNow && holder.threadIds.some(t => t !== input.threadId) ? holder.hostId : null;
      // Опора с писателем не блокируется — предпочтение нужно, только когда ход ушёл бы
      // на третью машину и ждал там освобождения папки.
      let prefer: string | null = null;
      // Codex-подтред (0.3.5): и маршрут Codex, и откат на «Авто» не держат его на машине
      // родителя (S11) — иначе при исчерпанной машине родителя подтред никуда не идёт.
      const codexRouted = isSubthreadCodexId(profileId);
      const decide = (at: number): Decision => selectStep({
        preferHostId: prefer, ignoreHome: codexRouted,
        config, requestedModel: profileId, accounts: deps.accounts(), thread: { ...engine, skippedStepIds: [...cardSkipped, ...skipped], consents: [...engine.consents, ...forever] }, health: withObserved(deps.health(config, input.threadId), stored.observed, at, stored.modelBlocks), now: at,
        running: stepId => activeTurns.count(stepId, input.threadId, at),
      });
      const pick = (): Decision => {
        prefer = null;
        let d = decide(now);
        if (preferHostId && (d.kind === 'run' || d.kind === 'confirm') && d.hostId !== anchorNow && d.hostId !== preferHostId) {
          prefer = preferHostId;
          d = decide(now);
        }
        return d;
      };
      mark('машина, согласия, писатель');
      let decision: Decision = pick();
      // Правило потомков исчерпано, выключено или не приняло ход: режим `fallback` — ход по
      // «Авто» без S11; `wait` (по умолчанию) — ждать сброса или спросить владельца (0.3.5).
      // Неизвестная квота Codex — не повод (профиль пробует ступень, onUnknown: try).
      // Занятая ступень (maxConcurrent) — тоже не повод: подтред ждёт места, как все.
      let codexFallback: string | null = null;
      if (rule?.onExhausted === 'fallback' && profileId === rule.profileId) {
        const codexSteps = config.steps.filter(st => st.enabled && st.providerId === 'codex').map(st => st.id);
        const allSkipped = codexSteps.length > 0 && codexSteps.every(id => skipped.includes(id) || cardSkipped.includes(id));
        const reason = codexFallbackReason(decision, utcTime) === null ? null : allSkipped ? 'вход на ступени Codex не удался' : codexFallbackReason(decision, utcTime);
        if (reason) {
          codexFallback = codexUnavailableLine(reason);
          profileId = SUBTHREAD_FALLBACK_PROFILE_ID;
          decision = pick();
        }
      }
      const busyNotes: RouteNote[] = [];
      if (codexFallback && !stored.codexFallback) busyNotes.push({ kind: 'notice', message: codexFallback.slice(0, 300) });
      // Машина родителя ушла из каскада — правило S11 не держит подтред (0.3.1).
      if (!codexRouted && parentHomeMissing(config, engine)) {
        const home = engine.homeHostId!;
        const name = config.machines.find(m => m.hostId === home)?.label ?? deps.hostName?.(home) ?? home;
        busyNotes.push({ kind: 'notice', message: `Машина родителя ${name} не в каскаде — иду по профилю.` });
      }
      // Ступень занята (maxConcurrent, onBusy: wait): ход ждёт освобождения со строкой в ленте.
      if (decision.kind === 'wait' && decision.reason === 'busy') {
        const step = config.steps.find(st => st.id === (decision as { stepId: string | null }).stepId);
        const machine = step ? machineLabel(config, step.hostId) : 'ступени';
        const started = deps.now();
        const limitMs = deps.stepBusyWaitMs ?? 30 * 60_000;
        const sleep = deps.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
        if (step) prep.begin(input.threadId, { reason: 'start', from: null, to: stageLabel(config, { stepId: step.id, hostId: step.hostId, providerId: step.providerId, modelId: null }), stepId: step.id });
        while (decision.kind === 'wait' && decision.reason === 'busy' && deps.now() - started < limitMs) {
          prep.attempt(input.threadId, `Жду: на ${machine} уже ${decision.running ?? step?.maxConcurrent ?? ''} ход(ов) · ${Math.round((deps.now() - started) / 1000)} с`);
          await sleep(BUSY_RECHECK_MS);
          decision = decide(deps.now());
        }
        prep.attempt(input.threadId, null);
        if (decision.kind === 'wait' && decision.reason === 'busy') {
          const note = `Жду: на ${machine} уже ${decision.running ?? ''} ход(ов) (предел ${step?.maxConcurrent ?? '—'}) — не освободилась за ${Math.round(limitMs / 60_000)} мин.`;
          return { action: 'refuse', retryable: true, message: refusalText('ступень занята', note), notes: [{ kind: 'wait', cause: 'recheck', until: null, note, ...(step ? { stepId: step.id } : {}) }] };
        }
        busyNotes.push({ kind: 'wait', cause: 'recheck', until: null, note: `Ждал свободного места на ${machine} ${Math.round((deps.now() - started) / 1000)} с (предел ходов ${step?.maxConcurrent ?? '—'}).` });
      }

      const save = (next: StoredThreadState) => deps.save(input.threadId, next).catch(error => warn(`состояние треда: ${String(error)}`));

      if (decision.kind === 'unavailable') {
        const reason = decision.reason === 'no-steps'
          ? `${explainNoSteps({ config, requestedModel: profileId, accounts: deps.accounts(), thread: engine, ignoreHome: codexRouted })}.`
          : REFUSE_TEXT[decision.reason] ?? 'не найдена ступень для хода.';
        const message = refusalText('настройки', reason);
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
      mark('решение');
      flushMarks(decision.stepId);
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
      // Смена ступени считается и по прошлому ходу (lastRun): состояние движка могло не
      // увидеть ход другого провайдера, а строка перехода нужна при любой смене —
      // машины, провайдера (Codex → Claude) или аккаунта.
      const order = (stepId: string) => config.steps.findIndex(s => s.id === stepId);
      // Та же ступень, что в прошлом ходе (например, подъём CLI после простоя), —
      // не переход: иначе в ленте «Сбой на Mac → Mac» (S9, 0.2.13).
      const changed = prev !== null ? prev.stepId !== decision.stepId : decision.switched;
      const returning = decision.returning || (prev !== null && changed && order(decision.stepId) !== -1 && order(prev.stepId) !== -1 && order(decision.stepId) < order(prev.stepId));
      // Прошлой ступени или её машины больше нет в настройках — это не сбой и не «не на связи» (0.3.3).
      const prevRemoved = prev !== null && (order(prev.stepId) === -1 || !config.machines.some(m => m.hostId === prev.hostId && m.enabled));
      const switchReason = prevRemoved && changed ? 'removed' : skipped.length > 0 ? 'unavailable' : prev === null ? 'start' : returning ? 'return' : fromHealth?.exhausted ? 'limit' : fromHealth && (!fromHealth.available || fromHealth.unknown) ? 'unavailable' : 'error';
      if (changed || prev === null && !local || skipped.length > 0) {
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
        // Та же ступень, что в прошлом ходе (подъём CLI после простоя), — строка
        // обычного хода «Ход на Mac · …», а не перехода «Сбой на Mac → Mac» (S9, 0.2.13).
        const prepAsSwitch = changed || prev === null || skipped.length > 0;
        prep.begin(input.threadId, { reason: prepAsSwitch ? switchReason : 'start', from: prepAsSwitch ? fromStage : null, to, stepId: decision.stepId });
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
          prep.attempt(input.threadId, `${await holderLine(input.threadId, projectId, workspace, config)} · ${Math.round((deps.now() - waitStarted) / 1000)} с`);
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
      notes.unshift(...busyNotes);
      if (settingsNote) notes.unshift({ kind: 'notice', message: settingsNote.slice(0, 300) });
      // Строки, оставленные этому треду другими (0.3.4: «подтред на Claude» от подтреда).
      const inbox = await takeThreadNotes(input.threadId);
      notes.unshift(...inbox.map((message): RouteNote => ({ kind: 'notice', message: message.slice(0, 300) })));
      if (codexFallback && !stored.codexFallback && info?.parentThreadId) {
        const title = await deps.threadTitle?.(input.threadId).catch(() => null);
        await pushThreadNote(info.parentThreadId, `Подтред ${title ? `«${title.slice(0, 60)}»` : input.threadId}: ${codexFallback}`);
      }
      activeTurns.start(decision.stepId, input.threadId, deps.now());
      notes.push({ kind: 'run', stage: to, stepId: decision.stepId });
      notes.push({ kind: 'state', phase: 'running', stage: to, stepId: decision.stepId, profileId });
      const seed = decision.providerId === 'claude-code' ? await adoptSeedOf(input.threadId, stored) : null;
      await save({
        ...stored, profileId,
        engine: nextThreadState(engine, decision, now),
        lastRun: { stepId: decision.stepId, hostId: decision.hostId, providerId: decision.providerId, modelId: decision.modelId, at: now },
        pendingFlushHostId: decision.hostId !== anchor && needsSync ? decision.hostId : stored.pendingFlushHostId,
        workspace,
        carryConsent: stored.carryConsent && stored.carryConsent.stepId === decision.stepId ? null : stored.carryConsent ?? null,
        ...(seed ? { seed } : {}),
        ...(rule ? { codexFallback: codexFallback !== null } : {}),
        inherited: rule,
      });
      // Тред знает, что он на каскаде, через окружение CLI ступени (0.3.0), а не через
      // промпт: начало запроса не меняется, кэш промптов не теряется.
      const stageEnv = { ...env, ...cascadeEnv(profileId, decision.stepId) };
      return {
        action: 'run', stepId: decision.stepId, hostId: decision.hostId, providerId: decision.providerId, modelId: decision.modelId, local, cwd, env: stageEnv, stage: to, notes,
        ...(seed && !seed.done ? { seedSession: { sessionId: seed.sessionId } } : {}),
      };
    }
  }

  /** Синхронизация хода на закреплённой машине (app-server Codex): без выбора ступени. */
  async function syncTurn(input: { threadId: string; stepId: string; hostId: string; phase: 'prepare' | 'finish' }): Promise<{ ok: boolean; message: string; cwd: string | null; notes: RouteNote[] }> {
    if (input.phase === 'finish') {
      const out = await finishTurn({ threadId: input.threadId, projectId: null, stepId: input.stepId, hostId: input.hostId, exitCode: 0, limits: [] });
      return { ok: true, message: '', cwd: null, notes: out.notes };
    }
    return serial(input.threadId, async () => {
      const config = await deps.loadConfig();
      const stored = await deps.load(input.threadId).catch(() => undefined);
      const projectId = stored?.engine.projectId ?? '';
      const anchor = anchorHostId(config);
      if (!deps.sync || !stored || !projectId || (input.hostId === anchor && stored.pendingFlushHostId === null)) return { ok: true, message: '', cwd: null, notes: [] };
      const outcome = await deps.sync.prepareTurn({ threadId: input.threadId, projectId, workspace: stored.workspace ?? null }, { hostId: input.hostId }).catch(error => ({
        ok: false as const, reason: 'error', message: error instanceof Error ? error.message : String(error), conflicts: [], timings: [], notices: [],
      }));
      const notes = syncNotes(config, outcome);
      if (!outcome.ok) {
        const message = refusalText(`синхронизация ${machineLabel(config, input.hostId)}`, outcome.message);
        return { ok: false, message, cwd: null, notes: [...notes, { kind: 'problem', message: message.slice(0, 300), stepId: input.stepId, note: REFUSAL_ACTIONS }] };
      }
      if (input.hostId !== anchor) await deps.save(input.threadId, { ...stored, pendingFlushHostId: input.hostId }).catch(() => {});
      activeTurns.start(input.stepId, input.threadId, deps.now());
      return { ok: true, message: '', cwd: outcome.cwd, notes };
    });
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
      activeTurns.finish(input.stepId, input.threadId);
      let stored = await deps.load(input.threadId).catch(() => undefined);
      if (stored && input.limits.length) {
        stored = { ...stored, observed: mergeObserved(stored.observed, input.stepId, input.limits, deps.now()) };
        await deps.save(input.threadId, stored).catch(error => warn(`лимит хода: ${String(error)}`));
      }
      // Первый удачный ход Claude переведённого треда: сессия продолжена, копия больше не нужна.
      if (stored?.seed && !stored.seed.done && input.exitCode === 0 && step?.providerId === 'claude-code') {
        stored = { ...stored, seed: { ...stored.seed, done: true } };
        await deps.save(input.threadId, stored).catch(error => warn(`посев: ${String(error)}`));
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
    // Папка свежей копии (0.3.3). Раньше здесь был общий путь опоры (`/opt/bbfs`) —
    // корень реплик, а не папка проекта: «Открыть папку» и файлы вели не туда.
    const freshCopyHostId = stored?.pendingFlushHostId ?? anchor;
    const workspace = stored?.workspace ?? null;
    let path: string | null = null;
    if (freshCopyHostId && projectId && deps.sync?.folderOn) {
      path = await deps.sync.folderOn({ threadId, projectId, workspace }, freshCopyHostId).catch(() => null);
    }
    // Без сервиса синхронизации на опоре известна хотя бы рабочая папка последнего хода.
    if (path === null && freshCopyHostId === anchor && workspace) path = workspace;
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
      path,
      freshCopyHostId,
    };
  }

  async function subthreadBypass(input: { threadId: string; parentThreadId: string; title: string | null; providerId: string }) {
    return serial(input.parentThreadId, async () => {
      const parent = await deps.load(input.parentThreadId).catch(() => undefined);
      if (!parent) return { noted: false, parentOnCascade: false };
      if (parent.bypassNoted?.includes(input.threadId)) return { noted: false, parentOnCascade: true };
      await deps.save(input.parentThreadId, { ...parent, bypassNoted: [...(parent.bypassNoted ?? []), input.threadId].slice(-50) });
      await pushThreadNote(input.parentThreadId, bypassLine(input.title ?? input.threadId));
      return { noted: true, parentOnCascade: true };
    });
  }

  async function threadScheme(threadId: string) {
    const [config, stored] = await Promise.all([deps.loadConfig(), deps.load(threadId).catch(() => undefined)]);
    if (!stored) return null;
    // Codex-подтред (0.3.5): схема по «Подтред · Codex» без S11, как у его маршрута.
    const profileId = stored.inherited ? stored.inherited.profileId : stored.profileId ?? config.profiles.find(p => p.enabled)?.id ?? 'auto';
    const now = deps.now();
    const explained = explainProfile({ config, requestedModel: profileId, accounts: deps.accounts(), thread: stored.engine, health: withObserved(deps.health(config, threadId), stored.observed, now), now, ignoreHome: isSubthreadCodexId(profileId) });
    const subthreads = subthreadsPreview(config, profileId, deps.accounts(), withObserved(deps.health(config, threadId), null, now), now);
    return {
      name: profileName(config, profileId),
      text: previewText(config, explained.decision, explained.attempts, now),
      test: usesTestQuota(config, threadId),
      attempts: explained.attempts,
      config,
      ...(subthreads ? { subthreads } : {}),
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
      // «Подтред · Codex» без Codex идёт на «Авто» (0.3.4) — повтор готов, если готово «Авто».
      const { decision } = selectWithFallback({
        config, accounts: deps.accounts(),
        thread: { ...stored.engine, turnId: `retry-${now}`, lastRunAt: stored.lastRun?.at ?? null }, health: withObserved(deps.health(config, threadId), stored.observed, now, stored.modelBlocks), now,
      }, stored.inherited ? stored.inherited.profileId : stored.profileId ?? config.profiles.find(p => p.enabled)?.id ?? 'auto', stored.inherited ?? null);
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
    const requested = input.requestedModel ?? state.profileId ?? deps.profileHint?.(input.threadId) ?? config.profiles.find(p => p.enabled)?.id ?? 'auto';
    // Правило потомков предка (0.3.5) — тот же выбор, что у routeTurn.
    const rule = await inheritedRule(config, input.threadId, info, input.requestedModel ?? null);
    const profileId = rule ? rule.profileId : requested;
    const now = deps.now();
    const forever = await projectConsentsOf(projectId);
    const turnId = `peek-${now}`;
    // Согласие «на ход», перенесённое на автоповтор, действует и здесь: мост выберет Codex сразу.
    const carry = state.carryConsent && state.carryConsent.until > now ? config.steps.find(st => st.id === state.carryConsent!.stepId) : undefined;
    if (carry) forever.push(grant('turn', { stepId: carry.id, bindingEpoch: bindingEpoch(carry), threadId: input.threadId, turnId, projectId, now }, null));
    const { decision } = selectWithFallback({
      config, accounts: deps.accounts(), health: withObserved(deps.health(config, input.threadId), state.observed, now, state.modelBlocks), now,
      thread: { ...state.engine, projectId, homeHostId: state.engine.homeHostId ?? info?.hostId ?? null, turnId, skippedStepIds: [], consents: [...state.engine.consents, ...forever], lastRunAt: state.lastRun && state.lastRun.stepId === state.engine.currentStepId ? state.lastRun.at : null },
    }, profileId, rule);
    // Только решённый ход: при «нужно подтверждение» мост остаётся на текущем провайдере,
    // карточку покажет его ход, а сессия другого провайдера откроется уже после «Да».
    if (decision.kind !== 'run') return none;
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

  return { subthreadBypass, routeTurn, finishTurn, answerConfirmation, peekProvider, handoffBrief, nativeSessions, threadStatus, threadScheme, retryAvailability, turnLimits, turnModelUnavailable, syncTurn, turnProgress: threadId => prep.note(threadId) };
}
