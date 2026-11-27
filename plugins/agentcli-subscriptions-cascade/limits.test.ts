import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Reading, Stage } from './adapter.ts';
import { claudeEventReading, codexEventReading } from './adapters.ts';
import { describeReading, healthFromReading, LimitMonitor, mergeReading, readingFromPackageUsage, readingFromUsageLimits, toInstant, windowAppliesTo } from './limits.ts';
import { NOW } from './fixtures.ts';

const stage: Stage = { hostId: 'host_tru', provider: 'claude-code', profileRef: 'default', authority: 'subscription', bindingEpoch: 'e1' };
const policies = { minRemainingPercent: 1, positiveFreshSeconds: 60 };
const usage = (windows: unknown[], extra: Record<string, unknown> = {}) => ({ status: 'ok', accountKey: 'acc-1', windows, ...extra });
const iso = (ms: number) => new Date(ms).toISOString();

test('время: секунды, миллисекунды, ISO только с поясом', () => {
  assert.equal(toInstant(1_767_225_600), 1_767_225_600_000);
  assert.equal(toInstant(1_767_225_600_000), 1_767_225_600_000);
  assert.equal(toInstant('2026-12-01T21:00:00Z'), Date.parse('2026-12-01T21:00:00Z'));
  assert.equal(toInstant('2026-12-01T21:00:00'), null);
});

test('usageLimits → Reading: окна, модельная область, unknown по статусам', () => {
  const r = readingFromUsageLimits(usage([{ kind: 'five_hour', label: '5-hour limit', usedPercent: 40, resetsAt: iso(NOW + 3_600_000) }, { kind: 'model', label: 'Weekly Opus', usedPercent: 100, resetsAt: iso(NOW + 86_400_000) }]), stage, NOW, true);
  assert.equal(r.kind, 'sample');
  if (r.kind !== 'sample') return;
  assert.equal(r.subjectRef, 'acc-1');
  assert.equal(r.windows[0]!.period, 'five-hour');
  assert.deepEqual(r.windows[1]!.scope, { kind: 'model', id: 'opus' });
  assert.equal(r.windows[0]!.timeBasis, 'direct-read');
  assert.deepEqual(readingFromUsageLimits({ status: 'unauthenticated' }, stage, NOW, true), { kind: 'unknown', reason: 'auth', checkedAt: NOW });
  assert.equal((readingFromUsageLimits(usage([]), stage, NOW, true) as { reason: string }).reason, 'empty');
});

test('модельное окно блокирует только свою модель', () => {
  const r = readingFromUsageLimits(usage([{ kind: 'model', label: 'Weekly Opus', usedPercent: 100, resetsAt: iso(NOW + 86_400_000) }, { kind: 'weekly', label: 'Weekly', usedPercent: 30, resetsAt: iso(NOW + 86_400_000) }]), stage, NOW, true);
  const opus = healthFromReading(r, 'claude-opus-5-5', { connected: true, now: NOW, policies });
  const fable = healthFromReading(r, 'claude-fable-5-2', { connected: true, now: NOW, policies });
  assert.equal(opus.exhausted, true);
  assert.equal(fable.exhausted, false);
  assert.equal(fable.unknown, false);
  if (r.kind === 'sample') assert.equal(windowAppliesTo(r.windows[0]!, null), false);
});

test('несколько блокирующих окон: возврат после самого позднего сброса', () => {
  const r = readingFromUsageLimits(usage([{ kind: 'five_hour', label: '5h', usedPercent: 100, resetsAt: iso(NOW + 3_600_000) }, { kind: 'weekly', label: 'Weekly', usedPercent: 99.6, resetsAt: iso(NOW + 5 * 86_400_000) }]), stage, NOW, true);
  assert.equal(healthFromReading(r, null, { connected: true, now: NOW, policies }).resetsAt, NOW + 5 * 86_400_000);
});

test('свежесть: старое и кэшированное показание не даёт положительного решения', () => {
  const fresh = readingFromUsageLimits(usage([{ kind: 'weekly', label: 'Weekly', usedPercent: 10, resetsAt: iso(NOW + 86_400_000) }]), stage, NOW - 30_000, true);
  assert.equal(healthFromReading(fresh, null, { connected: true, now: NOW, policies }).unknown, false);
  assert.equal(healthFromReading(fresh, null, { connected: true, now: NOW + 120_000, policies }).unknown, true);
  const cached = readingFromUsageLimits(usage([{ kind: 'weekly', label: 'Weekly', usedPercent: 10, resetsAt: iso(NOW + 86_400_000) }]), stage, NOW, false);
  assert.equal(healthFromReading(cached, null, { connected: true, now: NOW, policies }).unknown, true);
  assert.equal(healthFromReading(undefined, null, { connected: false, now: NOW, policies }).available, false);
});

test('пакет vclaude: остаток в единицах, без процента окна и периодического сброса', () => {
  const raw = { usage: { fetchedAt: iso(NOW), limitUnits: 405_000_000, remainingUnits: 380_730_000, endsAt: '2026-12-27T00:00:00Z' }, error: null };
  const gateway: Stage = { ...stage, hostId: 'host_mac', authority: 'gateway', quotaSource: 'vclaude' };
  const r = readingFromPackageUsage(raw, gateway, NOW);
  assert.equal(r.kind, 'sample');
  if (r.kind !== 'sample') return;
  const w = r.windows[0]!;
  assert.deepEqual(w.remaining, { amount: 380_730_000, unit: 'ед.', estimated: false });
  assert.equal(w.resetsAt, null);
  assert.equal(w.expiresAt, Date.parse('2026-12-27T00:00:00Z'));
  const health = healthFromReading(r, null, { connected: true, now: NOW, policies });
  assert.deepEqual([health.exhausted, health.unknown], [false, false]);
  assert.match(describeReading(r, health).text, /^осталось 380,73 млн из 405 млн ед\., до 27 дек/);
  // 99,9 % пакета израсходовано, но единицы ещё есть — не исчерпано (считаем в единицах).
  const almost = readingFromPackageUsage({ usage: { ...raw.usage, remainingUnits: 400_000 } }, gateway, NOW);
  assert.equal(healthFromReading(almost, null, { connected: true, now: NOW, policies }).exhausted, false);
  const empty = readingFromPackageUsage({ usage: { ...raw.usage, remainingUnits: 0 } }, gateway, NOW);
  assert.equal(healthFromReading(empty, null, { connected: true, now: NOW, policies }).exhausted, true);
  const expired = readingFromPackageUsage({ usage: { ...raw.usage, endsAt: iso(NOW - 1) } }, gateway, NOW);
  assert.equal(healthFromReading(expired, null, { connected: true, now: NOW, policies }).exhausted, true);
  assert.equal(readingFromPackageUsage({ usage: null, error: 'нет входа' }, gateway, NOW).kind, 'unknown');
});

test('merge: исчерпание держится до сброса, отказ источника его не стирает, новое поколение сбрасывает', () => {
  const ex = readingFromUsageLimits(usage([{ kind: 'weekly', label: 'Weekly', usedPercent: 100, resetsAt: iso(NOW + 86_400_000) }]), stage, NOW, true);
  const partial = readingFromUsageLimits(usage([{ kind: 'five_hour', label: '5h', usedPercent: 5, resetsAt: iso(NOW + 3_600_000) }]), stage, NOW + 1000, true);
  const merged = mergeReading(ex, partial, NOW + 1000);
  assert.equal(healthFromReading(merged, null, { connected: true, now: NOW + 1000, policies }).exhausted, true);
  const failed: Reading = { kind: 'unknown', reason: 'timeout', checkedAt: NOW + 2000 };
  assert.equal(healthFromReading(mergeReading(ex, failed, NOW + 2000), null, { connected: true, now: NOW + 2000, policies }).exhausted, true);
  const other = { ...partial, bindingEpoch: 'e2' } as Reading;
  assert.equal(healthFromReading(mergeReading(ex, other, NOW + 1000), null, { connected: true, now: NOW + 1000, policies }).exhausted, false);
});

test('rejected от провайдера блокирует до retryAt', () => {
  const r = claudeEventReading(stage, { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: (NOW + 600_000) / 1000, utilization: 1.02 } }, NOW)!;
  const h = healthFromReading(r, null, { connected: true, now: NOW, policies });
  assert.deepEqual([h.exhausted, h.resetsAt], [true, NOW + 600_000]);
});

test('события Claude: строка статуса и spend_limit шлюза', () => {
  const r = claudeEventReading(stage, { rate_limits: { five_hour: { used_percentage: 12, resets_at: (NOW + 3_600_000) / 1000 }, spend_limit: { used_percentage: 30, limit_usd: 100, used_usd: 30, period: 'monthly' } } }, NOW);
  assert.equal(r?.kind, 'sample');
  if (r?.kind !== 'sample') return;
  assert.deepEqual(r.windows.map(w => [w.windowId, w.origin]), [['statusline:five_hour', 'statusline'], ['spend:monthly', 'statusline']]);
  assert.deepEqual(r.windows[1]!.remaining, { amount: 70, unit: 'USD', estimated: true });
  assert.equal(claudeEventReading(stage, { type: 'assistant' }, NOW), null);
});

test('события Codex: account/rateLimits/updated', () => {
  const r = codexEventReading({ ...stage, provider: 'codex' }, { method: 'account/rateLimits/updated', params: { rateLimits: { primary: { usedPercent: 55, windowDurationMins: 300, resetsAt: (NOW + 3_600_000) / 1000 }, secondary: null } } }, NOW);
  assert.equal(r?.kind === 'sample' && r.windows.length, 1);
  assert.equal(r?.kind === 'sample' && r.windows[0]!.period, 'five-hour');
});

test('монитор объединяет параллельные чтения и игнорирует старое поколение', async () => {
  let calls = 0;
  const adapter = {
    provider: 'claude-code', supports: () => ({ poll: true, events: true }),
    read: async (s: Stage) => { calls++; await new Promise(r => setTimeout(r, 5)); return readingFromUsageLimits(usage([{ kind: 'weekly', label: 'W', usedPercent: 10, resetsAt: iso(NOW + 86_400_000) }]), s, Date.now(), true); },
    onNativeEvent: () => null,
  };
  const monitor = new LimitMonitor(() => adapter);
  await Promise.all([monitor.refresh(stage, 1000), monitor.refresh(stage, 1000)]);
  assert.equal(calls, 1);
  assert.equal(monitor.current(stage)?.kind, 'sample');
  const slow = { ...adapter, read: () => new Promise<Reading>(() => undefined) };
  const timed = new LimitMonitor(() => slow);
  const r = await timed.refresh({ ...stage, bindingEpoch: 'e9' }, 20);
  assert.deepEqual(r && r.kind === 'unknown' && r.reason, 'timeout');
});
