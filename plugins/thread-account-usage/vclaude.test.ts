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
    assert.equal(JSON.parse(await readFile(state, 'utf8')).cookie, 'session=new');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
