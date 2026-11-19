/** Pure rules of the low-priority hold. No BB access here. */

export type Scope = 'five-hour' | 'weekly' | 'any';
export type Flag = { percent: number; scope: Scope };

export function parseScope(value: unknown, fallback: Scope): Scope {
  const v = String(value ?? '').toLowerCase();
  if (['five-hour', '5h', '5', 'hour', 'session'].includes(v)) return 'five-hour';
  if (['weekly', 'week', 'w', '7d'].includes(v)) return 'weekly';
  if (['any', 'both', 'all'].includes(v)) return 'any';
  return fallback;
}
export const scopeLabel = (scope: Scope) => scope === 'five-hour' ? '5-часовое окно' : scope === 'weekly' ? 'недельный лимит' : '5-часовое окно или недельный лимит';
export type Window = { label: string; kind?: unknown; usedPercent: number; resetsAt?: string | null };
export type Decision = { hold: false } | { hold: true; label: string; usedPercent: number; percent: number; resetsAt: number | null };

export function clampPercent(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.min(100, Math.max(1, Math.round(n))) : fallback;
}

/** Only the two shared windows count: a per-model window is not "the limit I work in". */
export function sharedWindow(window: Window): 'five-hour' | 'weekly' | null {
  if (/fable|opus|sonnet|haiku|mythos/i.test(window.label)) return null;
  if (window.kind === 'five-hour' || /5.?hour|five.?hour|current session/i.test(window.label)) return 'five-hour';
  if (window.kind === 'weekly' || /week|7.?day|seven.?day/i.test(window.label)) return 'weekly';
  return null;
}

/** Hold when a window the thread watches is at or above the thread's percent. */
export function decide(flag: Flag | null, windows: readonly Window[] | null): Decision {
  if (!flag || !windows) return { hold: false };
  const over = windows.filter(w => { const k = sharedWindow(w); return k !== null && (flag.scope === 'any' || flag.scope === k); }).filter(w => Number.isFinite(w.usedPercent) && w.usedPercent >= flag.percent)
    .sort((a, b) => b.usedPercent - a.usedPercent)[0];
  if (!over) return { hold: false };
  const at = over.resetsAt ? Date.parse(over.resetsAt) : NaN;
  return { hold: true, label: sharedWindow(over) === 'five-hour' ? '5-часовое окно' : 'недельный лимит',
    usedPercent: Math.round(over.usedPercent), percent: flag.percent, resetsAt: Number.isFinite(at) ? at : null };
}

export function reason(d: Extract<Decision, { hold: true }>): string {
  return `Неприоритетный тред: ${d.label} ${d.usedPercent}% при пороге ${d.percent}%. Отправится само, когда лимит опустится ниже.`;
}

/** Ask again soon, but not after the window's own reset. */
export function nextCheck(d: Extract<Decision, { hold: true }>, now: number, stepMs = 5 * 60_000): number {
  return d.resetsAt !== null && d.resetsAt > now ? Math.min(now + stepMs, d.resetsAt + 30_000) : now + stepMs;
}
