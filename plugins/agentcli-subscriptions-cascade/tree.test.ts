// 0.3.5: профиль — правило на всё дерево тредов (self + descendants).
// Опирается только на API 0.3.4 (route-service, config), кроме полей профиля.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CascadeConfig, Profile } from './contract.ts';
import { normalizeConfig } from './config.ts';
import { ACCOUNTS, MAC_CODEX, MAC_GW, NOW, TRU, TRU_MAX, UA_CODEX, config, exhausted, ok, thread } from './fixtures.ts';
import { createRouteService, type RouteDeps, type StoredThreadState } from './bridge/route-service.ts';
import type { HealthLookup } from './engine.ts';
import type { StepHealth } from './limits.ts';

const PROFILE = 'auto-codex-children';
const BRIEF = ['/goal x; готово, когда тесты зелёные', '## Контекст', 'ветка', '## Как делать', '1. шаг', '## Критерии приёмки', '- тесты'].join('\n');

type Mode = 'wait' | 'fallback';
function cfg(mode: Mode | null = null, patch: (c: CascadeConfig) => CascadeConfig = c => c): CascadeConfig {
  const c = config();
  const profiles = c.profiles.map(p => (p.id === PROFILE ? { ...p, descendants: 'subthread-codex', ...(mode ? { onDescendantsExhausted: mode } : {}) } as Profile : p));
  return patch({ ...c, profiles });
}

/** Дерево: thr_root (профиль корня) → остальные по parentOf. */
function tree(c: CascadeConfig, rootProfile: string, parentOf: Record<string, string>, healthRef: { current: Record<string, StepHealth> } = { current: {} }) {
  const store = new Map<string, StoredThreadState>();
  store.set('thr_root', {
    engine: thread({ threadId: 'thr_root' }), profileId: rootProfile,
    lastRun: { stepId: TRU_MAX, hostId: TRU, providerId: 'claude-code', modelId: null, at: NOW - 60_000 }, pendingFlushHostId: null,
  });
  const outcome = { ok: true as const, cwd: '/srv/replica', env: {}, timings: [], notices: [] };
  const lookup: HealthLookup = stepId => healthRef.current[stepId] ?? ok;
  let now = NOW;
  const deps: RouteDeps = {
    loadConfig: async () => c, accounts: () => ACCOUNTS, health: () => lookup, refreshLimits: async () => {}, observeLimit: () => {},
    threadInfo: async id => ({ projectId: 'proj_1', hostId: TRU, parentThreadId: parentOf[id] ?? null, providerId: 'subscriptions-cascade', isolatedWorkspace: false }),
    load: async id => store.get(id), save: async (id, s) => { store.set(id, s); },
    sync: { prepareTurn: async () => outcome, finishTurn: async () => outcome }, now: () => now,
    threadEvents: async () => [{ seq: 1, type: 'client/turn/requested', data: { requestId: 'r1', input: [{ type: 'text', text: BRIEF }] } }],
  };
  const routes = createRouteService(deps);
  let n = 0;
  return {
    store, health: healthRef, advance(ms: number) { now += ms; },
    async turn(threadId: string, requestedModel: string | null) {
      const peek = await routes.peekProvider({ threadId, requestedModel });
      return routes.routeTurn({ threadId, projectId: 'proj_1', provider: peek.providerId ?? 'claude-code', requestedModel, cwd: '/srv/p', turnKey: `k${n++}` });
    },
    routes,
  };
}

test('потомок без явного профиля (нет --model, профиль по умолчанию, профиль родителя) получает правило корня', async () => {
  for (const requested of [null, 'auto', PROFILE]) {
    const t = tree(cfg(), PROFILE, { thr_child: 'thr_root' });
    const r = await t.turn('thr_child', requested);
    assert.ok(r.action === 'run' && r.providerId === 'codex', `${String(requested)} → ${JSON.stringify(r)}`);
  }
});

test('явный выбор действует только на этот подтред; его потомки наследуют правило предка', async () => {
  const t = tree(cfg(), PROFILE, { thr_pin: 'thr_root', thr_grand: 'thr_pin' });
  const pin = `pin:${MAC_GW}`;
  const own = await t.turn('thr_pin', pin);
  assert.ok(own.action === 'run' && own.stepId === MAC_GW && own.env.BB_CASCADE_PROFILE === pin, JSON.stringify(own));
  // Внук запущен с BB_CASCADE_PROFILE родителя (pin:…) — правило корня, а не закреплённая ступень.
  const grand = await t.turn('thr_grand', pin);
  assert.ok(grand.action === 'run' && grand.providerId === 'codex' && grand.env.BB_CASCADE_PROFILE === 'subthread-codex', JSON.stringify(grand));
  // Явный профиль у внука (другой, чем у родителя) — только на него.
  const t2 = tree(cfg(), PROFILE, { thr_pin: 'thr_root', thr_grand: 'thr_pin' });
  await t2.turn('thr_pin', pin);
  const explicit = await t2.turn('thr_grand', 'only-opus-5.5');
  assert.ok(explicit.action === 'run' && explicit.providerId === 'claude-code', JSON.stringify(explicit));
});

test('глубина: правило корня доходит до правнука', async () => {
  const t = tree(cfg(), PROFILE, { a: 'thr_root', b: 'a', c: 'b' });
  for (const id of ['a', 'b', 'c']) {
    const r = await t.turn(id, null);
    assert.ok(r.action === 'run' && r.providerId === 'codex', `${id}: ${JSON.stringify(r)}`);
  }
});

test('режим wait (по умолчанию): Codex исчерпан везде — потомок ждёт сброса, Claude не тратится', async () => {
  const t = tree(cfg(), PROFILE, { thr_child: 'thr_root' }, { current: { [MAC_CODEX]: exhausted(NOW + 3_600_000), [UA_CODEX]: exhausted(NOW + 3_600_000) } });
  const r = await t.turn('thr_child', PROFILE);
  assert.equal(r.action, 'refuse', JSON.stringify(r));
  assert.ok(r.action === 'refuse' && r.retryable && r.notes.some(n => n.kind === 'wait' && n.cause === 'reset'), JSON.stringify(r));
  assert.equal(t.store.get('thr_child')?.lastRun ?? null, null, 'на Claude не ушёл');
  assert.equal((await t.routes.retryAvailability('thr_child')).kind, 'blocked', 'provider-retry повторит после сброса Codex');
});

test('потомок на Codex, Claude освободился — остаётся на Codex', async () => {
  const t = tree(cfg(), PROFILE, { thr_child: 'thr_root' }, { current: { [TRU_MAX]: exhausted(NOW + 3_600_000) } });
  assert.ok((await t.turn('thr_child', PROFILE)).action === 'run');
  t.health.current = {};
  t.advance(60 * 60_000);
  const r = await t.turn('thr_child', PROFILE);
  assert.ok(r.action === 'run' && r.providerId === 'codex', JSON.stringify(r));
});

test('режим fallback: ушёл на Claude, Codex сбросился — на ближайшем ходе снова Codex', async () => {
  const t = tree(cfg('fallback'), PROFILE, { thr_child: 'thr_root' }, { current: { [MAC_CODEX]: exhausted(NOW + 600_000), [UA_CODEX]: exhausted(NOW + 600_000) } });
  const first = await t.turn('thr_child', PROFILE);
  assert.ok(first.action === 'run' && first.providerId === 'claude-code', JSON.stringify(first));
  t.health.current = {};
  t.advance(11 * 60_000);
  const back = await t.turn('thr_child', PROFILE);
  assert.ok(back.action === 'run' && back.providerId === 'codex' && back.stepId === MAC_CODEX, JSON.stringify(back));
});

test('descendants — любой профиль: потомки «Opus → Авто»-корня идут по «Только Opus 5.5»', async () => {
  const c = cfg(null, x => ({ ...x, profiles: x.profiles.map(p => (p.id === 'opus-then-auto' ? { ...p, descendants: 'only-opus-5.5' } : p)) }));
  const t = tree(c, 'opus-then-auto', { thr_child: 'thr_root' });
  const r = await t.turn('thr_child', 'opus-then-auto');
  assert.ok(r.action === 'run' && r.env.BB_CASCADE_PROFILE === 'only-opus-5.5', JSON.stringify(r));
});

test('настройки 0.3.4 (`subthreads: codex`) читаются как descendants: subthread-codex, режим wait', () => {
  const c = normalizeConfig({ machines: [], steps: [], models: [], profiles: [{ id: PROFILE, name: 'X', subthreads: 'codex' }] });
  const p = c.profiles.find(x => x.id === PROFILE)!;
  assert.equal(p.descendants, 'subthread-codex');
  assert.equal(p.onDescendantsExhausted, 'wait');
  assert.equal(p.subthreads, undefined);
});
