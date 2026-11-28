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
import { isPinId, pinnedProfile, stepTitle } from './pins.ts';
import { isSubthreadCodexId, subthreadCodexProfile } from './subthreads.ts';

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
  /**
   * 0.3.7: когда закончился последний ход треда на `currentStepId` (мс). Ступень, на
   * которой тред работал недавно, при «квота неизвестна» не покидается.
   */
  lastRunAt?: number | null;
}

/** 0.3.7: сколько минут после хода ступень треда остаётся «своей» при неизвестной квоте. */
export const STICKY_UNKNOWN_MS = 60 * 60_000;

export interface PlanInput {
  config: CascadeConfig;
  /** ID профиля (он же ID модели провайдера) или устаревший `m:<ключ строки>`. */
  requestedModel: string;
  accounts: readonly DiscoveredAccount[];
  thread: Pick<ThreadCascadeState, 'isSubthread' | 'homeHostId'>;
  /**
   * 0.3.5: не держать подтред на машине родителя (S11). Откат Codex-подтреда на
   * «Авто»: маршрут Codex S11 не держит — и откат тоже не должен.
   */
  ignoreHome?: boolean;
}

export interface SelectInput extends PlanInput {
  thread: ThreadCascadeState;
  health: HealthLookup;
  now: number;
  /** Сколько ходов других тредов сейчас идут на ступени (для `maxConcurrent`). Нет — лимит не проверяется. */
  running?: (stepId: string) => number;
  /**
   * Машина, где рабочую папку уже пишет другой тред: из готовых попыток берутся
   * её, если они есть (писатели одной машины не ждут друг друга). Нет — обычный порядок.
   */
  preferHostId?: string | null;
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
  | { kind: 'wait'; until: number; stepId: string | null; waitingSince: number; reason: 'exhausted' | 'unknown' | 'busy';
      /** reason busy: сколько ходов уже идёт на ступени. */
      running?: number }
  | { kind: 'ask-owner'; reason: 'wait-too-long' | 'no-reset-known'; earliestReset: number | null }
  | { kind: 'unavailable'; reason: 'no-steps' | 'profile-disabled' | 'unknown-profile' | 'unknown-model' };

type Unavailable = Extract<Decision, { kind: 'unavailable' }>;

// ---- Профиль → план попыток ----

/** Профиль по ID модели провайдера. `m:<ключ>` — устаревший выбор модели = «только X». */
export function resolveProfile(config: CascadeConfig, requestedModel: string): Profile | Unavailable {
  const found = config.profiles.find(p => p.id === requestedModel);
  if (found) return found.enabled ? found : { kind: 'unavailable', reason: 'profile-disabled' };
  // Закреплённая ступень `pin:<stepId>[:<модель>]` (0.3.0): только эта ступень.
  if (isPinId(requestedModel)) return pinnedProfile(config, requestedModel) ?? { kind: 'unavailable', reason: 'unknown-profile' };
  // «Подтред · Codex» (0.3.4): синтетический, строится из ступеней каскада.
  if (isSubthreadCodexId(requestedModel)) return subthreadCodexProfile(config);
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
  return profile.confirm[step.id] ?? profile.confirmDefault ?? step.confirm;
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
  // Закреплённую ступень выбрал владелец явно — запрет «подтред только на машине родителя» на неё не действует.
  // «Подтред · Codex» (0.3.4) идёт на Codex любой машины — S11 тоже не действует.
  const pinned = isPinId(profile.id) || isSubthreadCodexId(profile.id) || input.ignoreHome === true;
  // S11 действует, только пока машина родителя есть среди ступеней каскада (0.3.1):
  // машину убрали или выключили — подтред идёт по общему профилю.
  const homeInCascade = parentHomeInCascade(config, thread.homeHostId);
  const offHome = (step: Step) => !pinned && homeInCascade && thread.isSubthread && !config.policies.subthreadsUseOtherMachines && thread.homeHostId !== null && step.hostId !== thread.homeHostId;
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
    // 0.4.0: модель важнее машины. Сначала модель по общему приоритету, внутри модели —
    // ступени по порядку профиля. Первая готовая попытка — лучшая доступная модель:
    // ход не уходит на ступень с моделью хуже, пока текущая модель есть на другой, а
    // возврат S4 на более высокую ступень — только к той же или лучшей модели.
    // Модель без ID на машине в план ступени не попадает (без попытки). Ступени без
    // строк таблицы своего провайдера (модель CLI по умолчанию) — после всех моделей.
    const priority = modelPriority(config);
    const live = steps.filter(({ step, excluded }) => !excluded && !offHome(step));
    const placedOn = new Set<string>();
    for (const r of priority) {
      for (const { step } of live) {
        if (step.providerId !== r.providerId) continue;
        const modelId = effectiveModelId(r, step.hostId, account(step.hostId, step.providerId));
        if (modelId === null) continue;
        placedOn.add(step.id);
        push(step, 'any', r, modelId, null);
      }
    }
    for (const { step } of live) if (!placedOn.has(step.id) && !priority.some(r => r.providerId === step.providerId && effectiveModelId(r, step.hostId, account(step.hostId, step.providerId)) !== null)) push(step, 'any', null, null, null);
    for (const { step, excluded } of steps) if (excluded || offHome(step)) push(step, 'any', null, null, excluded ? 'excluded' : 'subthread');
  }
  return out;
}

/** Есть ли у машины включённая ступень на включённой машине (правилу S11 есть куда вести). */
export function parentHomeInCascade(config: CascadeConfig, homeHostId: string | null): boolean {
  if (homeHostId === null) return false;
  const on = config.machines.some(m => m.hostId === homeHostId && m.enabled);
  return on && config.steps.some(s => s.enabled && s.hostId === homeHostId);
}

/** Подтред, у которого машина родителя ушла из каскада: S11 не применяется, нужна строка в ленте. */
export function parentHomeMissing(config: CascadeConfig, thread: Pick<ThreadCascadeState, 'isSubthread' | 'homeHostId'>): boolean {
  return thread.isSubthread && !config.policies.subthreadsUseOtherMachines && thread.homeHostId !== null && !parentHomeInCascade(config, thread.homeHostId);
}

/**
 * Почему в профиле нет ни одной ступени (0.3.1): по каждой ступени каскада —
 * машина или ступень выключена, исключена профилем, S11, нет модели на машине.
 */
export function explainNoSteps(input: PlanInput): string {
  const { config, thread } = input;
  if (config.steps.length === 0) return 'в каскаде нет ни одной ступени — добавьте машины в настройках «Каскада»';
  const plan = buildPlan(input);
  const attempts = Array.isArray(plan) ? plan : [];
  const profile = resolveProfile(config, input.requestedModel);
  const modelKey = 'kind' in profile ? null : profile.modelKey;
  const modelName = (modelKey ? config.models.find(r => r.key === modelKey)?.displayName : null) ?? modelKey ?? '';
  const home = thread.homeHostId ? config.machines.find(m => m.hostId === thread.homeHostId)?.label ?? thread.homeHostId : '—';
  const reasons = config.steps.map(step => {
    const machine = config.machines.find(m => m.hostId === step.hostId);
    const title = stepTitle(config, step);
    if (!machine) return `${title} — машины нет в каскаде`;
    if (!machine.enabled) return `${title} — машина выключена`;
    if (!step.enabled) return `${title} — ступень выключена`;
    const skips = new Set(attempts.filter(a => a.stepId === step.id).map(a => a.skip));
    if (skips.has(null)) return null;
    if (skips.has('excluded')) return `${title} — исключена профилем`;
    if (skips.has('subthread')) return `${title} — S11: подтред только на машине родителя ${home}`;
    if (skips.has('no-model')) return `${title} — нет модели ${modelName} на этой машине`;
    return `${title} — не участвует`;
  }).filter((r): r is string => r !== null);
  return `в профиле нет доступных ступеней: ${reasons.join('; ')}`;
}

// ---- План → решение ----

interface Candidate extends Attempt { step: Step; health: StepHealth }

/** Готова ли попытка к ходу: неизвестная квота — по профилю (0.3.5), иначе по настройке ступени. */
function isReady(c: Candidate, profileOnUnknown: Profile['onUnknown']): boolean {
  if (!c.health.available || c.health.exhausted) return false;
  return !c.health.unknown || (profileOnUnknown ?? c.step.onUnknown) === 'try';
}

export function selectStep(input: SelectInput): Decision {
  const plan = buildPlan(input);
  if (!Array.isArray(plan)) return plan;
  const { config, thread, now } = input;
  const all: Candidate[] = plan.filter(a => a.skip === null)
    .map(a => ({ ...a, step: config.steps.find(s => s.id === a.stepId)!, health: input.health(a.stepId, a.modelId) }));
  if (all.length === 0) return { kind: 'unavailable', reason: 'no-steps' };
  const resolved = resolveProfile(config, input.requestedModel);
  const onUnknown = 'kind' in resolved ? undefined : resolved.onUnknown;
  // 0.3.7: ступень, на которой тред работал недавно, с неизвестной квотой — готова
  // («липкая»): прерванный ход или устаревшее показание не уводят тред на другую машину.
  // Исчерпание и недоступность — как раньше.
  const sticky = (c: Candidate) => c.stepId === thread.currentStepId && c.health.available && !c.health.exhausted && c.health.unknown
    && thread.lastRunAt != null && now - thread.lastRunAt <= STICKY_UNKNOWN_MS;
  let freeAll = all.filter(c => (isReady(c, onUnknown) || sticky(c)) && !thread.skippedStepIds.includes(c.stepId));
  // 0.3.7: готовых нет, но есть ступени с неизвестной квотой (не исчерпаны, машина на
  // связи) — пробуем их по порядку профиля (`onUnknown: skip` значит «сначала известные»).
  // Ожидание сброса и вопрос владельцу — только когда всё действительно исчерпано.
  if (freeAll.length === 0) freeAll = all.filter(c => c.health.available && !c.health.exhausted && c.health.unknown && !thread.skippedStepIds.includes(c.stepId));
  const onWriterHost = input.preferHostId ? freeAll.filter(c => c.hostId === input.preferHostId) : [];
  const free = onWriterHost.length > 0 ? onWriterHost : freeAll;

  // Ступень занята (maxConcurrent): onBusy next — дальше по профилю, wait — ход ждёт
  // её освобождения, если раньше по порядку нет свободной ступени.
  const ready: Candidate[] = [];
  for (const c of free) {
    const running = c.step.maxConcurrent !== null && input.running ? input.running(c.stepId) : 0;
    if (c.step.maxConcurrent === null || running < c.step.maxConcurrent) { ready.push(c); continue; }
    if (c.step.onBusy === 'wait' && ready.length === 0) return busyWait(c, running, input);
  }
  if (ready.length === 0) {
    const busy = free[0];
    return busy ? busyWait(busy, input.running?.(busy.stepId) ?? 0, input) : waitOrAsk(all, input);
  }

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

/** Пауза перепроверки занятой ступени. */
export const BUSY_RECHECK_MS = 5_000;

function busyWait(c: Candidate, running: number, input: SelectInput): Decision {
  return { kind: 'wait', until: input.now + BUSY_RECHECK_MS, stepId: c.stepId, waitingSince: input.thread.waitingSince ?? input.now, reason: 'busy', running };
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
  /** 0.3.5: причина состояния лимита (например, «ступень не готова: …»). */
  reason?: string | null;
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
    return { ...a, state, chosen, reason: h.reason };
  });
  return { attempts, decision };
}

/** Новое состояние треда после решения (что запомнить к следующему ходу). */
export function nextThreadState(state: ThreadCascadeState, decision: Decision, now: number): ThreadCascadeState {
  switch (decision.kind) {
    case 'run':
      // Отсчёт «не раньше N минут» идёт с момента, когда тред встал на эту ступень,
      // включая первый ход (currentStepId ещё пуст): иначе тред, начавший не на
      // приоритетной ступени, возвращался сразу после её освобождения (живой S4).
      return { ...state, currentStepId: decision.stepId, currentModelId: decision.modelId, switchedAt: decision.stepId !== state.currentStepId ? now : state.switchedAt ?? now, waitingSince: null, skippedStepIds: [] };
    case 'wait':
      return { ...state, waitingSince: decision.waitingSince };
    default:
      return state;
  }
}
