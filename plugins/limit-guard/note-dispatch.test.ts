import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STALE_NOTE_TEXT, staleNoteDecision } from './note-dispatch.ts';

test('a stale limit note is parked and dropped, not left as a failed row', () => {
  const d = staleNoteDecision(['q1', 'q2'], new Set(), 1000);
  assert.deepEqual(d, { action: 'drop', ids: ['q1', 'q2'], reason: STALE_NOTE_TEXT, sendAt: 61000 });
});

test('if the same row comes back (the delete failed), it is refused with calm words', () => {
  const d = staleNoteDecision(['q1'], new Set(['q1']), 0);
  assert.equal(d.action, 'reject');
  assert.ok(d.action === 'reject' && d.message.includes('ход уже закончился'));
  assert.ok(d.action === 'reject' && !d.message.includes('не работает'));
});

test('no row ids (a direct attempt, nothing queued) → refused, nothing to delete', () => {
  assert.equal(staleNoteDecision([], new Set(), 0).action, 'reject');
});
