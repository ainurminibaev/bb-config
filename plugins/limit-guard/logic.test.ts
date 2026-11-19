import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentRules, appliesToModel, assess, classifyWindow, formatDuration, normalizeThresholds, render, type QuotaWindow } from './logic.ts';

const T = { economy: 70, finish: 90 };
const w = (label: string, usedPercent: number, extra: Partial<QuotaWindow> = {}): QuotaWindow => ({
  label, kind: classifyWindow(label, extra.kind, extra.model), model: extra.model ?? null, usedPercent, resetsAt: null, ...extra,
});

test('classifies provider windows', () => {
  assert.equal(classifyWindow('Current session'), 'five-hour');
  assert.equal(classifyWindow('Weekly limit'), 'weekly');
  assert.equal(classifyWindow('Fable'), 'model');
  assert.equal(classifyWindow('Anything', 'weekly', 'fable'), 'model');
  assert.equal(classifyWindow('Credits'), 'other');
});

test('model window counts only for that model', () => {
  const fable = w('Fable', 95, { model: 'fable' });
  assert.equal(appliesToModel(fable, 'claude-fable-5-2'), true);
  assert.equal(appliesToModel(fable, 'claude-opus-5-5'), false);
  assert.equal(appliesToModel(fable, null), false);
  assert.equal(assess([w('Current session', 10), fable], 'claude-opus-5-5', T).mode, 'normal');
  assert.equal(assess([w('Current session', 10), fable], 'claude-fable-5-2', T).mode, 'finish');
});

test('mode follows the fullest relevant window', () => {
  assert.equal(assess([w('Current session', 69), w('Weekly limit', 20)], null, T).mode, 'normal');
  const a = assess([w('Current session', 40), w('Weekly limit', 70)], null, T);
  assert.equal(a.mode, 'economy');
  assert.equal(a.driver?.label, 'Weekly limit');
  assert.equal(assess([w('Current session', 90)], null, T).mode, 'finish');
  assert.equal(assess([w('Current session', 100)], null, T).mode, 'finish');
});

test('no data means unknown, never normal', () => {
  const a = assess([], null, T, 'машина не ответила');
  assert.equal(a.mode, 'unknown');
  assert.match(render(a, 0, { provider: 'codex', model: null, host: null, fetchedAt: null }), /НЕИЗВЕСТНО[\s\S]*маленькими шагами/);
});

test('thresholds are clamped and ordered', () => {
  assert.deepEqual(normalizeThresholds({}), { economy: 70, finish: 90 });
  assert.deepEqual(normalizeThresholds({ economy: 95, finish: 80 }), { economy: 95, finish: 95 });
  assert.deepEqual(normalizeThresholds({ economy: -5, finish: 500 }), { economy: 1, finish: 100 });
  assert.deepEqual(normalizeThresholds({ economy: Number.NaN, finish: 85.6 }), { economy: 70, finish: 86 });
});

test('durations read naturally', () => {
  assert.equal(formatDuration(-1), 'скоро');
  assert.equal(formatDuration(20_000), '1 мин');
  assert.equal(formatDuration(33 * 60_000), '33 мин');
  assert.equal(formatDuration(125 * 60_000), '2 ч 5 мин');
  assert.equal(formatDuration((3 * 24 + 4) * 3_600_000), '3 д 4 ч');
});

test('finish near a five-hour reset suggests waiting', () => {
  const now = Date.parse('2026-11-19T09:00:00Z');
  const a = assess([w('Current session', 96, { resetsAt: '2026-11-19T09:20:00Z' })], null, T);
  const out = render(a, now, { provider: 'claude-code', model: 'claude-opus-5-5', host: 'Tru', fetchedAt: '2026-11-19T08:59:00Z' });
  assert.match(out, /ФИНИШ \(Current session: 96%, сброс через 20 мин\)/);
  assert.match(out, /provider-retry/);
  assert.match(out, /данные на 08:59 UTC/);
});

test('agent rules state thresholds and safety', () => {
  const rules = agentRules({ economy: 60, finish: 85 });
  assert.match(rules, /обычный < 60%, экономный 60–84%, финиш ≥ 85%/);
  assert.match(rules, /force-push/);
  assert.ok(rules.length < 4096);
});
