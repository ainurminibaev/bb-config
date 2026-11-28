// 0.3.7: дефекты живой приёмки 0.3.6.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNTS, MAC_CODEX, MAC_GW, NOW, TRU, TRU_MAX, UA_CODEX, UA_PRO, config, exhausted, ok, thread, unknown } from './fixtures.ts';
import { selectStep, type HealthLookup } from './engine.ts';
import { createRouteService, type RouteDeps, type StoredThreadState } from './bridge/route-service.ts';
import { healthFromReading, readingFromUsageLimits } from './limits.ts';
import { policiesSchema, type CascadeConfig } from './contract.ts';
import type { Stage } from './adapter.ts';
import type { StepHealth } from './limits.ts';

function deps(c: CascadeConfig, health: Record<string, StepHealth>, extra: Partial<RouteDeps> = {}) {
  const store = new Map<string, StoredThreadState>();
  const outcome = { ok: true as const, cwd: '/opt/bbfs/app', env: {}, timings: [], notices: [] };
  let now = NOW;
  const lookup: HealthLookup = id => health[id] ?? ok;
  const d: RouteDeps = {
    loadConfig: async () => c, accounts: () => ACCOUNTS, health: () => lookup, refreshLimits: async () => {}, observeLimit: () => {},
    threadInfo: async () => ({ projectId: 'proj_1', hostId: TRU, parentThreadId: null, providerId: 'subscriptions-cascade', isolatedWorkspace: false }),
    load: async id => store.get(id), save: async (id, s) => { store.set(id, s); },
    sync: { prepareTurn: async () => outcome, finishTurn: async () => outcome }, now: () => now, sleep: async ms => { now += ms; },
    ...extra,
  };
  return { d, store, routes: createRouteService(d), advance: (ms: number) => { now += ms; } };
}

const turn = (routes: ReturnType<typeof createRouteService>, requestedModel: string | null, provider: 'claude-code' | 'codex' = 'claude-code', key = 'k') =>
  routes.routeTurn({ threadId: 'thr_1', projectId: 'proj_1', provider, requestedModel, cwd: '/srv/p', turnKey: key });

test('живой отказ thr_xt6a8: исчерпан только Tru, остальное «данные устарели» — ход идёт, а не «все исчерпаны»', () => {
  const stale = { ...unknown, reason: 'квота неизвестна: данные устарели' };
  const d = selectStep({ config: config(), requestedModel: 'auto', accounts: ACCOUNTS, thread: thread(), now: NOW,
    health: id => (id === TRU_MAX ? exhausted(NOW + 3 * 86_400_000) : stale) });
  assert.ok(d.kind === 'run' && d.stepId === MAC_GW, JSON.stringify(d));
  const all = selectStep({ config: config(), requestedModel: 'auto', accounts: ACCOUNTS, thread: thread(), now: NOW, health: () => exhausted(NOW + 3 * 86_400_000) });
  assert.equal(all.kind, 'ask-owner', 'всё действительно исчерпано — вопрос владельцу');
});

test('прерванный ход: следующий ход остаётся на той же ступени при «неизвестно» (не «Сбой → другая машина»)', async () => {
  const c = config();
  const health: Record<string, StepHealth> = {};
  const w = deps(c, health);
  const first = await turn(w.routes, `auto`);
  assert.ok(first.action === 'run' && first.stepId === TRU_MAX);
  // Ход прерван владельцем (finishTurn с кодом ≠ 0), показание Tru стало «неизвестно».
  await w.routes.finishTurn({ threadId: 'thr_1', projectId: 'proj_1', stepId: TRU_MAX, hostId: TRU, exitCode: 130, limits: [] });
  health[TRU_MAX] = unknown;
  w.advance(10_000);
  const next = await turn(w.routes, 'auto', 'claude-code', 'k2');
  assert.ok(next.action === 'run' && next.stepId === TRU_MAX, JSON.stringify(next));
  assert.ok(!next.notes.some(n => n.kind === 'switch'), 'перехода нет');
  // Через час без хода ступень уже не «своя»: известная готовая — впереди.
  w.advance(61 * 60_000);
  const later = await turn(w.routes, 'auto', 'claude-code', 'k3');
  assert.ok(later.action === 'run' && later.stepId === MAC_GW, JSON.stringify(later));
  assert.ok(later.notes.some(n => n.kind === 'switch' && n.reason === 'unavailable'), 'переход — «недоступна», не «сбой»');
});

test('закреплённая ступень Codex с неизвестной квотой (403 на usageLimits) — ход идёт, а не ждёт', () => {
  const c = config();
  const d = selectStep({ config: c, requestedModel: `pin:${UA_CODEX}`, accounts: ACCOUNTS, thread: thread(), now: NOW, health: () => unknown });
  assert.ok(d.kind === 'run' && d.stepId === UA_CODEX, JSON.stringify(d));
});

test('свежий тред на pin:<Codex>: app-server открывается без --model — профиль берётся из выбора модели, ход на Codex', async () => {
  const c = config();
  const w = deps(c, { [TRU_MAX]: exhausted(NOW + 86_400_000) }, { profileHint: () => `pin:${MAC_CODEX}` });
  const r = await turn(w.routes, null, 'codex');
  assert.ok(r.action === 'run' && r.stepId === MAC_CODEX && r.providerId === 'codex', JSON.stringify(r));
  // Без подсказки (0.3.6) свежий тред шёл по «Авто» и отказывал «переход на Claude».
  const old = deps(c, { [TRU_MAX]: exhausted(NOW + 86_400_000) });
  const bad = await turn(old.routes, null, 'codex');
  assert.equal(bad.action, 'refuse');
});

test('настроек нет (переустановка): ход ждёт их появления, а не отказывает «профиль не найден»', async () => {
  const empty = config();
  empty.profiles = empty.profiles.filter(p => p.id === 'auto');
  const full = config();
  let current = empty;
  let seeded = true;
  let polls = 0;
  const w = deps(empty, {}, {
    loadConfig: async () => { polls += 1; if (polls > 3) { current = full; seeded = false; } return current; },
    configSeeded: async () => seeded,
  });
  const r = await turn(w.routes, 'opus-then-auto');
  assert.ok(r.action === 'run', JSON.stringify(r));
  assert.ok(polls > 3, 'ждал настроек');
  // Настройки так и не появились — ход по «Авто» со строкой, а не отказ.
  const never = deps(empty, {}, { configSeeded: async () => true, settingsWaitMs: 3_000 });
  const r2 = await turn(never.routes, 'opus-then-auto');
  assert.ok(r2.action === 'run' && r2.notes.some(n => n.kind === 'notice' && /Настроек каскада нет/u.test(n.message)), JSON.stringify(r2));
  // Настройки есть, профиля нет — отказ, как раньше.
  const real = deps(full, {}, { configSeeded: async () => false });
  assert.equal((await turn(real.routes, 'no-such-profile')).action, 'refuse');
});

test('Codex «usage request failed (HTTP 403)» — «источник квоты ответил ошибкой», а не «шлюз»', () => {
  const stage = { hostId: 'h', provider: 'codex', profileRef: 'default', authority: 'subscription', quotaSource: 'provider', bindingEpoch: 'e' } as Stage;
  const r = readingFromUsageLimits({ status: 'error', message: 'Codex usage request failed (HTTP 403).' }, stage, NOW, true);
  const h = healthFromReading(r, null, { connected: true, now: NOW, policies: policiesSchema.parse({}) });
  assert.equal(h.reason, 'квота неизвестна: источник квоты ответил ошибкой (Codex usage request failed (HTTP 403).)');
  assert.doesNotMatch(h.reason!, /шлюз/u);
  assert.ok(UA_PRO);
});
