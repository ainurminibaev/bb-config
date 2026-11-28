// 0.3.4: проверка задания Codex-подтреда и чистые функции профиля «подтреды на Codex».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BRIEF_TEMPLATE, briefRefusalText, briefTextFromEvents, checkBrief, headingOf } from './brief.ts';
import { ACCOUNTS, MAC_CODEX, NOW, TRU_MAX, UA_CODEX, config, ok } from './fixtures.ts';
import { buildPlan } from './engine.ts';
import { describeProfile, profilePreview, providerModels, previewLookup } from './profiles.ts';
import { profileName } from './pins.ts';
import { codexFallbackReason, parentSendsChildrenToCodex, subthreadCodexProfile } from './subthreads.ts';

const RU = [
  '/goal Починить сборку; готово, когда npm test зелёный',
  '## Контекст', 'ветка bb/fix',
  '## Как делать', '1. тесты', '2. правка',
  '## Критерии приёмки', '- npm test → 0 падений',
].join('\n');

test('задание из четырёх частей (рус): принято; шаблон тоже проходит проверку после заполнения', () => {
  assert.deepEqual(checkBrief(RU), { ok: true, missing: [], empty: [] });
  assert.equal(checkBrief(BRIEF_TEMPLATE).ok, true, 'шаблон с многоточиями формально полон');
});

test('англ. заголовки, регистр, «ё/е», жирные и с двоеточием', () => {
  const en = ['/GOAL fix the build', '# CONTEXT', 'branch x', '### Steps', '- run tests', '**Acceptance criteria:** npm test passes'].join('\n');
  assert.equal(checkBrief(en).ok, true, JSON.stringify(checkBrief(en)));
  const mixed = ['/goal x', 'Контекст: ветка main', '**Порядок работы**', '1. шаг', 'КРИТЕРИИ ПРИЕМКИ: тесты зелёные'].join('\n');
  assert.equal(checkBrief(mixed).ok, true, JSON.stringify(checkBrief(mixed)));
  assert.equal(checkBrief(['  ', '/goal x', '## Context (files, branch)', 'a', '## How to', 'b', '## Definition of done', 'c'].join('\n')).ok, true);
});

test('нет /goal в первой строке, нет разделов, пустой раздел — перечислены по порядку шаблона', () => {
  assert.deepEqual(checkBrief('Почини сборку').missing, ['goal', 'context', 'steps', 'acceptance']);
  const late = ['Задание:', '/goal x', '## Контекст', 'a', '## Шаги', 'b', '## Критерии', 'c'].join('\n');
  assert.deepEqual(checkBrief(late).missing, ['goal'], '/goal не в первой строке');
  assert.deepEqual(checkBrief('/goal\n## Контекст\na\n## Шаги\nb\n## Критерии\nc').missing, ['goal'], '/goal без текста');
  const empty = ['/goal x', '## Контекст', 'a', '## Как делать', '## Критерии приёмки', '- [ ] тест'].join('\n');
  assert.deepEqual(checkBrief(empty), { ok: false, missing: ['steps'], empty: ['steps'] });
  const text = briefRefusalText(checkBrief(empty));
  assert.match(text, /«Как делать» — шаги работы \(заголовок есть, раздел пустой\)/u);
  assert.ok(text.includes(BRIEF_TEMPLATE));
});

test('похожие слова — не заголовки: «Планы на неделю», «Контекст-менеджер», фраза без двоеточия', () => {
  assert.equal(headingOf('## Планы на неделю'), null);
  assert.equal(headingOf('Контекст-менеджер упал'), null);
  assert.equal(headingOf('Шаги мы обсудим потом'), null);
  assert.deepEqual(headingOf('Контекст'), { part: 'context', rest: '' });
  assert.deepEqual(headingOf('**Как делать** — по шагам'), { part: 'steps', rest: 'по шагам' });
  assert.deepEqual(headingOf('1. Критерии приёмки: тесты'), { part: 'acceptance', rest: 'тесты' });
  // Заголовок другого смысла закрывает раздел: строки после него — не содержание «Шагов».
  assert.deepEqual(checkBrief(['/goal x', '## Контекст', 'a', '## Шаги', '## Заметки', 'b', '## Критерии', 'c'].join('\n')).missing, ['steps']);
});

test('текст задания из событий треда: последний запрос; автоповтор «Please continue.» — исходный', () => {
  const ev = (seq: number, requestId: string, text: string, retryOf?: string) => ({ seq, type: 'client/turn/requested', data: { requestId, input: [{ type: 'text', text }], ...(retryOf ? { retryOfRequestId: retryOf } : {}) } });
  assert.equal(briefTextFromEvents([]), null);
  assert.equal(briefTextFromEvents([ev(1, 'a', 'первое'), { seq: 2, type: 'item/completed', data: {} }, ev(3, 'b', 'второе')]), 'второе');
  assert.equal(briefTextFromEvents([ev(1, 'a', RU), ev(2, 'b', 'Please continue.', 'a')]), RU);
  assert.equal(briefTextFromEvents([ev(1, 'a', RU), ev(2, 'b', 'continue')]), RU);
});

test('профиль подтреда: только ступени Codex, без подтверждения; правило родителя — только у помеченного профиля', () => {
  const c = config();
  const p = subthreadCodexProfile(c);
  assert.deepEqual(p.excludedProviders, ['claude-code']);
  assert.deepEqual(p.confirm, { [MAC_CODEX]: false, [UA_CODEX]: false });
  const plan = buildPlan({ config: c, requestedModel: 'subthread-codex', accounts: ACCOUNTS, thread: { isSubthread: true, homeHostId: 'host_tru' } });
  assert.ok(Array.isArray(plan));
  assert.deepEqual(plan.filter(a => a.skip === null).map(a => a.stepId), [MAC_CODEX, UA_CODEX], 'S11 не держит, Claude исключён');
  assert.equal(profileName(c, 'subthread-codex'), 'Подтред · Codex');
  assert.equal(parentSendsChildrenToCodex(c, 'auto-codex-children'), true);
  for (const id of ['auto', 'auto-no-codex', 'opus-then-auto', `pin:${TRU_MAX}`, 'subthread-codex', null, 'нет-такого']) assert.equal(parentSendsChildrenToCodex(c, id), false, String(id));
});

test('причина отката на Claude: исчерпан, неизвестен, выключен, ask-owner; ход и занятость — без отката', () => {
  const t = (at: number) => new Date(at).toISOString().slice(11, 16);
  assert.equal(codexFallbackReason({ kind: 'run', stepId: 's', hostId: 'h', providerId: 'codex', modelId: null, fromStepId: null, switched: false, returning: false, pendingReturn: null }), null);
  assert.equal(codexFallbackReason({ kind: 'wait', until: NOW, stepId: 's', waitingSince: NOW, reason: 'busy', running: 1 }), null);
  assert.equal(codexFallbackReason({ kind: 'wait', until: NOW, stepId: 's', waitingSince: NOW, reason: 'exhausted' }, t), 'лимит Codex исчерпан до 12:00');
  assert.equal(codexFallbackReason({ kind: 'wait', until: NOW, stepId: null, waitingSince: NOW, reason: 'unknown' }), 'квота Codex неизвестна');
  assert.equal(codexFallbackReason({ kind: 'ask-owner', reason: 'no-reset-known', earliestReset: null }), 'лимиты Codex исчерпаны, сброс неизвестен');
  assert.equal(codexFallbackReason({ kind: 'unavailable', reason: 'no-steps' }), 'ступени Codex выключены или их нет в каскаде');
});

test('профиль в списке моделей и в схеме «i»: подпись правила, вторая цепочка — подтред на Codex', () => {
  const c = config();
  const model = providerModels(c, ACCOUNTS).find(m => m.id === 'auto-codex-children');
  assert.ok(model, 'профиль виден в списке моделей');
  assert.match(model.description, /^Старт: .*Потомки — только Codex на любой машине/u);
  const p = c.profiles.find(x => x.id === 'auto-codex-children')!;
  assert.equal(describeProfile(c, p, ACCOUNTS), model.description);
  const preview = profilePreview(c, p.id, ACCOUNTS, previewLookup({ ...c, testQuota: { ...c.testQuota, enabled: true } }, {}), NOW);
  assert.ok(preview.subthreads, 'вторая цепочка схемы');
  assert.match(preview.subthreads.text, /^потомок: сейчас ход пошёл бы на: GPT-6\.2 Sol · MacBook|^потомок: сейчас ход пошёл бы на: .*Mac/u);
  assert.equal(profilePreview(c, 'auto', ACCOUNTS, () => ok, NOW).subthreads, null, 'у других профилей второй цепочки нет');
});
