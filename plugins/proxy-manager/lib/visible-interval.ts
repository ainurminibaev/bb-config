/** What startVisibleInterval needs from the page; tests pass a stand-in. */
export interface VisibilitySource {
  readonly visibilityState: string;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

/**
 * Runs `run` every `ms` while the browser tab is shown, and at once when a
 * hidden tab is shown again. A hidden tab does not poll the server. Returns
 * the function that stops it.
 */
export function startVisibleInterval(
  run: () => void,
  ms: number,
  page: VisibilitySource = document,
  timers: { set: (fn: () => void, ms: number) => unknown; clear: (id: unknown) => void } = {
    set: (fn, delay) => setInterval(fn, delay),
    clear: (id) => clearInterval(id as ReturnType<typeof setInterval>),
  },
): () => void {
  const shown = () => page.visibilityState !== 'hidden';
  const id = timers.set(() => { if (shown()) run(); }, ms);
  const onChange = () => { if (shown()) run(); };
  page.addEventListener('visibilitychange', onChange);
  return () => { timers.clear(id); page.removeEventListener('visibilitychange', onChange); };
}
