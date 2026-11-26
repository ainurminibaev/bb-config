import { createReadStream } from 'node:fs';
import { open, opendir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { ConversionRate, VClaudeComparison } from './vclaude-contract';

const day = 86_400_000;
const windowLength = 7 * day;
const million = 1_000_000;
const catalogTtl = 60 * 60_000;
const calculationTtl = 15 * 60_000;
const apiDollarsPerMillionUnits = 5;
const tokenCount = z.number().finite().nonnegative().default(0);
const claudeUsage = z.object({
  input_tokens: tokenCount,
  output_tokens: tokenCount,
  cache_read_input_tokens: tokenCount,
  cache_creation_input_tokens: tokenCount,
  cache_creation: z.object({
    ephemeral_5m_input_tokens: tokenCount,
    ephemeral_1h_input_tokens: tokenCount,
  }).nullish(),
});
const logRow = z.object({
  timestamp: z.string(),
  requestId: z.string().optional(),
  message: z.object({ id: z.string().min(1), model: z.string(), usage: claudeUsage }),
});
const rowSchema = z.object({ sampled_at: z.number(), used_percent: z.number().min(0).max(100) });
type LimitSample = z.infer<typeof rowSchema>;
type Event = {
  at: number;
  key: string;
  model: string;
  usage: z.infer<typeof claudeUsage>;
};
type UsageTotals = {
  units: number;
  apiUsd: number;
  unpricedRequests: number;
  estimatedWriteRequests: number;
};
const apiCacheRead = new Map([
  ['fable-5-2', 0.20], ['fable-5-1', 0.25],
  ['opus-5-5', 0.20], ['sonnet-5-5', 0.10],
]);
const windowOrigin = 'https://vclaude.ru';

function normalizedModel(value: string) {
  return value.replace(/^(anthropic-)?claude-/, '').replace(/-\d{8}$/, '');
}

export function priceEvent(event: Event, rates: ReadonlyMap<string, ConversionRate>): UsageTotals {
  const name = normalizedModel(event.model);
  const u = event.usage;
  const five = u.cache_creation?.ephemeral_5m_input_tokens ?? 0;
  const hour = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  // Claude logs without a TTL break-down give only the combined write count.
  const unspecified = Math.max(0, u.cache_creation_input_tokens - five - hour);
  const inputSize = u.input_tokens + u.cache_read_input_tokens + five + hour + unspecified;
  const rate = rates.get(name);
  if (!rate) return { units: 0, apiUsd: 0, unpricedRequests: inputSize + u.output_tokens > 0 ? 1 : 0, estimatedWriteRequests: 0 };
  const base = (u.input_tokens * rate.input + u.output_tokens * rate.output +
    (five + unspecified) * rate.cacheWrite5m + hour * rate.cacheWrite1h) / million;
  const readUnits = u.cache_read_input_tokens * rate.cacheRead / million;
  const apiLongContextMultiplier = name === 'haiku-5-5' && inputSize > 100_000 ? 5 : 1;
  const readUsd = u.cache_read_input_tokens *
    (apiCacheRead.get(name) ?? rate.cacheRead * apiDollarsPerMillionUnits / million) / million;
  return {
    units: base + readUnits,
    apiUsd: (base * apiDollarsPerMillionUnits / million + readUsd) * apiLongContextMultiplier,
    unpricedRequests: 0,
    estimatedWriteRequests: unspecified > 0 ? 1 : 0,
  };
}

export function estimateComparison(samples: readonly LimitSample[], events: readonly Event[],
  rateCard: Readonly<Record<string, ConversionRate>>, now: number, resetsAt: number): VClaudeComparison['estimate'] {
  const rates = new Map(Object.entries(rateCard).map(([id, rate]) => [normalizedModel(id), rate]));
  const last = samples.at(-1);
  if (!last || !rates.size) return null;
  const sorted = [...events].sort((a, b) => a.at - b.at);
  const points = sorted.map(event => ({ event, cost: priceEvent(event, rates) }));
  function totals(start: number, end: number) {
    const result: UsageTotals = { units: 0, apiUsd: 0, unpricedRequests: 0, estimatedWriteRequests: 0 };
    for (const { event, cost } of points) {
      if (event.at >= end) break;
      if (event.at < start) continue;
      result.units += cost.units;
      result.apiUsd += cost.apiUsd;
      result.unpricedRequests += cost.unpricedRequests;
      result.estimatedWriteRequests += cost.estimatedWriteRequests;
    }
    return result;
  }
  const changes: { units: number; usd: number }[] = [];
  let base: LimitSample | undefined;
  for (const sample of samples) {
    if (!base || sample.used_percent < base.used_percent) {
      if (base) changes.length = 0;
      base = sample;
      continue;
    }
    const progress = sample.used_percent - base.used_percent;
    if (progress < 5 || sample.used_percent === 100) continue;
    const delta = totals(base.sampled_at, sample.sampled_at);
    if (delta.units > 0 && delta.apiUsd > 0 && delta.unpricedRequests === 0)
      changes.push({ units: delta.units / progress, usd: delta.apiUsd / progress });
    base = sample;
  }
  const byUnits = changes.map(change => change.units).sort((a, b) => a - b);
  const byUsd = changes.map(change => change.usd).sort((a, b) => a - b);
  const median = (xs: number[]) => (xs[Math.floor((xs.length - 1) / 2)] + xs[Math.floor(xs.length / 2)]) / 2;
  const observed = totals(Math.min(now - day, resetsAt - windowLength), now);
  const daily = totals(now - day, now);
  return {
    observedAt: new Date(last.sampled_at).toISOString(),
    resetsAt: new Date(resetsAt).toISOString(),
    weekProgress: last.used_percent,
    segments: changes.length,
    unitsPerPercent: changes.length >= 3 ? median(byUnits) : null,
    usdPerPercent: changes.length >= 3 ? median(byUsd) : null,
    unitsRange: changes.length >= 3 ? [byUnits[0], byUnits.at(-1)!] : null,
    dailyUnits: daily.units, dailyApiUsd: daily.apiUsd, unpricedRequests: observed.unpricedRequests,
    estimatedWriteRequests: observed.estimatedWriteRequests,
  };
}

export function readWeeklySamples(dbPath: string, resetsAt: number): LimitSample[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=1500');
    const filters = "provider_id = 'claude-code' AND label = 'Weekly limit' AND ABS(resets_at - ?) < 120000 AND sampled_at BETWEEN ? AND ?";
    const range = [resetsAt, resetsAt - windowLength, resetsAt];
    const keys = db.prepare(`SELECT DISTINCT account_key FROM limit_samples WHERE ${filters}`).all(...range);
    if (keys.length !== 1 || typeof keys[0].account_key !== 'string') return [];
    return z.array(rowSchema).parse(db.prepare(
      `SELECT sampled_at, used_percent FROM limit_samples WHERE ${filters} AND account_key = ? ORDER BY sampled_at`,
    ).all(...range, keys[0].account_key));
  } finally { db.close(); }
}

function createHistory(projects: string) {
  type CachedFile = { inode: number; modified: number; size: number; endsWithNewline: boolean; start: number; events: Event[] };
  const files = new Map<string, CachedFile>();

  async function* paths(directory: string): AsyncGenerator<string> {
    for await (const item of await opendir(directory)) {
      const filename = join(directory, item.name);
      if (item.isDirectory()) yield* paths(filename);
      else if (item.isFile() && item.name.endsWith('.jsonl')) yield filename;
    }
  }
  async function readEvents(filename: string, start: number, fromByte: number, endByte: number): Promise<Event[]> {
    const events: Event[] = [];
    if (fromByte >= endByte) return events;
    const stream = createReadStream(filename, { encoding: 'utf8', start: fromByte, end: endByte - 1 });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.includes('"usage"')) continue;
        let object: unknown;
        try { object = JSON.parse(line); } catch { continue; }
        const parsed = logRow.safeParse(object);
        if (!parsed.success) continue;
        const { message, requestId, timestamp } = parsed.data;
        const at = Date.parse(timestamp);
        if (!Number.isFinite(at) || at < start) continue;
        events.push({ key: `${message.id}:${requestId ?? ''}`, at, model: message.model, usage: message.usage });
      }
    } finally { lines.close(); stream.destroy(); }
    return events;
  }
  async function isComplete(filename: string, size: number) {
    if (!size) return true;
    const file = await open(filename, 'r');
    try {
      const byte = Buffer.alloc(1);
      return (await file.read(byte, 0, 1, size - 1)).bytesRead === 1 && byte[0] === 10;
    } finally { await file.close(); }
  }

  return async (start: number): Promise<Event[]> => {
    const unique = new Map<string, Event>();
    const existing = new Set<string>();
    for await (const filename of paths(projects)) {
      let file;
      try { file = await stat(filename); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      if (file.mtimeMs < start) continue;
      existing.add(filename);
      let cached = files.get(filename);
      if (!cached || cached.inode !== file.ino || cached.modified !== file.mtimeMs || cached.size !== file.size || cached.start > start) {
        try {
          const prior = cached && cached.inode === file.ino && cached.size < file.size &&
            cached.endsWithNewline && cached.start <= start ? cached : undefined;
          const next = await readEvents(filename, start, prior?.size ?? 0, file.size);
          cached = {
            inode: file.ino, modified: file.mtimeMs, size: file.size, start,
            endsWithNewline: await isComplete(filename, file.size),
            events: prior ? [...prior.events.filter(event => event.at >= start), ...next] : next,
          };
          files.set(filename, cached);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
      }
      for (const event of cached.events) {
        const previous = unique.get(event.key);
        if (event.at >= start && (!previous || event.usage.output_tokens > previous.usage.output_tokens)) unique.set(event.key, event);
      }
    }
    for (const path of files.keys()) if (!existing.has(path)) files.delete(path);
    return [...unique.values()];
  };
}

export function createComparisonReader(projects: string, database: () => string,
  resolveWeek: () => Promise<number | null>, conversionRates: () => Promise<Record<string, ConversionRate>>) {
  const history = createHistory(projects);
  let catalog: { at: number; values: VClaudeComparison['catalog'] } | undefined;
  let committed: { at: number; value: VClaudeComparison } | undefined;
  let pending: Promise<VClaudeComparison> | undefined;

  async function readCatalog() {
    if (catalog && Date.now() - catalog.at < catalogTtl) return catalog.values;
    try {
      const response = await fetch(windowOrigin + '/api/public/tariffs', { redirect: 'error', signal: AbortSignal.timeout(7000) });
      if (!response.ok) throw new Error('Catalog unavailable');
      const items = z.array(z.object({
        name: z.string(), price_minor: z.number().nonnegative(),
        limit_units: z.number().positive(), period_days: z.number().int().positive(),
      }));
      const raw = await response.json();
      const plans = items.parse(Array.isArray(raw) ? raw : raw.tariffs);
      const values = plans.map(p => ({
        name: p.name, priceRub: p.price_minor / 100, limitUnits: p.limit_units, periodDays: p.period_days,
      }));
      if (values.length) catalog = { at: Date.now(), values };
    } catch { /* Retain the last confirmed public catalog. */ }
    return catalog?.values ?? [];
  }

  async function compute(): Promise<VClaudeComparison> {
    const plans = readCatalog();
    let estimate: VClaudeComparison['estimate'] = null;
    let message: string | null = null;
    try {
      const [reset, rates] = await Promise.all([resolveWeek(), conversionRates()]);
      if (!reset || !Object.keys(rates).length) throw new Error('Inputs unavailable');
      const now = Date.now();
      const samples = readWeeklySamples(database(), reset);
      const last = samples.at(-1);
      if (!last || now - last.sampled_at > 3 * 60 * 60_000) throw new Error('No current samples');
      const events = await history(Math.min(reset - windowLength, now - day));
      estimate = estimateComparison(samples, events, rates, now, reset);
    } catch {
      message = 'Нет свежей пары замеров недельного окна и истории токенов Claude на сервере.';
    }
    return { catalog: await plans, estimate, message };
  }

  return async (refresh = false) => {
    if (pending) return pending;
    if (committed && Date.now() - committed.at < (refresh ? 60_000 : calculationTtl)) return committed.value;
    pending = compute().then(value => {
      committed = { at: Date.now(), value };
      return value;
    });
    try { return await pending; } finally { pending = undefined; }
  };
}
