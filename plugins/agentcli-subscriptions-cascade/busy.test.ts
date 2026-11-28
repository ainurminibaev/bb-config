// 0.3.0 п.11: лимит одновременных ходов на ступени (maxConcurrent, onBusy: wait|next).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CascadeConfig } from './contract.ts';
import { selectStep } from './engine.ts';
import { ACCOUNTS, MAC_GW, NOW, TRU, TRU_MAX, config, ok, thread } from './fixtures.ts';
import { ActiveTurns, createRouteService, type RouteDeps, type StoredThreadState } from './bridge/route-service.ts';

function limited(onBusy: 'wait' | 'next'): CascadeConfig {
  const c = config();
  return { ...c, steps: c.steps.map(s => s.id === TRU_MAX ? { ...s, maxConcurrent: 2, onBusy } : s) };
}

test('движок: ступень с maxConcurrent занята — wait ждёт её, next идёт дальше по профилю; ход своего треда не считается', () => {
  const base = { requestedModel: 'auto', accounts: ACCOUNTS, thread: thread(), health: () => ok, now: NOW };
  const waitD = selectStep({ ...base, config: limited('wait'), running: id => (id === TRU_MAX ? 2 : 0) });
  assert.deepEqual(waitD.kind === 'wait' ? [waitD.reason, waitD.stepId, waitD.running] : waitD, ['busy', TRU_MAX, 2]);
  const nextD = selectStep({ ...base, config: limited('next'), running: id => (id === TRU_MAX ? 2 : 0) });
  assert.ok(nextD.kind === 'run' && nextD.stepId === MAC_GW, 'следующая ступень профиля');
  const roomD = selectStep({ ...base, config: limited('wait'), running: () => 1 });
  assert.ok(roomD.kind === 'run' && roomD.stepId === TRU_MAX, 'место есть');
  const noLimit = selectStep({ ...base, config: config(), running: () => 99 });
  assert.ok(noLimit.kind === 'run' && noLimit.stepId === TRU_MAX, 'по умолчанию без лимита');
});

test('счётчик ходов: у треда один ход, свой не считается, брошенный истекает', () => {
  const a = new ActiveTurns();
  a.start('s', 'thr_a', 0);
  a.start('s', 'thr_b', 0);
  assert.equal(a.count('s', 'thr_c', 1), 2);
  assert.equal(a.count('s', 'thr_a', 1), 1);
  a.start('other', 'thr_a', 1);
  assert.equal(a.count('s', 'thr_c', 1), 1, 'новый ход треда снимает прежний');
  a.finish('s', 'thr_b');
  assert.equal(a.count('s', 'thr_c', 1), 0);
  a.start('s', 'thr_d', 0);
  assert.equal(a.count('s', 'thr_c', ActiveTurns.STALE_MS + 1), 0, 'ход без finishTurn истекает');
});

test('маршрут: на ступени уже 2 хода (один — подтред) — третий ждёт со строкой «Жду…», после конца хода идёт туда же', async () => {
  const store = new Map<string, StoredThreadState>();
  let clock = NOW;
  const parents: Record<string, string | null> = { thr_a: null, thr_sub: 'thr_a', thr_c: null };
  let release: (() => Promise<unknown>) | null = null;
  const deps: RouteDeps = {
    loadConfig: async () => limited('wait'), accounts: () => ACCOUNTS, health: () => () => ok, refreshLimits: async () => {}, observeLimit: () => {},
    threadInfo: async id => ({ projectId: 'proj_1', hostId: TRU, parentThreadId: parents[id] ?? null, providerId: 'subscriptions-cascade' }),
    load: async id => store.get(id), save: async (id, s) => { store.set(id, s); }, sync: null, now: () => clock,
    sleep: async ms => { clock += ms; if (clock - NOW > 60_000 && release) { const r = release; release = null; await r(); } },
  };
  const routes = createRouteService(deps);
  const turn = (threadId: string) => ({ threadId, projectId: 'proj_1', provider: 'claude-code' as const, requestedModel: 'auto', cwd: '/srv/p' });
  const a = await routes.routeTurn(turn('thr_a'));
  const sub = await routes.routeTurn(turn('thr_sub'));
  assert.ok(a.action === 'run' && a.stepId === TRU_MAX && sub.action === 'run' && sub.stepId === TRU_MAX, 'подтред тоже на Tru и считается');
  release = () => routes.finishTurn({ threadId: 'thr_a', stepId: TRU_MAX, hostId: TRU, exitCode: 0, limits: [] });
  const c = await routes.routeTurn(turn('thr_c'));
  assert.ok(c.action === 'run' && c.stepId === TRU_MAX, 'дождался места на той же ступени');
  if (c.action !== 'run') return;
  assert.ok(c.notes.some(n => n.kind === 'wait' && /Ждал свободного места на Tru/u.test(n.note ?? '')), JSON.stringify(c.notes));
  assert.ok(clock - NOW > 60_000);
  // Никто не освобождает — отказ с повтором после предела ожидания.
  const stuck = createRouteService({ ...deps, stepBusyWaitMs: 20_000, sleep: async ms => { clock += ms; } });
  await stuck.routeTurn(turn('thr_a'));
  await stuck.routeTurn(turn('thr_sub'));
  const refused = await stuck.routeTurn(turn('thr_c'));
  assert.ok(refused.action === 'refuse' && refused.retryable && /Жду: на Tru уже 2/u.test(refused.message), JSON.stringify(refused));
});

test('0.3.0 п.9: папку пишет тред на Mac — второй тред идёт на Mac (есть в профиле), иначе ждёт со строкой «Жду: папку держит тред …»', async () => {
  const { MAC, UA, UA_PRO } = await import('./fixtures.ts');
  const c = config();
  c.profiles.push({ id: 'ua-first', name: 'UA сначала', enabled: true, policy: 'any', modelKey: null, stepOrder: [UA_PRO, MAC_GW, TRU_MAX], excludedSteps: [TRU_MAX], excludedProviders: ['codex'], confirm: {} });
  c.profiles.push({ id: 'ua-only', name: 'Только UA', enabled: true, policy: 'any', modelKey: null, stepOrder: null, excludedSteps: c.steps.filter(s => s.id !== UA_PRO).map(s => s.id), excludedProviders: [], confirm: {} });
  const store = new Map<string, StoredThreadState>();
  let clock = NOW;
  let busyLeft = 0;
  const progress: string[] = [];
  let routes!: ReturnType<typeof createRouteService>;
  const ok2 = (hostId: string) => ({ ok: true as const, cwd: `/opt/bbfs/p-${hostId}`, env: {}, timings: [], notices: [] });
  const deps: RouteDeps = {
    loadConfig: async () => c, accounts: () => ACCOUNTS, health: () => () => ok, refreshLimits: async () => {}, observeLimit: () => {},
    threadInfo: async () => ({ projectId: 'proj_1', hostId: TRU, parentThreadId: null, providerId: 'subscriptions-cascade' }),
    load: async id => store.get(id), save: async (id, s) => { store.set(id, s); }, now: () => clock,
    threadTitle: async id => (id === 'thr_a' ? 'Отчёт за неделю' : null),
    sleep: async ms => { progress.push(JSON.stringify(routes.turnProgress('thr_b'))); clock += ms; },
    sync: {
      prepareTurn: async (_t, s) => (s.hostId === UA && busyLeft-- > 0
        ? { ok: false, reason: 'busy', message: 'Рабочую папку сейчас пишет другой тред (thr_a) на Mac', conflicts: [], timings: [], notices: [] }
        : ok2(s.hostId)),
      finishTurn: async (_t, s) => ok2(s.hostId),
      writerOf: async () => ({ hostId: MAC, threadIds: ['thr_a'] }),
      modeOf: () => 'lazy',
    },
  };
  routes = createRouteService(deps);
  const turn = (model: string) => ({ threadId: 'thr_b', projectId: 'proj_1', provider: 'claude-code' as const, requestedModel: model, cwd: '/srv/p' });
  const sameMachine = await routes.routeTurn(turn('ua-first'));
  assert.ok(sameMachine.action === 'run' && sameMachine.hostId === MAC, 'вместо UA — Mac, где уже пишет тред A');
  await routes.finishTurn({ threadId: 'thr_b', stepId: MAC_GW, hostId: MAC, exitCode: 0, limits: [] });
  busyLeft = 2;
  const waited = await routes.routeTurn(turn('ua-only'));
  assert.ok(waited.action === 'run' && waited.hostId === UA, JSON.stringify(waited));
  assert.ok(progress.some(p => /Жду: папку держит тред «Отчёт за неделю» на Mac/u.test(p)), progress.join('\n'));
});
