import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accountPlan, claudeProfilePlan, DEFAULT_ACCOUNT_RULES, parseAccountRules, policiesForAccount, ruleFor, thresholdsFor } from './account-logic.ts';
import { assess, DEFAULT_THRESHOLDS, type QuotaWindow } from './logic.ts';
import { decideHold, DEFAULT_POLICIES, mergePolicies } from './priority-logic.ts';

const rules = parseAccountRules(DEFAULT_ACCOUNT_RULES).rules;
const now = Date.parse('2026-11-22T12:00:00Z');
const win = (label: string, kind: QuotaWindow['kind'], used: number, resetsInMin: number, eta: number | null = null): QuotaWindow =>
  ({ label, kind, model: null, usedPercent: used, resetsAt: new Date(now + resetsInMin * 60_000).toISOString(), etaMinutes: eta });

test('rules parse; bad lines are reported', () => {
  assert.deepEqual(parseAccountRules('$200: 80/85; Max 5x: 70 / 90\nnonsense; x: 120/5').rules,
    [{ match: '$200', short: 80, long: 85 }, { match: 'max 5x', short: 70, long: 90 }]);
  assert.deepEqual(parseAccountRules('nonsense; x: 120/5').errors, ['nonsense', 'x: 120/5']);
  assert.deepEqual(parseAccountRules('').rules, []);
});

test('$200 plans match, others do not', () => {
  const max20 = accountPlan('claude-code', 'Pro', claudeProfilePlan('claude_max', 'default_claude_max_20x'));
  assert.equal(max20, 'Max 20x $200');
  assert.equal(ruleFor(rules, { email: null, plan: max20 })?.short, 80);
  assert.equal(ruleFor(rules, { email: null, plan: accountPlan('codex', 'Pro', null) })?.long, 85);
  assert.equal(ruleFor(rules, { email: null, plan: accountPlan('claude-code', 'Max 5x', null) }), null);
  assert.equal(ruleFor(rules, { email: null, plan: accountPlan('claude-code', 'Pro', null) }), null);
  assert.equal(ruleFor(parseAccountRules('work@: 80/85').rules, { email: 'Work@example.com', plan: null })?.short, 80);
});

test('$200 account at 70% of the 5-hour window: no finish, no economy, no hold', () => {
  const rule = ruleFor(rules, { email: null, plan: 'Max 20x $200' });
  const windows = [win('Current session', 'five-hour', 70, 4 * 60, 8), win('Weekly limit', 'weekly', 30, 3 * 24 * 60)];
  // Fast pace (8 min to full) would mean finish under the shared thresholds…
  assert.equal(assess(windows, null, DEFAULT_THRESHOLDS).mode, 'finish');
  // …but the $200 rule lets work go on until 80%.
  assert.equal(assess(windows, null, thresholdsFor(DEFAULT_THRESHOLDS, rule)).mode, 'normal');
  const base = policiesForAccount(DEFAULT_POLICIES, rule);
  assert.equal(decideHold('low', base, windows, null, now).hold, false);
  // Another account keeps the old behaviour: a low-priority thread waits at 70% early in the window.
  assert.equal(decideHold('low', DEFAULT_POLICIES, windows, null, now).hold, true);
});

test('$200 account: work stops past 80% / 85%', () => {
  const rule = ruleFor(rules, { email: null, plan: 'Pro $200' });
  const t = thresholdsFor(DEFAULT_THRESHOLDS, rule);
  assert.equal(assess([win('Current session', 'five-hour', 81, 4 * 60)], null, t).mode, 'economy');
  assert.equal(assess([win('Weekly limit', 'weekly', 86, 3 * 24 * 60)], null, t).mode, 'normal'); // long economy stays 90
  const base = policiesForAccount(DEFAULT_POLICIES, rule);
  assert.equal(decideHold('low', base, [win('Current session', 'five-hour', 81, 5 * 60 - 1)], null, now).hold, true);
  assert.equal(decideHold('low', base, [win('Weekly limit', 'weekly', 86, 7 * 24 * 60 - 10)], null, now).hold, true);
  assert.equal(decideHold('low', base, [win('Weekly limit', 'weekly', 84, 7 * 24 * 60 - 10)], null, now).hold, false);
});

test('rules only raise thresholds; a thread\'s own thresholds still win', () => {
  const rule = { match: '$200', short: 50, long: 50 };
  assert.deepEqual(thresholdsFor(DEFAULT_THRESHOLDS, rule).short, DEFAULT_THRESHOLDS.short);
  assert.equal(policiesForAccount(DEFAULT_POLICIES, rule).long.low, 60);
  const base = policiesForAccount(DEFAULT_POLICIES, { match: '$200', short: 80, long: 85 });
  assert.equal(mergePolicies(base, { short: { low: 30, high: 50 } }).short.low, 30);
  assert.equal(thresholdsFor(DEFAULT_THRESHOLDS, null), DEFAULT_THRESHOLDS);
});
