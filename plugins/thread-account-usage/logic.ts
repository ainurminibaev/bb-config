import type { Account, QuotaWindow } from './contract.ts';
export function classifyWindow(label: string, kind?: unknown): QuotaWindow['kind'] {
  if (/fable|opus|sonnet|haiku|mythos/i.test(label)) return 'model';
  if (kind === 'five-hour' || /5.?hour|five.?hour|current session/i.test(label)) return 'five-hour';
  if (kind === 'weekly' || /week|7.?day|seven.?day/i.test(label)) return 'weekly';
  return 'other';
}
export function appliesToModel(window: QuotaWindow, model: string | null): boolean {
  // Antigravity groups: a Gemini quota does not limit a Claude model and back.
  if (window.scope?.length) return model === null || window.scope.some(family => model.toLowerCase().includes(family));
  if (window.kind !== 'model') return true;
  return model !== null && ['fable', 'opus', 'sonnet', 'haiku', 'mythos'].some(
    family => window.label.toLowerCase().includes(family) && model.toLowerCase().includes(family));
}
/**
 * Claude's usage endpoint is rate limited. Then Claude Code answers with the
 * five-hour and weekly windows only, and per-model windows (Fable) vanish.
 * Keep the last known per-model window of the same account until it resets.
 */
export function carryModelWindows(fresh: QuotaWindow[], previous: readonly QuotaWindow[] | undefined, now: number): QuotaWindow[] {
  if (!previous?.length) return fresh;
  const present = new Set(fresh.filter(w => w.kind === 'model').map(w => w.label.toLowerCase()));
  const carried = previous.filter(w => w.kind === 'model' && !present.has(w.label.toLowerCase()) &&
    w.resetsAt !== null && Date.parse(w.resetsAt) > now);
  return carried.length ? [...fresh, ...carried] : fresh;
}
export function riskyOverride(names: readonly string[], providerId: string): boolean {
  const risky = providerId === 'codex'
    ? ['CODEX_HOME', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY', 'OPENAI_API_BASE']
    : ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'];
  return names.some(name => risky.includes(name));
}
/** Providers whose only quota is a prepaid package ('other'): spent package = no work. */
export const packageProviders = new Set(['vclaude', 'acp-gemini-antig']);
export const isPackageAccount = (account: Pick<Account, 'providerId'>) => packageProviders.has(account.providerId);
export function accountExhausted(account: Account): boolean {
  if (account.status !== 'ok') return false;
  const full = (w: QuotaWindow) => (w.kind === 'five-hour' || w.kind === 'weekly' || packageProviders.has(account.providerId)) && w.usedPercent >= 100;
  if (account.windows.some(w => !w.scope?.length && full(w))) return true;
  // Scoped groups (Gemini, Claude+GPT): the account is blocked only when every group is.
  const groups = new Map<string, boolean>();
  for (const w of account.windows.filter(w => w.scope?.length)) {
    const key = w.scope!.join('+');
    groups.set(key, (groups.get(key) ?? false) || full(w));
  }
  return groups.size > 0 && [...groups.values()].every(Boolean);
}
export function dedupeAccounts(accounts: Account[]): Account[] {
  const result = new Map<string, Account>();
  for (const account of accounts) {
    const key = account.email ? `${account.providerId}:${account.email.toLowerCase()}` : account.key;
    const previous = result.get(key);
    if (!previous) { result.set(key, { ...account, key }); continue; }
    const hosts = [...new Set([...previous.hostIds, ...account.hostIds])];
    const names = [...new Set([...previous.hostNames, ...account.hostNames])];
    const newer = account.status === 'ok' && (previous.status !== 'ok' ||
      Date.parse(account.fetchedAt ?? '') > Date.parse(previous.fetchedAt ?? ''));
    const chosen = newer ? account : previous;
    result.set(key, { ...chosen, key, hostIds: hosts, hostNames: names,
      resetCount: chosen.resetCount ?? (newer ? previous.resetCount : account.resetCount) ?? null });
  }
  return [...result.values()];
}

/**
 * Claude plan from the account profile that Claude Code keeps fresh in
 * ~/.claude.json. BB itself reads `subscriptionType` from the sign-in, which
 * stays "pro" after an upgrade to Max until the user signs in again.
 */
export function claudeProfilePlan(organizationType: string | null | undefined, rateLimitTier: string | null | undefined): string | null {
  const type = (organizationType ?? '').toLowerCase();
  const tier = (rateLimitTier ?? '').toLowerCase();
  const multiplier = /max_(\d+)x/.exec(tier)?.[1];
  if (type === 'claude_max' || /claude_max/.test(tier)) return multiplier ? `Max ${multiplier}x` : 'Max';
  if (type === 'claude_pro' || /claude_pro/.test(tier)) return 'Pro';
  if (type === 'claude_team' || /team/.test(type)) return 'Team';
  if (type === 'claude_enterprise' || /enterprise/.test(type)) return 'Enterprise';
  return null;
}

/** Codex plan ids BB leaves as-is ("Prolite", "Promax") get readable names. */
export function displayPlan(providerId: string, plan: string | null | undefined): string {
  if (!plan) return '';
  if (providerId === 'codex') {
    const names: Record<string, string> = { prolite: 'Pro Lite', promax: 'Pro Max' };
    return names[plan.toLowerCase().replace(/[\s_-]/g, '')] ?? plan;
  }
  return plan;
}

/** Monthly price of a plan in USD — a static table, shown as a hint only. */
export function planPrice(providerId: string, plan: string | null | undefined): string {
  const p = (plan ?? '').toLowerCase().replace(/[\s_-]/g, '');
  if (!p) return '';
  if (/free/.test(p)) return '$0';
  if (providerId === 'claude-code') {
    if (/max/.test(p)) return /20x/.test(p) ? '$200' : /5x/.test(p) ? '$100' : '';
    if (p === 'pro') return '$20';
  } else if (providerId === 'codex') {
    // ChatGPT Pro has three tiers: $100, $200 and $500 a month.
    if (p === 'prolite') return '$100';
    if (p === 'promax') return '$500';
    if (p === 'pro') return '$200';
    if (p === 'plus') return '$20';
    if (p === 'go') return '$8';
  }
  return '';
}

/** "Max 20x $200", "Pro Lite $100", "Plus", or "" when the plan is unknown. */
export function planLabel(providerId: string, plan: string | null | undefined): string {
  if (!plan) return '';
  const name = displayPlan(providerId, plan);
  const price = planPrice(providerId, plan);
  return price ? `${name} ${price}` : name;
}

/**
 * One scale for every way of billing (docs/customizations.md, «Единая шкала лимитов»):
 * a bar is the used share, its tick is the share of the period already gone —
 * a 5-hour or weekly window until its reset, a package's 30 days until it expires.
 */
const HOUR = 3_600_000;
export function periodMs(window: QuotaWindow): number | null {
  if (window.endsAt) return 30 * 24 * HOUR;
  if (window.kind === 'five-hour') return 5 * HOUR;
  if (window.kind === 'weekly' || window.kind === 'model') return 7 * 24 * HOUR;
  return null;
}
/** Percent of the window's period already gone, or null when its end or length is unknown. */
export function pace(window: QuotaWindow, now: number): number | null {
  const end = Date.parse(window.endsAt ?? window.resetsAt ?? '');
  const period = periodMs(window);
  if (!Number.isFinite(end) || period === null) return null;
  return Math.max(0, Math.min(100, 100 * (1 - (end - now) / period)));
}
/** Spending runs well ahead of time (15 points or more), or the window is nearly spent. */
export function ahead(window: QuotaWindow, now: number): boolean {
  if (window.usedPercent >= 90) return true;
  const gone = pace(window, now);
  return gone !== null && window.usedPercent >= 20 && window.usedPercent - gone >= 15;
}
/** A package that will expire mostly unused: three quarters of its term gone, 40 points under pace. */
export function wasteRisk(window: QuotaWindow, now: number): boolean {
  if (!window.endsAt) return false;
  const gone = pace(window, now);
  return gone !== null && gone >= 75 && window.usedPercent < gone - 40;
}

const millions = (v: number) => v >= 1e6 ? `${(v / 1e6).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} млн` : `${Math.round(v / 1e3)} тыс.`;
/**
 * VClaude package in its own units and in Opus tokens: model rates are units per
 * million tokens, so tokens ≈ remaining units ÷ (rate ÷ 1e6).
 */
export function vclaudeNote(remaining: number, limit: number, rates: Record<string, { input: number; output: number }>): string {
  const opus = Object.keys(rates).filter(id => /opus/i.test(id)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).at(-1);
  const rate = opus ? rates[opus] : undefined;
  const name = opus?.replace(/^anthropic-claude-/, '').replace(/^opus-(\d+)-(\d+)$/, 'Opus $1.$2') ?? '';
  const tokens = rate && rate.input > 0 && rate.output > 0
    ? ` ≈ ${millions(remaining / (rate.input / 1e6))} вх. или ${millions(remaining / (rate.output / 1e6))} вых. токенов ${name}` : '';
  return `осталось ${millions(remaining)} из ${millions(limit)} ед.${tokens}`;
}

/**
 * Rows of the accounts list: one per model group. A 5-hour and a weekly
 * window of the same group share a row (thick bar = 5 h, thin = week); a
 * per-model cap (Fable) and a package keep their own row.
 */
export type WindowRow = { name: string; five: QuotaWindow | null; week: QuotaWindow | null; single: QuotaWindow | null };
const groupName = (account: Pick<Account, 'providerId'>, w: QuotaWindow) =>
  w.scope?.length ? (w.scope.includes('gemini') ? 'Gemini' : 'Claude')
    : w.kind === 'model' || w.kind === 'other' ? w.label
    : account.providerId === 'codex' ? 'Codex' : 'Claude';
export function windowRows(account: Pick<Account, 'providerId' | 'windows'>): WindowRow[] {
  const rows: WindowRow[] = [];
  for (const w of account.windows) {
    const name = groupName(account, w);
    const pairable = w.kind === 'five-hour' || w.kind === 'weekly';
    const row = pairable ? rows.find(r => r.name === name && !r.single) : undefined;
    if (row && w.kind === 'five-hour' && !row.five) row.five = w;
    else if (row && w.kind === 'weekly' && !row.week) row.week = w;
    else rows.push(pairable ? { name, five: w.kind === 'five-hour' ? w : null, week: w.kind === 'weekly' ? w : null, single: null }
      : { name, five: null, week: null, single: w });
  }
  return rows;
}
/** The window that sets a row's percent and timer: the busier of the two. */
export const rowLead = (r: WindowRow): QuotaWindow =>
  r.single ?? (r.five && r.week ? (r.week.usedPercent > r.five.usedPercent ? r.week : r.five) : (r.five ?? r.week)!);
/**
 * Host of the endpoint Claude Code on a machine sends requests to: env.ANTHROPIC_BASE_URL
 * from its settings.json, else the process environment. Only the host name leaves the
 * machine, never tokens. null — the default Anthropic route or an unreadable value.
 */
export function claudeBaseHost(settings: unknown, envUrl?: string | null): string | null {
  const env = settings && typeof settings === 'object' ? (settings as { env?: unknown }).env : undefined;
  const fromSettings = env && typeof env === 'object' ? (env as Record<string, unknown>).ANTHROPIC_BASE_URL : undefined;
  const raw = typeof fromSettings === 'string' && fromSettings.trim() ? fromSettings.trim() : envUrl?.trim();
  if (!raw) return null;
  try { return new URL(raw).hostname.toLowerCase() || null; } catch { return null; }
}
/** Machines whose Claude Code is routed to `targetHost`, in the order of the current host list. */
export function routedHosts(routes: ReadonlyMap<string, { name: string; baseHost: string | null }>,
  targetHost: string, hosts?: readonly { id: string; name: string }[]): { ids: string[]; names: string[] } {
  const list = hosts ?? [...routes].map(([id, r]) => ({ id, name: r.name }));
  const hit = list.filter(h => routes.get(h.id)?.baseHost === targetHost.toLowerCase());
  return { ids: hit.map(h => h.id), names: hit.map(h => h.name) };
}
