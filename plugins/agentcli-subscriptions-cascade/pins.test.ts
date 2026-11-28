// 0.3.0: закреплённые ступени (pin:…), меню, переход «Закреплено» → «Авто», resolve.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { stepId } from './config.ts';
import type { CascadeConfig } from './contract.ts';
import { buildPlan, selectStep } from './engine.ts';
import { ACCOUNTS, MAC, MAC_CODEX, MAC_GW, NOW, TRU, TRU_MAX, UA, UA_CODEX, UA_PRO, account, config, exhausted, ok, thread } from './fixtures.ts';
import { parsePin, pinId, pinnedEntries, pinnedProfile } from './pins.ts';
import { PROVIDER_MODELS_MAX, providerModels } from './profiles.ts';
import { resolveRequest } from './resolve.ts';
import { createRouteService, type RouteDeps, type StoredThreadState } from './bridge/route-service.ts';

const TRU_CODEX = stepId(TRU, 'codex', null);

/** Каскад владельца + Codex на Tru и строки моделей Codex в таблице. */
function withCodex(): CascadeConfig {
  const c = config();
  const truCodex = { ...c.steps.find(s => s.id === MAC_CODEX)!, id: TRU_CODEX, hostId: TRU };
  return {
    ...c,
    steps: [...c.steps, truCodex],
    models: [...c.models,
      { key: 'gpt-6.2-sol', displayName: 'GPT-6.2 Sol', providerId: 'codex', enabled: true, cells: {} },
      { key: 'gpt-6.2-astra', displayName: 'GPT-6.2 Astra', providerId: 'codex', enabled: true, cells: {} }],
  };
}

const ACCOUNTS_CODEX = [...ACCOUNTS, account(TRU, 'codex', [{ id: 'gpt-6.2-sol', displayName: 'GPT-6.2 Sol' }, { id: 'gpt-6.2-astra', displayName: 'GPT-6.2 Astra' }])];
const HOSTS = [{ hostId: TRU, name: 'Tru' }, { hostId: MAC, name: 'MacBook Pro' }, { hostId: UA, name: 'UA' }, { hostId: 'host_win', name: 'Windows' }];

test('pin: ID ступени с «:» внутри разбирается целиком, ключ модели — остаток', () => {
  const c = config();
  assert.deepEqual(parsePin(c, pinId(MAC_GW, 'opus-5.5')), { step: c.steps.find(s => s.id === MAC_GW), modelKey: 'opus-5.5' });
  assert.deepEqual(parsePin(c, pinId(MAC_GW, null))!.modelKey, null);
  assert.equal(parsePin(c, 'pin:host_нет:codex:*'), null);
  const p = pinnedProfile(c, pinId(MAC_GW, 'opus-5.5'))!;
  assert.equal(p.policy, 'only');
  assert.equal(p.name, 'Mac · Claude (vclaude) · Opus 5.5');
  assert.deepEqual(p.stepOrder, [MAC_GW]);
  assert.ok(p.excludedSteps.includes(TRU_MAX) && !p.excludedSteps.includes(MAC_GW));
  assert.equal(pinnedProfile(c, pinId(MAC_CODEX, null))!.policy, 'any');
});

test('меню: сначала профили «Авто…», потом закреплённые ступени из включённых ступеней и таблицы; недоступных нет', () => {
  const c = withCodex();
  const models = providerModels(c, ACCOUNTS_CODEX);
  const firstPin = models.findIndex(m => m.id.startsWith('pin:'));
  assert.equal(firstPin, c.profiles.length, 'профили — первыми');
  assert.equal(models.filter(m => m.isDefault).length, 1);
  assert.equal(models[0]!.isDefault, true);
  const pins = models.slice(firstPin).map(m => m.displayName);
  assert.deepEqual(pins, [
    'Tru · Claude (Max 20)', 'Tru · Claude (Max 20) · Opus 5.5', 'Tru · Claude (Max 20) · Fable 5.2',
    'Mac · Claude (vclaude)', 'Mac · Claude (vclaude) · Opus 5.5', 'Mac · Claude (vclaude) · Fable 5.2',
    'UA · Claude (Pro)', 'UA · Claude (Pro) · Opus 5.5', 'UA · Claude (Pro) · Sonnet 5.5',
    'Mac · Codex', 'Mac · Codex · GPT-6.2 Sol',
    'UA · Codex', 'UA · Codex · GPT-6.2 Sol',
    'Tru · Codex', 'Tru · Codex · GPT-6.2 Sol', 'Tru · Codex · GPT-6.2 Astra',
  ]);
  assert.ok(models.slice(firstPin).every(m => m.description.startsWith('Закреплено: ')));
  // Модель недоступна на аккаунте, ступень выключена, CLI не установлен — пунктов нет.
  const blocked = pinnedEntries(c, ACCOUNTS_CODEX, (h, m) => h === TRU && m === 'gpt-6.2-astra').map(e => e.label);
  assert.ok(!blocked.includes('Tru · Codex · GPT-6.2 Astra'));
  const off = { ...c, steps: c.steps.map(s => s.id === UA_PRO ? { ...s, enabled: false } : s) };
  assert.ok(!pinnedEntries(off, ACCOUNTS_CODEX).some(e => e.stepId === UA_PRO));
  const noCli = ACCOUNTS_CODEX.map(a => a.hostId === UA && a.providerId === 'codex' ? { ...a, installed: false } : a);
  assert.ok(!pinnedEntries(c, noCli).some(e => e.stepId === UA_CODEX));
  // Предел BB — 64 пункта: лишние закреплённые отрезаются, профили остаются.
  const many = { ...c, models: [...c.models, ...Array.from({ length: 80 }, (_, i) => ({ key: `m${i}`, displayName: `M${i}`, providerId: 'claude-code', enabled: true, cells: { [TRU]: { modelId: `m${i}`, source: 'manual' as const } } }))] };
  const capped = providerModels(many, []);
  assert.equal(capped.length, PROVIDER_MODELS_MAX);
  const profs = capped.filter(m => !m.id.startsWith('pin:'));
  assert.ok(profs.length > 0);
  assert.deepEqual(capped.slice(0, profs.length), profs, 'профили не отрезаются и идут первыми');
});

test('движок: закреплённая ступень — только туда; исчерпана — ждёт сброса, в «Авто» не уходит; Codex без карточки', () => {
  const c = withCodex();
  const id = pinId(TRU_CODEX, 'gpt-6.2-sol');
  const health = (map: Record<string, ReturnType<typeof exhausted> | typeof ok>) => (sid: string) => map[sid] ?? ok;
  const run = selectStep({ config: c, requestedModel: id, accounts: ACCOUNTS_CODEX, thread: thread(), health: health({}), now: NOW });
  assert.equal(run.kind, 'run', 'закреплённый Codex — без карточки подтверждения');
  assert.ok(run.kind === 'run' && run.stepId === TRU_CODEX && run.modelId === 'gpt-6.2-sol');
  const reset = NOW + 2 * 3_600_000;
  const wait = selectStep({ config: c, requestedModel: id, accounts: ACCOUNTS_CODEX, thread: thread(), health: health({ [TRU_CODEX]: exhausted(reset) }), now: NOW });
  assert.deepEqual(wait.kind === 'wait' ? [wait.kind, wait.until, wait.stepId] : wait, ['wait', reset, TRU_CODEX]);
  const far = selectStep({ config: c, requestedModel: id, accounts: ACCOUNTS_CODEX, thread: thread(), health: health({ [TRU_CODEX]: exhausted(NOW + 100 * 3_600_000) }), now: NOW });
  assert.equal(far.kind, 'ask-owner');
  // Ступень целиком: модели по приоритету, но только на ней.
  const plan = buildPlan({ config: c, requestedModel: pinId(MAC_GW, null), accounts: ACCOUNTS_CODEX, thread: thread() });
  assert.ok(Array.isArray(plan));
  assert.deepEqual(plan.filter(a => a.skip === null).map(a => [a.stepId, a.modelId]), [[MAC_GW, 'opus55'], [MAC_GW, 'fable52']]);
  // Подтред: закреплённую машину выбрал владелец — запрет «только машина родителя» не действует.
  const sub = selectStep({ config: c, requestedModel: pinId(UA_PRO, null), accounts: ACCOUNTS_CODEX, thread: thread({ isSubthread: true, homeHostId: TRU }), health: health({}), now: NOW });
  assert.ok(sub.kind === 'run' && sub.stepId === UA_PRO);
  // Ступень исчезла из настроек — профиль не найден.
  assert.deepEqual(selectStep({ config: c, requestedModel: 'pin:host_x:codex:*', accounts: ACCOUNTS_CODEX, thread: thread(), health: health({}), now: NOW }), { kind: 'unavailable', reason: 'unknown-profile' });
});

function routeFixture(c: CascadeConfig) {
  const store = new Map<string, StoredThreadState>();
  let now = NOW;
  const deps: RouteDeps = {
    loadConfig: async () => c, accounts: () => ACCOUNTS_CODEX, health: () => () => ok, refreshLimits: async () => {}, observeLimit: () => {},
    threadInfo: async () => ({ projectId: 'proj_1', hostId: TRU, parentThreadId: null, providerId: 'subscriptions-cascade' }),
    load: async id => store.get(id), save: async (id, s) => { store.set(id, s); },
    sync: {
      prepareTurn: async (_t, s) => ({ ok: true, cwd: `/opt/bbfs/proj-${s.hostId}`, env: {}, timings: [], notices: [] }),
      finishTurn: async () => ({ ok: true, cwd: '', env: {}, timings: [], notices: [] }),
      modeOf: () => 'lazy',
    },
    now: () => now,
  };
  return { routes: createRouteService(deps), store, tick: (ms: number) => { now += ms; } };
}

test('«Закреплено» → «Авто» в том же треде: та же ступень, та же сессия и файлы, без строки перехода; профиль — в окружении CLI', async () => {
  const c = withCodex();
  const fx = routeFixture(c);
  const turn = { threadId: 'thr_pin', projectId: 'proj_1', provider: 'claude-code' as const, cwd: '/srv/projects/proj' };
  const pinned = pinId(MAC_GW, 'opus-5.5');
  const r1 = await fx.routes.routeTurn({ ...turn, requestedModel: pinned });
  assert.ok(r1.action === 'run' && r1.stepId === MAC_GW && r1.cwd === `/opt/bbfs/proj-${MAC}`);
  if (r1.action !== 'run') return;
  assert.deepEqual([r1.env.BB_CASCADE_PROFILE, r1.env.BB_CASCADE_STEP], [pinned, MAC_GW]);
  await fx.routes.finishTurn({ threadId: 'thr_pin', stepId: MAC_GW, hostId: MAC, exitCode: 0, limits: [] });
  const before = fx.store.get('thr_pin')!;
  fx.tick(60_000);
  // Владелец выбрал «Авто»: Tru приоритетнее, но правило «не раньше N минут» держит ступень.
  const r2 = await fx.routes.routeTurn({ ...turn, requestedModel: 'auto' });
  assert.ok(r2.action === 'run');
  if (r2.action !== 'run') return;
  assert.equal(r2.stepId, MAC_GW, 'ступень та же — сессия продолжается');
  assert.equal(r2.cwd, r1.cwd, 'та же папка ступени');
  assert.equal(r2.env.BB_CASCADE_PROFILE, 'auto');
  assert.ok(!r2.notes.some(n => n.kind === 'switch'), 'не переход');
  const after = fx.store.get('thr_pin')!;
  assert.equal(after.profileId, 'auto');
  assert.equal(after.engine.threadId, before.engine.threadId);
  assert.equal(after.engine.switchedAt, before.engine.switchedAt, 'отсчёт возврата не сброшен');
  assert.equal(after.workspace, before.workspace);
  // Через 30 минут «Авто» возвращается на Tru как обычный переход каскада.
  fx.tick(31 * 60_000);
  const r3 = await fx.routes.routeTurn({ ...turn, requestedModel: 'auto' });
  assert.ok(r3.action === 'run' && r3.stepId === TRU_MAX);
});

test('реле сессии: профиль сменился на той же ступени — новый процесс продолжает ту же сессию (--resume)', async () => {
  const { runSessionRelay } = await import('./launcher/session-relay.ts');
  const SID = '11111111-2222-3333-4444-555555555555';
  type Route = { action: 'run'; stepId: string; hostId: string; providerId: string; modelId: string | null; local: boolean; cwd: string | null; env: Record<string, string>; stage: { machine: string }; notes: never[] };
  const mk = (profile: string): Route => ({ action: 'run', stepId: MAC_GW, hostId: MAC, providerId: 'claude-code', modelId: 'opus55', local: true, cwd: null, env: { BB_CASCADE_PROFILE: profile, BB_CASCADE_STEP: MAC_GW }, stage: { machine: 'Mac' }, notes: [] });
  const routes = [mk('pin:x'), mk('pin:x'), mk('auto')];
  const started: { args: string[]; env: Record<string, string> }[] = [];
  const stdin = new PassThrough();
  const relay = runSessionRelay({ ...mk(''), stepId: '', hostId: '', env: {} }, ['--input-format', 'stream-json', `--session-id=${SID}`], SID, {
    start(route, args, onLine) {
      started.push({ args, env: route.env });
      let resolveDone!: (v: { code: number; transportError: null }) => void;
      const done = new Promise<{ code: number; transportError: null }>(r => { resolveDone = r; });
      return {
        write(line) { if ((JSON.parse(line) as { type: string }).type === 'user') setTimeout(() => onLine(JSON.stringify({ type: 'result' })), 5); },
        end() { resolveDone({ code: 0, transportError: null }); }, kill() { resolveDone({ code: 1, transportError: null }); }, done,
      };
    },
    sessionExists: () => true,
    routeTurn: async () => routes.shift()!,
    finishTurn: async () => {}, feed: async () => {}, limitFromLine: () => null,
    stdin, stdout: { write() {} }, stderr: { write() {} }, now: Date.now, log() {},
  }, { routeFirst: true });
  for (const n of [1, 2, 3]) {
    stdin.write(`${JSON.stringify({ type: 'user', message: { content: `ход ${n}` } })}\n`);
    await new Promise(r => setTimeout(r, 40));
  }
  stdin.end();
  assert.equal(await relay, 0);
  // Начало сессии, ход 1 (новая ступень), ход 2 — тот же процесс, ход 3 («Авто») — перезапуск.
  assert.equal(started.length, 3);
  assert.equal(started[1]!.env.BB_CASCADE_PROFILE, 'pin:x');
  assert.equal(started[2]!.env.BB_CASCADE_PROFILE, 'auto');
  assert.ok(started[2]!.args.includes(`--resume=${SID}`), 'та же сессия');
});

test('resolve: «Codex 6.2 на Tru», «на аккаунте vclaude», «Opus на UA» → ступень; несколько — кандидаты', () => {
  const c = withCodex();
  // Сравнение по ступени и подписи; model/effort/spawn (0.3.5) — в resolve-spawn.test.ts.
  const r = (text: string) => {
    const out = resolveRequest({ config: c, accounts: ACCOUNTS_CODEX, hosts: HOSTS, text });
    if ('match' in out) return { match: { profileId: out.match.profileId, label: out.match.label } };
    if ('candidates' in out) return { candidates: out.candidates };
    return out;
  };
  assert.deepEqual(r('на аккаунте vclaude'), { match: { profileId: pinId(MAC_GW, null), label: 'Mac · Claude (vclaude)' } });
  assert.deepEqual(r('Opus на UA'), { match: { profileId: pinId(UA_PRO, 'opus-5.5'), label: 'UA · Claude (Pro) · Opus 5.5' } });
  assert.deepEqual(r('запусти через каскад опус на юа'.replace('юа', 'UA')), { match: { profileId: pinId(UA_PRO, 'opus-5.5'), label: 'UA · Claude (Pro) · Opus 5.5' } });
  assert.deepEqual(r('Codex 6.2 на Tru'), { candidates: [
    { profileId: pinId(TRU_CODEX, 'gpt-6.2-sol'), label: 'Tru · Codex · GPT-6.2 Sol' },
    { profileId: pinId(TRU_CODEX, 'gpt-6.2-astra'), label: 'Tru · Codex · GPT-6.2 Astra' },
  ] });
  assert.deepEqual(r('GPT-6.2 Astra на Tru'), { match: { profileId: pinId(TRU_CODEX, 'gpt-6.2-astra'), label: 'Tru · Codex · GPT-6.2 Astra' } });
  assert.deepEqual(r('Codex на маке'), { match: { profileId: pinId(MAC_CODEX, null), label: 'Mac · Codex' } });
  const opus = r('Opus');
  assert.ok('candidates' in opus && opus.candidates?.length === 3, 'Opus есть на трёх машинах');
  assert.deepEqual(r('Авто Opus · без Codex'), { match: { profileId: 'auto-no-codex', label: 'Авто Opus · без Codex' } });
});

test('resolve: такой ступени нет — запасной путь со штатным провайдером и причиной', () => {
  const c = withCodex();
  const r = (text: string, cfg = c) => resolveRequest({ config: cfg, accounts: ACCOUNTS_CODEX, hosts: HOSTS, text });
  const acc = r('на аккаунте work-max');
  assert.ok('fallback' in acc);
  if (!('fallback' in acc)) return;
  assert.match(acc.fallback.reason, /аккаунт «work-max» не подключён/u);
  const win = r('Claude на Windows');
  assert.ok('fallback' in win && win.fallback.machine === 'host_win' && win.fallback.provider === 'claude-code' && /машины «Windows» нет в каскаде/u.test(win.fallback.reason));
  // Codex на Tru нет в каскаде владельца по умолчанию.
  const base = config();
  const noTru = r('Codex 6.2 на Tru', base);
  assert.ok('fallback' in noTru);
  if (!('fallback' in noTru)) return;
  assert.deepEqual([noTru.fallback.provider, noTru.fallback.machine], ['codex', TRU]);
  assert.match(noTru.fallback.reason, /нет ступени Codex на Tru/u);
  // Модели нет в таблице: штатный запуск с моделью из каталога машины, ближайшая ступень каскада.
  const sonnetMac = r('Sonnet на Mac');
  assert.ok('fallback' in sonnetMac);
  if (!('fallback' in sonnetMac)) return;
  assert.deepEqual(sonnetMac.fallback.nearest.map(n => n.profileId), [pinId(MAC_GW, null)]);
  assert.equal(sonnetMac.fallback.provider, 'claude-code');
  // Ступень выключена.
  const off = { ...c, steps: c.steps.map(s => s.id === UA_CODEX ? { ...s, enabled: false } : s) };
  const offR = r('Codex на UA', off);
  assert.ok('fallback' in offR && /выключена/u.test(offR.fallback.reason));
  // Каскад выключен; просьба без машины, CLI, аккаунта и модели.
  const disabled = { ...c, policies: { ...c.policies, executionMode: 'off' as const } };
  assert.ok('fallback' in r('Opus на UA', disabled));
  const vague = r('сделай побыстрее');
  assert.ok('fallback' in vague && vague.fallback.provider === null);
});
