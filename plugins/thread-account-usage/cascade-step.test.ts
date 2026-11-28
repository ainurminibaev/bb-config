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

test('ступень VClaude — шапка пакета, как у треда машины на VClaude (gateway главнее, маршрут — запасной)', () => {
  const gw = { ...sub, providerId: 'claude-code' as const, kind: 'gateway' as const, accountKey: 'vclaude' };
  const pkg = account({ key: 'vclaude', providerId: 'vclaude', providerName: 'VClaude', email: null });
  const s = cascadeSnapshot('t', gw, 'auto', 'Mac', pkg);
  assert.equal(s.gateway, 'vclaude'); assert.equal(s.binding, 'host-cli'); assert.equal(s.message, null);
  assert.deepEqual(s.cascade, { profileId: 'auto', kind: 'gateway' });
  // Кабинет не прочитан — честный «недоступно», шапка остаётся шапкой пакета.
  const none = cascadeSnapshot('t', gw, null, 'Mac', null);
  assert.equal(none.gateway, 'vclaude'); assert.equal(none.account?.status, 'unavailable'); assert.match(none.message!, /шлюз VClaude/);
  // Запасной путь: ступень-подписка, но Claude Code машины направлен на VClaude.
  const claudeSub = { ...sub, providerId: 'claude-code' as const };
  const routed = cascadeSnapshot('t', claudeSub, null, 'Mac', pkg, true);
  assert.equal(routed.gateway, 'vclaude'); assert.equal(routed.cascade?.kind, 'subscription');
  // Без признака VClaude — обычное кольцо подписки, поля gateway нет.
  assert.equal(cascadeSnapshot('t', claudeSub, null, 'Mac', account()).gateway, undefined);
  // Другой шлюз (не VClaude) без аккаунта — прежнее пояснение.
  assert.match(cascadeSnapshot('t', { ...gw, accountKey: 'other' }, null, 'Mac', null).message!, /остаток считает каскад/);
});
