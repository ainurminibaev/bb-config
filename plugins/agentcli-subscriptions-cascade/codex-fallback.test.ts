// 0.3.5: дефекты приёмки 0.3.4 на живом BB.
// 1. Квота Codex «неизвестна» (ступени с onUnknown: skip) откатывала Codex-подтред на Claude.
// 2. Откат на «Авто» включал S11: подтред Tru-родителя при исчерпанном Tru никуда не шёл
//    («Все ступени исчерпаны, а ближайший сброс позже порога ожидания»).
// Опирается только на API 0.3.4 — прогоняется на старом коде (там падает).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CascadeConfig } from './contract.ts';
import { ACCOUNTS, MAC_CODEX, MAC_GW, NOW, TRU, TRU_MAX, UA_CODEX, UA_PRO, config, exhausted, ok, thread, unknown } from './fixtures.ts';
import { createRouteService, type RouteDeps, type StoredThreadState } from './bridge/route-service.ts';
import type { HealthLookup } from './engine.ts';
import type { StepHealth } from './limits.ts';

const PROFILE = 'auto-codex-children';
const PARENT = 'thr_parent';
const CHILD = 'thr_child';
const BRIEF = ['/goal x; готово, когда тесты зелёные', '## Контекст', 'ветка', '## Как делать', '1. шаг', '## Критерии приёмки', '- тесты'].join('\n');
const WEEK = 7 * 24 * 3_600_000;

/** Как в живой установке: все ступени onUnknown: skip, подтреды держатся машины родителя. */
function liveConfig(patch: (c: CascadeConfig) => CascadeConfig = c => c): CascadeConfig {
  const c = config();
  const steps = c.steps.map(s => ({ ...s, onUnknown: 'skip' as const }));
  return patch({ ...c, steps, policies: { ...c.policies, subthreadsUseOtherMachines: false } });
}

/** Режим исчерпания правила потомков «на Авто» (в 0.3.4 был единственным). */
function fallbackMode(c: CascadeConfig): CascadeConfig {
  return { ...c, profiles: c.profiles.map(p => (p.id === PROFILE ? { ...p, onDescendantsExhausted: 'fallback' as const } : p)) };
}

function harness(cfg: CascadeConfig, health: Record<string, StepHealth>) {
  const store = new Map<string, StoredThreadState>();
  store.set(PARENT, {
    engine: thread({ threadId: PARENT }), profileId: PROFILE,
    lastRun: { stepId: MAC_GW, hostId: TRU, providerId: 'claude-code', modelId: null, at: NOW - 60_000 }, pendingFlushHostId: null,
  });
  const outcome = { ok: true as const, cwd: '/srv/replica', env: {}, timings: [], notices: [] };
  const lookup: HealthLookup = stepId => health[stepId] ?? ok;
  const deps: RouteDeps = {
    loadConfig: async () => cfg, accounts: () => ACCOUNTS, health: () => lookup, refreshLimits: async () => {}, observeLimit: () => {},
    threadInfo: async id => ({ projectId: 'proj_1', hostId: TRU, parentThreadId: id === CHILD ? PARENT : null, providerId: 'subscriptions-cascade', isolatedWorkspace: false }),
    load: async id => store.get(id), save: async (id, s) => { store.set(id, s); },
    sync: { prepareTurn: async () => outcome, finishTurn: async () => outcome }, now: () => NOW,
    threadEvents: async () => [{ seq: 1, type: 'client/turn/requested', data: { requestId: 'r1', input: [{ type: 'text', text: BRIEF }] } }],
  };
  return { routes: createRouteService(deps), store };
}

async function turn(h: ReturnType<typeof harness>, requestedModel = PROFILE) {
  const peek = await h.routes.peekProvider({ threadId: CHILD, requestedModel });
  return h.routes.routeTurn({ threadId: CHILD, projectId: 'proj_1', provider: peek.providerId ?? 'claude-code', requestedModel, cwd: '/srv/p', turnKey: 'k1' });
}

test('живой случай: Tru исчерпан на неделю, остальное «неизвестно» (onUnknown: skip) — подтред идёт на Codex, а не в отказ', async () => {
  const h = harness(liveConfig(), {
    [TRU_MAX]: exhausted(NOW + WEEK), [MAC_GW]: unknown, [UA_PRO]: unknown, [MAC_CODEX]: unknown, [UA_CODEX]: unknown,
  });
  const r = await turn(h);
  assert.equal(r.action, 'run', JSON.stringify(r));
  assert.ok(r.action === 'run' && r.providerId === 'codex' && r.stepId === MAC_CODEX, JSON.stringify(r));
  assert.ok(r.action === 'run' && !r.notes.some(n => n.kind === 'notice' && /Codex недоступен/u.test(n.message)), 'неизвестная квота — не откат');
  assert.equal(h.store.get(CHILD)?.profileId, 'subthread-codex');
});

test('квота Codex неизвестна у одной ступени и исчерпана у другой — пробуется ступень с неизвестной квотой', async () => {
  const h = harness(liveConfig(), { [MAC_CODEX]: exhausted(NOW + 3_600_000), [UA_CODEX]: unknown });
  const r = await turn(h);
  assert.ok(r.action === 'run' && r.stepId === UA_CODEX, JSON.stringify(r));
});

test('откат на «Авто» без S11: Codex исчерпан, Tru (машина родителя) исчерпан — подтред на Claude другой машины', async () => {
  const h = harness(liveConfig(fallbackMode), {
    [TRU_MAX]: exhausted(NOW + WEEK), [MAC_CODEX]: exhausted(NOW + 3_600_000), [UA_CODEX]: exhausted(NOW + 3_600_000),
  });
  const r = await turn(h);
  assert.equal(r.action, 'run', JSON.stringify(r));
  assert.ok(r.action === 'run' && r.providerId === 'claude-code' && r.stepId === MAC_GW, JSON.stringify(r));
  assert.ok(r.action === 'run' && r.notes.some(n => n.kind === 'notice' && /^Codex недоступен: лимит Codex исчерпан до .+ — подтред на Claude$/u.test(n.message)));
  assert.ok(r.action === 'run' && !r.notes.some(n => n.kind === 'notice' && /Машина родителя/u.test(n.message)));
  // Повтор после сбоя (provider-retry) видит то же: ход возможен.
  assert.equal((await h.routes.retryAvailability(CHILD)).kind, 'ready');
});

test('откат по исчерпанию Codex остаётся: обе ступени исчерпаны — на Claude; выключены — на Claude', async () => {
  const off = liveConfig(c => fallbackMode({ ...c, steps: c.steps.map(s => (s.providerId === 'codex' ? { ...s, enabled: false } : s)) }));
  const r = await turn(harness(off, {}));
  assert.ok(r.action === 'run' && r.providerId === 'claude-code' && r.notes.some(n => n.kind === 'notice' && /ступени Codex выключены/u.test(n.message)), JSON.stringify(r));
});

test('лимит из хода Codex (turnLimits, rejected) помечает ступень исчерпанной — следующий ход на другой Codex', async () => {
  const h = harness(liveConfig(), { [MAC_CODEX]: unknown, [UA_CODEX]: unknown });
  const first = await turn(h);
  assert.ok(first.action === 'run' && first.stepId === MAC_CODEX, JSON.stringify(first));
  const marked = await h.routes.turnLimits({ threadId: CHILD, stepId: MAC_CODEX, limits: [{ status: 'rejected', resetsAt: NOW + 3_600_000, windowType: 'codex-rate-limits' }] });
  assert.equal(marked.exhausted, true);
  const next = await h.routes.routeTurn({ threadId: CHILD, projectId: 'proj_1', provider: 'codex', requestedModel: PROFILE, cwd: '/srv/p', turnKey: 'k2' });
  assert.ok(next.action === 'run' && next.stepId === UA_CODEX, JSON.stringify(next));
});

test('подтреды обычных профилей: S11 и onUnknown ступени как в 0.3.4', async () => {
  const h = harness(liveConfig(), { [TRU_MAX]: exhausted(NOW + WEEK), [MAC_CODEX]: unknown });
  h.store.set(PARENT, { ...h.store.get(PARENT)!, profileId: 'auto' });
  const r = await turn(h, 'auto');
  assert.equal(r.action, 'refuse', 'родитель на «Авто»: S11 держит подтред на исчерпанном Tru, как раньше');
});
