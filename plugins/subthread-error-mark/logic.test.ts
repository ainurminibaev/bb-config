import { test } from 'node:test';
import assert from 'node:assert/strict';
import { showsErrorMark } from './logic.ts';

test('marks a child thread in error', () => {
  assert.equal(showsErrorMark({ parentThreadId: 'thr_p', status: 'error', isArchived: false }), true);
});

test('does not mark top-level threads: bb draws those itself', () => {
  assert.equal(showsErrorMark({ parentThreadId: null, status: 'error' }), false);
});

test('ignores other statuses, unknown values and archived children', () => {
  for (const status of ['idle', 'active', 'starting', 'stopping', 'something-new', null, undefined]) {
    assert.equal(showsErrorMark({ parentThreadId: 'thr_p', status }), false);
  }
  assert.equal(showsErrorMark({ parentThreadId: 'thr_p', status: 'error', isArchived: true }), false);
});

test('tolerates missing data', () => {
  assert.equal(showsErrorMark(null), false);
  assert.equal(showsErrorMark(undefined), false);
  assert.equal(showsErrorMark({}), false);
});
