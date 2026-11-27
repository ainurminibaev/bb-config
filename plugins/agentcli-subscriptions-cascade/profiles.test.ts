import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from './config.ts';
import { explainProfile, selectStep, type HealthLookup } from './engine.ts';
import { ACCOUNTS, MAC_CODEX, MAC_GW, NOW, TRU_MAX, UA_CODEX, UA_PRO, config, exhausted, ok, thread, unknown } from './fixtures.ts';
import type { StepHealth } from './limits.ts';
import {
  describeProfile, duplicateProfile, presetProfile, previewLookup, profilePreview, providerModels, quotaLookupFor, testQuotaLookup, usesTestQuota,
} from './profiles.ts';

const describe = (id: string, c = config()) => describeProfile(c, c.profiles.find(p => p.id === id)!, ACCOUNTS);

test('подпись профиля: первая ступень и правило', () => {
  assert.equal(describe('auto'), 'Старт: Opus · Tru — первая в приоритете моделей. Дальше любые модели по ступеням Tru → Mac → UA; Codex — с подтверждением');
  assert.equal(describe('auto-no-codex'), 'Старт: Opus · Tru — первая в приоритете моделей. Дальше любые модели по ступеням Tru → Mac → UA, без Codex');
  assert.equal(describe('fable-then-auto'), 'Старт: Fable · Tru. Сначала Fable на Tru → Mac, потом любые модели; Codex — с подтверждением');
  assert.equal(describe('only-opus-5.5'), 'Старт: Opus · Tru. Только Opus 5.5 на Tru → Mac → UA');
  const c = config();
  c.policies.modelPriority = ['fable-5.2'];
  assert.match(describe('auto', c), /^Старт: Fable · Tru — первая в приоритете моделей/, '«Авто» стартует с первой модели приоритета');
});

test('список моделей провайдера = включённые профили в порядке владельца', () => {
  const c = config();
  const models = providerModels(c, ACCOUNTS);
  assert.deepEqual(models.map(m => [m.id, m.displayName]), c.profiles.map(p => [p.id, p.name]));
  assert.deepEqual(models.map(m => m.isDefault), [true, false, false, false, false, false]);
  assert.ok(models.every(m => m.description.startsWith('Старт: ')));
  // «Авто» выключено — по умолчанию следующий профиль; профиль без ступеней не показывается.
  c.profiles = c.profiles.map(p => p.id === 'auto' ? { ...p, enabled: false } : p);
  c.models = c.models.map(r => r.key === 'fable-5.2' ? { ...r, cells: Object.fromEntries(c.machines.map(m => [m.hostId, { modelId: null, source: 'none' as const }])) } : r);
  const after = providerModels(c, ACCOUNTS);
  assert.equal(after[0]!.id, 'auto-no-codex');
  assert.equal(after[0]!.isDefault, true);
  assert.ok(!after.some(m => m.id === 'only-fable-5.2'), '«Только Fable» без ассоциаций не показывается');
});

test('умолчания только для конфигурации без профилей; пустой список владельца сохраняется', () => {
  const legacy = normalizeConfig({ machines: [], steps: [], models: [{ key: 'opus-5.5', displayName: 'Opus 5.5', providerId: 'claude-code' }] });
  assert.deepEqual(legacy.profiles.map(p => p.id), ['auto', 'auto-no-codex', 'opus-then-auto', 'only-opus-5.5']);
  assert.deepEqual(normalizeConfig({ ...legacy, profiles: [] }).profiles, []);
});

test('«+ Профиль»: заготовки и дублирование с уникальным ID', () => {
  const c = config();
  assert.deepEqual([presetProfile('only-model', c).id, presetProfile('only-model', c).policy], ['only-opus-5.5-2', 'only']);
  assert.equal(presetProfile('model-then-auto', c).name, 'Opus → Авто');
  assert.deepEqual(presetProfile('no-codex', c).excludedProviders, ['codex']);
  const copy = duplicateProfile(c.profiles[0]!, c);
  assert.deepEqual([copy.id, copy.name], ['auto-copy', 'Авто (копия)']);
});

test('тестовый источник квоты: только в тестовых тредах; превью и схема его учитывают', () => {
  const c = config();
  c.testQuota = { enabled: true, threadIds: ['thr_test'], steps: { [TRU_MAX]: { state: 'exhausted', resetsAt: new Date(NOW + 3_600_000).toISOString() }, [MAC_GW]: { state: 'unknown', resetsAt: null } }, threads: {}, bridgeIncompatible: false };
  const real: HealthLookup = () => ok;
  const input = (threadId: string) => ({ config: c, requestedModel: 'auto', accounts: ACCOUNTS, now: NOW, thread: thread({ threadId }), health: quotaLookupFor(c, threadId, real, NOW) });
  const t = selectStep(input('thr_test'));
  assert.equal(t.kind === 'run' && t.stepId, UA_PRO, 'S1/S10 на тестовых лимитах: Tru исчерпан, vclaude неизвестен → UA');
  assert.equal((d => d.kind === 'run' && d.stepId)(selectStep(input('thr_real'))), TRU_MAX, 'обычный тред видит реальные лимиты');
  assert.deepEqual(testQuotaLookup(c)(TRU_MAX, null).resetsAt, NOW + 3_600_000);
  const preview = profilePreview(c, 'auto', ACCOUNTS, previewLookup(c, {}), NOW);
  assert.equal(preview.text, 'сейчас ход пошёл бы на: Opus · UA');
  assert.deepEqual(preview.attempts.filter(a => a.stepId === TRU_MAX).map(a => a.state), ['exhausted', 'exhausted']);
  c.testQuota.enabled = false;
  assert.equal(quotaLookupFor(c, 'thr_test', real), real, 'флаг выключен — подмены нет');
});

test('превью: «сейчас ход пошёл бы на: Opus · vclaude Mac» по сводке лимитов', () => {
  const c = config();
  const summary = { [TRU_MAX]: { state: 'exhausted' as const, resetsAt: NOW + 3_600_000 }, [MAC_GW]: { state: 'available' as const, resetsAt: null } };
  assert.equal(profilePreview(c, 'auto', ACCOUNTS, previewLookup(c, summary), NOW).text, 'сейчас ход пошёл бы на: Opus · vclaude Mac');
  const all = { ...summary, [MAC_GW]: { state: 'exhausted' as const, resetsAt: null }, [UA_PRO]: { state: 'exhausted' as const, resetsAt: null }, [MAC_CODEX]: { state: 'available' as const, resetsAt: null } };
  assert.equal(profilePreview(c, 'auto', ACCOUNTS, previewLookup(c, all), NOW).text, 'сейчас ход пошёл бы на: Codex · Mac — после подтверждения');
  assert.match(profilePreview(c, 'auto-no-codex', ACCOUNTS, previewLookup(c, all), NOW).text, /^всё исчерпано — ждать сброса до /);
});

test('схема «i» строится из движка: отмеченная попытка совпадает с selectStep во всех сценариях', () => {
  const states: StepHealth[] = [ok, unknown, exhausted(NOW + 3_600_000), exhausted(null)];
  const steps = [TRU_MAX, MAC_GW, UA_PRO, MAC_CODEX, UA_CODEX];
  const c = config();
  c.profiles.find(p => p.id === 'fable-then-auto')!.excludedSteps = [UA_PRO];
  let checked = 0;
  for (const profile of c.profiles) {
    // Все сочетания четырёх состояний на первых трёх ступенях × два состояния Codex.
    for (let mask = 0; mask < 4 ** 3 * 2; mask++) {
      const health: Record<string, StepHealth> = {};
      steps.forEach((id, i) => { health[id] = i < 3 ? states[Math.floor(mask / 4 ** i) % 4]! : mask >= 64 ? exhausted(null) : ok; });
      const input = { config: c, requestedModel: profile.id, accounts: ACCOUNTS, now: NOW, thread: thread(), health: ((id: string) => health[id] ?? ok) as HealthLookup };
      const { attempts, decision } = explainProfile(input);
      assert.deepEqual(decision, selectStep(input));
      const chosen = attempts.filter(a => a.chosen);
      if (decision.kind === 'run' || decision.kind === 'confirm') {
        assert.equal(chosen.length, 1);
        assert.deepEqual([chosen[0]!.stepId, chosen[0]!.modelId], [decision.stepId, decision.modelId]);
        assert.equal(chosen[0]!.skip, null, 'исключённая ступень не бывает выбранной');
        assert.equal(chosen[0]!.state === 'available' || chosen[0]!.state === 'unknown', true);
      } else assert.equal(chosen.length, 0);
      checked++;
    }
  }
  assert.equal(checked, 6 * 128);
});

test('тестовая квота своего треда: главнее общей, действует без общего флага, исчерпание с прошедшим сбросом — «лимит есть»', () => {
  const c = config();
  c.testQuota = { enabled: false, threadIds: [], steps: { [TRU_MAX]: { state: 'exhausted', resetsAt: null } },
    threads: { thr_live: { [TRU_MAX]: { state: 'exhausted', resetsAt: new Date(NOW + 60_000).toISOString() }, [MAC_GW]: { state: 'unknown', resetsAt: null } } }, bridgeIncompatible: false };
  const real: HealthLookup = () => ok;
  assert.equal(usesTestQuota(c, 'thr_live'), true);
  assert.equal(usesTestQuota(c, 'thr_other'), false);
  const now = quotaLookupFor(c, 'thr_live', real, NOW);
  assert.equal(now(TRU_MAX, null).exhausted, true);
  assert.equal(now(MAC_GW, null).unknown, true);
  assert.equal(now(UA_PRO, null).exhausted, false, 'ступень без записи — «лимит есть»');
  const later = quotaLookupFor(c, 'thr_live', real, NOW + 120_000);
  assert.equal(later(TRU_MAX, null).exhausted, false, 'сброс прошёл');
  assert.equal(later(TRU_MAX, null).unknown, false, 'и квота подтверждена (S4)');
});
