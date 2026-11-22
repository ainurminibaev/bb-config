import type { Account, QuotaWindow } from './contract.ts';
export function classifyWindow(label: string, kind?: unknown): QuotaWindow['kind'] {
  if (/fable|opus|sonnet|haiku|mythos/i.test(label)) return 'model';
  if (kind === 'five-hour' || /5.?hour|five.?hour|current session/i.test(label)) return 'five-hour';
  if (kind === 'weekly' || /week|7.?day|seven.?day/i.test(label)) return 'weekly';
  return 'other';
}
export function appliesToModel(window: QuotaWindow, model: string | null): boolean {
  if (window.kind !== 'model') return true;
  return model !== null && ['fable', 'opus', 'sonnet', 'haiku', 'mythos'].some(
    family => window.label.toLowerCase().includes(family) && model.toLowerCase().includes(family));
}
export function riskyOverride(names: readonly string[], providerId: string): boolean {
  const risky = providerId === 'codex'
    ? ['CODEX_HOME', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY', 'OPENAI_API_BASE']
    : ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'];
  return names.some(name => risky.includes(name));
}
export function accountExhausted(account: Account): boolean {
  return account.status === 'ok' && account.windows.some(w =>
    (w.kind === 'five-hour' || w.kind === 'weekly') && w.usedPercent >= 100);
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
