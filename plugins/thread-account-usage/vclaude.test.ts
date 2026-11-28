import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createVClaudeReader, parseVClaudeUsage } from './vclaude.ts';

const date = '2026-11-25T12:00:00.000Z';
const fixture = {
  limit_units: 5_000_000, remaining_units: 4_000_000, nearest_expiry: date,
  packages: [{ state: 'active', limit_units: 5_000_000, used_units: 1_000_000, price_minor: 34_900 },
    { state: 'queued', limit_units: 900, used_units: 0, price_minor: 99_000 }],
  models: [{ model: 'opus', units: 100, requests: 2, token_usage_known: true,
    input_tokens: 3, output_tokens: 4, cache_read_tokens: 5, cache_write_tokens: 6 }],
  coefficients: [{ model: 'opus', values: {
    input: 800_000, output: 4_000_000, cache_read: 80_000, cache_write_5m: 1_000_000, cache_write_1h: 1_600_000,
  } }],
};

test('measured cache and cost by active package', () => {
  const usage = parseVClaudeUsage(fixture, date);
  assert.equal(usage.paidRub, 349);
  assert.equal(usage.usedRub, 69.8);
  assert.deepEqual(usage.models[0]?.tokens, { input: 3, output: 4, cacheRead: 5, cacheWrite: 6, estimated: false });
  assert.equal(usage.models[0]?.rates?.cacheRead, 80_000);
  assert.equal(parseVClaudeUsage({ ...fixture, models: [{ model: 'opus', units: 100, requests: 2 }] }, date).models[0]?.tokens, null);
});

test('a rejected session is replaced atomically and concurrent reads share renewal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'test-vclaude-'));
  try {
    const now = () => Date.parse(date);
    const state = join(directory, 'session.json');
    await writeFile(state, JSON.stringify({ cookie: 'session=old', expiresAt: '2026-11-28T12:00:00Z' }), { mode: 0o600 });
    await writeFile(join(directory, 'login.json'), JSON.stringify({ email: 'tester@example.com', password: 'test-only' }), { mode: 0o600 });
    let logins = 0;
    const send: typeof fetch = async (url, options) => {
      const path = new URL(String(url)).pathname;
      if (path === '/api/auth/login') {
        assert.equal(options?.method, 'POST');
        logins++;
        return new Response('{}', { headers: { 'Set-Cookie': 'session=new; HttpOnly; Secure' } });
      }
      const session = new Headers(options?.headers).get('Cookie');
      if (session !== 'session=new') return new Response('{}', { status: 401 });
      if (path === '/api/auth/session') return Response.json({ expires_at: '2026-12-25T12:00:00Z' });
      assert.equal(path, '/api/cabinet/tariff/usage');
      return Response.json(fixture);
    };
    const read = createVClaudeReader(directory, send, now);
    const results = await Promise.all([read(true), read(true)]);
    assert.equal(logins, 1);
    assert.equal(results[0]?.usage?.remainingUnits, fixture.remaining_units);
    assert.equal(results[1]?.error, null);
    // Почта аккаунта кабинета — из входа (ответ кабинета её не сообщает); пароль не выходит наружу.
    assert.equal(results[0]?.email, 'tester@example.com');
    assert.ok(!JSON.stringify(results[0]).includes('test-only'));
    assert.equal(JSON.parse(await readFile(state, 'utf8')).cookie, 'session=new');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a waiting package extends the term: its 30 days start at the running one\'s end', () => {
  const promoEnd = '2026-11-28T17:15:27.776Z';
  const usage = parseVClaudeUsage({
    limit_units: 405_000_000, remaining_units: 403_124_658, nearest_expiry: promoEnd, models: [], coefficients: [],
    packages: [
      { name: 'Max 100', limit_units: 400_000_000, used_units: 0, price_minor: 899_100, valid_until: null,
        state: 'waiting', started_at: null, queue_position: 1, period_days: 30 },
      { name: 'Промокод', limit_units: 5_000_000, used_units: 1_875_342, price_minor: 0, valid_until: promoEnd,
        state: 'active', started_at: '2026-11-25T17:15:27.776Z', queue_position: null, period_days: 3 },
    ],
  }, promoEnd);
  assert.equal(usage.nearestExpiry, promoEnd);
  assert.equal(usage.startedAt, '2026-11-25T17:15:27.776Z');
  assert.equal(usage.endsAt, '2026-12-28T17:15:27.776Z');
  assert.deepEqual(usage.queue.map(p => [p.name, p.state, p.startsAt, p.endsAt, p.estimated]), [
    ['Промокод', 'active', '2026-11-25T17:15:27.776Z', promoEnd, false],
    ['Max 100', 'waiting', promoEnd, '2026-12-28T17:15:27.776Z', true],
  ]);
  assert.equal(usage.paidRub, 8991);
  assert.equal(usage.usedRub, 0);
});
test('without package details the term is the cabinet\'s nearest expiry, as before', () => {
  const usage = parseVClaudeUsage({ ...fixture, packages: [] }, date);
  assert.equal(usage.endsAt, date);
  assert.equal(usage.startedAt, null);
});

test('the cabinet\'s own email wins over the login file; without login no email', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'test-vclaude-'));
  try {
    await writeFile(join(directory, 'session.json'), JSON.stringify({ cookie: 'session=ok', expiresAt: '2026-12-28T12:00:00Z' }), { mode: 0o600 });
    let body: unknown = { ...fixture, user: { email: 'cabinet@example.com' }, unknown_field: { nested: true } };
    const send: typeof fetch = async () => Response.json(body);
    const now = () => Date.parse(date);
    assert.equal((await createVClaudeReader(directory, send, now)(true)).email, 'cabinet@example.com');
    body = fixture;
    const plain = await createVClaudeReader(directory, send, now)(true);
    assert.equal(plain.error, null);
    assert.equal(plain.email, null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
