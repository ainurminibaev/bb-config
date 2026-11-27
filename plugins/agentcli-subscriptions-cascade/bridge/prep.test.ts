// Прогресс подготовки хода: строка ленты, повтор шага, переход на следующую ступень.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPrep, beginPrep, clock, prepMessage, prepNote, PrepTracker } from './prep-progress.ts';
import { createTimelineFeed } from './feed.ts';
import { createRouteService, type SyncOutcome } from './route-service.ts';
import { ACCOUNTS, MAC, MAC_GW, TRU, TRU_MAX, UA, UA_PRO, config as baseConfig, exhausted, ok } from '../fixtures.ts';
import type { CascadeConfig } from '../contract.ts';

const label = (id: string) => ({ host_tru: 'Tru', host_mac: 'Mac', host_ua: 'UA' }[id] ?? id);

test('строка подготовки: этап, счётчики, процент, таймер; повтор — подстрокой', () => {
  let state = beginPrep({ reason: 'limit', from: { machine: 'Tru' }, to: { machine: 'Mac', model: 'Opus' }, stepId: MAC_GW }, 0);
  state = applyPrep(state, { kind: 'step', step: 'flush', hostId: MAC, from: TRU, to: MAC, state: 'running', ms: 0 }, 1_000, label);
  state = applyPrep(state, { kind: 'transfer', step: 'flush', hostId: MAC, from: TRU, to: MAC, progress: { status: 'staging-beta', files: 10520, done: 2341, bytes: 1 } }, 47_000, label);
  const note = prepNote(state, 47_000);
  assert.equal(prepMessage(note), 'Подготовка Mac: передача · синхронизация Tru → Mac · 2 341 / 10 520 файлов · 22 % · 0:47');
  assert.equal(note.steps[0]!.state, 'running');
  assert.equal(note.steps[0]!.ms, 46_000);
  state = applyPrep(state, { kind: 'step', step: 'flush', hostId: MAC, from: TRU, to: MAC, state: 'failed', ms: 50_000, detail: 'ssh: Connection reset' }, 51_000, label);
  let now = 0;
  const tracker = new PrepTracker(() => now, label);
  tracker.begin('thr_1', { reason: 'limit', from: null, to: { machine: 'Mac' }, stepId: MAC_GW });
  now = 72_000;
  tracker.attempt('thr_1', 'повтор 2/3: ssh: Connection reset');
  assert.match(prepMessage(tracker.note('thr_1')!), /^Подготовка Mac: выбор ступени · повтор 2\/3: ssh: Connection reset · 1:12$/u);
  tracker.end('thr_1');
  assert.equal(tracker.note('thr_1'), null);
  assert.equal(state.steps.at(-1)!.label, 'синхронизация Tru → Mac: ssh: Connection reset');
  assert.equal(clock(72_000), '1:12');
});

function cfg(): CascadeConfig {
  const c = baseConfig();
  return { ...c, policies: { ...c.policies, executionMode: 'provider' } };
}

function routes(prepare: (hostId: string, progress?: (e: never) => void) => Promise<SyncOutcome>) {
  let clockMs = Date.parse('2026-11-27T12:00:00Z');
  const saved = new Map<string, unknown>();
  const service = createRouteService({
    loadConfig: async () => cfg(), accounts: () => ACCOUNTS, health: () => stepId => stepId === TRU_MAX ? exhausted(null) : ok,
    refreshLimits: async () => {}, observeLimit: () => {},
    threadInfo: async () => ({ projectId: 'proj_1', hostId: TRU, parentThreadId: null, providerId: 'subscriptions-cascade' }),
    load: async id => saved.get(id) as never, save: async (id, s) => { saved.set(id, s); },
    sync: { prepareTurn: (_t, s, progress) => prepare(s.hostId, progress as never), finishTurn: async () => ({ ok: true, cwd: '/x', env: {}, timings: [], notices: [] }) },
    now: () => clockMs, sleep: async ms => { clockMs += ms; }, prepRetryPauseMs: 5_000,
  });
  return service;
}

const turn = { threadId: 'thr_1', projectId: 'proj_1', provider: 'claude-code' as const, requestedModel: 'auto', cwd: '/srv/projects/proj' };
const okAt = (hostId: string): SyncOutcome => ({ ok: true, cwd: `/opt/bbfs/proj`, env: {}, timings: [{ step: 'flush', hostId, from: TRU, to: hostId, seconds: 1, ok: true }], notices: [] });
const fail = (reason: string, message: string): SyncOutcome => ({ ok: false, reason, message, conflicts: [], timings: [], notices: [] });

test('сбой подготовки: повтор шага до 3 раз, потом следующая ступень (Mac → UA) со строкой; конфликт — отказ без перехода', async () => {
  const calls: string[] = [];
  let progressSeen: unknown = null;
  const svc = routes(async (hostId) => {
    calls.push(hostId);
    if (calls.length === 2) progressSeen = svc.turnProgress('thr_1');
    return hostId === MAC ? fail('error', 'ssh: connect to host tru: Connection reset') : okAt(hostId);
  });
  const out = await svc.routeTurn(turn);
  assert.deepEqual(calls, [MAC, MAC, MAC, UA], 'три попытки на Mac, затем UA');
  assert.equal(out.action === 'run' && out.stepId, UA_PRO);
  assert.ok(out.action === 'run' && out.notes.some(n => n.kind === 'problem' && /Mac: подготовка не удалась .* ступень пропущена/u.test(n.message)));
  assert.match(JSON.stringify(progressSeen), /повтор 2\/3: ssh/u, 'повтор виден в строке подготовки');
  assert.equal(svc.turnProgress('thr_1'), null, 'после решения прогресса нет');

  const conflict = routes(async hostId => (hostId === MAC ? fail('conflict', 'конфликт в src/a.ts') : okAt(hostId)));
  const refused = await conflict.routeTurn(turn);
  assert.equal(refused.action, 'refuse');
  assert.match(refused.action === 'refuse' ? refused.message : '', /^Ход не запущен: Каскад подписок → синхронизация Mac: конфликт в src\/a\.ts/u);
  assert.ok(refused.action === 'refuse' && refused.notes.some(n => n.kind === 'problem' && /Что сделать: повторите ход/u.test(n.note ?? '')));
});

test('лента: prep обновляет одну строку перехода на месте, итоговые switch/sync её не дублируют', () => {
  const feed = createTimelineFeed({ now: () => 1_000 });
  const prep = (done: number, elapsedMs: number) => ({ kind: 'prep' as const, reason: 'limit' as const, from: { machine: 'Tru' }, to: { machine: 'Mac', model: 'Opus' }, stepId: MAC_GW, phase: 'передача · синхронизация Tru → Mac', elapsedMs, steps: [{ label: 'синхронизация Tru → Mac', ms: elapsedMs, state: 'running' as const }], sync: { files: 10520, done } });
  const a = feed.render('thr_1', [prep(100, 5_000)], 'pt-1') as { kind: string; message?: string }[];
  const b = feed.render('thr_1', [prep(2341, 47_000)], 'pt-1') as { kind: string; message?: string }[];
  const c = feed.render('thr_1', [
    { kind: 'switch', reason: 'limit', from: { machine: 'Tru' }, to: { machine: 'Mac', model: 'Opus' }, stepId: MAC_GW },
    { kind: 'sync', from: 'Tru', to: 'Mac', ms: 50_000, ok: true },
    { kind: 'run', stage: { machine: 'Mac', model: 'Opus' }, stepId: MAC_GW },
  ], 'pt-1') as { kind: string; item?: { payload?: { state?: string; steps?: { state: string }[] } } }[];
  assert.equal(a.filter(d => d.kind === 'item.open').length, 1);
  assert.equal(b.filter(d => d.kind === 'item.open').length, 0, 'та же строка');
  assert.match(b.find(d => d.kind === 'item.progress')!.message!, /^⟳ Подготовка Mac: передача · синхронизация Tru → Mac · 2 341 \/ 10 520 файлов · 22 % · 0:47$/u);
  assert.equal(c.filter(d => d.kind === 'item.open').length, 0, 'итоговый switch не открыл вторую строку');
  const closed = c.find(d => d.kind === 'item.close')!;
  assert.equal(closed.item!.payload!.state, 'done');
  assert.ok(closed.item!.payload!.steps!.every(s => s.state !== 'running'), 'шаги закрыты');
});
