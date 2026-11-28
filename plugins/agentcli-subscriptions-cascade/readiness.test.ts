// 0.3.5: готовность ступени (`check`) и отчёт о лимитах (`limits`) — чистые функции по
// ответам проб; неготовая ступень пропускается маршрутом с причиной.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkStep, formatCheck, formatLimits, limitsReport, tauStateOf, withReadiness, type StepProbes } from './readiness.ts';
import { ACCOUNTS, MAC, MAC_CODEX, MAC_GW, NOW, TRU, TRU_MAX, UA_CODEX, config, exhausted, ok, thread, unknown } from './fixtures.ts';
import { selectStep, explainProfile, type HealthLookup } from './engine.ts';

const PROBE = { platform: 'macos' as const, isRoot: false, user: 'u', sharedPathExists: true, sharedPathWritable: true, mutagenVersion: '0.18.1' };

function probes(patch: Partial<StepProbes> = {}): StepProbes {
  return {
    connected: true, probe: PROBE, account: { ...ACCOUNTS.find(a => a.hostId === MAC && a.providerId === 'codex')!, cliVersion: '0.130.0' },
    health: ok, tau: { state: 'available', usedPercent: 70 }, usedPercent: 70,
    wizard: { folder: { status: 'done' }, mutagen: { status: 'done' }, ssh: { status: 'done' } }, anchor: false, ...patch,
  };
}

test('готовая ступень: все пункты ✓', () => {
  const c = config();
  const step = c.steps.find(s => s.id === MAC_CODEX)!;
  const r = checkStep(c, step, probes());
  assert.equal(r.ready, true, formatCheck([r]));
  assert.deepEqual(r.items.filter(i => !i.ok), []);
  assert.deepEqual(r.items.map(i => i.id), ['machine', 'cli', 'login', 'limits', 'tau', 'models', 'shared-path', 'mutagen', 'ssh', 'dry-run']);
});

test('нет входа, нет Mutagen, SSH не проверялся — не готова, причина и подсказка по первому блокирующему пункту', () => {
  const c = config();
  const step = c.steps.find(s => s.id === MAC_CODEX)!;
  const account = { ...probes().account!, loggedIn: false, error: 'auth_required' };
  const r = checkStep(c, step, probes({ account, probe: { ...PROBE, mutagenVersion: null }, wizard: {} }));
  assert.equal(r.ready, false);
  assert.match(r.reason!, /нет входа в codex \(auth_required\) — войдите на Mac: codex login/u);
  const failed = r.items.filter(i => !i.ok).map(i => i.id);
  assert.deepEqual(failed, ['login', 'mutagen', 'ssh']);
  assert.match(formatCheck([r]), /✗ Mac · Codex — не готова/u);
});

test('лимиты unknown и расхождение с Thread Account Usage — предупреждения, не блокируют', () => {
  const c = config();
  const step = c.steps.find(s => s.id === MAC_CODEX)!;
  const r = checkStep(c, step, probes({ health: unknown, usedPercent: null, tau: { state: 'available', usedPercent: 70 } }));
  assert.equal(r.ready, true);
  const limits = r.items.find(i => i.id === 'limits')!;
  assert.equal(limits.ok, false);
  assert.match(limits.title, /лимиты не читаются: квота неизвестна/u);
  assert.match(r.items.find(i => i.id === 'tau')!.title, /расходится с Thread Account Usage: там available 70 %, у каскада unknown/u);
});

test('опора: пункты общего пути, Mutagen и SSH не нужны; машина не на связи — не готова', () => {
  const c = config();
  const step = c.steps.find(s => s.id === TRU_MAX)!;
  const r = checkStep(c, step, probes({ anchor: true, connected: false, probe: null, account: ACCOUNTS[0] }));
  assert.ok(!r.items.some(i => ['shared-path', 'mutagen', 'ssh'].includes(i.id)));
  assert.equal(r.ready, false);
  assert.match(r.reason!, /машина Tru не на связи/u);
});

test('сверка с TAU: строка VClaude для шлюза, провайдер:машина для подписки, неизвестно без окон', () => {
  const c = config();
  const gw = c.steps.find(s => s.id === MAC_GW)!;
  const codex = c.steps.find(s => s.id === MAC_CODEX)!;
  const tau = [
    { providerId: 'vclaude', hostIds: [MAC], status: 'ok', windows: [{ usedPercent: 20 }] },
    { providerId: 'codex', hostIds: [MAC], status: 'ok', windows: [{ usedPercent: 99.5 }] },
    { providerId: 'codex', hostIds: [TRU], status: 'unavailable', windows: [] },
  ];
  assert.deepEqual(tauStateOf(tau, gw, 99), { state: 'available', usedPercent: 20 });
  assert.deepEqual(tauStateOf(tau, codex, 99), { state: 'exhausted', usedPercent: 99.5 });
  assert.deepEqual(tauStateOf(tau, { ...codex, hostId: TRU }, 99), { state: 'unknown', usedPercent: null });
  assert.equal(tauStateOf(tau, { ...codex, hostId: 'host_x' }, 99), null);
});

test('отчёт limits: состояние, строка, источник и причина неизвестности', () => {
  const c = config();
  const lines = limitsReport(c, step => step.id === MAC_GW
    ? { health: unknown, text: 'квота неизвестна' }
    : step.id === TRU_MAX ? { health: exhausted(NOW + 3_600_000), text: 'неделя 100%' } : { health: ok, text: 'неделя 70%' });
  const gw = lines.find(l => l.stepId === MAC_GW)!;
  assert.equal(gw.state, 'unknown');
  assert.equal(gw.reason, 'квота неизвестна');
  assert.match(gw.source, /кабинет VClaude/u);
  assert.equal(lines.find(l => l.stepId === TRU_MAX)!.reason, null);
  assert.match(lines.find(l => l.stepId === MAC_CODEX)!.source, /usageLimits\(\)\.codex/u);
  assert.match(formatLimits(lines), /причина: квота неизвестна/u);
});

test('неготовая ступень: маршрут её пропускает (следующая ступень), схема «i» показывает причину', () => {
  const c = config();
  const notReady = 'нет входа в claude';
  const health: HealthLookup = id => withReadiness(ok, id === TRU_MAX ? notReady : null);
  const input = { config: c, requestedModel: 'auto', accounts: ACCOUNTS, thread: thread(), health, now: NOW };
  const d = selectStep(input);
  assert.ok(d.kind === 'run' && d.stepId === MAC_GW, JSON.stringify(d));
  const tru = explainProfile(input).attempts.find(a => a.stepId === TRU_MAX)!;
  assert.equal(tru.state, 'unavailable');
  assert.equal(tru.reason, `ступень не готова: ${notReady}`);
  assert.ok(UA_CODEX);
});
