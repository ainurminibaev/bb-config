import assert from 'node:assert/strict';
import { test } from 'node:test';
import { savingPercent, coldMessageFactor, decide, formatIdle, formatTokens } from './logic.ts';

const now = 10_000_000_000;
const base = { providerId: 'claude-code', status: 'idle', usedTokens: 400_000, lastActivityAt: now - 90 * 60_000, now, minTokens: 150_000, idleMinutes: 60 };

test('shows for a large Claude thread idle past the cache lifetime', () => {
  assert.deepEqual(decide(base), { show: true, usedTokens: 400_000, idleMinutes: 90, lastActivityAt: base.lastActivityAt });
});
test('hidden while the cache is still warm', () => {
  assert.equal(decide({ ...base, lastActivityAt: now - 59 * 60_000 }).show, false);
});
test('hidden for a small thread', () => {
  assert.equal(decide({ ...base, usedTokens: 149_999 }).show, false);
});
test('hidden while the thread works, for other providers, and without data', () => {
  assert.equal(decide({ ...base, status: 'active' }).show, false);
  assert.equal(decide({ ...base, providerId: 'codex' }).show, false);
  assert.equal(decide({ ...base, usedTokens: null }).show, false);
  assert.equal(decide({ ...base, lastActivityAt: null }).show, false);
});
test('wording helpers', () => {
  assert.equal(coldMessageFactor(), 20);
  assert.equal(savingPercent(231_000), 87);
  assert.equal(savingPercent(150_000), 80);
  assert.equal(savingPercent(20_000), 0);
  assert.equal(formatTokens(412_300), '412 тыс.');
  assert.equal(formatTokens(1_250_000), '1,3 млн');
  assert.equal(formatIdle(90), '90 мин');
  assert.equal(formatIdle(300), '5 ч');
  assert.equal(formatIdle(60 * 72), '3 дн');
});
