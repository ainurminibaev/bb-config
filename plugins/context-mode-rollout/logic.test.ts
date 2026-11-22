import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RECHECK_MS, RECONNECT_MIN_MS, RETRY_MS, agentsNeedingSetup, compareVersions, packageIsCurrent, parseAgents, pickVersion, shouldRun } from './logic.ts';

test('versions: missing or older is replaced, newer is kept', () => {
  assert.equal(packageIsCurrent(null, '2.2.0'), false);
  assert.equal(packageIsCurrent('2.1.9', '2.2.0'), false);
  assert.equal(packageIsCurrent('2.2.0', '2.2.0'), true);
  assert.equal(packageIsCurrent('2.10.0', '2.2.0'), true);
  assert.equal(compareVersions('garbage', '1.0.0'), -1);
});

test('parseAgents reads setup/doctor JSON tolerantly', () => {
  const out = 'progress line\n{"command":"setup","agents":[{"id":"codex","status":"PASS","changes":[],"extra":1},{"id":"claude-code","status":"FAIL","changes":[{}]},{"bad":true}]}';
  assert.deepEqual(parseAgents(out), [
    { id: 'codex', status: 'PASS', changes: 0 },
    { id: 'claude-code', status: 'FAIL', changes: 1 },
  ]);
  assert.equal(parseAgents('not json'), null);
  assert.equal(parseAgents('{"agents":"x"}'), null);
});

test('only drifted or missing agents get setup', () => {
  const dry = [{ id: 'codex', status: 'PASS', changes: 0 }, { id: 'claude-code', status: 'PASS', changes: 2 }];
  assert.deepEqual(agentsNeedingSetup(['claude-code', 'codex'], dry), ['claude-code']);
  assert.deepEqual(agentsNeedingSetup(['codex'], []), ['codex']);
  assert.deepEqual(agentsNeedingSetup(['codex'], null), ['codex']);
});

test('latest: newest stable release older than the quarantine', () => {
  const day = 24 * 60 * 60 * 1000;
  const now = Date.parse('2026-11-22T00:00:00Z');
  const times = {
    created: '2025-01-01T00:00:00Z', modified: '2026-11-21T00:00:00Z',
    '2.1.10': '2026-11-12T15:41:49Z', '2.2.0': '2026-11-14T15:56:32Z', '2.2.1': '2026-11-21T12:00:00Z',
    '2.0.0-next.40': '2026-11-21T13:00:00Z',
  };
  assert.equal(pickVersion('2.2.1', times, now, 2 * day), '2.2.0');
  assert.equal(pickVersion('2.2.1', times, now, 0), '2.2.1');
  assert.equal(pickVersion('2.2.0', times, now, 0), '2.2.0');
  assert.equal(pickVersion('2.2.1', { '2.2.1': '2026-11-21T12:00:00Z' }, now, 2 * day), '2.2.1');
});

test('schedule: new host now, reconnect after a pause, daily recheck, hourly retry', () => {
  const t = 10 * RECHECK_MS;
  assert.equal(shouldRun(undefined, false, t), true);
  assert.equal(shouldRun({ lastRunAt: t - 1000, ok: true }, true, t), false);
  assert.equal(shouldRun({ lastRunAt: t - RECONNECT_MIN_MS, ok: true }, true, t), true);
  assert.equal(shouldRun({ lastRunAt: t - RECONNECT_MIN_MS, ok: true }, false, t), false);
  assert.equal(shouldRun({ lastRunAt: t - RECHECK_MS, ok: true }, false, t), true);
  assert.equal(shouldRun({ lastRunAt: t - RETRY_MS + 1, ok: false }, false, t), false);
  assert.equal(shouldRun({ lastRunAt: t - RETRY_MS, ok: false }, false, t), true);
});
