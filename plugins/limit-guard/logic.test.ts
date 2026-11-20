import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  agentRules, appliesToModel, assess, blockingReset, classifyWindow, DEFAULT_THRESHOLDS as T, etaMinutes, formatDuration,
  normalizeThresholds, notification, render, resumeWindow, shouldNotify, stuckText, thresholdMessage, windowMode,
  type QuotaWindow, type StuckThread,
} from './logic.ts';

const w = (label: string, usedPercent: number, extra: Partial<QuotaWindow> = {}): QuotaWindow => ({
  label, kind: classifyWindow(label, extra.kind, extra.model), model: extra.model ?? null, usedPercent, resetsAt: null, etaMinutes: null, ...extra,
});

test('classifies provider windows', () => {
  assert.equal(classifyWindow('Current session'), 'five-hour');
  assert.equal(classifyWindow('Weekly limit'), 'weekly');
  assert.equal(classifyWindow('Fable'), 'model');
  assert.equal(classifyWindow('Anything', 'weekly', 'fable'), 'model');
  assert.equal(classifyWindow('Credits'), 'other');
});

test('model window counts only for that model', () => {
  const fable = w('Fable', 98, { model: 'fable' });
  assert.equal(appliesToModel(fable, 'claude-fable-5-2'), true);
  assert.equal(appliesToModel(fable, 'claude-opus-5-5'), false);
  assert.equal(assess([w('Current session', 10), fable], 'claude-opus-5-5', T).mode, 'normal');
  assert.equal(assess([w('Current session', 10), fable], 'claude-fable-5-2', T).mode, 'finish');
});

test('five-hour and weekly windows have their own thresholds', () => {
  assert.equal(windowMode(w('Current session', 74), T), 'normal');
  assert.equal(windowMode(w('Current session', 75), T), 'economy');
  assert.equal(windowMode(w('Current session', 90), T), 'finish');
  assert.equal(windowMode(w('Weekly limit', 89), T), 'normal', 'a week at 70-89% must not slow work for days');
  assert.equal(windowMode(w('Weekly limit', 90), T), 'economy');
  assert.equal(windowMode(w('Weekly limit', 97), T), 'finish');
});

test('pace makes a short window stricter, never a weekly one', () => {
  assert.equal(windowMode(w('Current session', 50, { etaMinutes: 35 }), T), 'economy');
  assert.equal(windowMode(w('Current session', 60, { etaMinutes: 8 }), T), 'finish');
  assert.equal(windowMode(w('Weekly limit', 60, { etaMinutes: 5 }), T), 'normal');
});

test('the worst window decides', () => {
  const a = assess([w('Current session', 40), w('Weekly limit', 92)], null, T);
  assert.equal(a.mode, 'economy');
  assert.equal(a.driver?.label, 'Weekly limit');
});

test('pace is estimated from recent growth only', () => {
  assert.equal(etaMinutes([{ at: 0, used: 50 }]), null);
  assert.equal(etaMinutes([{ at: 0, used: 50 }, { at: 8 * 60_000, used: 60 }]), null, 'two samples are not enough');
  assert.equal(etaMinutes([{ at: 0, used: 50 }, { at: 4 * 60_000, used: 55 }, { at: 8 * 60_000, used: 60 }]), null, 'less than ten minutes of data');
  assert.equal(etaMinutes([{ at: 0, used: 50 }, { at: 5 * 60_000, used: 50 }, { at: 10 * 60_000, used: 50 }]), null, 'not growing');
  assert.equal(Math.round(etaMinutes([{ at: 0, used: 20 }, { at: 6 * 60_000, used: 27 }, { at: 12 * 60_000, used: 33 }])!), 62);
});

test('no data is unknown and reads as normal work', () => {
  const a = assess([], null, T, 'машина не ответила');
  assert.equal(a.mode, 'unknown');
  assert.match(render(a, 0, { provider: 'codex', model: null, host: null, fetchedAt: null }), /НЕИЗВЕСТНО[\s\S]*работай как обычно/);
});

test('thresholds are clamped and ordered', () => {
  assert.deepEqual(normalizeThresholds({}), T);
  const odd = normalizeThresholds({ shortEconomy: 95, shortFinish: 80, longEconomy: -5, longFinish: 500, etaEconomy: 5, etaFinish: 20 });
  assert.deepEqual(odd.short, { economy: 95, finish: 95 });
  assert.deepEqual(odd.long, { economy: 1, finish: 100 });
  assert.equal(odd.etaEconomyMinutes, 20);
});

test('durations read naturally', () => {
  assert.equal(formatDuration(-1), 'скоро');
  assert.equal(formatDuration(33 * 60_000), '33 мин');
  assert.equal(formatDuration(125 * 60_000), '2 ч 5 мин');
  assert.equal(formatDuration((3 * 24 + 4) * 3_600_000), '3 д 4 ч');
});

test('finish near a reset says save and wait; a model window suggests another model', () => {
  const now = Date.parse('2026-11-19T09:00:00Z');
  const soon = assess([w('Current session', 96, { resetsAt: '2026-11-19T09:20:00Z' })], null, T);
  assert.match(render(soon, now, { provider: 'claude-code', model: null, host: 'Tru', fetchedAt: null }), /сохранись и жди/);
  const model = assess([w('Fable', 99, { model: 'fable', resetsAt: '2026-11-24T09:00:00Z' })], 'claude-fable-5-2', T);
  assert.match(thresholdMessage(model, now, 'claude-code'), /^\[limit-guard\] Лимит Claude «Fable»: 99%.*ФИНИШ.*другой модели этого же сервиса/);
});

test('agent rules no longer allow commits or pushes for the sake of the limit', () => {
  const rules = agentRules();
  assert.match(rules, /Ради лимита коммитить не нужно/);
  assert.match(rules, /не `git add -A`/);
  assert.doesNotMatch(rules, /разрешает .*push/);
  assert.ok(rules.length < 4096);
});

const stuck = (extra: Partial<StuckThread> = {}): StuckThread => ({
  threadId: 'thr_1', title: 'Задача', providerId: 'claude-code', failedAt: 0, resetAt: null, retry: 'unknown', retryAt: null,
  modelLimited: null, alternative: null, notified: false, ...extra,
});

test('blocking reset is the full window that frees last', () => {
  assert.equal(blockingReset([{ usedPercent: 100, resetsAtMs: 10 }, { usedPercent: 40, resetsAtMs: 99 }, { usedPercent: 100, resetsAtMs: 50 }]), 50);
  assert.equal(blockingReset([{ usedPercent: 80, resetsAtMs: 10 }, { usedPercent: 90, resetsAtMs: 30 }]), 30);
  assert.equal(blockingReset([]), null);
});

test('notify: long waits and no-retry; short or unknown-retry waits stay quiet', () => {
  const now = 1_000_000;
  assert.equal(shouldNotify({ resetAt: now + 10 * 60_000, retry: 'queued', retryAt: now + 10 * 60_000, notified: false }, now, 60), false);
  assert.equal(shouldNotify({ resetAt: now + 3 * 3_600_000, retry: 'queued', retryAt: now + 3 * 3_600_000, notified: false }, now, 60), true);
  assert.equal(shouldNotify({ resetAt: now + 5 * 60_000, retry: 'unknown', retryAt: null, notified: false }, now, 60), false, 'decision not seen: no false alarm');
  assert.equal(shouldNotify({ resetAt: now + 5 * 60_000, retry: 'none', retryAt: null, notified: false }, now, 60), true, 'nothing will resume it');
  assert.equal(shouldNotify({ resetAt: null, retry: 'none', retryAt: null, notified: true }, now, 60), false);
});

test('suggestions: another provider with room, another model, or wait', () => {
  const now = Date.parse('2026-11-19T09:00:00Z');
  const s = stuck({ retry: 'queued', retryAt: now + 2 * 3_600_000, alternative: { providerId: 'codex', mode: 'normal', percent: 20 } });
  const text = stuckText(s, now);
  assert.match(text, /bb handoff thr_1 --to codex\s/);
  assert.doesNotMatch(text, /--briefing/, 'the stuck source agent cannot write a briefing');
  assert.match(notification(s, now).body, /Можно передать в Codex \(занято 20%\)/);
  assert.match(stuckText(stuck({ modelLimited: 'Fable' }), now), /смените модель/);
  assert.match(notification(stuck({ retry: 'none' }), now).body, /Автоповтора нет/);
  assert.match(stuckText(stuck({ alternative: { providerId: 'codex', mode: 'finish', percent: 97 } }), now), /лучше подождать/);
  assert.ok(notification(stuck({ title: 'x'.repeat(200) }), now).title.length <= 80);
});

test('a resume waits for the most pressing window, the soonest among equals', () => {
  const now = Date.parse('2026-11-20T04:30:00Z');
  const at = (h: number) => new Date(now + h * 3_600_000).toISOString();
  const calm = [w('Current session', 27, { resetsAt: at(5) }), w('Weekly limit', 44, { resetsAt: at(80) })];
  assert.equal(resumeWindow(calm, null, T, now), null, 'nothing pressing: no window to wait for');
  const hidden = [w('Current session', 0, { resetsAt: null }), w('Weekly limit', 65, { resetsAt: at(80) })];
  assert.equal(resumeWindow(hidden, null, T, now), null, 'an exhausted window without a reset time must not pick the far weekly reset');
  const weekly = [w('Current session', 20, { resetsAt: at(4) }), w('Weekly limit', 98, { resetsAt: at(30) })];
  assert.equal(resumeWindow(weekly, null, T, now)?.label, 'Weekly limit', 'a full week decides even if later');
  assert.equal(resumeWindow([w('Current session', 50, { resetsAt: null })], null, T, now), null);
});
