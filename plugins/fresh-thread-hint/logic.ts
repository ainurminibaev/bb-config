/** Pure decision and wording for the hint. No BB or browser access here. */

/** Claude's prompt cache lifetime in BB sessions (1 hour). */
export const CACHE_TTL_MINUTES = 60;
/** API price ratios against plain input: a cache read and a 1-hour cache write. */
export const CACHE_READ_RATE = 0.1;
export const CACHE_WRITE_RATE = 2;

export type HintInput = {
  providerId: string;
  status: string;
  usedTokens: number | null;
  lastActivityAt: number | null;
  now: number;
  minTokens: number;
  idleMinutes: number;
};

export type Hint = { show: false } | {
  show: true;
  usedTokens: number;
  idleMinutes: number;
  lastActivityAt: number;
};

/** Show only for an idle Claude thread that is both large and past the cache lifetime. */
export function decide(input: HintInput): Hint {
  if (input.providerId !== 'claude-code' || input.status !== 'idle') return { show: false };
  if (input.usedTokens === null || input.lastActivityAt === null) return { show: false };
  if (input.usedTokens < input.minTokens) return { show: false };
  const idleMinutes = Math.floor((input.now - input.lastActivityAt) / 60_000);
  if (idleMinutes < Math.max(input.idleMinutes, 1)) return { show: false };
  return { show: true, usedTokens: input.usedTokens, idleMinutes, lastActivityAt: input.lastActivityAt };
}

/** How many ordinary (warm) messages one cold message costs: 2.0 / 0.1 = 20. */
export function coldMessageFactor(): number {
  return Math.round(CACHE_WRITE_RATE / CACHE_READ_RATE);
}

/** Assumed size of a thread right after a handoff: system prompt, tools and the briefing. */
export const FRESH_THREAD_TOKENS = 30_000;

/** How much cheaper a message is in a fresh thread: cost follows context size, cold or warm. */
export function savingPercent(usedTokens: number): number {
  if (usedTokens <= FRESH_THREAD_TOKENS) return 0;
  return Math.round((1 - FRESH_THREAD_TOKENS / usedTokens) * 100);
}

export function formatTokens(tokens: number): string {
  return tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1).replace('.', ',')} млн` : `${Math.round(tokens / 1000)} тыс.`;
}

export function formatIdle(minutes: number): string {
  if (minutes < 120) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} ч` : `${Math.floor(hours / 24)} дн`;
}
