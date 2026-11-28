// S4 из живой приёмки: возврат не раньше N минут (в том числе после первого хода
// треда не на приоритетной ступени и при тестовой квоте) и лимит, полученный в ходе.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNTS, MAC, MAC_CODEX, MAC_GW, TRU, TRU_MAX, config as baseConfig, exhausted, ok } from '../fixtures.ts';
import type { CascadeConfig } from '../contract.ts';
import { quotaLookupFor } from '../profiles.ts';
import { createRouteService, mergeObserved, type StoredThreadState } from './route-service.ts';
import { limitFromClaudeLine } from '../launcher/main.ts';

const T0 = Date.parse('2026-11-27T12:00:00Z');
const sync = { prepareTurn: async () => ({ ok: true as const, cwd: '/opt/bbfs/p', env: {}, timings: [], notices: [] }), finishTurn: async () => ({ ok: true as const, cwd: '/opt/bbfs/p', env: {}, timings: [], notices: [] }) };

function fixture() {
  let now = T0;
  let cfg: CascadeConfig = { ...baseConfig(), policies: { ...baseConfig().policies, executionMode: 'provider' } };
  const store = new Map<string, StoredThreadState>();
  const routes = createRouteService({
    loadConfig: async () => cfg, accounts: () => ACCOUNTS,
    // Как на сервере: тестовая квота треда поверх реальных лимитов (реальные — «есть»).
    health: (c, threadId) => quotaLookupFor(c, threadId, () => ok, now),
    refreshLimits: async () => {}, observeLimit: () => {},
    threadInfo: async () => ({ projectId: 'p', hostId: TRU, parentThreadId: null, providerId: 'subscriptions-cascade', isolatedWorkspace: true }),
    load: async id => store.get(id), save: async (id, s) => { store.set(id, s); }, sync, now: () => now,
  });
  const setQuota = (state: 'exhausted' | 'available', resetsAt: number | null = null) => {
    cfg = { ...cfg, testQuota: { ...cfg.testQuota, threads: { thr_s4: { [TRU_MAX]: { state, resetsAt: resetsAt === null ? null : new Date(resetsAt).toISOString() } } } } };
  };
  return { routes, store, setQuota, tick: (ms: number) => { now += ms; }, now: () => now };
}
const turn = { threadId: 'thr_s4', projectId: 'p', provider: 'claude-code' as const, requestedModel: 'auto', cwd: '/data/wt/thr_s4-1/p' };
const stepOf = (r: Awaited<ReturnType<ReturnType<typeof fixture>['routes']['routeTurn']>>) => (r.action === 'run' ? r.stepId : r.action);

test('S4: первый ход не на приоритетной ступени — возврат на Tru не раньше 30 мин, а не через 2,5', async () => {
  const fx = fixture();
  fx.setQuota('exhausted', T0 + 60_000);           // Tru исчерпан, сброс через минуту
  assert.equal(stepOf(await fx.routes.routeTurn(turn)), MAC_GW, 'первый ход — Mac');
  fx.tick(150_000);                                  // 2,5 мин: сброс Tru прошёл
  assert.equal(stepOf(await fx.routes.routeTurn(turn)), MAC_GW, 'через 2,5 мин остаёмся на Mac');
  fx.tick(28 * 60_000);                              // 30,5 мин с перехода
  const back = await fx.routes.routeTurn(turn);
  assert.equal(stepOf(back), TRU_MAX, 'после 30 мин — возврат');
  assert.ok(back.action === 'run' && back.notes.some(n => n.kind === 'switch' && n.reason === 'return'));
});

test('S4: лимит, полученный в ходе, помечает ступень исчерпанной поверх тестовой квоты; следующий ход — дальше по каскаду', async () => {
  const fx = fixture();
  fx.setQuota('available');                          // тестовая квота говорит «есть»
  assert.equal(stepOf(await fx.routes.routeTurn(turn)), TRU_MAX);
  // В ходе пришёл настоящий недельный лимит.
  const marked = await fx.routes.turnLimits({ threadId: 'thr_s4', stepId: TRU_MAX, limits: [{ status: 'rejected', resetsAt: T0 + 7 * 86_400_000, windowType: 'seven_day' }] });
  assert.equal(marked.exhausted, true);
  assert.deepEqual(await fx.routes.retryAvailability('thr_s4'), { kind: 'ready' }, 'provider-retry повторит ход сразу');
  const next = await fx.routes.routeTurn(turn);
  assert.equal(stepOf(next), MAC_GW, 'повтор хода — на следующей ступени');
  assert.ok(next.action === 'run' && next.notes.some(n => n.kind === 'switch' && n.reason === 'limit'));
});

test('отметка лимита: сброс известен — до него; неизвестен — час; ступень снова ответила — снята', () => {
  const a = mergeObserved(null, TRU_MAX, [{ status: 'rejected', resetsAt: T0 + 3_600_000, windowType: null }], T0);
  assert.equal(a?.[TRU_MAX]?.until, T0 + 3_600_000);
  const b = mergeObserved(null, TRU_MAX, [{ status: 'rejected', resetsAt: null, windowType: 'result-text' }], T0);
  assert.equal(b?.[TRU_MAX]?.until, T0 + 3_600_000);
  assert.equal(mergeObserved(a, TRU_MAX, [{ status: 'allowed', resetsAt: null, windowType: null }], T0), null);
  assert.equal(mergeObserved(a, MAC_GW, [], T0 + 4_000_000), null, 'просроченная отметка убирается');
});

test('лимит из текста result Claude: «You\'ve hit your weekly limit» без rate_limit_event', () => {
  const line = JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your weekly limit · resets Dec 3, 9am" });
  assert.equal(limitFromClaudeLine(line)?.status, 'rejected');
  assert.equal(limitFromClaudeLine(JSON.stringify({ type: 'result', is_error: false, result: 'обсудили weekly limit' })), null);
});

test('паспорт треда: ступень vclaude — accountKey «vclaude» и kind gateway (для thread-account-usage)', async () => {
  const fx = fixture();
  fx.setQuota('exhausted', T0 + 3_600_000);
  await fx.routes.routeTurn(turn);
  const status = await fx.routes.threadStatus('thr_s4');
  assert.ok(status.cascade);
  assert.deepEqual(status.cascade && status.step && { host: status.step.hostId, key: status.step.accountKey, kind: status.step.kind }, { host: 'host_mac', key: 'vclaude', kind: 'gateway' });
});

test('S11: подтред с профилем «Opus → Авто» — только машина родителя; родитель на Tru исчерпан — ждёт, на Mac не уходит', async () => {
  const store = new Map<string, StoredThreadState>();
  const cfg: CascadeConfig = { ...baseConfig(), policies: { ...baseConfig().policies, executionMode: 'provider', subthreadsUseOtherMachines: false } };
  const info = (threadId: string) => threadId === 'thr_parent'
    ? { projectId: 'p', hostId: TRU, parentThreadId: null, providerId: 'subscriptions-cascade' }
    : { projectId: 'p', hostId: childHost, parentThreadId: 'thr_parent', providerId: 'subscriptions-cascade', isolatedWorkspace: true };
  let childHost: string | null = TRU;
  // Прежнее состояние подтреда без машины дома (как до 0.1.9).
  store.set('thr_child', { engine: { threadId: 'thr_child', projectId: 'p', turnId: '', isSubthread: false, homeHostId: null, currentStepId: null, switchedAt: null, waitingSince: null, consents: [], skippedStepIds: [] }, profileId: 'opus-then-auto', lastRun: null, pendingFlushHostId: null });
  const routes = createRouteService({
    loadConfig: async () => cfg, accounts: () => ACCOUNTS, health: () => id => (id === TRU_MAX ? exhausted(T0 + 3_600_000) : ok),
    refreshLimits: async () => {}, observeLimit: () => {}, threadInfo: async id => info(id),
    load: async id => store.get(id), save: async (id, s) => { store.set(id, s); }, sync, now: () => T0,
  });
  const out = await routes.routeTurn({ ...turn, threadId: 'thr_child', requestedModel: 'opus-then-auto' });
  assert.equal(out.action, 'refuse', JSON.stringify(out).slice(0, 200));
  assert.ok(out.action === 'refuse' && out.notes.some(n => n.kind === 'wait'), 'ждёт сброса Tru');
  const free = createRouteService({
    loadConfig: async () => cfg, accounts: () => ACCOUNTS, health: () => () => ok,
    refreshLimits: async () => {}, observeLimit: () => {}, threadInfo: async id => info(id),
    load: async () => undefined, save: async () => {}, sync, now: () => T0,
  });
  const run = await free.routeTurn({ ...turn, threadId: 'thr_child', requestedModel: 'opus-then-auto' });
  assert.equal(stepOf(run), TRU_MAX, 'лимит родителя есть — ход на его машине');
  childHost = null;
  const orphan = createRouteService({
    loadConfig: async () => cfg, accounts: () => ACCOUNTS, health: () => () => ok, refreshLimits: async () => {}, observeLimit: () => {},
    threadInfo: async id => (id === 'thr_parent' ? null : info(id)), load: async () => undefined, save: async () => {}, sync, now: () => T0,
  });
  const refused = await orphan.routeTurn({ ...turn, threadId: 'thr_child' });
  assert.match(refused.action === 'refuse' ? refused.message : '', /машина родителя не определена/u);
});

test('ленивая настройка: машина не настроена — мастер при ходе, затем ход; нужно разрешение — ступень пропущена со строкой «Нужно разрешение»', async () => {
  const cfg: CascadeConfig = { ...baseConfig(), policies: { ...baseConfig().policies, executionMode: 'provider' } };
  const make = (ensure: { ok: boolean; message: string; consent: string | null }) => {
    const calls: string[] = [];
    let configured = false;
    const routes = createRouteService({
      loadConfig: async () => cfg, accounts: () => ACCOUNTS, health: () => id => (id === TRU_MAX ? exhausted(T0 + 3_600_000) : ok),
      refreshLimits: async () => {}, observeLimit: () => {},
      threadInfo: async () => ({ projectId: 'p', hostId: TRU, parentThreadId: null, providerId: 'subscriptions-cascade', isolatedWorkspace: true }),
      load: async () => undefined, save: async () => {}, now: () => T0, sleep: async () => {},
      sync: {
        prepareTurn: async (_t, step) => { calls.push(`prepare:${step.hostId}`); return configured || step.hostId !== 'host_mac' ? sync.prepareTurn() : { ok: false, reason: 'not-configured', message: 'Mac: не задан SSH-доступ к Tru', conflicts: [], timings: [], notices: [] }; },
        finishTurn: sync.finishTurn,
      },
      ensureMachine: async hostId => { calls.push(`ensure:${hostId}`); configured = ensure.ok; return ensure; },
    });
    return { routes, calls };
  };
  const good = make({ ok: true, message: '', consent: null });
  const ran = await good.routes.routeTurn(turn);
  assert.equal(stepOf(ran), MAC_GW);
  assert.deepEqual(good.calls, ['prepare:host_mac', 'ensure:host_mac', 'prepare:host_mac']);
  const consent = make({ ok: false, message: 'нужно разрешение', consent: 'Разрешить машине Mac входить на Tru по ключу SHA256:x?' });
  const next = await consent.routes.routeTurn(turn);
  assert.equal(stepOf(next), 'host_ua:claude-code:*', 'следующая ступень');
  assert.ok(next.action === 'run' && next.notes.some(n => n.kind === 'problem' && /Нужно разрешение для Mac/u.test(n.message) && /--allow-ssh/u.test(n.note ?? '')));
});

test('S3: согласие «на этот ход» переживает автоповтор (новый turnKey) — повтор на Codex без второй карточки', async () => {
  const cfg: CascadeConfig = { ...baseConfig(), policies: { ...baseConfig().policies, executionMode: 'provider' } };
  const store = new Map<string, StoredThreadState>();
  const allClaudeOut = (id: string) => (id.includes(':claude-code:') ? exhausted(T0 + 3_600_000) : ok);
  const routes = createRouteService({
    loadConfig: async () => cfg, accounts: () => ACCOUNTS, health: () => allClaudeOut,
    refreshLimits: async () => {}, observeLimit: () => {},
    threadInfo: async () => ({ projectId: 'p', hostId: TRU, parentThreadId: null, providerId: 'subscriptions-cascade', isolatedWorkspace: true }),
    load: async id => store.get(id), save: async (id, s) => { store.set(id, s); }, sync, now: () => T0,
  });
  const card = await routes.routeTurn({ ...turn, turnKey: 'k1' });
  assert.equal(card.action, 'confirm');
  const stepId = card.action === 'confirm' ? card.prompt.stepId : '';
  await routes.answerConfirmation({ threadId: 'thr_s4', stepId, turnKey: 'k1', action: 'go', scope: 'turn', threadUntil: null });
  const inClaude = await routes.routeTurn({ ...turn, turnKey: 'k1' });
  assert.equal(inClaude.action === 'refuse' && inClaude.retryAs, 'limit', 'ход Claude отдаётся на автоповтор');
  assert.equal((await routes.retryAvailability('thr_s4')).kind, 'ready');
  const retry = await routes.routeTurn({ ...turn, provider: 'codex', turnKey: 'k2' });
  assert.equal(retry.action, 'run', 'повтор (новый ход) — без второй карточки');
  assert.equal(retry.action === 'run' && retry.providerId, 'codex');
  const next = await routes.routeTurn({ ...turn, provider: 'codex', turnKey: 'k3' });
  assert.equal(next.action, 'confirm', 'следующий настоящий ход снова спрашивает');
});

test('S7: плагин обновился посреди подготовки — отказ с автоповтором как перегрузка; модель недоступна — следующая попытка', async () => {
  const cfg: CascadeConfig = { ...baseConfig(), policies: { ...baseConfig().policies, executionMode: 'provider' } };
  const store = new Map<string, StoredThreadState>();
  const base = {
    loadConfig: async () => cfg, accounts: () => ACCOUNTS, refreshLimits: async () => {}, observeLimit: () => {},
    threadInfo: async () => ({ projectId: 'p', hostId: TRU, parentThreadId: null, providerId: 'subscriptions-cascade', isolatedWorkspace: true }),
    load: async (id: string) => store.get(id), save: async (id: string, s: StoredThreadState) => { store.set(id, s); }, now: () => T0,
  };
  const retired = createRouteService({ ...base, health: () => id => (id === TRU_MAX ? exhausted(null) : ok),
    sync: { prepareTurn: async () => ({ ok: false, reason: 'error', message: 'host plugin agentcli-subscriptions-cascade generation 6af6 is retired', conflicts: [], timings: [], notices: [] }), finishTurn: sync.finishTurn } });
  const r = await retired.routeTurn(turn);
  assert.equal(r.action === 'refuse' && r.retryAs, 'overload');
  assert.match(r.action === 'refuse' ? r.message : '', /обновился во время подготовки хода — ход повторится автоматически/u);

  const blocked: string[] = [];
  const models = createRouteService({ ...base, health: () => () => ok, sync, blockModel: async (h, m) => { blocked.push(`${h}|${m}`); } });
  const first = await models.routeTurn({ ...turn, requestedModel: 'only-fable-5.2' });
  assert.equal(stepOf(first), TRU_MAX);
  await models.turnModelUnavailable({ threadId: 'thr_s4', stepId: TRU_MAX, modelId: first.action === 'run' ? first.modelId : null, reason: 'Fable 5.2 requires usage credits' });
  assert.equal(blocked.length, 1, 'ячейка в таблице помечена');
  const second = await models.routeTurn({ ...turn, requestedModel: 'only-fable-5.2' });
  assert.equal(stepOf(second), MAC_GW, 'та же модель на следующей ступени профиля');
});

test('provider-retry availability: свой тред — за доли секунды без обнаружения и опроса лимитов; медленный источник — ready по бюджету; чужой — not-routed', async () => {
  const cfg: CascadeConfig = { ...baseConfig(), policies: { ...baseConfig().policies, executionMode: 'provider' } };
  const store = new Map<string, StoredThreadState>();
  let heavy = 0;
  const slow = () => new Promise<never>(() => {}); // повисший вызов: обнаружение, сеть
  const routes = createRouteService({
    loadConfig: async () => cfg, accounts: () => ACCOUNTS, health: () => id => (id === TRU_MAX ? exhausted(T0 + 3_600_000) : ok),
    refreshLimits: async () => { heavy += 1; return slow(); }, observeLimit: () => {},
    threadInfo: async () => { heavy += 1; return slow(); },
    load: async id => store.get(id), save: async (id, s) => { store.set(id, s); }, sync, now: () => T0,
  });
  store.set('thr_own', { engine: { threadId: 'thr_own', projectId: 'p', turnId: '', isSubthread: false, homeHostId: TRU, currentStepId: TRU_MAX, switchedAt: T0 - 60_000, waitingSince: null, consents: [], skippedStepIds: [] }, profileId: 'auto', lastRun: null, pendingFlushHostId: null, observed: { [TRU_MAX]: { until: T0 + 3_600_000, at: T0 } } });
  const t0 = performance.now();
  assert.deepEqual(await routes.retryAvailability('thr_own'), { kind: 'ready' });
  assert.ok(performance.now() - t0 < 200, `ответ за ${Math.round(performance.now() - t0)} мс`);
  assert.equal(heavy, 0, 'ни обнаружения, ни запросов треда');
  assert.deepEqual(await routes.retryAvailability('thr_native'), { kind: 'not-routed' });

  // Медленная конфигурация (обнаружение при пустых настройках) — бюджет, свой тред — ready.
  const stuck = createRouteService({
    loadConfig: slow, accounts: () => ACCOUNTS, health: () => () => ok, refreshLimits: async () => {}, observeLimit: () => {},
    threadInfo: async () => null, load: async id => store.get(id), save: async () => {}, sync, now: () => T0, availabilityBudgetMs: 50,
  });
  const t1 = performance.now();
  assert.deepEqual(await stuck.retryAvailability('thr_own'), { kind: 'ready' });
  assert.ok(performance.now() - t1 < 1_000);
});

test('S5: возврат Codex → Claude — строка перехода «возврат» с исходной ступенью Codex, и когда движок не видел ход Codex', async () => {
  for (const engineSaw of [true, false]) {
    const fx = fixture();
    fx.setQuota('available');
    assert.equal(stepOf(await fx.routes.routeTurn(turn)), TRU_MAX);
    // Прошлый ход шёл на Codex (Mac) 31 мин назад; лимит Claude сброшен.
    const stored = fx.store.get('thr_s4')!;
    fx.store.set('thr_s4', {
      ...stored,
      lastRun: { stepId: MAC_CODEX, hostId: MAC, providerId: 'codex', modelId: null, at: fx.now() },
      engine: engineSaw ? { ...stored.engine, currentStepId: MAC_CODEX, currentModelId: undefined, switchedAt: fx.now() } : stored.engine,
    });
    fx.tick(31 * 60_000);
    const back = await fx.routes.routeTurn(turn);
    assert.equal(stepOf(back), TRU_MAX);
    const sw = back.action === 'run' ? back.notes.find(n => n.kind === 'switch') : undefined;
    assert.ok(sw && sw.kind === 'switch', `строка перехода есть (движок видел Codex: ${engineSaw})`);
    assert.equal(sw.reason, 'return');
    assert.equal(sw.from?.provider, 'Codex');
    assert.equal(sw.to.provider, 'Claude');
  }
});
