import type { CascadeStep } from './cascade-passport.ts';
import type { Account, Snapshot } from './contract.ts';
import { unavailableVClaude } from './logic.ts';

/** Ступень шлюза VClaude (каскад 0.2.0: `kind: 'gateway'`, `accountKey: 'vclaude'`): её остаток — пакет VClaude, а не квота подписки машины. */
export const isVClaudeStep = (step: CascadeStep): boolean =>
  step.kind === 'gateway' && step.accountKey === 'vclaude';

/**
 * Снимок кольца для треда каскада — по текущей ступени: её провайдер, машина и
 * аккаунт. `account` — аккаунт ступени (подписка машины или пакет VClaude), если найден.
 * `viaVClaude` — расход идёт в пакет VClaude: главный признак — ступень `kind: 'gateway'`
 * VClaude; запасной — Claude Code машины ступени сам направлен на шлюз VClaude (0.3.1).
 * Тогда шапка та же, что у обычного треда на VClaude: остаток пакета (`gateway: 'vclaude'`).
 */
export function cascadeSnapshot(threadId: string, step: CascadeStep, profileId: string | null, hostName: string | null, account: Account | null,
  viaVClaude: boolean = isVClaudeStep(step)): Snapshot {
  const base: Snapshot = {
    threadId, providerId: step.providerId, model: step.model, hostId: step.hostId, hostName: hostName ?? step.hostId,
    binding: 'unavailable', message: null, account: null, cascade: { profileId, kind: step.kind },
  };
  if (viaVClaude) {
    return { ...base, binding: 'host-cli', gateway: 'vclaude', account: account ?? unavailableVClaude(step.hostId, base.hostName),
      message: account ? null : 'Ступень каскада идёт через шлюз VClaude: данные кабинета недоступны' };
  }
  if (step.kind === 'gateway' && !account) return { ...base, message: 'Ступень каскада идёт через шлюз: остаток считает каскад' };
  if (!account) return { ...base, binding: 'uncertain', message: 'CLI ступени не сообщил аккаунт' };
  // Подписка подтверждена входом CLI на машине ступени; другой шлюз — самим шлюзом.
  const confirmed = step.kind === 'gateway' || account.email !== null;
  return { ...base, account, binding: confirmed ? 'host-cli' : 'uncertain', message: confirmed ? null : 'CLI не сообщил идентификатор аккаунта' };
}
