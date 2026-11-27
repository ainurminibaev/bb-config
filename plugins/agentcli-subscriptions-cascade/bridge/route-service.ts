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
  RouteNote, RouteTurnInput, RouteTurnOutput, StageLabel, ThreadStatus,
} from './route-contract.ts';
import { answerConfirmationInputSchema, finishTurnInputSchema, handoffBriefInputSchema, nativeSessionsSchema, routeTurnInputSchema } from './route-contract.ts';

/** Ответ sync/ (SyncService.prepareTurn/finishTurn) в нужном здесь объёме. */
export type SyncOutcome =
  | { ok: true; cwd: string; env: Record<string, string>; timings: { step: string; hostId: string; from?: string; to?: string; seconds: number; ok: boolean; detail?: string }[]; notices: string[] }
  | { ok: false; reason: string; message: string; conflicts: string[]; timings: { step: string; hostId: string; from?: string; to?: string; seconds: number; ok: boolean; detail?: string }[]; notices: string[] };

export interface SyncPort {
  prepareTurn(thread: { threadId: string; projectId: string }, step: { hostId: string }): Promise<SyncOutcome>;
  finishTurn(thread: { threadId: string; projectId: string }, step: { hostId: string }): Promise<SyncOutcome>;
  /** Режим синхронизации проекта для паспорта. */
  modeOf?(config: CascadeConfig, projectId: string): string;
}

export interface ThreadInfo {
  projectId: string;
  /** Машина окружения треда — там работает мост. */
  hostId: string | null;
  parentThreadId: string | null;
  providerId: string;
}

/** Состояние треда в хранилище плагина: состояние движка + последний ход. */
export interface StoredThreadState {
  engine: ThreadCascadeState;
  profileId: string | null;
  lastRun: { stepId: string; hostId: string; providerId: string; modelId: string | null; at: number } | null;
  /** Ход на машине не-опоре ещё не вернул файлы (finishTurn не прошёл). */
  pendingFlushHostId: string | null;
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
  /** Постоянные правила «навсегда» проекта (карточка подтверждения). Нет порта — правил нет. */
  projectConsents?(projectId: string): Promise<Consent[]>;
  saveProjectConsents?(projectId: string, consents: Consent[]): Promise<void>;
  /** События треда после seq (по возрастанию) — для сводки и дельты другой нативной сессии. */
  threadEvents?(threadId: string, afterSeq: number): Promise<ThreadEventRow[]>;
}

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

  async function projectConsentsOf(projectId: string): Promise<Consent[]> {
    if (!projectId || !deps.projectConsents) return [];
    return deps.projectConsents(projectId).catch(error => { warn(`правила «навсегда»: ${String(error)}`); return []; });
  }

  async function routeTurn(raw: RouteTurnInput): Promise<RouteTurnOutput> {
    const input = routeTurnInputSchema.parse(raw);
    return serial(input.threadId, async () => {
      const config = await deps.loadConfig();
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
        return { action: 'refuse', retryable: false, message: 'Каскад подписок выключен (режим исполнения «off»). Включите режим «Свой провайдер» в настройках каскада или выберите штатный провайдер.', notes: [] };
      }

      const plannedSteps = config.steps.filter(s => s.enabled);
      await deps.refreshLimits(config, plannedSteps).catch(error => warn(`лимиты перед ходом: ${String(error)}`));
      // «Пропустить ступень» действует только на свой ход (тот же turnKey).
      const skipped = input.turnKey !== null && stored.skipTurnKey === input.turnKey ? stored.engine.skippedStepIds : [];
      const engine: ThreadCascadeState = {
        ...stored.engine, projectId, homeHostId: stored.engine.homeHostId ?? bridgeHost,
        turnId: input.turnKey ?? `turn-${now}`, skippedStepIds: skipped,
      };
      const forever = await projectConsentsOf(projectId);
      const decision: Decision = selectStep({
        config, requestedModel: profileId, accounts: deps.accounts(), thread: { ...engine, consents: [...engine.consents, ...forever] }, health: deps.health(config, input.threadId), now,
      });

      const save = (next: StoredThreadState) => deps.save(input.threadId, next).catch(error => warn(`состояние треда: ${String(error)}`));

      if (decision.kind === 'unavailable') {
        return { action: 'refuse', retryable: false, message: REFUSE_TEXT[decision.reason] ?? 'Каскад не нашёл ступень для хода.', notes: [{ kind: 'problem', message: REFUSE_TEXT[decision.reason] ?? decision.reason }] };
      }
      if (decision.kind === 'wait') {
        await save({ ...stored, profileId, engine: nextThreadState(engine, decision, now) });
        const note = decision.reason === 'exhausted' ? 'Лимиты исчерпаны на всех ступенях — жду сброса.' : 'Квота ступеней неизвестна — перепроверю позже.';
        return { action: 'refuse', retryable: true, message: `${note} До ${new Date(decision.until).toISOString()}.`, notes: [{ kind: 'wait', cause: decision.reason === 'exhausted' ? 'reset' : 'recheck', until: decision.until, note, ...(decision.stepId ? { stepId: decision.stepId } : {}) }] };
      }
      if (decision.kind === 'ask-owner') {
        const message = decision.reason === 'wait-too-long'
          ? 'Все ступени исчерпаны, а ближайший сброс позже порога ожидания — нужен ваш выбор.'
          : 'Все ступени недоступны, срок сброса неизвестен — нужен ваш выбор.';
        return { action: 'refuse', retryable: false, message, notes: [{ kind: 'problem', message }] };
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
        const message = `Следующая ступень — ${to.provider ?? decision.providerId} на ${to.machine}: этот ход ведёт ${providerLabel(input.provider)}, переход между провайдерами выполняется со следующего сообщения. Отправьте сообщение ещё раз.`;
        return { action: 'refuse', retryable: true, message, notes: [{ kind: 'problem', message: message.slice(0, 300), stage: to, stepId: decision.stepId }] };
      }
      const prev = stored.lastRun;
      const local = bridgeHost !== null && decision.hostId === bridgeHost;
      if (decision.switched || prev === null && !local) {
        const fromStage = prev ? stageLabel(config, prev) : null;
        const fromHealth = prev ? deps.health(config, input.threadId)(prev.stepId, prev.modelId) : null;
        const reason = prev === null ? 'start' : decision.returning ? 'return' : fromHealth?.exhausted ? 'limit' : fromHealth && !fromHealth.available ? 'unavailable' : 'error';
        notes.push({ kind: 'switch', reason, from: fromStage, to, resetAt: fromHealth?.resetsAt ?? null, stepId: decision.stepId });
      }

      let cwd: string | null = null;
      let env: Record<string, string> = {};
      const anchor = anchorHostId(config);
      const needsSync = deps.sync !== null && projectId !== '' && (decision.hostId !== anchor || stored.pendingFlushHostId !== null);
      if (needsSync) {
        const outcome = await deps.sync!.prepareTurn({ threadId: input.threadId, projectId }, { hostId: decision.hostId }).catch(error => ({
          ok: false as const, reason: 'error', message: error instanceof Error ? error.message : String(error), conflicts: [], timings: [], notices: [],
        }));
        notes.push(...syncNotes(config, outcome));
        if (!outcome.ok) {
          const message = `Файлы не готовы к ходу на ${to.machine}: ${outcome.message}`;
          notes.push({ kind: 'problem', message: message.slice(0, 300), stage: to, stepId: decision.stepId });
          // Ход не передан (S9): ступень и состояние треда не меняются.
          return { action: 'refuse', retryable: outcome.reason === 'busy', message, notes };
        }
        if (!local) cwd = outcome.cwd;
        env = outcome.env;
      }

      notes.push({ kind: 'run', stage: to, stepId: decision.stepId });
      notes.push({ kind: 'state', phase: 'running', stage: to, stepId: decision.stepId, profileId });
      await save({
        ...stored, profileId,
        engine: nextThreadState(engine, decision, now),
        lastRun: { stepId: decision.stepId, hostId: decision.hostId, providerId: decision.providerId, modelId: decision.modelId, at: now },
        pendingFlushHostId: decision.hostId !== anchor && needsSync ? decision.hostId : stored.pendingFlushHostId,
      });
      return { action: 'run', stepId: decision.stepId, hostId: decision.hostId, providerId: decision.providerId, modelId: decision.modelId, local, cwd, env, stage: to, notes };
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
      const stored = await deps.load(input.threadId).catch(() => undefined);
      const projectId = input.projectId ?? stored?.engine.projectId ?? '';
      const anchor = anchorHostId(config);
      if (deps.sync && projectId && input.hostId !== anchor && stored?.pendingFlushHostId === input.hostId) {
        const outcome = await deps.sync.finishTurn({ threadId: input.threadId, projectId }, { hostId: input.hostId }).catch(error => ({
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
            await save({ ...stored, engine: { ...stored.engine, projectId, consents: [...kept, consent] } });
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
      config, requestedModel: profileId, accounts: deps.accounts(), health: deps.health(config, input.threadId), now,
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

  return { routeTurn, finishTurn, answerConfirmation, peekProvider, handoffBrief, nativeSessions, threadStatus, threadScheme };
}
