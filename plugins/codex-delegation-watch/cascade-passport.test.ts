import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cascadeFolder, parsePassport, passportCache, readPassport, CASCADE_PROVIDER_ID, CASCADE_PLUGIN_ID, CASCADE_STATUS_METHOD } from './cascade-passport.ts';

const full = {
  cascade: true, profileId: 'auto', anchorHostId: 'tru', syncMode: 'lazy', path: '/opt/bbfs/p', freshCopyHostId: 'mac',
  step: { hostId: 'mac', providerId: 'codex', model: 'gpt', accountKey: 'acc', kind: 'subscription', extra: 1 }, future: 'x',
};

test('без каскада: тред claude-code/codex — каскад не спрашивается, паспорта нет', async () => {
  let calls = 0;
  const call = async () => { calls++; return full; };
  assert.equal(await readPassport(call, { id: 't', providerId: 'claude-code' }), null);
  assert.equal(await readPassport(call, { id: 't', providerId: 'codex' }), null);
  assert.equal(await passportCache(call)({ id: 't', providerId: 'codex' }), null);
  assert.equal(calls, 0);
});

test('каскад не установлен, бросил или молчит — null', async () => {
  const thread = { id: 't', providerId: CASCADE_PROVIDER_ID };
  assert.equal(await readPassport(async () => { throw new Error('plugin not found'); }, thread), null);
  assert.equal(await readPassport(() => new Promise(() => {}), thread, 20), null);
  assert.equal(await readPassport(async () => ({ cascade: false }), thread), null);
  assert.equal(await readPassport(async () => 'garbage', thread), null);
});

test('паспорт по контракту, неизвестные поля игнорируются', async () => {
  const p = await readPassport(async () => full, { id: 't', providerId: CASCADE_PROVIDER_ID });
  assert.deepEqual(p, {
    profileId: 'auto', anchorHostId: 'tru', syncMode: 'lazy', path: '/opt/bbfs/p', freshCopyHostId: 'mac',
    step: { hostId: 'mac', providerId: 'codex', model: 'gpt', accountKey: 'acc', kind: 'subscription' },
  });
});

test('неизвестный провайдер ступени — ступени нет; неизвестный вид — шлюз', () => {
  assert.equal(parsePassport({ ...full, step: { hostId: 'h', providerId: 'gemini' } })!.step, null);
  assert.equal(parsePassport({ ...full, step: { hostId: 'h', providerId: 'codex', kind: 'new' } })!.step!.kind, 'gateway');
});

test('папка: свежая копия, затем опора; без пути — окружение треда', () => {
  assert.deepEqual(cascadeFolder(parsePassport(full)), { hostId: 'mac', path: '/opt/bbfs/p' });
  assert.deepEqual(cascadeFolder(parsePassport({ ...full, freshCopyHostId: null })), { hostId: 'tru', path: '/opt/bbfs/p' });
  assert.equal(cascadeFolder(parsePassport({ ...full, path: null })), null);
  assert.equal(cascadeFolder(null), null);
});

test('кэш: один вызов на тред в пределах срока', async () => {
  let calls = 0;
  const read = passportCache(async () => { calls++; return full; }, 60_000);
  await read({ id: 't', providerId: CASCADE_PROVIDER_ID });
  await read({ id: 't', providerId: CASCADE_PROVIDER_ID });
  assert.equal(calls, 1);
});

test('ID провайдера треда каскада — subscriptions-cascade, ID плагина для RPC — agentcli-subscriptions-cascade', () => {
  assert.equal(CASCADE_PROVIDER_ID, 'subscriptions-cascade');
  assert.equal(CASCADE_PLUGIN_ID, 'agentcli-subscriptions-cascade');
  assert.equal(CASCADE_STATUS_METHOD, 'threadStatus');
});
