import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampMinutes, tick } from './logic.ts';

const MIN = 60_000;

test('an expanded parent starts its clock and is collapsed after the delay', () => {
  const first = tick(['p'], new Set(), new Map(), 0, 5 * MIN);
  assert.deepEqual(first.collapse, []);
  assert.equal(first.since.get('p'), 0);
  const mid = tick(['p'], new Set(), first.since, 4 * MIN, 5 * MIN);
  assert.deepEqual(mid.collapse, []);
  const due = tick(['p'], new Set(), mid.since, 5 * MIN, 5 * MIN);
  assert.deepEqual(due.collapse, ['p']);
  assert.equal(due.since.has('p'), false);
});

test('collapsing by hand resets the clock; expanding again starts it anew', () => {
  const a = tick(['p'], new Set(), new Map(), 0, 5 * MIN);
  const b = tick(['p'], new Set(['p']), a.since, 3 * MIN, 5 * MIN);
  assert.equal(b.since.has('p'), false);
  const c = tick(['p'], new Set(), b.since, 4 * MIN, 5 * MIN);
  assert.equal(c.since.get('p'), 4 * MIN);
  assert.deepEqual(tick(['p'], new Set(), c.since, 8 * MIN, 5 * MIN).collapse, []);
});

test('a parent that lost all subthreads is forgotten', () => {
  const a = tick(['p'], new Set(), new Map(), 0, 5 * MIN);
  const b = tick([], new Set(), a.since, MIN, 5 * MIN);
  assert.equal(b.since.size, 0);
});

test('minutes are clamped', () => {
  assert.equal(clampMinutes(undefined), 5);
  assert.equal(clampMinutes(0), 1);
  assert.equal(clampMinutes(10), 10);
});
