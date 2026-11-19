import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyWindow, type QuotaWindow } from './logic.ts';
import { decideHold, DEFAULT_POLICIES as P, floatingThreshold, holdReason, nextCheckAt, normalizePolicy, parseMode, policiesFor, priorityStatus } from './priority-logic.ts';

const H = 3_600_000;
const now = Date.parse('2026-11-19T12:00:00Z');
const w = (label: string, used: number, resetIn: number | null, model: string | null = null): QuotaWindow => ({
  label, kind: classifyWindow(label, undefined, model), model, usedPercent: used, resetsAt: resetIn === null ? null : new Date(now + resetIn).toISOString(),
});

test('the five-hour threshold floats from 40% just after a reset to 90% half an hour before it', () => {
  assert.equal(floatingThreshold(P.short, 'short', now + 5 * H, now), 40);
  assert.equal(floatingThreshold(P.short, 'short', now + 30 * 60_000, now), 90);
  assert.equal(floatingThreshold(P.short, 'short', now + 10 * 60_000, now), 90);
  const mid = floatingThreshold(P.short, 'short', now + 2.75 * H, now);
  assert.ok(mid > 55 && mid < 75, `midway ${mid}`);
  assert.equal(floatingThreshold(P.short, 'short', null, now), 90, 'unknown reset never blocks more than the top');
});

test('a low-priority thread waits above the floating threshold and goes below it', () => {
  assert.equal(decideHold('low', P, [w('Current session', 63, 4.8 * H)], null, now).hold, true, 'fresh window: 63% is above ~42%');
  assert.equal(decideHold('low', P, [w('Current session', 63, 20 * 60_000)], null, now).hold, false, 'near the reset: 63% is below 90%');
  assert.equal(decideHold('normal', P, [w('Current session', 99, H)], null, now).hold, false);
});

test('each window has its own switch; a model window counts only for its model', () => {
  const windows = [w('Current session', 10, 4 * H), w('Fable', 97, 5 * 24 * H, 'fable')];
  assert.equal(decideHold('low', P, windows, 'claude-fable-5-2', now).hold, true);
  assert.equal(decideHold('low', P, windows, 'claude-opus-5-5', now).hold, false);
  const noModel = { ...P, model: { ...P.model, enabled: false } };
  assert.equal(decideHold('low', noModel, windows, 'claude-fable-5-2', now).hold, false);
});

test('background is stricter than low', () => {
  const windows = [w('Current session', 30, 4.9 * H)];
  assert.equal(decideHold('low', P, windows, null, now).hold, false);
  assert.equal(decideHold('background', P, windows, null, now).hold, true);
  assert.equal(policiesFor('background', P).short.low, 20);
});

test('missing limit data is reported as missing and never holds', () => {
  const d = decideHold('low', P, null, null, now);
  assert.equal(d.hold, false);
  assert.match(priorityStatus('low', d, null), /данных о лимите нет/);
  assert.match(priorityStatus('low', decideHold('low', P, [w('Current session', 63, 4.8 * H)], null, now), 'thr_p'), /при пороге \d+%.*от родителя thr_p/);
});

test('policies and modes are parsed safely', () => {
  assert.deepEqual(normalizePolicy({ low: 95, high: 50, nearMinutes: -3 }, P.short), { enabled: true, low: 95, high: 95, nearMinutes: 0 });
  assert.equal(parseMode('фоновый'), 'background');
  assert.equal(parseMode('off'), 'normal');
  assert.equal(parseMode('x'), null);
});

test('an exhausted window waits for its reset like a scheduled retry', () => {
  const d = decideHold('low', P, [w('Current session', 100, 2 * H)], null, now);
  assert.equal(d.hold, true);
  if (!d.hold) return;
  assert.equal(d.exhausted, true);
  assert.equal(nextCheckAt(d, now), now + 2 * H + 30_000);
  assert.match(holdReason('low', d), /исчерпан до .* — отправится само после сброса/);
  const partial = decideHold('low', P, [w('Current session', 70, 2 * H)], null, now);
  if (partial.hold) { assert.equal(partial.exhausted, false); assert.equal(nextCheckAt(partial, now), now + 2 * 60_000); }
});
