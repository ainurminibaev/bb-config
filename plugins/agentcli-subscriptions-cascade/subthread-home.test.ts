// 0.3.1 п.13: подтред, у которого машина родителя ушла из каскада.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CascadeConfig } from './contract.ts';
import { explainNoSteps, selectStep } from './engine.ts';
import { ACCOUNTS, MAC, MAC_CODEX, MAC_GW, NOW, TRU, TRU_MAX, config, ok, thread } from './fixtures.ts';
import { createRouteService, type RouteDeps, type StoredThreadState } from './bridge/route-service.ts';

/** Каскад без Mac: машину убрали из настроек вместе со ступенями. */
function withoutMac(): CascadeConfig {
  const c = config();
  return { ...c, machines: c.machines.filter(m => m.hostId !== MAC), steps: c.steps.filter(s => s.hostId !== MAC) };
}

test('движок: машина родителя убрана или выключена — S11 не держит подтред, ход по профилю; машина в каскаде — S11 как прежде', () => {
  const sub = thread({ isSubthread: true, homeHostId: MAC });
  const removed = selectStep({ config: withoutMac(), requestedModel: 'auto', accounts: ACCOUNTS, thread: sub, health: () => ok, now: NOW });
  assert.ok(removed.kind === 'run' && removed.stepId === TRU_MAX, JSON.stringify(removed));
  const c = config();
  const off = { ...c, machines: c.machines.map(m => (m.hostId === MAC ? { ...m, enabled: false } : m)) };
  const disabled = selectStep({ config: off, requestedModel: 'auto', accounts: ACCOUNTS, thread: sub, health: () => ok, now: NOW });
  assert.ok(disabled.kind === 'run' && disabled.stepId === TRU_MAX);
  const still = selectStep({ config: c, requestedModel: 'auto', accounts: ACCOUNTS, thread: sub, health: () => ok, now: NOW });
  assert.ok(still.kind === 'run' && still.stepId === MAC_GW, 'Mac в каскаде — подтред на машине родителя');
});

test('отказ «нет ступеней» называет причину по каждой ступени: S11, выключена, исключена, нет модели', () => {
  const c = config();
  const sub = thread({ isSubthread: true, homeHostId: MAC });
  // Профиль «без Codex», на Mac Claude выключен: S11 держит на Mac, а там ничего нет.
  const cfg: CascadeConfig = { ...c, steps: c.steps.map(s => (s.id === MAC_GW ? { ...s, enabled: false } : s)) };
  const none = selectStep({ config: cfg, requestedModel: 'auto-no-codex', accounts: ACCOUNTS, thread: sub, health: () => ok, now: NOW });
  assert.deepEqual(none, { kind: 'unavailable', reason: 'no-steps' });
  const text = explainNoSteps({ config: cfg, requestedModel: 'auto-no-codex', accounts: ACCOUNTS, thread: sub });
  assert.match(text, /Tru · Claude \(Max 20\) — S11: подтред только на машине родителя Mac/u);
  assert.match(text, /Mac · Claude \(vclaude\) — ступень выключена/u);
  assert.match(text, /Mac · Codex — исключена профилем/u);
  const fable = explainNoSteps({ config: { ...c, steps: c.steps.filter(s => s.hostId === 'host_ua') }, requestedModel: 'only-fable-5.2', accounts: ACCOUNTS, thread: thread() });
  assert.match(fable, /UA · Claude \(Pro\) — нет модели Fable 5\.2 на этой машине/u);
  assert.ok(MAC_CODEX);
});

test('маршрут: подтред треда с убранной машины — ход по профилю и строка «машина родителя … не в каскаде — иду по профилю»', async () => {
  const store = new Map<string, StoredThreadState>();
  const deps: RouteDeps = {
    loadConfig: async () => withoutMac(), accounts: () => ACCOUNTS, health: () => () => ok, refreshLimits: async () => {}, observeLimit: () => {},
    threadInfo: async id => (id === 'thr_parent'
      ? { projectId: 'proj_1', hostId: MAC, parentThreadId: null, providerId: 'claude-code' }
      : { projectId: 'proj_1', hostId: TRU, parentThreadId: 'thr_parent', providerId: 'subscriptions-cascade' }),
    load: async id => store.get(id), save: async (id, s) => { store.set(id, s); }, sync: null, now: () => NOW,
    hostName: id => (id === MAC ? 'MacBook' : null),
  };
  const r = await createRouteService(deps).routeTurn({ threadId: 'thr_sub', projectId: 'proj_1', provider: 'claude-code', requestedModel: 'auto', cwd: '/srv/p' });
  assert.ok(r.action === 'run' && r.stepId === TRU_MAX, JSON.stringify(r));
  assert.ok(r.notes.some(n => n.kind === 'notice' && /Машина родителя MacBook не в каскаде — иду по профилю/u.test(n.message)), JSON.stringify(r.notes));
});
