import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clearMark, parseStore, replaceMarks, setMark, visibleMarks } from '../lib/thread-marks.ts';

const crown = { glyph: 'crown', tone: 'neutral', label: 'Role' };

test('marks belong to the plugin that set them; another plugin cannot clear them', () => {
  let store = setMark({}, 'roster', 'thr_a', crown);
  store = setMark(store, 'other', 'thr_b', { ...crown, glyph: 'link' });
  store = clearMark(store, 'other', 'thr_a');
  assert.deepEqual(Object.keys(store.roster), ['thr_a']);
  store = clearMark(store, 'roster', 'thr_a');
  assert.equal(store.roster, undefined);
  assert.deepEqual(Object.keys(store.other), ['thr_b']);
});

test('replace swaps all marks of one plugin (a role moved to another thread)', () => {
  let store = setMark({}, 'roster', 'thr_old', crown);
  store = setMark(store, 'other', 'thr_x', crown);
  store = replaceMarks(store, 'roster', [{ threadId: 'thr_new', ...crown, tone: 'accent' }]);
  assert.deepEqual(Object.keys(store.roster), ['thr_new']);
  assert.equal(store.roster.thr_new.tone, 'accent');
  assert.ok(store.other.thr_x);
});

test('a disabled or removed plugin draws nothing; one mark per thread', () => {
  let store = setMark({}, 'roster', 'thr_a', crown);
  store = setMark(store, 'zeta', 'thr_a', { ...crown, glyph: 'bot' });
  assert.deepEqual(visibleMarks(store, new Set()), {});
  assert.equal(visibleMarks(store, new Set(['roster', 'zeta'])).thr_a.pluginId, 'roster');
  assert.equal(visibleMarks(store, new Set(['zeta'])).thr_a.glyph, 'bot');
});

test('tolerant reading: unknown glyphs, tones, ids and junk are dropped; no colours pass', () => {
  const store = parseStore({
    roster: { thr_a: { glyph: 'crown', tone: '#ff0000', label: 'x'.repeat(500), extra: 1 }, 'bad id': crown, thr_b: { glyph: 'skull' } },
    'Bad Plugin': { thr_c: crown },
    junk: 5,
  });
  assert.deepEqual(Object.keys(store), ['roster']);
  assert.deepEqual(Object.keys(store.roster), ['thr_a']);
  assert.equal(store.roster.thr_a.tone, 'neutral');
  assert.equal(store.roster.thr_a.label.length, 160);
  assert.deepEqual(parseStore(null), {});
});
