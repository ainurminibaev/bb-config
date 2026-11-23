import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSummaryLabel, offlineName, parseList, quietState, toHostLike, type HostLike } from './logic.ts';

const host = (over: Partial<HostLike>): HostLike => ({ id: 'h', name: 'H', status: 'connected', type: 'persistent', phase: 'active', cleanupFailed: false, ...over });

test('parseList splits commas and new lines, drops blanks and duplicates', () => {
  assert.deepEqual(parseList(' Windows, host_1\n\nWindows ,'), ['Windows', 'host_1']);
  assert.deepEqual(parseList(''), []);
});

test('toHostLike reads SDK hosts leniently', () => {
  assert.equal(toHostLike(null), null);
  assert.equal(toHostLike({ id: 1 }), null);
  assert.deepEqual(toHostLike({ id: 'a', name: 'A' }), { id: 'a', name: 'A', status: 'unknown', type: 'persistent', phase: 'active', cleanupFailed: false });
  assert.equal(toHostLike({ id: 'a', name: 'A', lifecycle: { phase: 'removing', teardown: { status: 'failed' } } })!.cleanupFailed, true);
});

test('quietState matches names and IDs case-insensitively', () => {
  const hosts = [host({ id: 'host_w', name: 'Windows', status: 'disconnected' }), host({ id: 'host_m', name: 'Mac' })];
  assert.deepEqual(quietState(hosts, ['windows']), { quietNames: ['Windows'], allWarningsQuiet: true });
  assert.deepEqual(quietState(hosts, ['HOST_W']), { quietNames: ['Windows'], allWarningsQuiet: true });
  assert.deepEqual(quietState(hosts, []), { quietNames: [], allWarningsQuiet: false });
});

test('the summary stays when another machine also warns', () => {
  const hosts = [host({ id: 'w', name: 'Windows', status: 'disconnected' }), host({ id: 'u', name: 'UA', status: 'disconnected' })];
  assert.equal(quietState(hosts, ['Windows']).allWarningsQuiet, false);
  assert.equal(quietState(hosts, ['Windows', 'UA']).allWarningsQuiet, true);
});

test('ephemeral machines do not warn; cleanup failures are never hidden', () => {
  assert.equal(quietState([host({ name: 'E', type: 'ephemeral', status: 'disconnected' })], ['E']).allWarningsQuiet, false);
  assert.equal(quietState([host({ name: 'W', phase: 'removing', cleanupFailed: true })], ['W']).allWarningsQuiet, false);
});

test('labels', () => {
  assert.equal(offlineName('Windows is offline'), 'Windows');
  assert.equal(offlineName('MacBook Pro — Айнур (3) is offline'), 'MacBook Pro — Айнур (3)');
  assert.equal(offlineName('Windows cleanup failed'), null);
  assert.ok(isSummaryLabel('Machines offline'));
  assert.ok(isSummaryLabel('2 machines need attention'));
  assert.ok(isSummaryLabel('3 machines are offline'));
  assert.ok(!isSummaryLabel('Machines'));
});
