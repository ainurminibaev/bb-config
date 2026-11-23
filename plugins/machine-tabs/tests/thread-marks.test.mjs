import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clearMark, parseStore, replaceMarks, setMark, visibleMarks } from '../lib/thread-marks.ts';

const crown = { glyph: 'crown', tone: 'neutral', place: 'top', size: 'normal', label: 'Role' };
const tg = { glyph: 'telegram', tone: 'neutral', place: 'corner', size: 'normal', label: 'Telegram' };

test('marks belong to the plugin that set them; another plugin cannot clear them', () => {
  let store = setMark({}, 'roster', 'thr_a', crown);
  store = setMark(store, 'other', 'thr_b', { ...crown, glyph: 'link' });
  store = clearMark(store, 'other', 'thr_a');
  assert.deepEqual(Object.keys(store.roster), ['thr_a']);
  store = clearMark(store, 'roster', 'thr_a');
  assert.equal(store.roster, undefined);
  assert.deepEqual(Object.keys(store.other), ['thr_b']);
});

test('two marks per thread from one plugin, one per place; a new mark replaces the same place', () => {
  let store = setMark({}, 'roster', 'thr_a', crown);
  store = setMark(store, 'roster', 'thr_a', tg);
  store = setMark(store, 'roster', 'thr_a', { ...crown, tone: 'accent', size: 'large' });
  assert.deepEqual(store.roster.thr_a.map((m) => `${m.place}:${m.glyph}:${m.tone}:${m.size}`).sort(), ['corner:telegram:neutral:normal', 'top:crown:accent:large']);
  store = clearMark(store, 'roster', 'thr_a', 'corner');
  assert.deepEqual(store.roster.thr_a.map((m) => m.place), ['top']);
});

test('replace swaps all marks of one plugin (a role moved to another thread)', () => {
  let store = setMark({}, 'roster', 'thr_old', crown);
  store = setMark(store, 'other', 'thr_x', crown);
  store = replaceMarks(store, 'roster', [{ threadId: 'thr_new', ...crown, tone: 'accent' }, { threadId: 'thr_new', ...tg }]);
  assert.deepEqual(Object.keys(store.roster), ['thr_new']);
  assert.equal(store.roster.thr_new.length, 2);
  assert.ok(store.other.thr_x);
});

test('a disabled or removed plugin draws nothing; one mark per place per thread', () => {
  let store = setMark({}, 'roster', 'thr_a', crown);
  store = setMark(store, 'zeta', 'thr_a', { ...crown, glyph: 'bot' });
  store = setMark(store, 'zeta', 'thr_a', tg);
  assert.deepEqual(visibleMarks(store, new Set()), {});
  const both = visibleMarks(store, new Set(['roster', 'zeta'])).thr_a;
  assert.deepEqual(both.map((m) => `${m.pluginId}:${m.place}`), ['roster:top', 'zeta:corner']);
  assert.equal(visibleMarks(store, new Set(['zeta'])).thr_a[0].glyph, 'bot');
});

test('tolerant reading: 0.2.10 data (one mark, no place/size) still loads as a corner mark; junk is dropped; no colours pass', () => {
  const store = parseStore({
    roster: { thr_old: { glyph: 'crown', tone: 'accent', label: 'old' }, thr_a: [{ glyph: 'crown', tone: '#ff0000', place: 'top', size: 'huge', label: 'x'.repeat(500) }, { glyph: 'skull' }], 'bad id': crown },
    'Bad Plugin': { thr_c: crown },
    junk: 5,
  });
  assert.deepEqual(Object.keys(store), ['roster']);
  assert.deepEqual(store.roster.thr_old, [{ glyph: 'crown', tone: 'accent', place: 'corner', size: 'normal', label: 'old' }]);
  assert.equal(store.roster.thr_a.length, 1);
  assert.equal(store.roster.thr_a[0].tone, 'neutral');
  assert.equal(store.roster.thr_a[0].size, 'normal');
  assert.equal(store.roster.thr_a[0].label.length, 160);
  assert.deepEqual(parseStore(null), {});
});
