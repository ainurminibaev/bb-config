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
test('accounts list: one row per model group, 5 h and week together, Fable apart', async () => {
  const { windowRows, rowLead } = await import('./logic.ts');
  const w = (label: string, kind: QuotaWindow['kind'], usedPercent: number, scope?: string[]): QuotaWindow => ({ label, kind, usedPercent, resetsAt: null, ...(scope ? { scope } : {}) });
  const claude = windowRows({ providerId: 'claude-code', windows: [w('Current session', 'five-hour', 7), w('Weekly limit', 'weekly', 97), w('Fable', 'model', 77)] });
  assert.deepEqual(claude.map(r => [r.name, r.five?.usedPercent ?? null, r.week?.usedPercent ?? null, r.single?.label ?? null]), [['Claude', 7, 97, null], ['Fable', null, null, 'Fable']]);
  assert.equal(rowLead(claude[0]!).usedPercent, 97);
  const google = windowRows({ providerId: 'acp-antigravity-acp', windows: [w('Gemini · 5 ч', 'five-hour', 2, ['gemini']), w('Claude+GPT · неделя', 'weekly', 100, ['claude', 'gpt']), w('Claude+GPT · 5 ч', 'five-hour', 51, ['claude', 'gpt'])] });
  assert.deepEqual(google.map(r => [r.name, r.five?.usedPercent ?? null, r.week?.usedPercent ?? null]), [['Gemini', 2, null], ['Claude', 51, 100]]);
  const codex = windowRows({ providerId: 'codex', windows: [w('Weekly limit', 'weekly', 28)] });
  assert.deepEqual(codex.map(r => [r.name, r.week?.usedPercent]), [['Codex', 28]]);
  const pack = windowRows({ providerId: 'acp-gemini-antig', windows: [w('Часы', 'other', 100)] });
  assert.equal(pack[0]!.single?.label, 'Часы');
});
test('Claude route host comes from settings env, without secrets, falling back to process env', async () => {
  const { claudeBaseHost } = await import('./logic.ts');
  assert.equal(claudeBaseHost({ env: { ANTHROPIC_BASE_URL: 'https://VClaude.ru', ANTHROPIC_AUTH_TOKEN: 'x' } }), 'vclaude.ru');
  assert.equal(claudeBaseHost({ env: { ANTHROPIC_BASE_URL: 'https://vclaude.ru/v1/' } }, 'https://other.example'), 'vclaude.ru');
  assert.equal(claudeBaseHost({}, 'https://vclaude.ru'), 'vclaude.ru');
  assert.equal(claudeBaseHost({ env: {} }), null);
  assert.equal(claudeBaseHost({ env: { ANTHROPIC_BASE_URL: 'not a url' } }), null);
  assert.equal(claudeBaseHost(null), null);
});
test('VClaude machines are the hosts routed to it, named as BB currently names them', async () => {
  const { routedHosts } = await import('./logic.ts');
  const routes = new Map([['mac', { name: 'Old Mac name', baseHost: 'vclaude.ru' }], ['tru', { name: 'Tru', baseHost: null }]]);
  assert.deepEqual(routedHosts(routes, 'vclaude.ru', [{ id: 'tru', name: 'Tru' }, { id: 'mac', name: 'MacBook Pro — Айнур (3)' }]),
    { ids: ['mac'], names: ['MacBook Pro — Айнур (3)'] });
  assert.deepEqual(routedHosts(routes, 'vclaude.ru'), { ids: ['mac'], names: ['Old Mac name'] });
  assert.deepEqual(routedHosts(routes, 'vclaude.ru', [{ id: 'gone', name: 'X' }]), { ids: [], names: [] });
});
test('VClaude note names the running and the queued package', async () => {
  const { vclaudeNote } = await import('./logic.ts');
  const note = vclaudeNote(403_124_658, 405_000_000, {}, [
    { name: 'Промокод', state: 'active', limitUnits: 5_000_000, usedUnits: 1_875_342, endsAt: '2026-11-28T17:15:27Z', estimated: false },
    { name: 'Max 100', state: 'waiting', limitUnits: 400_000_000, usedUnits: 0, endsAt: '2026-12-28T17:15:27Z', estimated: true },
  ]);
  assert.match(note, /^осталось 403,12 млн из 405 млн ед\.\nПо очереди: сейчас Промокод — 3,12 млн до 28 нояб\.; затем Max 100 — 400 млн, не позже до 28 дек\.$/);
  assert.equal(vclaudeNote(4e6, 5e6, {}), 'осталось 4 млн из 5 млн ед.');
});
test('a queue term replaces the default 30 days: the tick does not run ahead', async () => {
  const { pace, wasteRisk } = await import('./logic.ts');
  const w: QuotaWindow = { label: 'Тариф', kind: 'other', usedPercent: 0.5, resetsAt: null,
    startsAt: '2026-11-25T17:15:00Z', endsAt: '2026-12-28T17:15:00Z' };
  const now = Date.parse('2026-11-27T07:15:00Z');
  assert.ok(Math.abs(pace(w, now)! - 100 * 38 / (33 * 24)) < 0.01);
  assert.equal(wasteRisk(w, now), false);
  // Old shape (no start): 30 days before the end, as before.
  assert.ok(Math.abs(pace({ ...w, startsAt: undefined, endsAt: '2026-11-28T17:15:00Z' }, now)! - 100 * (1 - 34 / 720)) < 0.01);
});
test('a Claude Code thread on a VClaude machine shows the package, not «не подтверждён» (0.2.4)', async () => {
  const { vclaudeRouted, vclaudeThreadSnapshot, vclaudeHeadline } = await import('./logic.ts');
  const base = { threadId: 't', providerId: 'claude-code', model: null, hostId: 'mac', hostName: 'MacBook Pro',
    binding: 'unavailable' as const, message: null, account: null };
  const pkg: Account = { key: 'vclaude', providerId: 'vclaude', providerName: 'VClaude', hostIds: ['mac'], hostNames: ['MacBook Pro'],
    email: null, plan: null, status: 'ok', message: null, fetchedAt: null, resetCount: null,
    meter: { total: 405_000_000, left: 380_730_000, tokensPerUnit: 1.25 },
    windows: [{ label: 'Тариф', kind: 'other', usedPercent: 6, resetsAt: null, endsAt: '2026-12-27T12:00:00Z' }] };
  assert.equal(vclaudeRouted('claude-code', 'VClaude.ru', 'vclaude.ru'), true);
  assert.equal(vclaudeRouted('codex', 'vclaude.ru', 'vclaude.ru'), false);
  const snap = vclaudeThreadSnapshot(base, 'vclaude.ru', 'vclaude.ru', pkg)!;
  assert.equal(snap.gateway, 'vclaude'); assert.equal(snap.binding, 'host-cli'); assert.equal(snap.account?.providerId, 'vclaude');
  const head = vclaudeHeadline(snap.account);
  assert.equal(head.account, 'VClaude');
  assert.equal(head.text, '380,73 млн из 405 млн · до 27 дек');
  assert.equal(head.level, 'normal');
  assert.equal(vclaudeHeadline({ ...pkg, meter: { total: 100, left: 5, tokensPerUnit: null } }).level, 'warning');
  assert.equal(vclaudeHeadline({ ...pkg, meter: { total: 100, left: 0, tokensPerUnit: null } }).level, 'blocked');
  // Cabinet unreadable: an honest unknown, still VClaude.
  const none = vclaudeThreadSnapshot(base, 'vclaude.ru', 'vclaude.ru', null)!;
  assert.equal(none.account?.status, 'unavailable');
  const unknown = vclaudeHeadline(none.account);
  assert.deepEqual([unknown.account, unknown.text, unknown.level], ['VClaude', 'остаток неизвестен', null]);
});
test('other threads keep the usual path: no gateway', async () => {
  const { vclaudeThreadSnapshot } = await import('./logic.ts');
  const base = { threadId: 't', providerId: 'claude-code', model: null, hostId: 'tru', hostName: 'Tru',
    binding: 'unavailable' as const, message: null, account: null };
  assert.equal(vclaudeThreadSnapshot(base, null, 'vclaude.ru', null), null);
  assert.equal(vclaudeThreadSnapshot(base, 'api.anthropic.com', 'vclaude.ru', null), null);
  assert.equal(vclaudeThreadSnapshot({ ...base, providerId: 'codex' }, 'vclaude.ru', 'vclaude.ru', null), null);
});

test('VClaude header names the machine\'s account: label, else cabinet email, else VClaude (0.3.2)', async () => {
  const { vclaudeHeadline, vclaudeLabel } = await import('./logic.ts');
  const meter = { total: 100, left: 50, tokensPerUnit: null };
  assert.equal(vclaudeHeadline({ meter, windows: [], message: null, label: 'Рабочий', email: 'a@example.com' }).account, 'Рабочий');
  assert.equal(vclaudeHeadline({ meter, windows: [], message: null, email: 'a@example.com' }).account, 'a@example.com');
  assert.equal(vclaudeHeadline(null).account, 'VClaude');
  assert.equal(vclaudeLabel({ label: ' ', email: null }), 'VClaude');
});
