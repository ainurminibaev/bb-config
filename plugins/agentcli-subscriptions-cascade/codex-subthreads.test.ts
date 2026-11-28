// 0.3.4: профиль «Авто · подтреды на Codex» — маршрут подтредов, проверка задания,
// откат на Claude и доказательство, что профиль не влияет ни на что, кроме
// подтредов треда с этим профилем. Файл опирается только на API 0.3.3
// (route-service, engine, config), чтобы его можно было прогнать на старом коде.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CascadeConfig, Profile } from './contract.ts';
import { normalizeConfig } from './config.ts';
import { selectStep, type HealthLookup } from './engine.ts';
import { ACCOUNTS, MAC, MAC_CODEX, MAC_GW, NOW, TRU, TRU_MAX, UA_CODEX, UA_PRO, config, exhausted, ok, thread, unknown } from './fixtures.ts';
import { createRouteService, type RouteDeps, type StoredThreadState } from './bridge/route-service.ts';
import type { StepHealth } from './limits.ts';

const PROFILE = 'auto-codex-children';
const CHILD_PROFILE = 'subthread-codex';
const PARENT = 'thr_parent';
const CHILD = 'thr_child';

const GOOD_BRIEF = [
  '/goal Починить сборку; готово, когда npm test зелёный',
  '',
  '## Контекст',
  '- ветка bb/fix, файл engine.ts',
  '',
  '## Как делать',
  '1. Запустить тесты',
  '2. Исправить',
  '',
  '## Критерии приёмки',
  '- [ ] npm test → 0 падений',
].join('\n');

/** Каскад из фикстур + профиль «подтреды на Codex» (на старом коде — вручную). */
function cfg(patch: (c: CascadeConfig) => CascadeConfig = c => c): CascadeConfig {
  const c = config();
  if (!c.profiles.some(p => p.id === PROFILE)) {
    c.profiles.push({ id: PROFILE, name: 'Авто · подтреды на Codex', enabled: true, policy: 'any', modelKey: null, stepOrder: null, excludedSteps: [], excludedProviders: [], confirm: {}, subthreads: 'codex' } as Profile);
  }
  return patch(c);
}

function parentState(profileId: string): StoredThreadState {
  return {
    engine: { ...thread({ threadId: PARENT }) }, profileId,
    lastRun: { stepId: TRU_MAX, hostId: TRU, providerId: 'claude-code', modelId: null, at: NOW - 60_000 }, pendingFlushHostId: null,
  };
}

interface Harness {
  routes: ReturnType<typeof createRouteService>;
  store: Map<string, StoredThreadState>;
  eventsRead: string[];
}

/**
 * Родитель на Tru (опора), подтред — на машине родителя. Синхронизация — заглушка
 * (готова на любой машине). parentProfile null — родитель не на каскаде.
 */
function harness(options: { parentProfile: string | null; config?: CascadeConfig; brief?: string; health?: Record<string, StepHealth>; parentOf?: Record<string, string | null> }): Harness {
  const store = new Map<string, StoredThreadState>();
  if (options.parentProfile !== null) store.set(PARENT, parentState(options.parentProfile));
  const eventsRead: string[] = [];
  const parentOf = options.parentOf ?? { [CHILD]: PARENT, [PARENT]: null };
  const outcome = { ok: true as const, cwd: '/srv/replica', env: {}, timings: [], notices: [] };
  const health: HealthLookup = stepId => options.health?.[stepId] ?? ok;
  const deps: RouteDeps = {
    loadConfig: async () => options.config ?? cfg(), accounts: () => ACCOUNTS, health: () => health,
    refreshLimits: async () => {}, observeLimit: () => {},
    threadInfo: async id => ({ projectId: 'proj_1', hostId: TRU, parentThreadId: parentOf[id] ?? null, providerId: 'subscriptions-cascade', isolatedWorkspace: false }),
    load: async id => store.get(id), save: async (id, s) => { store.set(id, s); },
    sync: { prepareTurn: async () => outcome, finishTurn: async () => outcome },
    now: () => NOW,
    threadEvents: async id => {
      eventsRead.push(id);
      return [{ seq: 1, type: 'client/turn/requested', data: { requestId: 'r1', input: [{ type: 'text', text: options.brief ?? GOOD_BRIEF }] } }];
    },
    threadTitle: async id => (id === CHILD ? 'Починка сборки' : null),
  };
  return { routes: createRouteService(deps), store, eventsRead };
}

/** Ход треда так, как его ведёт мост каскада: провайдер — по peekProvider. */
async function turn(h: Harness, threadId: string, requestedModel: string) {
  const peek = await h.routes.peekProvider({ threadId, requestedModel });
  return h.routes.routeTurn({ threadId, projectId: 'proj_1', provider: peek.providerId ?? 'claude-code', requestedModel, cwd: '/srv/p', turnKey: `${threadId}-1` });
}

// ---- Подтред треда на «подтреды на Codex» ----

test('подтред родителя на «подтреды на Codex»: ход на Codex (любая машина, без подтверждения), свой профиль subthread-codex', async () => {
  const h = harness({ parentProfile: PROFILE });
  // Подтред просит профиль родителя (как из $BB_CASCADE_PROFILE) — решает код каскада.
  const r = await turn(h, CHILD, PROFILE);
  assert.equal(r.action, 'run', JSON.stringify(r));
  if (r.action !== 'run') return;
  // Codex-ступени в фикстурах «с подтверждением», а машина родителя — Tru (S11): правило снимает оба.
  assert.equal(r.stepId, MAC_CODEX);
  assert.equal(r.providerId, 'codex');
  assert.equal(r.env.BB_CASCADE_PROFILE, CHILD_PROFILE, 'подтред получает собственный профиль, а не профиль родителя');
  assert.equal(h.store.get(CHILD)?.profileId, CHILD_PROFILE);
  assert.deepEqual(h.eventsRead, [CHILD], 'задание прочитано один раз');
});

test('задание без четырёх частей: первый ход не запускается, отказ перечисляет недостающее и даёт шаблон', async () => {
  const h = harness({ parentProfile: PROFILE, brief: 'Почини сборку, пожалуйста.\n\n## Контекст\nветка bb/fix' });
  const r = await turn(h, CHILD, PROFILE);
  assert.equal(r.action, 'refuse', JSON.stringify(r));
  if (r.action !== 'refuse') return;
  assert.equal(r.retryable, false);
  assert.match(r.message, /\/goal/u);
  assert.match(r.message, /Как делать/u);
  assert.match(r.message, /Критерии приёмки/u);
  assert.doesNotMatch(r.message.split('\n\n')[0]!, /«Контекст»/u, 'Контекст есть — в перечне недостающего его нет');
  assert.match(r.message, /## Критерии приёмки\n- \[ \]/u, 'шаблон в тексте отказа');
  assert.equal(h.store.get(CHILD)?.lastRun ?? null, null, 'ход не начат');
});

test('исправленное задание тем же подтредом (bb thread tell) — ход идёт; после первого хода задание не перечитывается', async () => {
  const first = harness({ parentProfile: PROFILE, brief: 'сделай как-нибудь' });
  assert.equal((await turn(first, CHILD, PROFILE)).action, 'refuse');
  // Новое сообщение подтреду с полным заданием: тот же тред и хранилище, другой последний запрос.
  const second = harness({ parentProfile: PROFILE, brief: GOOD_BRIEF });
  for (const [k, v] of first.store) second.store.set(k, v);
  assert.equal((await turn(second, CHILD, PROFILE)).action, 'run');
  assert.equal((await turn(second, CHILD, PROFILE)).action, 'run');
  assert.deepEqual(second.eventsRead, [CHILD], 'второй ход задание не проверяет');
});

test('Codex исчерпан — подтред на Claude («Авто»), строка в ленте подтреда и в следующем ходе родителя', async () => {
  const h = harness({ parentProfile: PROFILE, health: { [MAC_CODEX]: exhausted(NOW + 3_600_000), [UA_CODEX]: exhausted(NOW + 7_200_000) } });
  const r = await turn(h, CHILD, PROFILE);
  assert.equal(r.action, 'run', JSON.stringify(r));
  if (r.action !== 'run') return;
  assert.equal(r.providerId, 'claude-code');
  assert.equal(r.stepId, TRU_MAX, '«Авто» с правилом S11: машина родителя');
  assert.equal(r.env.BB_CASCADE_PROFILE, 'auto');
  const line = r.notes.find(n => n.kind === 'notice' && /^Codex недоступен: .+ — подтред на Claude$/u.test(n.message));
  assert.ok(line, JSON.stringify(r.notes));
  assert.match((line as { message: string }).message, /лимит Codex исчерпан до 13:00 UTC/u);
  // Второй ход подтреда — строки уже нет (только при переходе).
  const again = await turn(h, CHILD, PROFILE);
  assert.ok(again.action === 'run' && !again.notes.some(n => n.kind === 'notice' && /Codex недоступен/u.test(n.message)));
  // Родитель: строка приходит в его следующем ходе, один раз.
  const parent = await turn(h, PARENT, PROFILE);
  assert.ok(parent.action === 'run' && parent.notes.some(n => n.kind === 'notice' && /^Подтред «Починка сборки»: Codex недоступен: .+ — подтред на Claude$/u.test(n.message)), JSON.stringify(parent));
  const parent2 = await turn(h, PARENT, PROFILE);
  assert.ok(parent2.action === 'run' && !parent2.notes.some(n => n.kind === 'notice' && /Подтред/u.test(n.message)));
});

test('ступени Codex выключены — причина «выключены»; квота Codex неизвестна — тоже на Claude', async () => {
  const off = cfg(c => ({ ...c, steps: c.steps.map(s => (s.providerId === 'codex' ? { ...s, enabled: false } : s)) }));
  const r = await turn(harness({ parentProfile: PROFILE, config: off }), CHILD, PROFILE);
  assert.ok(r.action === 'run' && r.providerId === 'claude-code', JSON.stringify(r));
  assert.ok(r.action === 'run' && r.notes.some(n => n.kind === 'notice' && /Codex недоступен: ступени Codex выключены/u.test(n.message)));
  const unk = cfg(c => ({ ...c, steps: c.steps.map(s => (s.providerId === 'codex' ? { ...s, onUnknown: 'skip' as const } : s)) }));
  const u = await turn(harness({ parentProfile: PROFILE, config: unk, health: { [MAC_CODEX]: unknown, [UA_CODEX]: unknown } }), CHILD, PROFILE);
  assert.ok(u.action === 'run' && u.providerId === 'claude-code', JSON.stringify(u));
});

test('общие ресурсы: Codex-подтред подчиняется maxConcurrent ступени — ждёт места, а не уходит на Claude', () => {
  const c = cfg(c => ({ ...c, steps: c.steps.map(s => (s.providerId === 'codex' ? { ...s, maxConcurrent: 1, onBusy: 'wait' as const } : s)) }));
  const d = selectStep({ config: c, requestedModel: CHILD_PROFILE, accounts: ACCOUNTS, thread: thread({ isSubthread: true }), health: () => ok, now: NOW, running: () => 1 });
  assert.equal(d.kind, 'wait');
  assert.ok(d.kind === 'wait' && d.reason === 'busy' && d.stepId === MAC_CODEX, JSON.stringify(d));
});

// ---- Профиль не влияет ни на что, кроме подтредов треда с этим профилем ----

const PARENT_PROFILES: { name: string; profile: string | null }[] = [
  { name: 'auto', profile: 'auto' },
  { name: 'opus-then-auto', profile: 'opus-then-auto' },
  { name: 'pin:…', profile: `pin:${MAC_GW}` },
  { name: 'без каскада', profile: null },
];

for (const { name, profile } of PARENT_PROFILES) {
  test(`родитель на ${name}: подтред идёт как в 0.3.3, задание не проверяется`, async () => {
    for (const childModel of ['auto', 'only-opus-5.5', PROFILE]) {
      const h = harness({ parentProfile: profile, brief: 'без goal и разделов' });
      const r = await turn(h, CHILD, childModel);
      // Эталон 0.3.3: тот же подтред, у родителя нет состояния каскада.
      const base = await turn(harness({ parentProfile: null, brief: 'без goal и разделов' }), CHILD, childModel);
      assert.deepEqual(r, base, `${name} → подтред ${childModel}`);
      assert.equal(r.action, 'run');
      assert.ok(r.action === 'run' && r.env.BB_CASCADE_PROFILE === childModel, 'профиль подтреда — свой');
      assert.ok(r.action === 'run' && r.stepId === TRU_MAX, 'S11: машина родителя');
      assert.deepEqual(h.eventsRead, [], 'задание не читается');
    }
  });
}

test('сам тред на «подтреды на Codex» ходит как «Авто»: движок во всех сочетаниях лимитов и маршрут без проверки задания', async () => {
  const c = cfg();
  const states: StepHealth[] = [ok, unknown, exhausted(NOW + 3_600_000), exhausted(null)];
  const steps = [TRU_MAX, MAC_GW, UA_PRO, MAC_CODEX, UA_CODEX];
  for (const subthread of [false, true]) {
    for (let mask = 0; mask < 4 ** 5; mask++) {
      const health: Record<string, StepHealth> = {};
      steps.forEach((id, i) => { health[id] = states[Math.floor(mask / 4 ** i) % 4]!; });
      const input = { config: c, accounts: ACCOUNTS, now: NOW, thread: thread({ isSubthread: subthread, homeHostId: MAC }), health: ((id: string) => health[id] ?? ok) as HealthLookup };
      assert.deepEqual(selectStep({ ...input, requestedModel: PROFILE }), selectStep({ ...input, requestedModel: 'auto' }), `mask ${mask}`);
    }
  }
  const h = harness({ parentProfile: null, brief: 'без goal', parentOf: {} });
  const own = await turn(h, PARENT, PROFILE);
  const auto = await turn(harness({ parentProfile: null, brief: 'без goal', parentOf: {} }), PARENT, 'auto');
  assert.ok(own.action === 'run' && auto.action === 'run');
  // Отличается только имя профиля в окружении и строке состояния ленты.
  const strip = (r: typeof own) => JSON.parse(JSON.stringify({ ...r, env: {} }).replaceAll(`"${PROFILE}"`, '"auto"'));
  assert.deepEqual(strip(own), strip(auto));
  assert.deepEqual(h.eventsRead, []);
});

test('правило не идёт вглубь: подтред Codex-подтреда ходит по своему профилю, без проверки задания', async () => {
  const GRAND = 'thr_grand';
  const parentOf = { [GRAND]: CHILD, [CHILD]: PARENT, [PARENT]: null };
  const h = harness({ parentProfile: PROFILE, parentOf, brief: 'без goal' });
  h.store.set(CHILD, { ...parentState(CHILD_PROFILE), engine: thread({ threadId: CHILD, isSubthread: true }) });
  const r = await turn(h, GRAND, 'auto');
  assert.ok(r.action === 'run' && r.stepId === TRU_MAX && r.env.BB_CASCADE_PROFILE === 'auto', JSON.stringify(r));
  assert.deepEqual(h.eventsRead, []);
});

// ---- Настройки ----

test('встроенный профиль добавляется в существующие настройки один раз; удалённый не возвращается; пустой список — пустой', () => {
  const old = { machines: [], steps: [], models: [], profiles: [{ id: 'auto', name: 'Авто' }] };
  const first = normalizeConfig(old);
  assert.deepEqual(first.profiles.map(p => p.id), ['auto', PROFILE]);
  const removed = normalizeConfig({ ...first, profiles: first.profiles.filter(p => p.id !== PROFILE) });
  assert.deepEqual(removed.profiles.map(p => p.id), ['auto']);
  assert.deepEqual(normalizeConfig({ machines: [], steps: [], models: [], profiles: [] }).profiles, []);
  assert.equal(normalizeConfig(normalizeConfig(old)).profiles.filter(p => p.id === PROFILE).length, 1);
});

test('подтред Codex идёт на UA, если Mac Codex исчерпан (любая машина, порядок из настроек)', async () => {
  const h = harness({ parentProfile: PROFILE, health: { [MAC_CODEX]: exhausted(NOW + 3_600_000) } });
  const r = await turn(h, CHILD, 'auto');
  assert.ok(r.action === 'run' && r.stepId === UA_CODEX && r.providerId === 'codex', JSON.stringify(r));
  assert.ok(MAC);
});
