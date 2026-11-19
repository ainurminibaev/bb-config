import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clampPercent, decide, nextCheck, parseScope, reason } from './logic.ts';

const windows = [
  { label: 'Current session', usedPercent: 57, resetsAt: null },
  { label: 'Weekly limit', usedPercent: 61.4, resetsAt: '2026-11-25T00:00:00Z' },
  { label: 'Fable', usedPercent: 90, resetsAt: null },
];
test('not marked or no data: never hold', () => {
  assert.deepEqual(decide(null, windows), { hold: false });
  assert.deepEqual(decide({ percent: 60, scope: 'any' }, null), { hold: false });
});
test('holds on the worst shared window and ignores the per-model one', () => {
  const d = decide({ percent: 60, scope: 'any' }, windows);
  assert.equal(d.hold, true);
  if (d.hold) { assert.equal(d.label, 'недельный лимит'); assert.equal(d.usedPercent, 61); assert.match(reason(d), /61% при пороге 60%/); }
  assert.equal(decide({ percent: 62, scope: 'any' }, windows).hold, false);
  assert.equal(decide({ percent: 60, scope: 'five-hour' }, windows).hold, false);
  assert.equal(decide({ percent: 60, scope: 'weekly' }, windows).hold, true);
  assert.equal(parseScope('5h', 'any'), 'five-hour'); assert.equal(parseScope('week', 'any'), 'weekly'); assert.equal(parseScope(undefined, 'five-hour'), 'five-hour');
});
test('threshold is inclusive', () => {
  assert.equal(decide({ percent: 57, scope: 'five-hour' }, windows).hold, true);
});
test('next check is soon and never far past the reset', () => {
  const d = decide({ percent: 60, scope: 'any' }, windows); assert.ok(d.hold);
  if (d.hold) {
    assert.equal(nextCheck(d, 1000), 301_000);
    assert.equal(nextCheck(d, d.resetsAt! - 60_000), d.resetsAt! + 30_000);
  }
});
test('clampPercent', () => {
  assert.equal(clampPercent('70', 60), 70); assert.equal(clampPercent(0, 60), 1);
  assert.equal(clampPercent(250, 60), 100); assert.equal(clampPercent('x', 60), 60);
});
