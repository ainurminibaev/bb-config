// 0.4.1: набор и названия профилей; строка «где я выполняюсь» для хода на чужой машине.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import type { StepHealth } from './limits.ts';
import { ACCOUNTS, MAC, MAC_CODEX, MAC_GW, NOW, TRU, TRU_MAX, UA_CODEX, config, exhausted, ok, thread } from './fixtures.ts';
import { normalizeConfig } from './config.ts';
import { providerModels } from './profiles.ts';
import { selectStep } from './engine.ts';
import { appendToUserLine, createRouteService, machinesEnv, whereLine, type RouteDeps, type StoredThreadState } from './bridge/route-service.ts';
import { startCodexRelay } from './launcher/codex-relay.ts';

test('существующие настройки: прежние имена → новые, «Opus → Авто» скрыт и помечен, новые встроенные — в конец один раз', () => {
  const old = normalizeConfig({ machines: [], steps: [], offeredProfiles: ['auto-codex-children'], models: [
    { key: 'opus-5.5', displayName: 'Opus 5.5', providerId: 'claude-code' }, { key: 'fable-5.2', displayName: 'Fable 5.2', providerId: 'claude-code' }], profiles: [
    { id: 'my-first', name: 'Мой первый' }, { id: 'auto', name: 'Лучшая модель · любая машина' }, { id: 'opus-then-auto', name: 'Opus, потом лучшая', policy: 'prefer-then-any', modelKey: 'opus-5.5' },
    { id: 'fable-then-auto', name: 'Мой Fable', policy: 'prefer-then-any', modelKey: 'fable-5.2' }] });
  assert.deepEqual(old.profiles.map(p => [p.id, p.name]), [
    ['my-first', 'Мой первый'], ['auto', 'Авто Opus · с Codex'], ['opus-then-auto', 'Opus, потом лучшая (прежний)'], ['fable-then-auto', 'Мой Fable'],
    ['fable-no-codex', 'Авто Fable · без Codex'], ['fable-codex-children', 'Авто Fable · подтреды только Codex'], ['only-codex', 'Только Codex'],
  ]);
  const auto = old.profiles.find(p => p.id === 'auto')!;
  assert.deepEqual([auto.policy, auto.modelKey], ['prefer-then-any', 'opus-5.5']);
  assert.equal(old.profiles.find(p => p.id === 'opus-then-auto')!.hidden, true);
  // Повторная нормализация ничего не добавляет и не возвращает удалённое.
  const again = normalizeConfig({ ...old, profiles: old.profiles.filter(p => p.id !== 'only-codex') });
  assert.ok(!again.profiles.some(p => p.id === 'only-codex'));
});

test('скрытый «прежний» профиль не в списке моделей, но тред на нём ходит', () => {
  const c = normalizeConfig({ ...config(), profiles: [...config().profiles, { id: 'opus-then-auto', name: 'Opus → Авто', policy: 'prefer-then-any', modelKey: 'opus-5.5' }] });
  assert.ok(!providerModels(c, ACCOUNTS).some(m => m.id === 'opus-then-auto'));
  const d = selectStep({ config: c, requestedModel: 'opus-then-auto', accounts: ACCOUNTS, thread: thread(), health: () => ok, now: NOW });
  assert.ok(d.kind === 'run' && d.stepId === TRU_MAX);
});

test('«Только Codex»: ступени Codex любой машины, без подтверждения, неизвестная квота — пробовать', () => {
  const unknown = { available: true, exhausted: false, unknown: true, resetsAt: null, reason: 'квота неизвестна' };
  const d = selectStep({ config: config(), requestedModel: 'only-codex', accounts: ACCOUNTS, thread: thread(), health: () => unknown, now: NOW });
  assert.ok(d.kind === 'run' && d.stepId === MAC_CODEX, JSON.stringify(d));
  const e = selectStep({ config: config(), requestedModel: 'only-codex', accounts: ACCOUNTS, thread: thread(), health: id => (id === MAC_CODEX ? exhausted(NOW + 60_000) : ok), now: NOW });
  assert.ok(e.kind === 'run' && e.stepId === UA_CODEX);
});

function world() {
  const store = new Map<string, StoredThreadState>();
  store.set('thr_1', { engine: thread(), profileId: 'auto', lastRun: null, pendingFlushHostId: null });
  const outcome = { ok: true as const, cwd: '/opt/bbfs/app', env: {}, timings: [], notices: [] };
  let health: Record<string, () => StepHealth> = {};
  const d: RouteDeps = {
    loadConfig: async () => config(), accounts: () => ACCOUNTS, health: () => id => (health[id]?.() ?? ok), refreshLimits: async () => {}, observeLimit: () => {},
    threadInfo: async () => ({ projectId: 'proj_1', hostId: TRU, parentThreadId: null, providerId: 'subscriptions-cascade', isolatedWorkspace: false }),
    load: async id => store.get(id), save: async (id, s) => { store.set(id, s); }, sync: { prepareTurn: async () => outcome, finishTurn: async () => outcome }, now: () => NOW,
  };
  return { routes: createRouteService(d), set: (h: typeof health) => { health = h; } };
}

test('«где я выполняюсь»: только при ступени не на машине треда; текст стабилен; env с машинами', async () => {
  const w = world();
  let n = 0;
  const turn = () => w.routes.routeTurn({ threadId: 'thr_1', projectId: 'proj_1', provider: 'claude-code', requestedModel: 'auto', cwd: '/srv/p', turnKey: `k${n++}` });
  const home = await turn();
  assert.ok(home.action === 'run' && home.stepId === TRU_MAX && !home.whereNote, 'на машине треда строки нет');
  assert.ok(home.action === 'run' && home.env.BB_CASCADE_HOME_HOST === TRU && home.env.BB_CASCADE_EXEC_HOST === TRU && /Tru=host_tru/u.test(home.env.BB_CASCADE_MACHINES!));
  w.set({ [TRU_MAX]: () => exhausted(NOW + 86_400_000) });
  const away = await turn();
  const again = await turn();
  assert.ok(away.action === 'run' && away.stepId === MAC_GW && again.action === 'run');
  assert.equal(away.whereNote, whereLine('Mac', 'Tru'));
  assert.equal(again.whereNote, away.whereNote, 'текст стабилен от хода к ходу');
  assert.equal(away.env.BB_CASCADE_EXEC_HOST, MAC);
  assert.equal(away.env.BB_CASCADE_HOME_LABEL, 'Tru');
  const text = away.whereNote!;
  assert.ok(text.split('\n').length <= 3);
  assert.match(text, /не машине треда \(Tru\)/u);
  assert.match(text, /«эта машина» значит Tru, другую владелец называет сам/u);
  assert.match(text, /nginx и https для сайта ставь на машине, где сайт работает/u);
  assert.doesNotMatch(text, /запускай на Tru/u, 'Tru не навязывается как цель');
  assert.deepEqual(machinesEnv(config(), TRU, MAC, h => h).BB_CASCADE_MACHINES.split(';').length, config().machines.length);
});

test('строка дописывается в конец сообщения хода: Claude stream-json и Codex turn/start', () => {
  const note = whereLine('UA', 'Tru');
  const arr = JSON.parse(appendToUserLine(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'почисти диск' }] } }), note));
  assert.deepEqual(arr.message.content.map((c: { text: string }) => c.text), ['почисти диск', note], 'начало сообщения не меняется');
  const str = JSON.parse(appendToUserLine(JSON.stringify({ type: 'user', message: { role: 'user', content: 'почисти диск' } }), note));
  assert.equal(str.message.content, `почисти диск\n\n${note}`);
  assert.equal(appendToUserLine('{"type":"control_request"}', note), '{"type":"control_request"}');
  const sent: string[] = [];
  const stdin = new PassThrough();
  const relay = startCodexRelay({ stdin, toChild: l => sent.push(l), endChild: () => {}, toBridge: () => {}, bridgeCwd: '/a', stageCwd: null,
    prepare: async () => ({ ok: true, message: '' }), finish: async () => {}, log: () => {}, whereNote: note });
  stdin.end(`${JSON.stringify({ id: 1, method: 'turn/start', params: { input: [{ type: 'text', text: 'почисти диск' }] } })}\n`);
  return relay.pump.then(() => {
    const msg = JSON.parse(sent[0]!);
    assert.deepEqual(msg.params.input.map((i: { text: string }) => i.text), ['почисти диск', note]);
  });
});
