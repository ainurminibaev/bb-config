// 0.3.6: накладные расходы маршрута до подготовки. Живой случай: ход ждал 6–28 с,
// потому что перед ним синхронно шли обнаружение машин (раз в 2 мин, до ~20 с) и
// опрос квот (до preTurnBudgetMs). Теперь опрос — в фоне, ход идёт по последнему
// показанию; медленный источник держит ход не дольше бюджета.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNTS, MAC_GW, NOW, TRU, config, ok, thread } from './fixtures.ts';
import { createRouteService, type RouteDeps, type StoredThreadState } from './bridge/route-service.ts';
import type { CascadeConfig } from './contract.ts';

function deps(c: CascadeConfig, refreshLimits: RouteDeps['refreshLimits'], trace: string[] = []): RouteDeps {
  const store = new Map<string, StoredThreadState>();
  store.set('thr_1', { engine: thread(), profileId: `pin:${MAC_GW}`, lastRun: { stepId: MAC_GW, hostId: TRU, providerId: 'claude-code', modelId: null, at: NOW - 60_000 }, pendingFlushHostId: null });
  const outcome = { ok: true as const, cwd: '/opt/bbfs/app', env: {}, timings: [], notices: [] };
  return {
    loadConfig: async () => c, accounts: () => ACCOUNTS, health: () => () => ok, refreshLimits, observeLimit: () => {},
    threadInfo: async () => ({ projectId: 'proj_1', hostId: TRU, parentThreadId: null, providerId: 'subscriptions-cascade', isolatedWorkspace: false }),
    load: async id => store.get(id), save: async (id, s) => { store.set(id, s); },
    sync: { prepareTurn: async () => outcome, finishTurn: async () => outcome }, now: () => NOW, trace: line => trace.push(line),
  };
}

const turn = (routes: ReturnType<typeof createRouteService>) => routes.routeTurn({ threadId: 'thr_1', projectId: 'proj_1', provider: 'claude-code', requestedModel: `pin:${MAC_GW}`, cwd: '/srv/p', turnKey: 'k' });

test('источник лимитов не отвечает — ход стартует не позже preTurnBudgetMs, по последнему показанию', async () => {
  const c = config();
  c.policies = { ...c.policies, preTurnBudgetMs: 500 };
  const trace: string[] = [];
  const routes = createRouteService(deps(c, () => new Promise<void>(() => undefined), trace));
  const t0 = performance.now();
  const r = await turn(routes);
  const ms = performance.now() - t0;
  assert.equal(r.action, 'run', JSON.stringify(r));
  assert.ok(ms < 1_000, `маршрут ${Math.round(ms)} мс при бюджете 500`);
});

test('обычный ход: опрос в фоне — маршрут до подготовки занимает миллисекунды, замер шагов пишется только для долгих', async () => {
  const trace: string[] = [];
  const routes = createRouteService(deps(config(), async () => {}, trace));
  const t0 = performance.now();
  assert.equal((await turn(routes)).action, 'run');
  assert.ok(performance.now() - t0 < 200);
  assert.deepEqual(trace, [], 'быстрый ход без строки журнала');
  const slow = createRouteService(deps(config(), () => new Promise<void>(resolve => setTimeout(resolve, 1_100)), trace));
  await turn(slow);
  assert.equal(trace.length, 1);
  assert.match(trace[0]!, /^ход thr_1 до подготовки \(host_mac:claude-code:\*\): состояние \d+\.\d+ с, профиль и задание \d+\.\d+ с, лимиты 1\.\d+ с, машина, согласия, писатель \d+\.\d+ с, решение \d+\.\d+ с$/u);
});
