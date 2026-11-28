// 0.3.5: запуск подтредов только через каскад. resolve отдаёт profileId, модель, effort
// и готовые аргументы `bb thread spawn`; агент ничего не выбирает сам. Подтред,
// созданный штатным провайдером при установленном каскаде, — строка у родителя.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effortFromText, lastReasoningLevel, resolveRequest } from './resolve.ts';
import type { CascadeConfig } from './contract.ts';
import { ACCOUNTS, MAC, MAC_CODEX, MAC_GW, NOW, TRU, config, ok, thread } from './fixtures.ts';
import { pinId } from './pins.ts';
import { bypassLine, createRouteService, type RouteDeps, type StoredThreadState } from './bridge/route-service.ts';

/** Каскад с моделями Codex в таблице (как у владельца). */
function withCodexRows(): CascadeConfig {
  const c = config();
  return { ...c, models: [...c.models, { key: 'gpt-6.2-sol', displayName: 'GPT-6.2 Sol', providerId: 'codex', enabled: true, cells: {} }] };
}

const HOSTS = [{ hostId: TRU, name: 'Tru' }, { hostId: MAC, name: 'MacBook' }, { hostId: 'host_ua', name: 'UA' }];

test('«передай Codex» — профиль «Codex · любая машина», модель Codex по приоритету, effort родителя, аргументы запуска', () => {
  for (const text of ['Codex', 'передай кодексу', 'отдай это Codex']) {
    const r = resolveRequest({ config: withCodexRows(), accounts: ACCOUNTS, hosts: HOSTS, text, parentEffort: 'medium' });
    assert.ok('match' in r, `${text}: ${JSON.stringify(r)}`);
    if (!('match' in r)) continue;
    assert.equal(r.match.profileId, 'subthread-codex');
    assert.equal(r.match.model, 'gpt-6.2-sol');
    assert.equal(r.match.effort, 'medium');
    assert.deepEqual(r.match.spawn, ['--provider', 'subscriptions-cascade', '--model', 'subthread-codex', '--reasoning-level', 'medium']);
  }
});

test('effort: явный в просьбе главнее родительского; без родителя и без явного — не передаётся', () => {
  assert.equal(effortFromText('Codex, подумай как следует'), 'high');
  assert.equal(effortFromText('на Mac xhigh'), 'xhigh');
  assert.equal(effortFromText('Codex low'), 'low');
  assert.equal(effortFromText('Codex на маке'), null);
  const hi = resolveRequest({ config: withCodexRows(), accounts: ACCOUNTS, hosts: HOSTS, text: 'Codex на маке high', parentEffort: 'medium' });
  assert.ok('match' in hi && hi.match.profileId === pinId(MAC_CODEX, null) && hi.match.effort === 'high', JSON.stringify(hi));
  assert.ok('match' in hi && hi.match.model === 'gpt-6.2-sol', 'модель ступени — первая по приоритету на машине');
  const none = resolveRequest({ config: config(), accounts: ACCOUNTS, hosts: HOSTS, text: 'на аккаунте vclaude' });
  assert.ok('match' in none && none.match.effort === null && !none.match.spawn.includes('--reasoning-level') && none.match.profileId === pinId(MAC_GW, null));
});

test('запасной путь тоже отдаёт аргументы штатного запуска с effort', () => {
  const r = resolveRequest({ config: config(), accounts: ACCOUNTS, hosts: HOSTS, text: 'Codex на Tru', parentEffort: 'low' });
  assert.ok('fallback' in r, JSON.stringify(r));
  if (!('fallback' in r)) return;
  assert.deepEqual(r.fallback.spawn, ['--provider', 'codex', '--machine', TRU, '--reasoning-level', 'low']);
});

test('effort родителя — из последнего запроса хода треда (execution.reasoningLevel)', () => {
  const ev = (seq: number, level: string | null) => ({ seq, type: 'client/turn/requested', data: { execution: level ? { reasoningLevel: level } : {} } });
  assert.equal(lastReasoningLevel([ev(1, 'low'), ev(3, 'high'), { seq: 4, type: 'item/completed', data: {} }]), 'high');
  assert.equal(lastReasoningLevel([ev(1, 'low'), ev(2, null)]), 'low');
  assert.equal(lastReasoningLevel([]), null);
});

test('подтред мимо каскада: родитель на каскаде получает строку в следующем ходе, один раз на подтред', async () => {
  const store = new Map<string, StoredThreadState>();
  store.set('thr_parent', { engine: thread({ threadId: 'thr_parent' }), profileId: 'auto', lastRun: null, pendingFlushHostId: null });
  const deps: RouteDeps = {
    loadConfig: async () => config(), accounts: () => ACCOUNTS, health: () => () => ok, refreshLimits: async () => {}, observeLimit: () => {},
    threadInfo: async () => ({ projectId: 'proj_1', hostId: TRU, parentThreadId: null, providerId: 'subscriptions-cascade' }),
    load: async id => store.get(id), save: async (id, s) => { store.set(id, s); }, sync: null, now: () => NOW,
  };
  const routes = createRouteService(deps);
  const child = { threadId: 'thr_direct', parentThreadId: 'thr_parent', title: 'Починка сборки', providerId: 'codex' };
  assert.deepEqual(await routes.subthreadBypass(child), { noted: true, parentOnCascade: true });
  assert.deepEqual(await routes.subthreadBypass(child), { noted: false, parentOnCascade: true }, 'второй раз — без повтора');
  const turn = () => routes.routeTurn({ threadId: 'thr_parent', projectId: 'proj_1', provider: 'claude-code', requestedModel: 'auto', cwd: '/srv/p', turnKey: 'k' });
  const first = await turn();
  assert.ok(first.action === 'run' && first.notes.filter(n => n.kind === 'notice' && n.message === bypassLine('Починка сборки')).length === 1, JSON.stringify(first));
  const second = await turn();
  assert.ok(second.action === 'run' && !second.notes.some(n => n.kind === 'notice' && /мимо каскада/u.test(n.message)));
  // Родитель не на каскаде: строку доставить некуда — сообщается вызывающему (замечания настроек).
  assert.deepEqual(await routes.subthreadBypass({ ...child, threadId: 'thr_x', parentThreadId: 'thr_native' }), { noted: false, parentOnCascade: false });
});
