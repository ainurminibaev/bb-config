import test from 'node:test';
import assert from 'node:assert/strict';
import { accountExhausted, appliesToModel, classifyWindow, dedupeAccounts, riskyOverride, planLabel, claudeProfilePlan, carryModelWindows } from './logic.ts';
import type { Account, QuotaWindow } from './contract.ts';
const window = (label: string, kind: QuotaWindow['kind']): QuotaWindow => ({ label, kind, usedPercent: 100, resetsAt: null });
test('model weekly quotas remain distinct from the account weekly quota', () => {
  assert.equal(classifyWindow('Fable', 'weekly'), 'model');
  assert.equal(classifyWindow('Weekly limit', 'weekly'), 'weekly');
  assert.equal(classifyWindow('Current session'), 'five-hour');
  assert.equal(classifyWindow('Credits'), 'other');
});
test('exhausted Fable does not imply exhausted Sonnet or Codex', () => {
  const fable = window('Fable', 'model');
  assert.equal(appliesToModel(fable, 'claude-sonnet-5'), false);
  assert.equal(appliesToModel(fable, 'claude-fable-5'), true);
  assert.equal(appliesToModel(fable, null), false);
  assert.equal(appliesToModel(window('Current session', 'five-hour'), 'claude-sonnet-5'), true);
});
test('custom credential paths and routes forbid host-default identity inference', () => {
  assert.equal(riskyOverride(['PATH', 'BB_THREAD_ID'], 'codex'), false);
  assert.equal(riskyOverride(['CODEX_HOME'], 'codex'), true);
  assert.equal(riskyOverride(['ANTHROPIC_BASE_URL'], 'claude-code'), true);
  assert.equal(riskyOverride(['CLAUDE_CONFIG_DIR'], 'claude-code'), true);
  assert.equal(riskyOverride(['HTTP_PROXY'], 'claude-code'), false);
});
test('same login on multiple machines is one account, never summed', () => {
  const account: Account = { key:'codex:a',providerId:'codex',providerName:'Codex',hostIds:['a'],hostNames:['A'],email:'user@example.test',plan:'Pro',resetCount:null,status:'ok',message:null,fetchedAt:'2026-01-01T01:00:00Z',windows:[{...window('Weekly limit','weekly'),usedPercent:34}] };
  const merged = dedupeAccounts([account,{...account,key:'codex:b',hostIds:['b'],hostNames:['B'],email:'USER@example.test'}]);
  assert.equal(merged.length,1);
  assert.equal(merged[0].windows[0].usedPercent,34);
  assert.deepEqual(merged[0].hostIds,['a','b']);
  assert.equal(dedupeAccounts([account,{...account,email:'other@example.test'}]).length,2);
});
test('failed reading on another host cannot overwrite a healthy account', () => {
  const a: Account = { key:'a',providerId:'codex',providerName:'Codex',hostIds:['a'],hostNames:['A'],email:'user@example.test',plan:'Pro',resetCount:null,status:'ok',message:null,fetchedAt:'2026-01-01T01:00:00Z',windows:[{...window('Weekly limit','weekly'),usedPercent:34}] };
  assert.equal(dedupeAccounts([a,{...a,status:'stale',windows:[]}])[0].windows.length,1);
});
test('reset credits are not summed across machines and a newer zero wins',()=>{
  const a:Account={key:'a',providerId:'codex',providerName:'Codex',hostIds:['a'],hostNames:['A'],email:'user@example.test',plan:'Pro',status:'ok',message:null,fetchedAt:'2026-01-01T01:00:00Z',windows:[],resetCount:1};
  assert.equal(dedupeAccounts([a,{...a,key:'b',hostIds:['b'],hostNames:['B']}])[0].resetCount,1);
  assert.equal(dedupeAccounts([a,{...a,key:'b',hostIds:['b'],hostNames:['B'],fetchedAt:'2026-01-01T02:00:00Z',resetCount:0}])[0].resetCount,0);
});
test('account status excludes model-only caps and stale readings',()=>{
  const a:Account={key:'a',providerId:'claude-code',providerName:'Claude',hostIds:['a'],hostNames:['A'],email:'user@example.test',plan:'Pro',status:'ok',message:null,fetchedAt:null,windows:[window('Fable','model')],resetCount:null};
  assert.equal(accountExhausted(a),false);
  assert.equal(accountExhausted({...a,windows:[window('Current session','five-hour')]}),true);
  assert.equal(accountExhausted({...a,windows:[window('Weekly limit','weekly')]}),true);
  assert.equal(accountExhausted({...a,status:'stale',windows:[window('Current session','five-hour')]}),false);
});

test('plan label with a static monthly price', () => {
  assert.equal(planLabel('claude-code', 'Pro'), 'Pro $20');
  assert.equal(planLabel('claude-code', 'Max 20x'), 'Max 20x $200');
  assert.equal(planLabel('codex', 'Pro'), 'Pro $200');
  assert.equal(planLabel('codex', 'Plus'), 'Plus $20');
  assert.equal(planLabel('codex', 'Enterprise'), 'Enterprise');
  assert.equal(planLabel('codex', null), '');
  assert.equal(planLabel('codex', 'Prolite'), 'Pro Lite $100');
  assert.equal(planLabel('codex', 'Promax'), 'Pro Max $500');
  assert.equal(planLabel('codex', 'Go'), 'Go $8');
  assert.equal(planLabel('claude-code', 'Max 5x'), 'Max 5x $100');
  assert.equal(planLabel('claude-code', 'Max'), 'Max');
});

test('Claude plan from the account profile', () => {
  assert.equal(claudeProfilePlan('claude_max', 'default_claude_max_20x'), 'Max 20x');
  assert.equal(claudeProfilePlan('claude_max', 'default_claude_max_5x'), 'Max 5x');
  assert.equal(claudeProfilePlan('claude_max', null), 'Max');
  assert.equal(claudeProfilePlan('claude_pro', 'default_claude_ai'), 'Pro');
  assert.equal(claudeProfilePlan(null, null), null);
});

test('per-model window survives a rate-limited answer until it resets', () => {
  const now = Date.parse('2026-11-22T20:00:00Z');
  const fable: QuotaWindow = { label: 'Fable', kind: 'model', usedPercent: 24, resetsAt: '2026-11-24T21:00:00Z' };
  const base = [window('Current session', 'five-hour'), window('Weekly limit', 'weekly')];
  assert.deepEqual(carryModelWindows(base, [fable], now), [...base, fable]);
  const fresh = { ...fable, usedPercent: 30 };
  assert.deepEqual(carryModelWindows([...base, fresh], [fable], now), [...base, fresh]);
  assert.deepEqual(carryModelWindows(base, [{ ...fable, resetsAt: '2026-11-22T19:00:00Z' }], now), base);
  assert.deepEqual(carryModelWindows(base, undefined, now), base);
});
test('one scale: pace tick, running ahead, a package expiring unused', async () => {
  const { pace, ahead, wasteRisk, vclaudeNote } = await import('./logic.ts');
  const now = Date.parse('2026-11-26T05:00:00Z');
  const week = { label: 'Weekly limit', kind: 'weekly' as const, usedPercent: 85, resetsAt: '2026-12-01T21:00:00Z' };
  assert.equal(Math.round(pace(week, now)!), 19);
  assert.equal(ahead(week, now), true);
  assert.equal(ahead({ ...week, usedPercent: 25 }, now), false);
  assert.equal(ahead({ ...week, usedPercent: 92, resetsAt: null }, now), true);
  const pack = { label: 'Тариф', kind: 'other' as const, usedPercent: 7.1, resetsAt: null, endsAt: '2026-11-28T17:15:00Z' };
  assert.equal(Math.round(pace(pack, now)!), 92);
  assert.equal(wasteRisk(pack, now), true);
  assert.equal(wasteRisk({ ...pack, endsAt: '2026-12-26T04:16:00Z' }, now), false);
  assert.equal(pace({ label: 'Credits', kind: 'other', usedPercent: 1, resetsAt: null }, now), null);
  assert.equal(vclaudeNote(4_643_626, 5_000_000, { 'anthropic-claude-opus-4-6': { input: 1, output: 1 }, 'anthropic-claude-opus-5-5': { input: 800_000, output: 4_000_000 } }),
    'осталось 4,64 млн из 5 млн ед. ≈ 5,8 млн вх. или 1,16 млн вых. токенов Opus 5.5');
});
