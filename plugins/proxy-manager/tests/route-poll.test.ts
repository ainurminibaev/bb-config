import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TtlCache, cachedLoad } from '../lib/ttl-cache.ts';
import { activityThreadId, BUSY_POLL_MS, claudeFreshMs, IDLE_POLL_MS, isBusyStatus, pollInterval } from '../lib/route-poll.ts';

test('cache keeps an entry for its lifetime and evicts the oldest when full', () => {
  let now = 0;
  const cache = new TtlCache<string>(1000, 2, () => now);
  cache.set('a', '1'); now = 10; cache.set('b', '2');
  assert.equal(cache.get('a'), '1');
  now = 999; assert.equal(cache.get('a'), '1');
  now = 1000; assert.equal(cache.get('a'), undefined);
  cache.set('c', '3'); cache.set('d', '4');
  assert.equal(cache.size, 2);
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('d'), '4');
  cache.delete('d', 'other'); assert.equal(cache.get('d'), '4');
  cache.delete('d', '4'); assert.equal(cache.get('d'), undefined);
});

test('cachedLoad shares one request and forgets a failure', async () => {
  const cache = new TtlCache<Promise<number>>(60_000);
  let loads = 0;
  const ok = () => { loads++; return Promise.resolve(loads); };
  const [a, b] = await Promise.all([cachedLoad(cache, 'k', ok), cachedLoad(cache, 'k', ok)]);
  assert.deepEqual([a, b, loads], [1, 1, 1]);
  await assert.rejects(cachedLoad(cache, 'bad', () => Promise.reject(new Error('down'))));
  await Promise.resolve();
  assert.equal(await cachedLoad(cache, 'bad', () => Promise.resolve(7)), 7);
});

test('badge polls fast only while a turn runs in its own thread', () => {
  assert.equal(pollInterval('thr', true), BUSY_POLL_MS);
  assert.equal(pollInterval('thr', false), IDLE_POLL_MS);
  assert.equal(pollInterval('thr', undefined), IDLE_POLL_MS);
  assert.equal(pollInterval(null, true), IDLE_POLL_MS);
  assert.ok(claudeFreshMs(false) > IDLE_POLL_MS);
  assert.ok(claudeFreshMs(true) > BUSY_POLL_MS);
});

test('thread statuses and activity signals', () => {
  for (const s of ['active', 'starting', 'pending', 'stopping']) assert.equal(isBusyStatus(s), true, s);
  for (const s of ['idle', 'error']) assert.equal(isBusyStatus(s), false, s);
  assert.equal(activityThreadId({ threadId: 'thr', busy: true }), 'thr');
  assert.equal(activityThreadId({}), null);
  assert.equal(activityThreadId(null), null);
  assert.equal(activityThreadId('thr'), null);
});
