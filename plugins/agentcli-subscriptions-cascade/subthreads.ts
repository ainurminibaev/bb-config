// Профиль как правило на дерево тредов (0.3.4–0.3.5). Чистые функции.
//
// Профиль = self (как идёт сам тред: policy, ступени, модели) + descendants
// (по какому профилю идут все его потомки). «Авто · подтреды на Codex»:
// self = «Авто», descendants = `subthread-codex` («Подтред · Codex»: только
// ступени Codex на любой машине, без подтверждения, неизвестная квота — пробовать).
//
// Наследование делает каскад, а не агент (route-service.ts): подтред без явного
// профиля (или с профилем родителя из BB_CASCADE_PROFILE) получает descendants
// ближайшего предка, у профиля которого оно задано. Явный выбор (pin:…, другой
// профиль) действует только на этот подтред; его потомки снова наследуют правило
// предка. Профиль без descendants ничего не меняет: потомки идут по своему профилю.
import { AUTO_CODEX_CHILDREN_ID, AUTO_MODEL_ID, SUBTHREAD_CODEX_ID, type CascadeConfig, type Profile } from './contract.ts';
import type { Decision } from './engine.ts';

export const CODEX_PROVIDER_ID = 'codex';
export const SUBTHREAD_CODEX_NAME = 'Подтред · Codex';
export const AUTO_CODEX_CHILDREN_NAME = 'Авто · подтреды на Codex';
/** Сколько предков просматривается в поиске правила (защита от циклов и длинных цепочек). */
export const MAX_ANCESTOR_DEPTH = 10;

/** Встроенный профиль «Авто · подтреды на Codex»: сам тред — как «Авто». */
export function autoCodexChildrenProfile(): Profile {
  return {
    id: AUTO_CODEX_CHILDREN_ID, name: AUTO_CODEX_CHILDREN_NAME, enabled: true, policy: 'any', modelKey: null,
    stepOrder: null, excludedSteps: [], excludedProviders: [], confirm: {}, descendants: SUBTHREAD_CODEX_ID, onDescendantsExhausted: 'wait',
  };
}

export const isSubthreadCodexId = (id: string | null | undefined): boolean => id === SUBTHREAD_CODEX_ID;

/**
 * Синтетический профиль «Подтред · Codex»: любые модели Codex по общему приоритету
 * на ступенях Codex в общем порядке каскада; ступени других провайдеров исключены,
 * подтверждение входа на ступени Codex выключено. Неизвестная квота — попробовать
 * ступень (`onUnknown: try`, 0.3.5): лимит придёт из хода (`account/rateLimits/updated`).
 */
export function subthreadCodexProfile(config: Pick<CascadeConfig, 'steps'>): Profile {
  const providers = [...new Set(config.steps.map(s => s.providerId))].filter(p => p !== CODEX_PROVIDER_ID);
  const confirm = Object.fromEntries(config.steps.filter(s => s.providerId === CODEX_PROVIDER_ID).map(s => [s.id, false] as const));
  return {
    id: SUBTHREAD_CODEX_ID, name: SUBTHREAD_CODEX_NAME, enabled: true, policy: 'any', modelKey: null,
    stepOrder: null, excludedSteps: [], excludedProviders: providers, confirm, onUnknown: 'try',
  };
}

/** Правило потомков профиля: какой профиль и что делать, когда он исчерпан. */
export interface DescendantsRule {
  /** Профиль потомков (ID из настроек, `pin:…` или `subthread-codex`). */
  profileId: string;
  onExhausted: 'wait' | 'fallback';
}

/** descendants профиля с учётом поля 0.3.4 (`subthreads: 'codex'`). */
export function descendantsOf(profile: Pick<Profile, 'descendants' | 'subthreads'>): string | null {
  if (profile.descendants) return profile.descendants;
  return profile.subthreads === 'codex' ? SUBTHREAD_CODEX_ID : null;
}

/**
 * Правило потомков профиля из настроек. null — правила нет (профиль не из
 * настроек: `pin:…`, `subthread-codex`, неизвестный; или descendants не задан).
 */
export function descendantsRule(config: Pick<CascadeConfig, 'profiles'>, profileId: string | null | undefined): DescendantsRule | null {
  if (!profileId) return null;
  const p = config.profiles.find(x => x.id === profileId && x.enabled);
  if (!p) return null;
  const target = descendantsOf(p);
  if (!target || target === profileId) return null;
  return { profileId: target, onExhausted: p.onDescendantsExhausted ?? 'wait' };
}

/**
 * Наследует ли подтред правило предка: профиль не выбран явно. Явный выбор — любой
 * профиль, кроме: нет профиля; профиль по умолчанию (BB подставляет его, когда
 * `--model` не задан); профиль родителя (BB_CASCADE_PROFILE); профиль владельца
 * правила или сам профиль правила.
 */
export function inheritsRule(requested: string | null, candidates: { defaultProfileId: string | null; parentProfileId: string | null; ownerProfileId: string; ruleProfileId: string }): boolean {
  if (!requested) return true;
  return [candidates.defaultProfileId, candidates.parentProfileId, candidates.ownerProfileId, candidates.ruleProfileId].includes(requested);
}

/** Совместимость 0.3.4: подтреды родителя на правиле Codex. */
export function parentSendsChildrenToCodex(config: Pick<CascadeConfig, 'profiles'>, parentProfileId: string | null | undefined): boolean {
  return isSubthreadCodexId(descendantsRule(config, parentProfileId)?.profileId);
}

/**
 * Почему ход по правилу Codex уходит на «Авто» (режим `fallback`); null — остаётся
 * на Codex (ход, подтверждение или ожидание места на занятой ступени — как у всех).
 */
export function codexFallbackReason(decision: Decision, formatTime: (at: number) => string = utcTime): string | null {
  switch (decision.kind) {
    case 'run':
    case 'confirm':
      return null;
    case 'wait':
      if (decision.reason === 'busy') return null;
      return decision.reason === 'exhausted' ? `лимит Codex исчерпан до ${formatTime(decision.until)}` : 'квота Codex неизвестна';
    case 'ask-owner':
      return decision.earliestReset !== null ? `лимит Codex исчерпан до ${formatTime(decision.earliestReset)}` : 'лимиты Codex исчерпаны, сброс неизвестен';
    case 'unavailable':
      return decision.reason === 'no-steps' ? 'ступени Codex выключены или их нет в каскаде' : 'профиль подтреда недоступен';
  }
}

/** Строка ленты подтреда (и родителя) о переходе на Claude. */
export function codexUnavailableLine(reason: string): string {
  return `Codex недоступен: ${reason} — подтред на Claude`;
}

/** Профиль, на который потомок уходит в режиме `fallback`. */
export const SUBTHREAD_FALLBACK_PROFILE_ID = AUTO_MODEL_ID;

function utcTime(at: number): string {
  return `${new Date(at).toISOString().slice(11, 16)} UTC`;
}
