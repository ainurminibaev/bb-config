/**
 * Паспорт треда «Каскада подписок» — мягкое чтение. Одинаковая копия лежит в
 * каждом плагине, который его читает (limit-guard, thread-account-usage,
 * codex-delegation-watch, file-local-open, project-open): сборка плагина не
 * берёт файлы из соседних папок. Правьте все копии вместе.
 *
 * Контракт: RPC `agentcli-subscriptions-cascade.threadStatus({ threadId })` →
 * `{ cascade: true, profileId, step: { hostId, providerId, model, accountKey, kind },
 *    anchorHostId, syncMode, path, freshCopyHostId }`. Неизвестные поля
 * игнорируются. Каскад не установлен, выключен, не ответил или ответил не по
 * контракту — `null`, и плагин ведёт себя как без каскада.
 */

export const CASCADE_PLUGIN_ID = 'agentcli-subscriptions-cascade';
/** providerId треда, которым управляет каскад. */
export const CASCADE_PROVIDER_ID = 'agentcli-subscriptions-cascade';
export const CASCADE_STATUS_METHOD = 'threadStatus';

export type CascadeStepProvider = 'claude-code' | 'codex';
export interface CascadeStep {
  hostId: string;
  providerId: CascadeStepProvider;
  model: string | null;
  accountKey: string | null;
  kind: 'subscription' | 'gateway';
}
export interface CascadePassport {
  profileId: string | null;
  /** Текущая ступень; `null` — каскад ещё не выбрал ступень (тред ждёт). */
  step: CascadeStep | null;
  anchorHostId: string | null;
  syncMode: string | null;
  path: string | null;
  freshCopyHostId: string | null;
}

const obj = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

export const isCascadeProvider = (providerId: unknown): boolean => providerId === CASCADE_PROVIDER_ID;

/** Терпимый разбор ответа каскада. Всё, что не по контракту, — `null` (как без каскада). */
export function parsePassport(raw: unknown): CascadePassport | null {
  const r = obj(raw);
  if (!r || r.cascade !== true) return null;
  const s = obj(r.step);
  let step: CascadeStep | null = null;
  if (s) {
    const hostId = str(s.hostId);
    const providerId = s.providerId === 'claude-code' || s.providerId === 'codex' ? s.providerId : null;
    // Неизвестный вид ступени не угадываем: без квоты провайдера он ведёт себя как шлюз.
    const kind = s.kind === 'subscription' ? 'subscription' : 'gateway';
    if (hostId && providerId) step = { hostId, providerId, model: str(s.model), accountKey: str(s.accountKey), kind };
  }
  return {
    profileId: str(r.profileId), step, anchorHostId: str(r.anchorHostId), syncMode: str(r.syncMode),
    path: str(r.path), freshCopyHostId: str(r.freshCopyHostId),
  };
}

/** Вызов RPC каскада; плагин передаёт свою обёртку над `bb.sdk.plugins.callRpc`. */
export type PassportCall = (threadId: string, signal: AbortSignal) => Promise<unknown>;

/**
 * Паспорт треда или `null`. Никогда не бросает. Каскад спрашивается только
 * для треда каскада: у треда `claude-code`/`codex` и любого другого — сразу `null`,
 * без вызовов.
 */
export async function readPassport(call: PassportCall, thread: { id: string; providerId?: unknown }, timeoutMs = 3_000): Promise<CascadePassport | null> {
  if (!isCascadeProvider(thread.providerId)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const answer = await Promise.race([
      call(thread.id, controller.signal),
      new Promise<null>(resolve => controller.signal.addEventListener('abort', () => resolve(null), { once: true })),
    ]);
    return parsePassport(answer);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Кэш паспортов на короткое время: опросы по таймеру не дёргают каскад на каждый тред. */
export function passportCache(call: PassportCall, ttlMs = 30_000, timeoutMs = 3_000) {
  const saved = new Map<string, { at: number; value: CascadePassport | null }>();
  return async (thread: { id: string; providerId?: unknown }): Promise<CascadePassport | null> => {
    if (!isCascadeProvider(thread.providerId)) return null;
    const hit = saved.get(thread.id);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value;
    const value = await readPassport(call, thread, timeoutMs);
    saved.set(thread.id, { at: Date.now(), value });
    if (saved.size > 500) saved.delete(saved.keys().next().value!);
    return value;
  };
}

/**
 * Где лежат файлы треда каскада: машина со свежей копией (иначе опорная) и
 * общий путь. `null` — брать окружение треда, как без каскада.
 */
export function cascadeFolder(passport: CascadePassport | null): { hostId: string; path: string } | null {
  if (!passport?.path) return null;
  const hostId = passport.freshCopyHostId ?? passport.anchorHostId ?? passport.step?.hostId ?? null;
  return hostId ? { hostId, path: passport.path } : null;
}
