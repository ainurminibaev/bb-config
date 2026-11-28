// 0.3.9: в модели треда каскада — ID модели CLI («gpt-6.2-sol»: BB подставил модель по
// умолчанию, пока список моделей каскада был недоступен). Раньше — «Профиль каскада не
// найден» на каждом ходе и повторе. Теперь подбор: строка таблицы моделей → «только эта
// модель»; иначе сохранённый профиль треда; иначе «Авто». Строка в ленте.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNTS, MAC_CODEX, NOW, TRU, TRU_MAX, config, ok, thread } from './fixtures.ts';
import { createRouteService, recoverProfile, type RouteDeps, type StoredThreadState } from './bridge/route-service.ts';
import type { CascadeConfig } from './contract.ts';

function withCodexRow(): CascadeConfig {
  const c = config();
  // Подтверждение входа на Codex (в фикстуре включено) здесь не проверяется.
  return { ...c, steps: c.steps.map(s => ({ ...s, confirm: false })), models: [...c.models, { key: 'gpt-6.2-sol', displayName: 'GPT-6.2 Sol', providerId: 'codex', enabled: true, cells: {} }] };
}

function world(c: CascadeConfig, stored: Partial<StoredThreadState> = {}) {
  const store = new Map<string, StoredThreadState>();
  store.set('thr_1', { engine: thread(), profileId: null, lastRun: null, pendingFlushHostId: null, ...stored });
  const outcome = { ok: true as const, cwd: '/opt/bbfs/app', env: {}, timings: [], notices: [] };
  const d: RouteDeps = {
    loadConfig: async () => c, accounts: () => ACCOUNTS, health: () => () => ok, refreshLimits: async () => {}, observeLimit: () => {},
    threadInfo: async () => ({ projectId: 'proj_1', hostId: TRU, parentThreadId: null, providerId: 'subscriptions-cascade', isolatedWorkspace: false }),
    load: async id => store.get(id), save: async (id, s) => { store.set(id, s); },
    sync: { prepareTurn: async () => outcome, finishTurn: async () => outcome }, now: () => NOW,
  };
  return { routes: createRouteService(d), store };
}

const turn = (w: ReturnType<typeof world>, requestedModel: string, provider: 'claude-code' | 'codex' = 'claude-code') =>
  w.routes.routeTurn({ threadId: 'thr_1', projectId: 'proj_1', provider, requestedModel, cwd: '/srv/p', turnKey: 'k' });

test('ID модели CLI из таблицы → «только эта модель» на ступенях её провайдера, со строкой в ленте', async () => {
  const w = world(withCodexRow());
  const r = await turn(w, 'gpt-6.2-sol', 'codex');
  assert.ok(r.action === 'run' && r.stepId === MAC_CODEX && r.modelId === 'gpt-6.2-sol', JSON.stringify(r));
  assert.ok(r.notes.some(n => n.kind === 'notice' && /Модель треда «gpt-6\.2-sol» — не профиль каскада: ход «только GPT-6\.2 Sol» на ступенях Codex/u.test(n.message)), JSON.stringify(r.notes));
  assert.equal(r.action === 'run' && r.env.BB_CASCADE_PROFILE, 'm:gpt-6.2-sol');
  // Повтор после сбоя тоже видит подобранный профиль.
  assert.equal((await w.routes.retryAvailability('thr_1')).kind, 'ready');
});

test('не модель таблицы — сохранённый профиль треда; нет и его — «Авто»; отказ, только если выбрать нечего', async () => {
  const c = config();
  const kept = world(c, { profileId: 'only-opus-5.5' });
  const r = await turn(kept, 'something-unknown');
  assert.ok(r.action === 'run' && r.env.BB_CASCADE_PROFILE === 'only-opus-5.5', JSON.stringify(r));
  assert.ok(r.notes.some(n => n.kind === 'notice' && /не найден — ход по прежнему профилю треда «only-opus-5\.5»/u.test(n.message)));
  const fresh = await turn(world(c), 'something-unknown');
  assert.ok(fresh.action === 'run' && fresh.stepId === TRU_MAX && fresh.env.BB_CASCADE_PROFILE === 'auto', JSON.stringify(fresh));
  assert.ok(fresh.notes.some(n => n.kind === 'notice' && /не найден — ход по «Лучшая модель · любая машина»/u.test(n.message)));
  const none = { ...c, profiles: c.profiles.map(p => ({ ...p, enabled: false })) };
  assert.equal((await turn(world(none), 'something-unknown')).action, 'refuse');
});

test('recoverProfile: известный профиль, pin и m: — без подмены; модель находится и по имени', () => {
  const c = withCodexRow();
  for (const id of ['auto', 'only-opus-5.5', `pin:${MAC_CODEX}`, 'm:gpt-6.2-sol']) assert.deepEqual(recoverProfile(c, ACCOUNTS, id, null), { profileId: id, note: null });
  assert.equal(recoverProfile(c, ACCOUNTS, 'GPT-6.2 Sol', null).profileId, 'm:gpt-6.2-sol');
});
