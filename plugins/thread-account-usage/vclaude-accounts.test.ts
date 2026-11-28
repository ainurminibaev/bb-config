import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { cabinetEmail, parseVClaudeLabels, validVClaudeLabels, vclaudeAccountOf, vclaudeGroups, vclaudeKeyId, type VClaudeRoute } from './vclaude-accounts.ts';

const gateway = 'gateway.example';
const hash = (key: string) => createHash('sha256').update(key).digest('hex').slice(0, 8);
const A = hash('key-a'), B = hash('key-b');
const routes = (entries: [string, string, string | null, string | null | undefined][]) =>
  new Map<string, VClaudeRoute>(entries.map(([id, name, baseHost, keyId]) => [id, { name, baseHost, keyId }]));

test('key id: sha256 prefix of the gateway key, settings first, key itself never returned', () => {
  assert.equal(vclaudeKeyId({ env: { ANTHROPIC_AUTH_TOKEN: 'key-a' } }, { ANTHROPIC_API_KEY: 'key-b' }), A);
  assert.equal(vclaudeKeyId({ env: { ANTHROPIC_API_KEY: ' key-b ' } }), B);
  assert.equal(vclaudeKeyId(null, { ANTHROPIC_AUTH_TOKEN: 'key-a' }), A);
  assert.equal(vclaudeKeyId({ env: { ANTHROPIC_AUTH_TOKEN: '' } }, {}), null);
  assert.match(vclaudeKeyId({ env: { ANTHROPIC_AUTH_TOKEN: 'key-a' } })!, /^[0-9a-f]{8}$/);
});

test('one account on two machines: one row with the cabinet email and both machines', () => {
  const groups = vclaudeGroups(routes([['h1', 'Mac', gateway, A], ['h2', 'Server', gateway, A], ['h3', 'Other', null, null]]),
    gateway, undefined, { cabinetEmail: 'owner@example.com' });
  assert.deepEqual(groups, [{ id: A, key: 'vclaude', label: 'owner@example.com', cabinet: true, hostIds: ['h1', 'h2'], hostNames: ['Mac', 'Server'] }]);
});

test('older hosts without a key id stay under the cabinet row, as before', () => {
  const groups = vclaudeGroups(routes([['h1', 'Mac', gateway, undefined]]), gateway, [{ id: 'h1', name: 'Mac · new name' }], {});
  assert.deepEqual(groups.map(g => [g.key, g.label, g.hostNames]), [['vclaude', 'VClaude · ключ не найден', ['Mac · new name']]]);
});

test('two accounts: the label equal to the cabinet email picks the cabinet group, the other is its own row', () => {
  const map = routes([['h1', 'Mac', gateway, A], ['h2', 'Server', gateway, B], ['h3', 'Laptop', gateway, A]]);
  const groups = vclaudeGroups(map, gateway, undefined,
    { cabinetEmail: 'Owner@Example.com', labels: { [A]: 'Рабочий', [B]: 'owner@example.com' } });
  assert.deepEqual(groups.map(g => [g.key, g.label, g.cabinet, g.hostIds]), [
    ['vclaude', 'owner@example.com', true, ['h2']],
    [`vclaude:${A}`, 'Рабочий', false, ['h1', 'h3']],
  ]);
  assert.equal(vclaudeAccountOf(groups, 'h3')?.label, 'Рабочий');
  assert.equal(vclaudeAccountOf(groups, 'unknown')?.key, 'vclaude');
});

test('two accounts without a match: the cabinet row has no machines, accounts are labelled by id', () => {
  const groups = vclaudeGroups(routes([['h1', 'Mac', gateway, A], ['h2', 'Server', gateway, B]]), gateway, undefined, { cabinetEmail: 'x@example.com' });
  assert.deepEqual(groups.map(g => [g.key, g.label, g.hostIds]), [
    ['vclaude', 'x@example.com', []], [`vclaude:${A}`, `VClaude · ${A}`, ['h1']], [`vclaude:${B}`, `VClaude · ${B}`, ['h2']],
  ]);
});

test('labels setting is tolerant: bad JSON, foreign keys and empty labels are ignored', () => {
  assert.deepEqual(parseVClaudeLabels(`{"${A.toUpperCase()}": " Мой ", "not-an-id": "x", "${B}": ""}`), { [A]: 'Мой' });
  assert.deepEqual(parseVClaudeLabels('{broken'), {});
  assert.deepEqual(parseVClaudeLabels('[1]'), {});
  assert.equal(validVClaudeLabels(''), true);
  assert.equal(validVClaudeLabels('{}'), true);
  assert.equal(validVClaudeLabels('nope'), false);
});

test('cabinet email is read from undocumented fields only when it looks like an email', () => {
  assert.equal(cabinetEmail({ email: 'a@example.com' }), 'a@example.com');
  assert.equal(cabinetEmail({ account: { email: 'b@example.com' } }), 'b@example.com');
  assert.equal(cabinetEmail({ user: { email: 'not email' } }), null);
  assert.equal(cabinetEmail('text'), null);
});
