import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAC_GW, NOW, TRU_MAX, UA_PRO, config } from './fixtures.ts';
import { formatThreadTestQuota, parseResetAt, parseTestQuotaSpec, resolveStepRef, withThreadTestQuota } from './test-quota.ts';
import { quotaLookupFor } from './profiles.ts';

test('test-quota: ступень по ID, «Машина:провайдер» и подписи; неоднозначность — ошибка', () => {
  const c = config();
  assert.equal((resolveStepRef(c, TRU_MAX) as { id: string }).id, TRU_MAX);
  assert.equal((resolveStepRef(c, 'tru') as { id: string }).id, TRU_MAX);
  assert.equal((resolveStepRef(c, 'Mac:claude') as { id: string }).id, MAC_GW);
  assert.match(resolveStepRef(c, 'Mac') as string, /несколько ступеней/u);
  assert.equal((resolveStepRef(c, 'vclaude') as { id: string }).id, MAC_GW);
  assert.match(resolveStepRef(c, 'Марс') as string, /не найдена/u);
});

test('test-quota: разбор, относительный сброс, запись в тред и снятие', () => {
  const c = config();
  assert.equal(parseResetAt('+30m', NOW), new Date(NOW + 1_800_000).toISOString());
  assert.equal(parseResetAt('', NOW), null);
  assert.ok(parseResetAt('завтра', NOW) instanceof Error);
  const parsed = parseTestQuotaSpec(c, 'Tru=exhausted,+1h; Mac:claude=unknown;UA:claude=ok', NOW);
  assert.ok('entries' in parsed);
  assert.deepEqual(parsed.entries[TRU_MAX], { state: 'exhausted', resetsAt: new Date(NOW + 3_600_000).toISOString() });
  assert.equal(parsed.entries[UA_PRO]!.state, 'available');
  assert.match((parseTestQuotaSpec(c, 'Tru=сломан', NOW) as { error: string }).error, /состояние/u);
  const withQuota = withThreadTestQuota(c, 'thr_s1', { entries: parsed.entries });
  assert.equal(c.testQuota.threads.thr_s1, undefined, 'исходная конфигурация не меняется');
  const health = quotaLookupFor(withQuota, 'thr_s1', () => { throw new Error('реальные лимиты не нужны'); }, NOW);
  assert.equal(health(TRU_MAX, null).exhausted, true);
  assert.equal(health(MAC_GW, null).unknown, true);
  assert.match(formatThreadTestQuota(withQuota, 'thr_s1'), /Tru · Claude · Max 20: exhausted до /u);
  const merged = withThreadTestQuota(withQuota, 'thr_s1', { entries: { [TRU_MAX]: { state: 'available', resetsAt: null } } });
  assert.equal(merged.testQuota.threads.thr_s1![MAC_GW]!.state, 'unknown', 'новые записи добавляются к прежним');
  const cleared = withThreadTestQuota(merged, 'thr_s1', { clear: true });
  assert.equal(cleared.testQuota.threads.thr_s1, undefined);
  assert.match(formatThreadTestQuota(cleared, 'thr_s1'), /нет/u);
});
