/** Pure timing logic: which expanded parents are due to be collapsed again. */

export interface Tick {
  /** Parents that are expanded now and have been for at least `delayMs`. */
  collapse: string[];
  /** Updated "expanded since" times, only for parents still expanded. */
  since: Map<string, number>;
}

/**
 * `parents` are threads with at least one active subthread, `collapsed` is the
 * thread-list `collapsedThreads` preference. A parent that is not collapsed is
 * expanded: by the user's click or by a new subthread appearing under it.
 * Either way its clock starts the first time it is seen expanded.
 */
export function tick(parents: Iterable<string>, collapsed: ReadonlySet<string>, previous: ReadonlyMap<string, number>, now: number, delayMs: number): Tick {
  const since = new Map<string, number>();
  const collapse: string[] = [];
  for (const id of new Set(parents)) {
    if (collapsed.has(id)) continue;
    const start = previous.get(id) ?? now;
    if (now - start >= delayMs) collapse.push(id);
    else since.set(id, start);
  }
  return { collapse, since };
}

export function clampMinutes(value: unknown, fallback = 5): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(1440, Math.max(1, n));
}
