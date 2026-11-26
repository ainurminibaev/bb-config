// Volume of a quota window in tokens, measured: between two readings the
// tokens agy spent (all machines of the account, from its conversation
// stores) are set against how far the provider's own used percent moved.
// An interval is dropped when the window was reset in between, when a
// machine is missing from either reading, or when totals went down (a
// conversation was deleted). Volume = Σ tokens ÷ Σ percent × 100.
import type { GroupTotals, TokenTotals } from './agy-tokens.ts';

export type MeterWindow = { used: number; resetsAt: string | null; group: keyof GroupTotals };
export type MeterReading = { at: number; hosts: Record<string, GroupTotals>; windows: Record<string, MeterWindow> };
export type MeterSums = Record<string, { tokens: number; percent: number; samples: number }>;

const all = (t: TokenTotals) => t.input + t.cacheRead + t.cacheWrite + t.output;

export function accumulate(prev: MeterReading | null, cur: MeterReading, sums: MeterSums): MeterSums {
  if (!prev) return sums;
  const hosts = Object.keys(cur.hosts);
  if (!hosts.length || hosts.length !== Object.keys(prev.hosts).length || hosts.some(h => !prev.hosts[h])) return sums;
  const next = { ...sums };
  for (const [label, w] of Object.entries(cur.windows)) {
    const before = prev.windows[label];
    if (!before) continue;
    if (before.resetsAt && Date.parse(before.resetsAt) <= cur.at) continue;
    const percent = w.used - before.used;
    const deltas = hosts.map(h => all(cur.hosts[h]![w.group]) - all(prev.hosts[h]![w.group]));
    if (percent < 0 || deltas.some(d => d < 0)) continue;
    const tokens = deltas.reduce((a, b) => a + b, 0);
    if (!tokens && !percent) continue;
    const s = next[label] ?? { tokens: 0, percent: 0, samples: 0 };
    next[label] = { tokens: s.tokens + tokens, percent: s.percent + percent, samples: s.samples + 1 };
  }
  return next;
}

/** Tokens a whole window holds, once enough of it has been spent to say. */
export function windowVolume(s: MeterSums[string] | undefined): number | null {
  return s && s.percent >= 2 && s.samples >= 2 ? s.tokens / s.percent * 100 : null;
}
