import test from 'node:test';
import assert from 'node:assert/strict';
import { candidates, afterAttempt, requestKey, instructionsFor, notifyJob, retentionExpired } from './jobs.mjs';

const ex = [
  { id: 'server:codex', hostId: 'server', name: 'Server', backend: 'codex', accountGroup: 'chatgpt-A', tier: 0, ready: true },
  { id: 'laptop:codex', hostId: 'laptop', name: 'Laptop', backend: 'codex', accountGroup: 'chatgpt-A', tier: 0, ready: true, busy: true },
  { id: 'other:codex', hostId: 'other', name: 'Other', backend: 'codex', accountGroup: 'chatgpt-B', tier: 0, ready: true },
  { id: 'server:api', hostId: 'server', name: 'Server', backend: 'api:openai', accountGroup: 'api-key', tier: 1, ready: true },
  { id: 'off:codex', hostId: 'off', name: 'Off', backend: 'codex', tier: 0, ready: false },
];

test('cascade: caller machine first, idle before busy, paid tier only when enabled', () => {
  assert.deepEqual(candidates(ex, { callerHostId: 'laptop' }), ['laptop:codex', 'server:codex', 'other:codex']);
  assert.deepEqual(candidates(ex, { callerHostId: 'x' }), ['server:codex', 'other:codex', 'laptop:codex']);
  assert.deepEqual(candidates(ex, { callerHostId: 'x', maxTier: 1 }).at(-1), 'server:api');
  assert.deepEqual(candidates(ex, { callerHostId: 'server', preferred: 'Other' })[0], 'other:codex');
});

test('Codex caller that hit its limit excludes its own account everywhere', () => {
  assert.deepEqual(candidates(ex, { callerHostId: 'server', excludeAccounts: ['chatgpt-A'] }), ['other:codex']);
});

test('limit moves only to another account; unknown never moves', () => {
  const job = { executorId: 'server:codex', plan: ['server:codex', 'laptop:codex', 'other:codex'], attempts: [] };
  assert.deepEqual(afterAttempt(job, { status: 'limited' }, ex), { state: 'queued', executorId: 'other:codex', limitedAccount: 'chatgpt-A' });
  const last = { executorId: 'other:codex', plan: ['other:codex'], attempts: [] };
  assert.equal(afterAttempt(last, { status: 'limited', resetHint: '18:40' }, ex).state, 'limited');
  assert.equal(afterAttempt(job, { status: 'unknown' }, ex).state, 'unknown');
  assert.equal(afterAttempt(job, { status: 'fenced' }, ex).state, 'unknown');
  assert.deepEqual(afterAttempt(job, { status: 'not_started' }, ex), { state: 'queued', executorId: 'laptop:codex' });
  assert.equal(afterAttempt(job, { status: 'completed' }, ex).state, 'returning');
  assert.equal(afterAttempt(job, { status: 'failed', error: 'x' }, ex).state, 'failed');
});

test('idempotency key ignores nothing relevant and honours client keys', () => {
  const a = requestKey({ threadId: 't', prompt: 'cat' });
  assert.equal(a, requestKey({ threadId: 't', prompt: 'cat' }));
  assert.notEqual(a, requestKey({ threadId: 't', prompt: 'dog' }));
  assert.equal(requestKey({ threadId: 't', clientKey: 'k', prompt: 'cat' }), requestKey({ threadId: 't', clientKey: 'k', prompt: 'dog' }));
});

test('instructions differ for Codex and other providers', () => {
  assert.match(instructionsFor('codex'), /встроенным image_gen/);
  assert.match(instructionsFor('codex'), /Каскад/);
  assert.doesNotMatch(instructionsFor('claude-code'), /генерируй сам/);
  assert.match(instructionsFor('claude-code'), /image_generate/);
  assert.match(instructionsFor(null), /Если ты Codex/);
});

function fakes() {
  const store = new Map(); const sent = [];
  return { sent, kv: { get: async k => store.get(k), set: async (k, v) => store.set(k, v) },
    threads: { send: async m => { sent.push(m); return { ok: true }; } } };
}

test('notice is sent once and suppressed for cancelled or already-inline results', async () => {
  const f = fakes(); const job = { id: 'img_1', state: 'completed', notify: true, threadId: 't', returned: [{ path: '/a.png' }] };
  assert.equal(await notifyJob({ ...f, job, alreadyAccepted: async () => false }), 'sent');
  assert.equal(await notifyJob({ ...f, job, alreadyAccepted: async () => false }), 'sent');
  assert.equal(f.sent.length, 1);
  assert.equal(await notifyJob({ ...f, job: { ...job, id: 'img_2', state: 'cancelled' }, alreadyAccepted: async () => false }), 'suppressed');
  assert.equal(await notifyJob({ ...f, job: { ...job, id: 'img_3', deliveredInline: true }, alreadyAccepted: async () => false }), 'suppressed');
  assert.equal(f.sent.length, 1);
});

test('no notice while the caller still waits inline', async () => {
  const f = fakes(); const job = { id: 'img_5', state: 'completed', notify: true, threadId: 't', inlineWaitUntil: Date.now() + 10000 };
  assert.equal(await notifyJob({ ...f, job, alreadyAccepted: async () => false }), 'wait');
  assert.equal(await notifyJob({ ...f, job: { ...job, inlineWaitUntil: 0 }, alreadyAccepted: async () => false }), 'sent');
});

test('ambiguous send is recovered from history instead of resending', async () => {
  const f = fakes(); const job = { id: 'img_4', state: 'failed', notify: true, threadId: 't' };
  await f.kv.set('notice:img_4:failed', { status: 'sending', retryAt: 0 });
  assert.equal(await notifyJob({ ...f, job, alreadyAccepted: async () => true }), 'sent');
  assert.equal(f.sent.length, 0);
});

test('retention only removes finished jobs', () => {
  const now = Date.now();
  assert.equal(retentionExpired({ state: 'completed', updatedAt: now - 31 * 86400000 }, now), true);
  assert.equal(retentionExpired({ state: 'running', updatedAt: 0 }, now), false);
});
