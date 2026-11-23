/** How often the route badge asks the server while a turn runs in its thread. */
export const BUSY_POLL_MS = 5_000;
/** How often it asks while the thread is idle, or for a new thread without an id. */
export const IDLE_POLL_MS = 30_000;
/** Realtime channel on which the server announces a thread's turn starting or ending. */
export const THREAD_ACTIVITY_CHANNEL = 'thread-activity';

/** Thread statuses (SDK `ThreadStatus`) after which no turn is running. */
const RESTING = new Set(['idle', 'error']);

/** True while BB reports a turn starting, running or stopping in the thread. Unknown values count as running, so the badge polls faster, not slower. */
export function isBusyStatus(status: string): boolean { return !RESTING.has(status); }

export function pollInterval(threadId: string | null, busy: boolean | null | undefined): number {
  return threadId && busy ? BUSY_POLL_MS : IDLE_POLL_MS;
}

/** How long a Claude process check stays trusted: a little longer than the polling interval, so an idle badge does not flash "checking". */
export function claudeFreshMs(busy: boolean | null | undefined): number {
  return busy ? 15_000 : 45_000;
}

/** The thread id from a thread-activity signal, or null for anything else. */
export function activityThreadId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const id = (payload as { threadId?: unknown }).threadId;
  return typeof id === 'string' && id ? id : null;
}
