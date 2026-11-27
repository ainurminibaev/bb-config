import test from 'node:test';
import assert from 'node:assert/strict';
import { cascadeSnapshot, isVClaudeStep } from './cascade-step.ts';
import type { Account } from './contract.ts';
import { passportCache, CASCADE_PROVIDER_ID } from './cascade-passport.ts';

const account = (over: Partial<Account> = {}) => ({ key: 'codex:mac', providerId: 'codex', providerName: 'Codex', hostIds: ['mac'], hostNames: ['Mac'],
  email: 'a@b', plan: null, status: 'ok', message: null, windows: [], resetCount: null, ...over }) as unknown as Account;
const sub = { hostId: 'mac', providerId: 'codex' as const, model: 'gpt-x', accountKey: null, kind: 'subscription' as const };

test('без каскада всё как раньше: тред claude-code/codex не спрашивает каскад и идёт старым путём', async () => {
  let calls = 0;
  const read = passportCache(async () => { calls++; return { cascade: true, step: sub }; });
  // server.ts строит снимок по ступени только при passport?.step; здесь его нет — старый путь без изменений.
  assert.equal(await read({ id: 't', providerId: 'claude-code' }), null);
  assert.equal(await read({ id: 't', providerId: 'codex' }), null);
  assert.equal(calls, 0);
  // Каскад не установлен (RPC бросает) — тоже старый путь.
  assert.equal(await passportCache(async () => { throw new Error('no plugin'); })({ id: 't', providerId: CASCADE_PROVIDER_ID }), null);
});

test('тред каскада — кольцо по ступени: провайдер, машина, модель и аккаунт ступени', () => {
  const s = cascadeSnapshot('t', sub, 'auto', 'Mac', account());
  assert.equal(s.providerId, 'codex'); assert.equal(s.hostId, 'mac'); assert.equal(s.model, 'gpt-x');
  assert.equal(s.binding, 'host-cli'); assert.deepEqual(s.cascade, { profileId: 'auto', kind: 'subscription' });
  assert.equal(cascadeSnapshot('t', sub, null, null, account({ email: null })).binding, 'uncertain');
  assert.equal(cascadeSnapshot('t', sub, null, null, null).binding, 'uncertain');
});

test('ступень через шлюз: пакет VClaude, иначе — пояснение без кольца', () => {
  const gw = { ...sub, providerId: 'claude-code' as const, kind: 'gateway' as const, accountKey: 'vclaude' };
  assert.equal(isVClaudeStep(gw), true);
  assert.equal(isVClaudeStep({ ...gw, accountKey: 'other' }), false);
  assert.equal(isVClaudeStep(sub), false);
  assert.equal(isVClaudeStep({ ...gw, providerId: 'codex' }), true);
  assert.equal(isVClaudeStep({ ...gw, kind: 'subscription' }), false);
  assert.equal(isVClaudeStep({ ...gw, accountKey: 'VClaude-old' }), false);
  assert.equal(cascadeSnapshot('t', gw, null, 'Mac', account({ providerId: 'vclaude', email: null })).binding, 'host-cli');
  assert.match(cascadeSnapshot('t', gw, null, 'Mac', null).message!, /шлюз/);
});
