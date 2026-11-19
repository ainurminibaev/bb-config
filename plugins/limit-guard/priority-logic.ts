// Low-priority threads: new turns wait while a watched window is above a threshold
// that floats with the time left until that window resets. Pure logic, no I/O.
import { appliesToModel, clock, type QuotaWindow, type WindowKind } from './logic.ts';

export type PriorityMode = 'normal' | 'low' | 'background';
export const PRIORITY_MODES: PriorityMode[] = ['normal', 'low', 'background'];
export type PolicyKey = 'short' | 'long' | 'model';

/** One window's rule: off, or a threshold from `low`% (window just reset) to `high`% (`nearMinutes` before reset). */
export interface WindowPolicy { enabled: boolean; low: number; high: number; nearMinutes: number }
export type Policies = Record<PolicyKey, WindowPolicy>;

export const DEFAULT_POLICIES: Policies = {
  short: { enabled: true, low: 40, high: 90, nearMinutes: 30 },
  long: { enabled: true, low: 60, high: 95, nearMinutes: 12 * 60 },
  model: { enabled: true, low: 60, high: 95, nearMinutes: 12 * 60 },
};
/** "Background" is stricter than "low": every threshold 20 points lower. */
export const BACKGROUND_SHIFT = 20;

const WINDOW_MS: Record<PolicyKey, number> = { short: 5 * 60 * 60_000, long: 7 * 24 * 60 * 60_000, model: 7 * 24 * 60 * 60_000 };
export const policyKey = (kind: WindowKind): PolicyKey => (kind === 'weekly' ? 'long' : kind === 'model' ? 'model' : 'short');
export const POLICY_LABEL: Record<PolicyKey, string> = { short: '5-часовое окно', long: 'недельное окно', model: 'окно модели' };
export const MODE_LABEL: Record<PriorityMode, string> = { normal: 'обычный', low: 'неприоритетный', background: 'фоновый' };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function normalizePolicy(raw: Partial<WindowPolicy>, d: WindowPolicy): WindowPolicy {
  const num = (v: unknown, def: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? clamp(Math.round(v), lo, hi) : def);
  const low = num(raw.low, d.low, 1, 100);
  return { enabled: typeof raw.enabled === 'boolean' ? raw.enabled : d.enabled, low, high: Math.max(low, num(raw.high, d.high, 1, 100)), nearMinutes: num(raw.nearMinutes, d.nearMinutes, 0, 7 * 24 * 60) };
}

export function policiesFor(mode: PriorityMode, base: Policies): Policies {
  if (mode !== 'background') return base;
  const shift = (p: WindowPolicy): WindowPolicy => ({ ...p, low: Math.max(5, p.low - BACKGROUND_SHIFT), high: Math.max(5, p.high - BACKGROUND_SHIFT) });
  return { short: shift(base.short), long: shift(base.long), model: shift(base.model) };
}

/**
 * Threshold now: `low` when the whole window is still ahead, `high` once at most
 * `nearMinutes` are left, linear in between. An unknown reset uses `high`:
 * missing data must not stop work.
 */
export function floatingThreshold(policy: WindowPolicy, key: PolicyKey, resetsAt: number | null, now: number): number {
  if (resetsAt === null || !Number.isFinite(resetsAt)) return policy.high;
  const length = WINDOW_MS[key];
  const near = policy.nearMinutes * 60_000;
  const left = clamp(resetsAt - now, 0, length);
  if (left <= near || length <= near) return policy.high;
  const passed = (length - left) / (length - near);
  return Math.round(policy.low + (policy.high - policy.low) * clamp(passed, 0, 1));
}

export type HoldDecision =
  | { hold: false; unknown: boolean; closest: { label: string; used: number; threshold: number } | null }
  | { hold: true; label: string; key: PolicyKey; used: number; threshold: number; resetsAt: number | null; exhausted: boolean };

export function decideHold(mode: PriorityMode, base: Policies, windows: QuotaWindow[] | null, model: string | null, now: number): HoldDecision {
  if (mode === 'normal') return { hold: false, unknown: false, closest: null };
  if (!windows || windows.length === 0) return { hold: false, unknown: true, closest: null };
  const policies = policiesFor(mode, base);
  let worst: { label: string; key: PolicyKey; used: number; threshold: number; resetsAt: number | null; margin: number } | null = null;
  for (const w of windows) {
    if (!appliesToModel(w, model)) continue;
    const key = policyKey(w.kind);
    const policy = policies[key];
    if (!policy.enabled) continue;
    const resetsAt = w.resetsAt ? Date.parse(w.resetsAt) : null;
    const threshold = floatingThreshold(policy, key, Number.isFinite(resetsAt) ? resetsAt : null, now);
    const margin = w.usedPercent - threshold;
    if (!worst || margin > worst.margin) worst = { label: w.label, key, used: Math.round(w.usedPercent), threshold, resetsAt: Number.isFinite(resetsAt) ? resetsAt : null, margin };
  }
  if (!worst) return { hold: false, unknown: false, closest: null };
  if (worst.margin >= 0) return { hold: true, label: worst.label, key: worst.key, used: worst.used, threshold: worst.threshold, resetsAt: worst.resetsAt, exhausted: worst.used >= 100 };
  return { hold: false, unknown: false, closest: { label: worst.label, used: worst.used, threshold: worst.threshold } };
}

export function holdReason(mode: PriorityMode, d: Extract<HoldDecision, { hold: true }>): string {
  // An exhausted window waits for its reset anyway: say so plainly, like a scheduled retry.
  if (d.exhausted) return `Лимит «${d.label}» исчерпан${d.resetsAt ? ` до ${clock(d.resetsAt)}` : ''} — отправится само после сброса.`;
  return `${MODE_LABEL[mode][0]!.toUpperCase()}${MODE_LABEL[mode].slice(1)} тред: «${d.label}» ${d.used}% при пороге ${d.threshold}% (порог растёт к сбросу окна). Отправится само, когда лимит станет ниже порога.`;
}

export function priorityStatus(mode: PriorityMode, d: HoldDecision, inheritedFrom: string | null): string {
  const who = inheritedFrom ? ` (от родителя ${inheritedFrom})` : '';
  if (mode === 'normal') return 'Обычный тред: задания не откладываются.';
  if (d.hold) return `${holdReason(mode, d)}${who}`;
  if (d.unknown) return `Режим «${MODE_LABEL[mode]}»${who}: данных о лимите нет — задания не откладываются.`;
  return `Режим «${MODE_LABEL[mode]}»${who}: задания идут${d.closest ? `; «${d.closest.label}» ${d.closest.used}% при пороге сейчас ${d.closest.threshold}%` : ''}.`;
}

/** Ask again soon, and right after the blocking window resets. */
export function nextCheckAt(d: Extract<HoldDecision, { hold: true }>, now: number, stepMs = 2 * 60_000): number {
  if (d.exhausted && d.resetsAt !== null && d.resetsAt > now) return d.resetsAt + 30_000;
  return d.resetsAt !== null && d.resetsAt > now ? Math.min(now + stepMs, d.resetsAt + 30_000) : now + stepMs;
}

export function parseMode(value: unknown): PriorityMode | null {
  const v = String(value ?? '').toLowerCase();
  if (['normal', 'off', 'обычный', 'выкл', 'no'].includes(v)) return 'normal';
  if (['low', 'on', 'неприоритетный', 'вкл', 'yes'].includes(v)) return 'low';
  if (['background', 'bg', 'фоновый', 'фон'].includes(v)) return 'background';
  return null;
}
