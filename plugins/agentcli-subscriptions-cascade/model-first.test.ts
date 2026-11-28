// 0.4.0: модель важнее машины. Живой случай thr_xt6a8: ход шёл на UA · Opus, каскад
// «вернулся» на более высокую ступень iTAB (vclaude), там Opus — 402 «лимит тарифа
// исчерпан», Fable — 402 «только в Ultra 200», и тред ушёл на Sonnet. Теперь возврат
// возможен только к той же или лучшей модели, а 402 делится на «лимит» и «тариф».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { account, ACCOUNTS, MAC, MAC_GW, NOW, TRU, TRU_MAX, UA_PRO, config, exhausted, ok, thread } from './fixtures.ts';
import { selectStep, type HealthLookup } from './engine.ts';
import { createRouteService, modelRefusalKind, type RouteDeps, type StoredThreadState } from './bridge/route-service.ts';
import { codexLimits } from './adapters.ts';
import { codexRateLimitsToUsage } from './launcher/codex-quota.ts';
import { healthFromReading } from './limits.ts';
import { normalizeConfig } from './config.ts';
import { describeProfile } from './profiles.ts';
import { policiesSchema, type CascadeConfig } from './contract.ts';
import type { Stage } from './adapter.ts';

/** На шлюзе Mac есть Opus, Fable и Sonnet (как iTAB у владельца). */
const ACC = ACCOUNTS.map(a => (a.hostId === MAC && a.providerId === 'claude-code'
  ? account(MAC, 'claude-code', [{ id: 'opus55', displayName: 'opus55' }, { id: 'fable52', displayName: 'fable52' }, { id: 'sonnet55', displayName: 'sonnet55' }]) : a));

function cfg(): CascadeConfig {
  const c = config();
  const cell = (id: string) => ({ modelId: id, source: 'manual' as const });
  return { ...c, steps: c.steps.map(s => ({ ...s, confirm: false })), policies: { ...c.policies, returnAfterMinutes: 5 },
    models: c.models.map(r => r.key === 'sonnet-5.5' ? { ...r, cells: { ...r.cells, [MAC]: cell('sonnet55') } } : r) };
}

test('живой случай: UA · Opus, возврат на Mac (шлюз) — там Opus «лимит исчерпан», Fable «только в тарифе» → обратно на Opus UA, не Sonnet', async () => {
  const store = new Map<string, StoredThreadState>();
  let now = NOW;
  const health: Record<string, ReturnType<HealthLookup>> = { [TRU_MAX]: exhausted(NOW + 5 * 86_400_000), [MAC_GW]: exhausted(NOW + 60_000) };
  const outcome = { ok: true as const, cwd: '/opt/bbfs/app', env: {}, timings: [], notices: [] };
  const d: RouteDeps = {
    loadConfig: async () => cfg(), accounts: () => ACC, health: () => id => health[id] ?? ok, refreshLimits: async () => {}, observeLimit: () => {},
    threadInfo: async () => ({ projectId: 'proj_1', hostId: TRU, parentThreadId: null, providerId: 'subscriptions-cascade', isolatedWorkspace: false }),
    load: async id => store.get(id), save: async (id, s) => { store.set(id, s); }, sync: { prepareTurn: async () => outcome, finishTurn: async () => outcome }, now: () => now,
  };
  const routes = createRouteService(d);
  let n = 0;
  const turn = () => routes.routeTurn({ threadId: 'thr_1', projectId: 'proj_1', provider: 'claude-code', requestedModel: 'auto', cwd: '/srv/p', turnKey: `k${n++}` });
  const first = await turn();
  assert.ok(first.action === 'run' && first.stepId === UA_PRO && /opus/u.test(first.modelId ?? ''), JSON.stringify(first));
  // Mac освободился — возврат на ту же модель на более высокой ступени разрешён.
  delete health[MAC_GW];
  now += 6 * 60_000;
  const back = await turn();
  assert.ok(back.action === 'run' && back.stepId === MAC_GW && back.modelId === 'opus55', JSON.stringify(back));
  // На шлюзе: Opus — 402 «лимит тарифа исчерпан», Fable — 402 «только в Ultra 200».
  await routes.turnModelUnavailable({ threadId: 'thr_1', stepId: MAC_GW, modelId: 'opus55', reason: 'API Error: 402 Лимит тарифа исчерпан' });
  await routes.turnModelUnavailable({ threadId: 'thr_1', stepId: MAC_GW, modelId: 'fable52', reason: 'API Error: 402 Claude Fable доступен только в тарифе VClaude Ultra 200' });
  const next = await turn();
  assert.ok(next.action === 'run' && next.stepId === UA_PRO && /opus/u.test(next.modelId ?? ''), `ушёл на худшую модель: ${JSON.stringify(next)}`);
  const blocks = store.get('thr_1')!.modelBlocks!;
  assert.equal(blocks[`${MAC_GW}|opus55`]!.kind, 'quota');
  assert.equal(blocks[`${MAC_GW}|fable52`]!.kind, 'plan');
  assert.ok(blocks[`${MAC_GW}|opus55`]!.until - now <= 60 * 60_000, 'лимит — перепроверка через час');
  assert.ok(blocks[`${MAC_GW}|fable52`]!.until - now >= 23 * 3_600_000, 'тариф — суточная перепроверка');
});

test('S4: более высокая ступень, где доступна только модель хуже, — не возврат', () => {
  const c = cfg();
  const opusOnMac = (id: string, m: string | null) => (id === TRU_MAX ? exhausted(NOW + 86_400_000) : id === MAC_GW && m === 'opus55' ? exhausted(NOW + 3_600_000) : ok);
  const d = selectStep({ config: c, requestedModel: 'auto', accounts: ACC, now: NOW + 3_600_000, health: opusOnMac,
    thread: thread({ currentStepId: UA_PRO, currentModelId: 'claude-opus-5-5', switchedAt: NOW - 3_600_000 }) });
  assert.ok(d.kind === 'run' && d.stepId === UA_PRO && d.modelId === 'claude-opus-5-5', JSON.stringify(d));
});

test('402: «лимит … исчерпан» — исчерпание; «только в тарифе», «requires usage credits» — модель недоступна на ступени', () => {
  assert.equal(modelRefusalKind('API Error: 402 Лимит тарифа исчерпан'), 'quota');
  assert.equal(modelRefusalKind('usage limit reached for this plan'), 'quota');
  assert.equal(modelRefusalKind('API Error: 402 Claude Fable доступен только в тарифе VClaude Ultra 200'), 'plan');
  assert.equal(modelRefusalKind('This model requires usage credits'), 'plan');
});

test('квота Codex: usageLimits ответил 403 — адаптер спрашивает сам Codex (app-server account/rateLimits/read)', async () => {
  const appServer = { rateLimits: { primary: { usedPercent: 65, windowDurationMins: 10080, resetsAt: 1_796_217_355 }, secondary: null, planType: 'pro' } };
  const usage = codexRateLimitsToUsage(appServer);
  assert.deepEqual(usage, { status: 'ok', windows: [{ label: 'Weekly limit', kind: 'weekly', usedPercent: 65, resetsAt: new Date(1_796_217_355_000).toISOString() }], planLabel: 'pro', source: 'codex-app-server' });
  const adapter = codexLimits({
    usageLimits: async () => ({ codex: { status: 'error', message: 'Codex usage request failed (HTTP 403).' } }),
    vclaudeUsage: async () => null, codexRateLimits: async () => ({ usage, error: null }), now: () => NOW,
  });
  const stage = { hostId: 'h', provider: 'codex', profileRef: 'default', authority: 'subscription', quotaSource: 'provider', bindingEpoch: 'e' } as Stage;
  const reading = await adapter.read(stage, new AbortController().signal);
  assert.equal(reading.kind, 'sample');
  const h = healthFromReading(reading, null, { connected: true, now: NOW, policies: policiesSchema.parse({}) });
  assert.equal(h.unknown, false);
  // app-server тоже не ответил — честная причина 403.
  const none = codexLimits({ usageLimits: async () => ({ codex: { status: 'error', message: 'HTTP 403' } }), vclaudeUsage: async () => null, codexRateLimits: async () => ({ usage: null, error: 'нет' }), now: () => NOW });
  assert.equal((await none.read(stage, new AbortController().signal)).kind, 'unknown');
});

test('названия говорят о модели; прежние имена в настройках переименовываются, свои — нет; ID прежние', () => {
  const c = normalizeConfig({ machines: [], steps: [], models: [], profiles: [
    { id: 'auto', name: 'Авто' }, { id: 'opus-then-auto', name: 'Opus → Авто', policy: 'prefer-then-any', modelKey: 'opus-5.5' },
    { id: 'auto-codex-children', name: 'Авто · подтреды на Codex', descendants: 'subthread-codex' }, { id: 'mine', name: 'Мой профиль' }] });
  assert.deepEqual(c.profiles.map(p => [p.id, p.name]), [
    ['auto', 'Авто Opus · с Codex'], ['opus-then-auto', 'Opus, потом лучшая (прежний)'],
    ['auto-codex-children', 'Авто Opus · подтреды только Codex'], ['mine', 'Мой профиль'], ['only-codex', 'Только Codex']]);
});

test('подзаголовок — цепочка моделей; Fable, которую не может запустить ни одна ступень, не показывается', () => {
  const c = config();
  const noFable = { ...c, models: c.models.map(r => (r.key === 'fable-5.2' ? { ...r, cells: Object.fromEntries(c.machines.map(m => [m.hostId, { modelId: null, source: 'none' as const }])) } : r)) };
  const auto = noFable.profiles.find(p => p.id === 'auto')!;
  assert.match(describeProfile(noFable, auto, ACCOUNTS), /^Opus → Sonnet → Codex\. /u);
  assert.match(describeProfile(c, c.profiles.find(p => p.id === 'auto')!, ACCOUNTS), /^Opus → Fable → Sonnet → Codex\. /u);
});
