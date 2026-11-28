// 0.3.5: тред или подтред на «Авто», ушедший на Codex (все Claude исчерпаны),
// возвращается на Claude, как только тот доступен: сброс лимита или новая ступень
// Claude. Каждый потомок отдельно. Правило дерева «только Codex» этому не мешает
// у деревьев без такого правила. Квота шлюза vclaude из кэша Thread Account Usage
// (до 2 мин) считается известной — иначе возврат не делался и тред застревал на Codex.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CascadeConfig } from './contract.ts';
import { ACCOUNTS, MAC, MAC_CODEX, MAC_GW, NOW, TRU, TRU_MAX, UA_PRO, config, exhausted, ok, thread } from './fixtures.ts';
import { createRouteService, type RouteDeps, type StoredThreadState } from './bridge/route-service.ts';
import type { HealthLookup } from './engine.ts';
import { healthFromReading, readingFromPackageUsage, type StepHealth } from './limits.ts';
import { stageOf } from './config.ts';

function cfg(patch: (c: CascadeConfig) => CascadeConfig = c => c): CascadeConfig {
  const c = config();
  return patch({
    ...c, steps: c.steps.map(s => ({ ...s, confirm: false, onUnknown: 'skip' as const })),
    policies: { ...c.policies, returnAfterMinutes: 5, subthreadsUseOtherMachines: true },
  });
}

function world(c: { current: CascadeConfig }, health: { current: Record<string, StepHealth | ((now: number) => StepHealth)> }) {
  const store = new Map<string, StoredThreadState>();
  store.set('thr_root', { engine: thread({ threadId: 'thr_root' }), profileId: 'auto', lastRun: null, pendingFlushHostId: null });
  let now = NOW;
  const outcome = { ok: true as const, cwd: '/srv/replica', env: {}, timings: [], notices: [] };
  const lookup: HealthLookup = id => { const h = health.current[id]; return typeof h === 'function' ? h(now) : h ?? ok; };
  const deps: RouteDeps = {
    loadConfig: async () => c.current, accounts: () => ACCOUNTS, health: () => lookup, refreshLimits: async () => {}, observeLimit: () => {},
    threadInfo: async id => ({ projectId: 'proj_1', hostId: TRU, parentThreadId: id === 'thr_root' ? null : 'thr_root', providerId: 'subscriptions-cascade', isolatedWorkspace: false }),
    load: async id => store.get(id), save: async (id, s) => { store.set(id, s); },
    sync: { prepareTurn: async () => outcome, finishTurn: async () => outcome }, now: () => now,
  };
  const routes = createRouteService(deps);
  let n = 0;
  return {
    store, advance(ms: number) { now += ms; },
    async turn(threadId: string) {
      const peek = await routes.peekProvider({ threadId, requestedModel: 'auto' });
      return routes.routeTurn({ threadId, projectId: 'proj_1', provider: peek.providerId ?? 'claude-code', requestedModel: 'auto', cwd: '/srv/p', turnKey: `k${n++}` });
    },
  };
}

const allClaudeOut = { [TRU_MAX]: exhausted(NOW + 30 * 60_000), [MAC_GW]: exhausted(NOW + 30 * 60_000), [UA_PRO]: exhausted(NOW + 30 * 60_000) };

test('подтред на «Авто»: Claude кончился → Codex; Claude сбросился → следующий ход (после N минут) снова Claude, переход «возврат»', async () => {
  const health = { current: { ...allClaudeOut } as Record<string, StepHealth> };
  const w = world({ current: cfg() }, health);
  const first = await w.turn('thr_child');
  assert.ok(first.action === 'run' && first.providerId === 'codex', JSON.stringify(first));
  health.current = {};
  w.advance(6 * 60_000);
  const back = await w.turn('thr_child');
  assert.ok(back.action === 'run' && back.providerId === 'claude-code' && back.stepId === TRU_MAX, JSON.stringify(back));
  assert.ok(back.action === 'run' && back.notes.some(n => n.kind === 'switch' && n.reason === 'return'), 'строка «возврат», прежняя сессия Claude продолжается (S5)');
  // Второй потомок — отдельно: у него своя история и свой возврат.
  const other = await w.turn('thr_child2');
  assert.ok(other.action === 'run' && other.providerId === 'claude-code');
});

test('новая ступень Claude в настройках — возврат с Codex на неё', async () => {
  const c = { current: cfg(x => ({ ...x, steps: x.steps.filter(s => s.id !== UA_PRO) })) };
  const health = { current: { [TRU_MAX]: exhausted(NOW + 3 * 3_600_000), [MAC_GW]: exhausted(NOW + 3 * 3_600_000) } as Record<string, StepHealth> };
  const w = world(c, health);
  const first = await w.turn('thr_child');
  assert.ok(first.action === 'run' && first.providerId === 'codex', JSON.stringify(first));
  c.current = cfg();
  w.advance(6 * 60_000);
  const back = await w.turn('thr_child');
  assert.ok(back.action === 'run' && back.stepId === UA_PRO, JSON.stringify(back));
});

test('шлюз vclaude: остаток из кэша Thread Account Usage (2 мин) — квота известна, возврат на Claude делается', async () => {
  const c = cfg();
  const gwStage = stageOf(c.steps.find(s => s.id === MAC_GW)!);
  // Пакет прочитан кабинетом 2 минуты назад (кэш TAU), остаток 90 %.
  const vclaude = (now: number) => healthFromReading(
    readingFromPackageUsage({ usage: { fetchedAt: new Date(now - 120_000).toISOString(), limitUnits: 405_000_000, remainingUnits: 380_000_000, endsAt: null }, error: null }, gwStage, now),
    null, { connected: true, now, policies: c.policies });
  const health = { current: { ...allClaudeOut } as Record<string, StepHealth | ((now: number) => StepHealth)> };
  const w = world({ current: c }, health);
  assert.ok((await w.turn('thr_child')).action === 'run');
  health.current = { [TRU_MAX]: exhausted(NOW + 3 * 3_600_000), [UA_PRO]: exhausted(NOW + 3 * 3_600_000), [MAC_GW]: vclaude };
  w.advance(6 * 60_000);
  const back = await w.turn('thr_child');
  assert.ok(back.action === 'run' && back.stepId === MAC_GW && back.providerId === 'claude-code', JSON.stringify(back));
  assert.ok(MAC && MAC_CODEX);
});
