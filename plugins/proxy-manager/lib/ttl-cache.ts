/**
 * A small time-limited cache with a size bound. When full, the oldest entry
 * leaves first. `now` is injectable for tests.
 */
export class TtlCache<V> {
  private readonly entries = new Map<string, { at: number; value: V }>();
  private readonly ttlMs: number;
  private readonly max: number;
  private readonly now: () => number;
  constructor(ttlMs: number, max = 100, now: () => number = Date.now) { this.ttlMs = ttlMs; this.max = max; this.now = now; }

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.now() - entry.at >= this.ttlMs) { this.entries.delete(key); return undefined; }
    return entry.value;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    while (this.entries.size >= this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { at: this.now(), value });
  }

  /** Removes the entry; with `expected`, only while it still holds that value. */
  delete(key: string, expected?: V): void {
    if (expected !== undefined && this.entries.get(key)?.value !== expected) return;
    this.entries.delete(key);
  }

  clear(): void { this.entries.clear(); }
  get size(): number { return this.entries.size; }
}

/**
 * Returns the cached promise for `key` or starts `load` once and caches it.
 * Callers arriving while it runs share it; a failed load is not kept, so the
 * next call asks again.
 */
export function cachedLoad<V>(cache: TtlCache<Promise<V>>, key: string, load: () => Promise<V>): Promise<V> {
  const hit = cache.get(key);
  if (hit) return hit;
  const pending = load();
  cache.set(key, pending);
  pending.catch(() => cache.delete(key, pending));
  return pending;
}
