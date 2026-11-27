// Движок каскада: выбор ступени на следующий ход. Чистые функции, вызываются
// только между ходами — смена ступени посреди нативного вызова запрещена;
// ход, оборванный лимитом, закрывается как прерванный и снова приходит сюда.
//
// Ход выбирается по профилю каскада (пункт в списке моделей провайдера).
// `buildPlan` разворачивает профиль в упорядоченный план попыток
// «ступень × модель»; `selectStep` берёт из плана первую готовую попытку.
// Схема профиля на экране (`explainProfile`) строится из тех же двух функций,
// поэтому картинка и поведение не расходятся.
import { bindingEpoch } from './config.ts';
import { hasConsent, type Consent } from './consent.ts';
import { AUTO_MODEL_ID, MODEL_ID_PREFIX, type CascadeConfig, type DiscoveredAccount, type ModelRow, type Profile, type Step } from './contract.ts';
import type { StepHealth } from './limits.ts';
import { effectiveModelId } from './models.ts';

export type { StepHealth } from './limits.ts';
export type HealthLookup = (stepId: string, modelId: string | null) => StepHealth;

export interface ThreadCascadeState {
  threadId: string;
  projectId: string;
  /** Логический ход, для которого выбирается ступень. */
  turnId: string;
  /** Подтред: без разрешения не уходит с машины родителя. */
  isSubthread: boolean;
  /** Машина, на которой живёт тред (у подтреда — машина родителя). */
  homeHostId: string | null;
  /** Ступень прошлого хода. */
  currentStepId: string | null;
  /** Модель прошлого хода; не задана — текущая попытка ищется только по ступени. */
  currentModelId?: string | null;
  /** Когда тред последний раз сменил ступень (правило возврата N минут), мс. */
  switchedAt: number | null;
  /** С какого момента тред ждёт сброса, мс. */
  waitingSince: number | null;
  /** Согласия этого треда и постоянные правила проекта. */
  consents: readonly Consent[];
  /** «Пропустить ступень» в карточке: исключить на текущий выбор. */
  skippedStepIds: readonly string[];
}

export interface PlanInput {
  config: CascadeConfig;
  /** ID профиля (он же ID модели провайдера) или устаревший `m:<ключ строки>`. */
  requestedModel: string;
  accounts: readonly DiscoveredAccount[];
  thread: Pick<ThreadCascadeState, 'isSubthread' | 'homeHostId'>;
}

export interface SelectInput extends PlanInput {
  thread: ThreadCascadeState;
  health: HealthLookup;
  now: number;
}

export interface Target { stepId: string; hostId: string; providerId: string; modelId: string | null }

/** Попытка плана: ступень × модель. */
export interface Attempt extends Target {
  /** Ключ строки таблицы; null — модель CLI по умолчанию. */
  rowKey: string | null;
  /** Фаза профиля: только X, сначала X, любые по приоритету. */
  phase: 'only' | 'preferred' | 'any';
  /** «Спрашивать при входе» с учётом профиля. */
  confirm: boolean;
  /** Почему попытка не участвует: исключена профилем, нет модели на машине, подтред. */
  skip: 'excluded' | 'no-model' | 'subthread' | null;
}

export type Decision =
  | ({ kind: 'run'; fromStepId: string | null; switched: boolean; returning: boolean;
       /** Более приоритетная ступень свободна, но правило N минут держит текущую. */
       pendingReturn: Target | null } & Target)
  | ({ kind: 'confirm'; fromStepId: string | null;
       /** Тот же исполнитель, разовое согласие кончилось: «Продолжить ещё один ход?». */
       continuing: boolean;
       /** Сброс окна, из-за которого ушли с прежней ступени: граница тредового согласия. */
       triggerResetAt: number | null;
       skipped: readonly string[] } & Target)
  | { kind: 'wait'; until: number; stepId: string | null; waitingSince: number; reason: 'exhausted' | 'unknown' }
  | { kind: 'ask-owner'; reason: 'wait-too-long' | 'no-reset-known'; earliestReset: number | null }
  | { kind: 'unavailable'; reason: 'no-steps' | 'profile-disabled' | 'unknown-profile' | 'unknown-model' };

type Unavailable = Extract<Decision, { kind: 'unavailable' }>;

// ---- Профиль → план попыток ----

/** Профиль по ID модели провайдера. `m:<ключ>` — устаревший выбор модели = «только X». */
export function resolveProfile(config: CascadeConfig, requestedModel: string): Profile | Unavailable {
  const found = config.profiles.find(p => p.id === requestedModel);
  if (found) return found.enabled ? found : { kind: 'unavailable', reason: 'profile-disabled' };
  if (requestedModel.startsWith(MODEL_ID_PREFIX)) {
    return { id: requestedModel, name: requestedModel, enabled: true, policy: 'only', modelKey: requestedModel.slice(MODEL_ID_PREFIX.length), stepOrder: null, excludedSteps: [], excludedProviders: [], confirm: {} };
  }
  return { kind: 'unavailable', reason: requestedModel === AUTO_MODEL_ID ? 'profile-disabled' : 'unknown-profile' };
}

/**
 * Ступени профиля по порядку: включённые ступени на включённых машинах, в
 * своём порядке профиля (неупомянутые — в конце, в общем порядке) или в общем.
 * Исключённые остаются в списке с пометкой — схема показывает их серыми.
 */
export function profileSteps(config: CascadeConfig, profile: Profile): { step: Step; excluded: boolean }[] {
  const machinesOn = new Set(config.machines.filter(m => m.enabled).map(m => m.hostId));
  const base = config.steps.filter(s => s.enabled && machinesOn.has(s.hostId));
  let ordered = base;
  if (profile.stepOrder) {
    const index = new Map(profile.stepOrder.map((id, i) => [id, i]));
    ordered = [...base.filter(s => index.has(s.id)).sort((a, b) => index.get(a.id)! - index.get(b.id)!), ...base.filter(s => !index.has(s.id))];
  }
  return ordered.map(step => ({ step, excluded: profile.excludedSteps.includes(step.id) || profile.excludedProviders.includes(step.providerId) }));
}

/** Общий приоритет моделей: сначала из настроек, затем остальные включённые строки по таблице. */
export function modelPriority(config: CascadeConfig): ModelRow[] {
  const enabled = config.models.filter(r => r.enabled);
  const listed = config.policies.modelPriority.map(key => enabled.find(r => r.key === key)).filter((r): r is ModelRow => !!r);
  return [...new Set([...listed, ...enabled])];
}

export function stepConfirm(profile: Profile, step: Step): boolean {
  return profile.confirm[step.id] ?? step.confirm;
}

/**
 * План профиля: попытки «ступень × модель» в порядке, в котором движок их пробует.
 * - only: модель X по ступеням профиля;
 * - prefer-then-any: X по всем ступеням, затем фаза any без повторов;
 * - any: на каждой ступени модели по общему приоритету (с ассоциацией на машине);
 *   нет ни одной строки для провайдера ступени — модель CLI по умолчанию.
 */
export function buildPlan(input: PlanInput): Attempt[] | Unavailable {
  const { config, accounts, thread } = input;
  const profile = resolveProfile(config, input.requestedModel);
  if ('kind' in profile) return profile;
  const row = profile.policy === 'any' ? null : config.models.find(r => r.key === profile.modelKey && r.enabled);
  if (profile.policy !== 'any' && !row) return { kind: 'unavailable', reason: 'unknown-model' };
  const account = (hostId: string, providerId: string) => accounts.find(a => a.hostId === hostId && a.providerId === providerId);
  const steps = profileSteps(config, profile);
  const offHome = (step: Step) => thread.isSubthread && !config.policies.subthreadsUseOtherMachines && thread.homeHostId !== null && step.hostId !== thread.homeHostId;
  const out: Attempt[] = [];
  const seen = new Set<string>();
  const push = (step: Step, phase: Attempt['phase'], r: ModelRow | null, modelId: string | null, skip: Attempt['skip']) => {
    const key = skip === 'excluded' || skip === 'subthread' ? `${step.id}|${skip}` : `${step.id}|${skip ?? ''}|${modelId}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ stepId: step.id, hostId: step.hostId, providerId: step.providerId, modelId, rowKey: r?.key ?? null, phase, confirm: stepConfirm(profile, step), skip });
  };

  if (row) {
    const phase = profile.policy === 'only' ? 'only' : 'preferred';
    for (const { step, excluded } of steps) {
      // Модель без ассоциации на машине не участвует в каскаде этой машины.
      const modelId = step.providerId === row.providerId ? effectiveModelId(row, step.hostId, account(step.hostId, step.providerId)) : null;
      push(step, phase, row, modelId, excluded ? 'excluded' : offHome(step) ? 'subthread' : modelId ? null : 'no-model');
    }
  }
  if (profile.policy !== 'only') {
    const priority = modelPriority(config);
    for (const { step, excluded } of steps) {
      if (excluded || offHome(step)) { push(step, 'any', null, null, excluded ? 'excluded' : 'subthread'); continue; }
      const placed = priority
        .filter(r => r.providerId === step.providerId)
        .map(r => ({ r, modelId: effectiveModelId(r, step.hostId, account(step.hostId, step.providerId)) }))
        .filter(x => x.modelId !== null);
      if (placed.length === 0) push(step, 'any', null, null, null);
      for (const x of placed) push(step, 'any', x.r, x.modelId, null);
    }
  }
  return out;
}

// ---- План → решение ----

interface Candidate extends Attempt { step: Step; health: StepHealth }

/** Готова ли попытка к ходу: неизвестная квота — по настройке ступени. */
function isReady(c: Candidate): boolean {
  if (!c.health.available || c.health.exhausted) return false;
  return !c.health.unknown || c.step.onUnknown === 'try';
}

export function selectStep(input: SelectInput): Decision {
  const plan = buildPlan(input);
  if (!Array.isArray(plan)) return plan;
  const { config, thread, now } = input;
  const all: Candidate[] = plan.filter(a => a.skip === null)
    .map(a => ({ ...a, step: config.steps.find(s => s.id === a.stepId)!, health: input.health(a.stepId, a.modelId) }));
  if (all.length === 0) return { kind: 'unavailable', reason: 'no-steps' };
  const ready = all.filter(c => isReady(c) && !thread.skippedStepIds.includes(c.stepId));

  if (ready.length === 0) return waitOrAsk(all, input);

  const best = ready[0]!;
  const isCurrent = (c: Target) => c.stepId === thread.currentStepId && (thread.currentModelId === undefined || c.modelId === thread.currentModelId);
  const current = ready.find(isCurrent);
  let chosen = best;
  let pendingReturn: Target | null = null;
  if (current && current !== best) {
    // Возврат на более приоритетную попытку (S4) — между ходами (выбор идёт только
    // перед ходом), не раньше чем через N минут после перехода и только по
    // подтверждённой квоте: «неизвестно» с onUnknown: try возврата не даёт.
    const gateMs = config.policies.returnAfterMinutes * 60_000;
    const elapsed = thread.switchedAt === null ? Infinity : now - thread.switchedAt;
    if (elapsed < gateMs || best.health.unknown) { chosen = current; pendingReturn = target(best); }
  }
  const switched = thread.currentStepId !== null && chosen.stepId !== thread.currentStepId;
  const consented = hasConsent(thread.consents, {
    stepId: chosen.stepId, bindingEpoch: bindingEpoch(chosen.step), threadId: thread.threadId, turnId: thread.turnId, projectId: thread.projectId, now,
  });
  if (chosen.confirm && !consented) {
    const from = all.find(c => c.stepId === thread.currentStepId);
    return {
      kind: 'confirm', fromStepId: thread.currentStepId, continuing: chosen.stepId === thread.currentStepId,
      triggerResetAt: from?.health.exhausted ? from.health.resetsAt : null, skipped: thread.skippedStepIds, ...target(chosen),
    };
  }
  const order = all.findIndex(isCurrent);
  const returning = switched && order !== -1 && all.indexOf(chosen) < order;
  return { kind: 'run', fromStepId: thread.currentStepId, switched, returning, pendingReturn, ...target(chosen) };
}

/** Все попытки исчерпаны или неизвестны: ждать ближайшего сброса/проверки, но не дольше N часов. */
function waitOrAsk(all: readonly Candidate[], input: SelectInput): Decision {
  const { config, thread, now } = input;
  const since = thread.waitingSince ?? now;
  const limitMs = config.policies.exhaustedWaitHours * 3_600_000;
  const resets = all.filter(c => c.health.resetsAt !== null && c.health.resetsAt > now).sort((a, b) => a.health.resetsAt! - b.health.resetsAt!);
  const first = resets[0];
  if (first) {
    if (first.health.resetsAt! - since <= limitMs) return { kind: 'wait', until: first.health.resetsAt!, stepId: first.stepId, waitingSince: since, reason: 'exhausted' };
    return { kind: 'ask-owner', reason: 'wait-too-long', earliestReset: first.health.resetsAt };
  }
  // Сброс неизвестен, но есть ступени с неизвестной квотой — перепроверить через recheckMinutes.
  if (all.some(c => c.health.available && c.health.unknown)) {
    const until = now + config.policies.recheckMinutes * 60_000;
    if (until - since <= limitMs) return { kind: 'wait', until, stepId: null, waitingSince: since, reason: 'unknown' };
  }
  return { kind: 'ask-owner', reason: 'no-reset-known', earliestReset: null };
}

function target(c: Target): Target {
  return { stepId: c.stepId, hostId: c.hostId, providerId: c.providerId, modelId: c.modelId };
}

// ---- Схема профиля ----

export type AttemptState = 'available' | 'exhausted' | 'unknown' | 'unavailable';

export interface ExplainedAttempt extends Attempt {
  /** Лимит попытки цветом: есть, исчерпан, неизвестен, ступень недоступна. */
  state: AttemptState;
  /** Сюда пошёл бы ход прямо сейчас (run или confirm). */
  chosen: boolean;
}

/**
 * Схема профиля для экрана: тот же план и то же решение, что у движка.
 * `chosen` ставится по результату `selectStep`, а не вычисляется заново.
 */
export function explainProfile(input: SelectInput): { attempts: ExplainedAttempt[]; decision: Decision } {
  const decision = selectStep(input);
  const plan = buildPlan(input);
  if (!Array.isArray(plan)) return { attempts: [], decision };
  const picked = decision.kind === 'run' || decision.kind === 'confirm' ? decision : null;
  const attempts = plan.map(a => {
    const h = input.health(a.stepId, a.modelId);
    const state: AttemptState = !h.available ? 'unavailable' : h.exhausted ? 'exhausted' : h.unknown ? 'unknown' : 'available';
    const chosen = a.skip === null && picked !== null && picked.stepId === a.stepId && picked.modelId === a.modelId;
    return { ...a, state, chosen };
  });
  return { attempts, decision };
}

/** Новое состояние треда после решения (что запомнить к следующему ходу). */
export function nextThreadState(state: ThreadCascadeState, decision: Decision, now: number): ThreadCascadeState {
  switch (decision.kind) {
    case 'run':
      return { ...state, currentStepId: decision.stepId, currentModelId: decision.modelId, switchedAt: decision.switched ? now : state.switchedAt, waitingSince: null, skippedStepIds: [] };
    case 'wait':
      return { ...state, waitingSince: decision.waitingSince };
    default:
      return state;
  }
}
