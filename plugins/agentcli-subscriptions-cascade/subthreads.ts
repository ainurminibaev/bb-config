// Профиль «Авто · подтреды на Codex» (0.3.4). Чистые функции.
//
// Правило действует только на прямые подтреды треда, чей профиль помечен
// `subthreads: 'codex'`. Решает код каскада по parentThreadId и сохранённому
// профилю родителя, а не агент:
// - подтред ходит по синтетическому профилю «Подтред · Codex» (SUBTHREAD_CODEX_ID):
//   только ступени Codex, любая машина (S11 не держит), без подтверждения входа;
// - Codex исчерпан, выключен или квота неизвестна — ход идёт по «Авто», в ленту
//   подтреда и родителя уходит строка «Codex недоступен: … — подтред на Claude»;
// - занятость ступени (maxConcurrent) — как у всех: ход ждёт места;
// - сам подтред получает собственный профиль (`subthread-codex` или `auto`), а не
//   профиль родителя: правило не размножается вглубь.
import { AUTO_CODEX_CHILDREN_ID, AUTO_MODEL_ID, SUBTHREAD_CODEX_ID, type CascadeConfig, type Profile } from './contract.ts';
import type { Decision } from './engine.ts';

export const CODEX_PROVIDER_ID = 'codex';
export const SUBTHREAD_CODEX_NAME = 'Подтред · Codex';
export const AUTO_CODEX_CHILDREN_NAME = 'Авто · подтреды на Codex';

/** Встроенный профиль «Авто · подтреды на Codex»: сам тред — как «Авто». */
export function autoCodexChildrenProfile(): Profile {
  return {
    id: AUTO_CODEX_CHILDREN_ID, name: AUTO_CODEX_CHILDREN_NAME, enabled: true, policy: 'any', modelKey: null,
    stepOrder: null, excludedSteps: [], excludedProviders: [], confirm: {}, subthreads: 'codex',
  };
}

export const isSubthreadCodexId = (id: string | null | undefined): boolean => id === SUBTHREAD_CODEX_ID;

/**
 * Синтетический профиль подтреда: любые модели Codex по общему приоритету на
 * ступенях Codex в общем порядке каскада; ступени других провайдеров исключены,
 * подтверждение входа на ступени Codex выключено.
 */
export function subthreadCodexProfile(config: Pick<CascadeConfig, 'steps'>): Profile {
  const providers = [...new Set(config.steps.map(s => s.providerId))].filter(p => p !== CODEX_PROVIDER_ID);
  const confirm = Object.fromEntries(config.steps.filter(s => s.providerId === CODEX_PROVIDER_ID).map(s => [s.id, false] as const));
  return {
    id: SUBTHREAD_CODEX_ID, name: SUBTHREAD_CODEX_NAME, enabled: true, policy: 'any', modelKey: null,
    stepOrder: null, excludedSteps: [], excludedProviders: providers, confirm, subthreads: 'same',
  };
}

/**
 * Подтреды родителя идут на Codex? Только если профиль родителя есть в
 * настройках и помечен `subthreads: 'codex'`. Неизвестный профиль, закреплённая
 * ступень, «Авто», «Opus → Авто», родитель без каскада (profileId null) — нет.
 */
export function parentSendsChildrenToCodex(config: Pick<CascadeConfig, 'profiles'>, parentProfileId: string | null | undefined): boolean {
  if (!parentProfileId) return false;
  return config.profiles.some(p => p.id === parentProfileId && p.subthreads === 'codex');
}

/**
 * Почему ход Codex-подтреда уходит на «Авто»; null — остаётся на Codex
 * (ход, подтверждение или ожидание места на занятой ступени — как у всех).
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

/** Профиль, на который подтред уходит без Codex. */
export const SUBTHREAD_FALLBACK_PROFILE_ID = AUTO_MODEL_ID;

function utcTime(at: number): string {
  return `${new Date(at).toISOString().slice(11, 16)} UTC`;
}
