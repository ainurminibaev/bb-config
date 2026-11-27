import { isCascadeProvider, type CascadePassport } from './cascade-passport.ts';
import type { Assessment } from './logic.ts';

/** Чьи лимиты считать для треда: провайдер и машина. */
export interface Runtime {
  providerId: string;
  hostId: string;
  /** Тред каскада: лимиты — текущей ступени, в «финиш» не уводим. */
  cascade: boolean;
  /** Ступень через API-шлюз: квоты подписки у неё нет, остаток считает каскад. */
  gateway: boolean;
}

/**
 * Обычный тред — его провайдер и машина окружения, как раньше. Тред каскада —
 * текущая ступень из паспорта; паспорта нет (каскад не установлен или не
 * ответил) — `null`, как у любого провайдера без лимитов подписки.
 */
export function runtimeOf(row: { providerId: string; environmentHostId: string | null }, passport: CascadePassport | null, supported: ReadonlySet<string>): Runtime | null {
  if (!isCascadeProvider(row.providerId)) {
    return supported.has(row.providerId) && row.environmentHostId
      ? { providerId: row.providerId, hostId: row.environmentHostId, cascade: false, gateway: false } : null;
  }
  const step = passport?.step;
  if (!step || !supported.has(step.providerId)) return null;
  return { providerId: step.providerId, hostId: step.hostId, cascade: true, gateway: step.kind !== 'subscription' };
}

export const CASCADE_NOTE = 'тред каскада: на исходе ступени каскад сам перейдёт на следующую между ходами, поэтому вместо «финиша» — экономный режим';

/** Каскад переключает ступень сам: «финиш» для его треда смягчается до экономного режима. */
export function forCascade(a: Assessment, cascade: boolean): Assessment {
  if (!cascade || a.mode !== 'finish') return a;
  return { ...a, mode: 'economy', reason: a.reason ? `${a.reason}; ${CASCADE_NOTE}` : CASCADE_NOTE };
}
