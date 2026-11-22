// Thresholds per account: a bigger subscription can run further into its windows.
// Pure logic, no I/O.
import type { Thresholds } from './logic.ts';
import type { Policies, WindowPolicy } from './priority-logic.ts';

/** "Work goes on up to `short`% of the five-hour window and `long`% of the weekly and model windows." */
export interface AccountRule { match: string; short: number; long: number }

/** Default: subscriptions at $200 a month (Claude Max 20x, ChatGPT Pro) work up to 80% / 85%. */
export const DEFAULT_ACCOUNT_RULES = '$200: 80/85';

/**
 * Rules typed by a person, separated by ";" or new lines: `<match>: <5-hour>/<weekly>`.
 * `<match>` is part of the plan ("$200", "Max 20x") or of the account e-mail.
 * Lines that do not parse are skipped and reported.
 */
export function parseAccountRules(text: string | null | undefined): { rules: AccountRule[]; errors: string[] } {
  const rules: AccountRule[] = []; const errors: string[] = [];
  for (const raw of String(text ?? '').split(/[;\n]/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(.+?)\s*:\s*(\d{1,3})\s*\/\s*(\d{1,3})$/.exec(line);
    const short = m ? Number(m[2]) : NaN; const long = m ? Number(m[3]) : NaN;
    if (!m || short < 1 || short > 100 || long < 1 || long > 100) { errors.push(line); continue; }
    rules.push({ match: m[1]!.trim().toLowerCase(), short, long });
  }
  return { rules, errors };
}

export interface AccountInfo { email: string | null; plan: string | null }

/** First rule whose text is part of the plan label or of the e-mail. */
export function ruleFor(rules: AccountRule[], account: AccountInfo | null): AccountRule | null {
  if (!account) return null;
  const plan = (account.plan ?? '').toLowerCase(); const email = (account.email ?? '').toLowerCase();
  return rules.find(r => (plan && plan.includes(r.match)) || (email && email.includes(r.match))) ?? null;
}

/**
 * Claude plan from the profile Claude Code keeps in ~/.claude.json. BB's own
 * label comes from the sign-in and stays "Pro" after an upgrade until the next sign-in.
 */
export function claudeProfilePlan(organizationType: string | null | undefined, rateLimitTier: string | null | undefined): string | null {
  const type = (organizationType ?? '').toLowerCase(); const tier = (rateLimitTier ?? '').toLowerCase();
  const multiplier = /max_(\d+)x/.exec(tier)?.[1];
  if (type === 'claude_max' || /claude_max/.test(tier)) return multiplier ? `Max ${multiplier}x` : 'Max';
  if (type === 'claude_pro' || /claude_pro/.test(tier)) return 'Pro';
  if (type === 'claude_team' || /team/.test(type)) return 'Team';
  if (type === 'claude_enterprise' || /enterprise/.test(type)) return 'Enterprise';
  return null;
}

/** Monthly price in USD, so a rule can say "$200" for any provider. */
export function planPrice(providerId: string, plan: string | null | undefined): string {
  const p = (plan ?? '').toLowerCase().replace(/[\s_-]/g, '');
  if (!p) return '';
  if (/free/.test(p)) return '$0';
  if (providerId === 'claude-code') {
    if (/max/.test(p)) return /20x/.test(p) ? '$200' : /5x/.test(p) ? '$100' : '';
    if (p === 'pro') return '$20';
  } else if (providerId === 'codex') {
    if (p === 'prolite') return '$100';
    if (p === 'promax') return '$500';
    if (p === 'pro') return '$200';
    if (p === 'plus') return '$20';
    if (p === 'go') return '$8';
  }
  return '';
}

/** "Max 20x $200", "Pro $200", or null when the plan is unknown. */
export function accountPlan(providerId: string, bbPlan: string | null, profilePlan: string | null): string | null {
  const plan = profilePlan ?? bbPlan;
  if (!plan) return null;
  const price = planPrice(providerId, plan);
  return price ? `${plan} ${price}` : plan;
}

/**
 * Raise the thresholds to the account rule, never lower them: economy starts no
 * earlier than the rule, finish stays above economy, and the pace check waits
 * until the window reaches the rule.
 */
export function thresholdsFor(t: Thresholds, rule: AccountRule | null): Thresholds {
  if (!rule) return t;
  const level = (l: Thresholds['short'], at: number) => {
    const economy = Math.max(l.economy, at);
    return { economy, finish: Math.max(l.finish, Math.min(100, economy + 1)) };
  };
  return { ...t, short: level(t.short, rule.short), long: level(t.long, rule.long), paceFrom: Math.max(t.paceFrom ?? 0, rule.short) };
}

/** Low-priority holds start no earlier than the rule; the threshold still grows towards the reset. */
export function policiesForAccount(p: Policies, rule: AccountRule | null): Policies {
  if (!rule) return p;
  const lift = (w: WindowPolicy, at: number): WindowPolicy => {
    const low = Math.max(w.low, at);
    return { ...w, low, high: Math.max(w.high, low) };
  };
  return { short: lift(p.short, rule.short), long: lift(p.long, rule.long), model: lift(p.model, rule.long) };
}
