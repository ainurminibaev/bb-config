// Резюме экрана настроек: заголовки свёрнутых секций, отличия от умолчаний,
// подпись «Старт: …» и полоска остатка.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CascadeState } from './contract.ts';
import { ACCOUNTS, MAC, MAC_GW, TRU, TRU_MAX, UA, account, config } from './fixtures.ts';
import { changedPolicies, limitLine, plural, remainingPercent, sectionSummaries, startLine, stepCustomized } from './settings-summary.ts';

function state(patch: Partial<CascadeState> = {}): CascadeState {
  const done = { status: 'done' as const, message: null, at: null };
  const ready = (hostId: string) => ({ hostId, steps: { probe: done, folder: done, mutagen: done, ssh: done, verify: done } });
  return {
    config: config(), accounts: ACCOUNTS, cells: {}, stepLimits: {}, projects: [], issues: [],
    hosts: [TRU, MAC, UA].map(hostId => ({ hostId, name: hostId, connected: true, platform: 'linux' as const })),
    wizard: [ready(TRU), ready(MAC), ready(UA)],
    ...patch,
  };
}

test('резюме: всё готово и по умолчанию — спокойные строки без предупреждений', () => {
  const s = sectionSummaries(state(), config());
  assert.deepEqual(s.machines, { text: '3 готовы' });
  assert.equal(s.models.tone, undefined);
  assert.match(s.models.text, /все сопоставлены$/);
  assert.equal(s.files.text, 'по требованию, с .env');
  assert.deepEqual(s.advanced, { text: 'по умолчанию', tone: 'muted' });
});

test('резюме: несопоставленные модели, машина без мастера, тестовая квота — предупреждение', () => {
  const cell = (status: 'unmatched' | 'auto') => ({ status, modelId: null, candidates: [] });
  const st = state({
    cells: { 'opus-5.5': { [TRU]: cell('auto'), [MAC]: cell('unmatched') }, 'haiku-5.5': { [TRU]: cell('unmatched'), [UA]: cell('unmatched') } },
    wizard: [],
  });
  const cfg = config();
  cfg.testQuota.enabled = true;
  const s = sectionSummaries(st, cfg);
  assert.deepEqual(s.models, { text: '3 несопоставленных', tone: 'warn' });
  assert.deepEqual(s.machines, { text: '3 на связи, не настроено: 3', tone: 'warn' });
  assert.deepEqual(s.advanced, { text: 'включена тестовая квота', tone: 'warn' });
});

test('резюме: машина не на связи важнее мастера; изменённые правила считаются', () => {
  const st = state({ hosts: [{ hostId: TRU, name: 'Tru', connected: false, platform: 'linux' }] });
  assert.deepEqual(sectionSummaries(st, config()).machines, { text: '3 не на связи из 3', tone: 'warn' });
  const cfg = config();
  cfg.policies.returnAfterMinutes = 10;
  cfg.policies.recheckMinutes = 99; // служебное поле на экран не выводится — не считается
  assert.deepEqual(changedPolicies(cfg), ['returnAfterMinutes']);
  assert.deepEqual(sectionSummaries(state(), cfg).advanced, { text: 'изменено: 1' });
});

test('подпись «Старт: …», склонения, полоска остатка и метка «⋯»', () => {
  assert.equal(startLine('Старт: Opus · Tru — первая в приоритете моделей. Дальше любые модели по ступеням Tru → Mac'), 'Старт: Opus · Tru');
  assert.equal(startLine('Старт: Fable · Tru. Только Fable 5.2 на Tru → Mac'), 'Старт: Fable · Tru');
  assert.deepEqual([1, 2, 5, 11, 21, 22].map(n => plural(n, 'готова', 'готовы', 'готово')), ['готова', 'готовы', 'готово', 'готово', 'готова', 'готовы']);
  const cfg = config();
  const tru = cfg.steps.find(s => s.id === TRU_MAX)!;
  const mac = cfg.steps.find(s => s.id === MAC_GW)!;
  const windows = [
    { kind: 'five-hour' as const, label: '5h', usedPercent: 40, resetsAt: null, models: [] },
    { kind: 'weekly' as const, label: 'Weekly', usedPercent: 56, resetsAt: null, models: [] },
  ];
  assert.equal(remainingPercent(account(TRU, 'claude-code', [], { windows }), tru), 44, 'по самому загруженному окну');
  assert.equal(remainingPercent(account(TRU, 'claude-code', []), tru), null, 'окон нет — без полоски');
  assert.equal(remainingPercent(account(MAC, 'claude-code', [], { windows }), mac), null, 'пакет vclaude — без полоски');
  assert.equal(stepCustomized(tru), false);
  assert.equal(stepCustomized(mac), true, 'шлюз vclaude отличается от умолчаний');
});

test('строка лимита: окна по-русски, исчерпание со сбросом, пакет с полоской', () => {
  const now = new Date(2026, 10, 27, 12, 0).getTime();
  assert.deepEqual(limitLine({ state: 'available', text: '5h 40% · Weekly 56%', resetsAt: null }, now), { text: '5 ч 40 % · неделя 56 %', remaining: null });
  assert.deepEqual(limitLine({ state: 'exhausted', text: 'Weekly 100%', resetsAt: new Date(2026, 11, 1, 21, 0).getTime() }, now), { text: 'исчерпан до 01.12 21:00', remaining: 0 });
  assert.equal(limitLine({ state: 'exhausted', text: 'Weekly 100%', resetsAt: new Date(2026, 10, 27, 17, 5).getTime() }, now).text, 'исчерпан до 17:05');
  const pkg = limitLine({ state: 'available', text: 'осталось 380,73 млн из 405 млн ед., до 27 дек', resetsAt: null }, now);
  assert.equal(pkg.text, '380,73 из 405 млн');
  assert.equal(Math.round(pkg.remaining!), 94);
  assert.equal(limitLine({ state: 'unknown', text: 'Weekly 20% (квота неизвестна: данные устарели)', resetsAt: null }, now).text, 'неделя 20 %');
  assert.deepEqual(limitLine(undefined, now), { text: 'лимит не прочитан', remaining: null });
});
