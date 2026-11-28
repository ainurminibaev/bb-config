// 0.3.5: usageLimits BB отвечает для Codex 403 («Codex usage request failed (HTTP 403)»: машина
// с российским IP), а сам Codex на машине квоту знает — окна берутся из account/rateLimits/read.
import assert from 'node:assert/strict';
import test from 'node:test';
import { codexAppServerWindows, usageWindows } from './logic.ts';

// Образцы живых ответов (обезличены).
const USAGE_403 = { status: 'error', message: 'Codex usage request failed (HTTP 403).' };
const APP_SERVER = { limitId: 'codex', primary: { usedPercent: 65, windowDurationMins: 10080, resetsAt: 1796217355 }, secondary: null, planType: 'pro', rateLimitReachedType: null };

test('403 от usageLimits — окон нет; ответ самого Codex даёт недельное окно с процентом и сбросом', () => {
  assert.deepEqual(usageWindows(USAGE_403), { ok: false, windows: [] });
  assert.deepEqual(codexAppServerWindows(APP_SERVER), [{ label: 'Weekly limit', kind: 'weekly', usedPercent: 65, resetsAt: new Date(1796217355 * 1000).toISOString() }]);
});

test('пятичасовое и недельное окна; пустой или чужой ответ — пусто', () => {
  const both = codexAppServerWindows({ primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1796000000 }, secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: null } });
  assert.deepEqual(both.map(w => [w.kind, w.usedPercent, w.resetsAt === null]), [['five-hour', 12, false], ['weekly', 40, true]]);
  assert.deepEqual(codexAppServerWindows(undefined), []);
  assert.deepEqual(codexAppServerWindows({ primary: { usedPercent: 'x' } }), []);
});
