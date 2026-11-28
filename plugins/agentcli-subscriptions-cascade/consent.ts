// Согласия на вход в ступень с «спрашивать при входе» (cross-provider.md,
// «Карточка подтверждения»). Чистые функции.
// - turn: только этот логический ход этого треда;
// - thread: повторные входы в этом треде до сброса окна, вызвавшего переход (until), или до ручного отзыва;
// - forever: правило владельца для ступени в проекте, включая будущие треды.
// Смена машины, профиля, аккаунта или типа квоты меняет bindingEpoch — старое согласие не действует.
// Подтред — свой тред: разовые и тредовые согласия родителя в него не переходят.

export type ConsentScope = 'turn' | 'thread' | 'forever';

export interface Consent {
  stepId: string;
  bindingEpoch: string;
  scope: ConsentScope;
  threadId: string | null;
  turnId: string | null;
  projectId: string | null;
  /** Граница тредового согласия (сброс окна); null — до ручного отзыва. */
  until: number | null;
  grantedAt: number;
}

export interface ConsentContext {
  stepId: string;
  bindingEpoch: string;
  threadId: string;
  turnId: string;
  projectId: string;
  now: number;
}

export function consentCovers(consent: Consent, ctx: ConsentContext): boolean {
  if (consent.stepId !== ctx.stepId || consent.bindingEpoch !== ctx.bindingEpoch) return false;
  switch (consent.scope) {
    case 'turn': return consent.threadId === ctx.threadId && consent.turnId === ctx.turnId;
    case 'thread': return consent.threadId === ctx.threadId && (consent.until === null || ctx.now < consent.until);
    case 'forever': return consent.projectId === ctx.projectId;
  }
}

export function hasConsent(consents: readonly Consent[], ctx: ConsentContext): boolean {
  return consents.some(c => consentCovers(c, ctx));
}

/** Ответ карточки → согласие. `resetAt` — ближайший сброс окна, вызвавшего переход. */
export function grant(scope: ConsentScope, ctx: ConsentContext, resetAt: number | null): Consent {
  return {
    stepId: ctx.stepId, bindingEpoch: ctx.bindingEpoch, scope,
    threadId: scope === 'forever' ? null : ctx.threadId,
    turnId: scope === 'turn' ? ctx.turnId : null,
    projectId: scope === 'forever' ? ctx.projectId : null,
    until: scope === 'thread' ? resetAt : null,
    grantedAt: ctx.now,
  };
}

/** Удаляет истёкшие и неприменимые согласия (смена поколения связи). */
export function pruneConsents(consents: readonly Consent[], epochs: ReadonlyMap<string, string>, now: number): Consent[] {
  return consents.filter(c => epochs.get(c.stepId) === c.bindingEpoch && !(c.scope === 'thread' && c.until !== null && now >= c.until));
}
