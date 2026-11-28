import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindingEpoch } from './config.ts';
import { grant } from './consent.ts';
import { buildPlan, nextThreadState, selectStep, type Attempt, type HealthLookup, type SelectInput } from './engine.ts';
import {
  ACCOUNTS, MAC, MAC_CODEX, MAC_GW, NOW, TRU, TRU_MAX, UA, UA_CODEX, UA_PRO,
  config, exhausted, offline, ok, thread, unknown,
} from './fixtures.ts';
import type { StepHealth } from './limits.ts';

/** Лимиты по ступени; ключ `stepId|modelId` задаёт модельное окно. */
function input(health: Record<string, StepHealth>, patch: Partial<SelectInput> = {}): SelectInput {
  const lookup: HealthLookup = (id, model) => health[`${id}|${model}`] ?? health[id] ?? ok;
  return { config: config(), requestedModel: 'auto', accounts: ACCOUNTS, health: lookup, thread: thread(), now: NOW, ...patch };
}
const pick = (d: ReturnType<typeof selectStep>) => d.kind === 'run' || d.kind === 'confirm' ? [d.kind, d.stepId, d.modelId] : [d.kind];
const live = (plan: ReturnType<typeof buildPlan>) => (plan as Attempt[]).filter(a => a.skip === null).map(a => [a.stepId, a.modelId]);
const allClaudeOut = (reset: number | null = null) => ({ [TRU_MAX]: exhausted(reset), [MAC_GW]: exhausted(null), [UA_PRO]: exhausted(null) });

test('каскад по умолчанию: Tru → Mac (шлюз) → UA (Pro) → Codex на Mac и UA с подтверждением', () => {
  const c = config();
  assert.deepEqual(c.steps.map(s => [s.id, s.authority, s.quotaSource, s.label, s.confirm]), [
    [TRU_MAX, 'subscription', 'provider', 'Max 20', false], [MAC_GW, 'gateway', 'vclaude', 'vclaude', false],
    [UA_PRO, 'subscription', 'provider', 'Pro', false], [MAC_CODEX, 'subscription', 'provider', 'Codex', true], [UA_CODEX, 'subscription', 'provider', 'Codex', true],
  ]);
  assert.deepEqual(c.machines.map(m => [m.label, m.anchor]), [['Tru', true], ['Mac', false], ['UA', false]]);
});

test('профили из коробки: названия, политики и порядок', () => {
  assert.deepEqual(config().profiles.map(p => [p.id, p.name, p.policy, p.modelKey, p.excludedProviders]), [
    ['auto', 'Авто Opus · с Codex', 'prefer-then-any', 'opus-5.5', []],
    ['auto-no-codex', 'Авто Opus · без Codex', 'prefer-then-any', 'opus-5.5', ['codex']],
    ['auto-codex-children', 'Авто Opus · подтреды только Codex', 'prefer-then-any', 'opus-5.5', []],
    ['fable-then-auto', 'Авто Fable · с Codex', 'prefer-then-any', 'fable-5.2', []],
    ['fable-no-codex', 'Авто Fable · без Codex', 'prefer-then-any', 'fable-5.2', ['codex']],
    ['fable-codex-children', 'Авто Fable · подтреды только Codex', 'prefer-then-any', 'fable-5.2', []],
    ['only-opus-5.5', 'Только Opus 5.5', 'only', 'opus-5.5', []],
    ['only-fable-5.2', 'Только Fable 5.2', 'only', 'fable-5.2', []],
    ['only-codex', 'Только Codex', 'any', null, ['claude-code']],
  ]);
});

test('only: «Только Opus» — Claude Opus на Tru → vclaude Opus на Mac → Claude Opus на UA', () => {
  const plan = buildPlan({ config: config(), requestedModel: 'only-opus-5.5', accounts: ACCOUNTS, thread: thread() }) as Attempt[];
  assert.deepEqual(live(plan), [[TRU_MAX, 'claude-opus-5-5'], [MAC_GW, 'opus55'], [UA_PRO, 'claude-opus-5-5']]);
  assert.deepEqual(plan.filter(a => a.skip === 'no-model').map(a => a.stepId), [MAC_CODEX, UA_CODEX], 'у Codex нет Opus');
  const d = selectStep(input({ [TRU_MAX]: exhausted(NOW + 3_600_000), [MAC_GW]: exhausted(null) }, { requestedModel: 'only-opus-5.5' }));
  assert.deepEqual(pick(d), ['run', UA_PRO, 'claude-opus-5-5']);
});

test('any (0.4.0): модель важнее машины — Opus исчерпан на Tru → Opus на следующей ступени, а не Fable на Tru', () => {
  assert.deepEqual(pick(selectStep(input({}))), ['run', TRU_MAX, 'claude-opus-5-5']);
  const d = selectStep(input({ [`${TRU_MAX}|claude-opus-5-5`]: exhausted(NOW + 60_000) }));
  assert.ok(d.kind === 'run' && d.stepId !== TRU_MAX && /opus/u.test(d.modelId ?? ''), JSON.stringify(d));
  // Opus нигде нет — следующая модель по приоритету, ступени по порядку.
  const opusOut = (id: string, m: string | null) => (/opus/u.test(m ?? '') ? exhausted(NOW + 60_000) : ok);
  assert.deepEqual(pick(selectStep({ ...input({}), health: opusOut })), ['run', TRU_MAX, 'claude-fable-5-2']);
  const c = config();
  c.policies.modelPriority = ['fable-5.2', 'opus-5.5'];
  // 0.4.1: «Авто Opus» начинает с Opus при любом приоритете; приоритет решает фазу «потом лучшая».
  assert.deepEqual(pick(selectStep(input({}, { config: c }))), ['run', TRU_MAX, 'claude-opus-5-5']);
  assert.deepEqual(pick(selectStep({ ...input({}, { config: c }), health: opusOut })), ['run', TRU_MAX, 'claude-fable-5-2'], 'приоритет моделей задаётся в настройках');
});

test('prefer-then-any: сначала X на всех ступенях, потом любые', () => {
  const p = { requestedModel: 'fable-then-auto' };
  const plan = buildPlan({ config: config(), accounts: ACCOUNTS, thread: thread(), ...p }) as Attempt[];
  assert.deepEqual(plan.filter(a => a.phase === 'preferred' && !a.skip).map(a => a.stepId), [TRU_MAX, MAC_GW]);
  // Fable исчерпан на Tru, но есть на Mac — идём на Mac за Fable, а не на Opus на Tru.
  const mac = selectStep(input({ [`${TRU_MAX}|claude-fable-5-2`]: exhausted(NOW + 60_000) }, p));
  assert.deepEqual(pick(mac), ['run', MAC_GW, 'fable52']);
  // Fable нигде нет — дальше обычное «Авто» с начала каскада.
  const any = selectStep(input({ [`${TRU_MAX}|claude-fable-5-2`]: exhausted(null), [`${MAC_GW}|fable52`]: exhausted(null) }, p));
  assert.deepEqual(pick(any), ['run', TRU_MAX, 'claude-opus-5-5']);
  assert.equal(new Set(plan.filter(a => !a.skip).map(a => `${a.stepId}|${a.modelId}`)).size, plan.filter(a => !a.skip).length, 'без повторов');
});

test('исключённые ступени и свой порядок профиля', () => {
  const c = config();
  // «Авто · без Codex»: все Claude исчерпаны → не Codex, а ожидание сброса.
  const noCodex = selectStep(input(allClaudeOut(NOW + 3_600_000), { config: c, requestedModel: 'auto-no-codex' }));
  assert.equal(noCodex.kind, 'wait');
  const plan = buildPlan({ config: c, requestedModel: 'auto-no-codex', accounts: ACCOUNTS, thread: thread() }) as Attempt[];
  assert.deepEqual(plan.filter(a => a.skip === 'excluded').map(a => a.stepId), [MAC_CODEX, UA_CODEX]);
  const auto = c.profiles.find(p => p.id === 'auto')!;
  auto.stepOrder = [UA_PRO, TRU_MAX];
  auto.excludedSteps = [MAC_GW];
  const steps = [...new Set((buildPlan({ config: c, requestedModel: 'auto', accounts: ACCOUNTS, thread: thread() }) as Attempt[]).filter(a => !a.skip).map(a => a.stepId))];
  assert.deepEqual(steps, [UA_PRO, TRU_MAX, MAC_CODEX, UA_CODEX], 'свой порядок, неупомянутые — в конце, исключённая — вне плана');
});

test('подтверждения профиля переопределяют ступень', () => {
  const c = config();
  const auto = c.profiles.find(p => p.id === 'auto')!;
  auto.confirm = { [MAC_CODEX]: false, [UA_PRO]: true };
  assert.deepEqual(pick(selectStep(input({ [TRU_MAX]: exhausted(null), [MAC_GW]: exhausted(null) }, { config: c }))), ['confirm', UA_PRO, 'claude-opus-5-5']);
  assert.deepEqual(pick(selectStep(input(allClaudeOut(), { config: c }))), ['run', MAC_CODEX, null], 'Codex без карточки в этом профиле');
});

test('несопоставленные модели: ступень без ассоциации не участвует', () => {
  const c = config();
  c.models = c.models.map(r => r.key === 'fable-5.2' ? { ...r, cells: { [MAC]: { modelId: null, source: 'none' } } } : r);
  const plan = buildPlan({ config: c, requestedModel: 'only-fable-5.2', accounts: ACCOUNTS, thread: thread() }) as Attempt[];
  assert.deepEqual(live(plan), [[TRU_MAX, 'claude-fable-5-2']]);
  assert.deepEqual(plan.filter(a => a.skip === 'no-model').map(a => a.stepId), [MAC_GW, UA_PRO, MAC_CODEX, UA_CODEX], 'Mac сброшен вручную, на UA (Pro) Fable нет');
  const d = selectStep(input({ [TRU_MAX]: exhausted(NOW + 3_600_000) }, { config: c, requestedModel: 'only-fable-5.2' }));
  assert.equal(d.kind, 'wait');
  // Устаревший ID `m:<ключ>` читается как «только X».
  assert.deepEqual(pick(selectStep(input({}, { config: c, requestedModel: 'm:fable-5.2' }))), ['run', TRU_MAX, 'claude-fable-5-2']);
  assert.deepEqual(selectStep(input({}, { requestedModel: 'nope' })), { kind: 'unavailable', reason: 'unknown-profile' });
  assert.deepEqual(selectStep(input({}, { requestedModel: 'm:nope' })), { kind: 'unavailable', reason: 'unknown-model' });
});

test('S6: «Только Fable», Fable исчерпан везде — ждать сброса до 6 ч, потом владелец; в «Авто» не уходит', () => {
  const fableOut = (reset: number) => ({ [`${TRU_MAX}|claude-fable-5-2`]: exhausted(reset), [`${MAC_GW}|fable52`]: exhausted(null) });
  const wait = selectStep(input(fableOut(NOW + 2 * 3_600_000), { requestedModel: 'only-fable-5.2' }));
  assert.deepEqual(wait, { kind: 'wait', until: NOW + 2 * 3_600_000, stepId: TRU_MAX, waitingSince: NOW, reason: 'exhausted' });
  assert.equal(selectStep(input(fableOut(NOW + 7 * 3_600_000), { requestedModel: 'only-fable-5.2' })).kind, 'ask-owner');
});

test('S10: неизвестная квота — skip пропускает, try идёт', () => {
  const c = config();
  const skip = selectStep(input({ [TRU_MAX]: exhausted(NOW + 60_000), [MAC_GW]: unknown }, { config: c }));
  assert.deepEqual(pick(skip), ['run', UA_PRO, 'claude-opus-5-5'], 'шлюз с неизвестной квотой пропущен до UA');
  c.steps = c.steps.map(s => s.id === MAC_GW ? { ...s, onUnknown: 'try' } : s);
  assert.deepEqual(pick(selectStep(input({ [TRU_MAX]: exhausted(NOW + 60_000), [MAC_GW]: unknown }, { config: c }))), ['run', MAC_GW, 'opus55']);
});

test('S1: Tru исчерпан → vclaude на Mac; переход отмечен как switched', () => {
  const d = selectStep(input({ [TRU_MAX]: exhausted(NOW + 3_600_000) }, { thread: thread({ currentStepId: TRU_MAX }) }));
  assert.deepEqual(pick(d), ['run', MAC_GW, 'opus55']);
  assert.equal(d.kind === 'run' && d.switched, true);
});

test('S3: все Claude исчерпаны → Codex только с подтверждением; согласие на ход снимает карточку', () => {
  const health = allClaudeOut(NOW + 60_000);
  assert.deepEqual(pick(selectStep(input(health))), ['confirm', MAC_CODEX, null]);
  const step = config().steps.find(s => s.id === MAC_CODEX)!;
  const consent = grant('turn', { stepId: MAC_CODEX, bindingEpoch: bindingEpoch(step), threadId: 'thr_1', turnId: 'turn_1', projectId: 'proj_1', now: NOW }, null);
  assert.deepEqual(pick(selectStep(input(health, { thread: thread({ consents: [consent] }) }))), ['run', MAC_CODEX, null]);
  const nextTurn = selectStep(input(health, { thread: thread({ consents: [consent], turnId: 'turn_2', currentStepId: MAC_CODEX }) }));
  assert.equal(nextTurn.kind, 'confirm', 'разовое согласие кончилось');
  assert.equal(nextTurn.kind === 'confirm' && nextTurn.continuing, true, '«Продолжить ещё один ход?»');
});

test('согласие старого поколения связи не действует', () => {
  const consent = grant('thread', { stepId: MAC_CODEX, bindingEpoch: 'old-epoch', threadId: 'thr_1', turnId: 'turn_1', projectId: 'proj_1', now: NOW }, null);
  assert.equal(selectStep(input(allClaudeOut(NOW + 60_000), { thread: thread({ consents: [consent] }) })).kind, 'confirm');
});

test('«Пропустить ступень» исключает её из текущего выбора', () => {
  assert.deepEqual(pick(selectStep(input({}, { thread: thread({ skippedStepIds: [TRU_MAX] }) }))), ['run', MAC_GW, 'opus55']);
});

test('S4: возврат на приоритетную ступень не раньше чем через 30 минут', () => {
  const t = thread({ currentStepId: MAC_GW, switchedAt: NOW - 10 * 60_000 });
  const early = selectStep(input({}, { thread: t }));
  assert.equal(early.kind === 'run' && early.stepId, MAC_GW);
  assert.equal(early.kind === 'run' && early.pendingReturn?.stepId, TRU_MAX);
  const late = selectStep(input({}, { thread: { ...t, switchedAt: NOW - 31 * 60_000 } }));
  assert.equal(late.kind === 'run' && late.stepId, TRU_MAX);
  assert.equal(late.kind === 'run' && late.returning, true);
});

test('S11: подтред не уходит с машины родителя без разрешения', () => {
  const sub = thread({ isSubthread: true, homeHostId: TRU });
  assert.equal(selectStep(input({ [TRU_MAX]: exhausted(NOW + 3_600_000) }, { thread: sub })).kind, 'wait');
  const c = config();
  c.policies.subthreadsUseOtherMachines = true;
  assert.equal((d => d.kind === 'run' && d.stepId)(selectStep(input({ [TRU_MAX]: exhausted(NOW + 3_600_000) }, { thread: sub, config: c }))), MAC_GW);
});

test('всё исчерпано: ждать сброса до 6 часов, дальше спросить владельца', () => {
  const all = (reset: number) => ({ ...allClaudeOut(reset), [MAC_CODEX]: exhausted(null), [UA_CODEX]: exhausted(null) });
  assert.deepEqual(selectStep(input(all(NOW + 2 * 3_600_000))), { kind: 'wait', until: NOW + 2 * 3_600_000, stepId: TRU_MAX, waitingSince: NOW, reason: 'exhausted' });
  assert.equal(selectStep(input(all(NOW + 7 * 3_600_000))).kind, 'ask-owner');
  assert.equal(selectStep(input(all(NOW + 2 * 3_600_000), { thread: thread({ waitingSince: NOW - 5 * 3_600_000 }) })).kind, 'ask-owner', 'ожидание дольше 6 часов');
});

test('0.3.7: всё неизвестно — пробуется первая ступень по порядку (ожидание и вопрос — только при исчерпании)', () => {
  const d = selectStep(input({ [TRU_MAX]: unknown, [MAC_GW]: unknown, [UA_PRO]: unknown, [MAC_CODEX]: unknown, [UA_CODEX]: unknown }));
  assert.deepEqual(pick(d), ['run', TRU_MAX, 'claude-opus-5-5']);
  // Известная готовая ступень главнее неизвестной.
  assert.deepEqual(pick(selectStep(input({ [TRU_MAX]: unknown, [MAC_GW]: unknown }))), ['run', UA_PRO, 'claude-opus-5-5']);
});

test('S8: машина не на связи пропускается; выключенная машина и профиль не участвуют', () => {
  assert.deepEqual(pick(selectStep(input({ [TRU_MAX]: exhausted(null), [MAC_GW]: offline }))), ['run', UA_PRO, 'claude-opus-5-5']);
  const c = config();
  c.machines = c.machines.map(m => m.hostId === TRU ? { ...m, enabled: false } : m);
  assert.equal((d => d.kind === 'run' && d.stepId)(selectStep(input({}, { config: c }))), MAC_GW);
  c.profiles = c.profiles.map(p => p.id === 'auto' ? { ...p, enabled: false } : p);
  assert.deepEqual(selectStep(input({}, { config: c })), { kind: 'unavailable', reason: 'profile-disabled' });
  c.machines = c.machines.map(m => ({ ...m, enabled: m.hostId === UA }));
  assert.deepEqual(selectStep(input({}, { config: c, requestedModel: 'only-fable-5.2' })), { kind: 'unavailable', reason: 'no-steps' });
});

test('nextThreadState запоминает ступень, модель и момент перехода', () => {
  const t = thread({ currentStepId: TRU_MAX });
  const next = nextThreadState(t, selectStep(input({ [TRU_MAX]: exhausted(NOW + 60_000) }, { thread: t })), NOW);
  assert.deepEqual([next.currentStepId, next.currentModelId, next.switchedAt], [MAC_GW, 'opus55', NOW]);
});

test('S4: возврат на приоритетную ступень — только после N минут и по подтверждённой квоте', () => {
  const gate = (health: Record<string, StepHealth>, switchedAgo: number) => selectStep(input(health, {
    thread: { ...input(health).thread, currentStepId: MAC_GW, currentModelId: undefined, switchedAt: NOW - switchedAgo },
  }));
  const unknownTry = { ...ok, unknown: true };
  // Tru снова доступна, но прошло 10 минут — остаёмся на Mac, возврат отложен.
  const early = gate({ [TRU_MAX]: ok, [MAC_GW]: ok, [UA_PRO]: ok }, 10 * 60_000);
  assert.equal(early.kind === 'run' && early.stepId, MAC_GW);
  assert.equal(early.kind === 'run' && early.pendingReturn?.stepId, TRU_MAX);
  // 40 минут и квота Tru подтверждена — возврат.
  const back = gate({ [TRU_MAX]: ok, [MAC_GW]: ok, [UA_PRO]: ok }, 40 * 60_000);
  assert.equal(back.kind === 'run' && back.stepId, TRU_MAX);
  assert.equal(back.kind === 'run' && back.returning, true);
  // Квота Tru неизвестна (даже с onUnknown: try) — без возврата.
  const config = input({}).config;
  const tryConfig = { ...config, steps: config.steps.map(s => s.id === TRU_MAX ? { ...s, onUnknown: 'try' as const } : s) };
  const unknown = selectStep({ ...input({ [TRU_MAX]: unknownTry, [MAC_GW]: ok, [UA_PRO]: ok }), config: tryConfig,
    thread: { ...input({}).thread, currentStepId: MAC_GW, switchedAt: NOW - 40 * 60_000 } });
  assert.equal(unknown.kind === 'run' && unknown.stepId, MAC_GW);
});
