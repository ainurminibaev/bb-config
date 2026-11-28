// 0.3.0: adopt --native — тред Claude Code → тред каскада с той же сессией (стенд на фейках).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACCOUNTS, NOW, TRU, config } from '../fixtures.ts';
import { claudeSessionPath, forkSessionLines, hasConversation } from '../launcher/cli-args.ts';
import { materializeSeed } from '../launcher/main.ts';
import { parseAdoptArgs } from './adopt.ts';
import { runNativeAdopt, seedFor, sessionFromEvents, type AdoptSeed, type NativeAdoptPorts, type NativeSourceThread, type SeedStore } from './adopt-native.ts';
import { createRouteService, type RouteDeps, type StoredThreadState } from './route-service.ts';
import { ok } from '../fixtures.ts';

const SRC = 'aaaaaaaa-1111-2222-3333-444444444444';
const NEW = 'bbbbbbbb-1111-2222-3333-444444444444';

function source(patch: Partial<NativeSourceThread> = {}): NativeSourceThread {
  return { id: 'thr_src', title: 'Отчёт за неделю', providerId: 'claude-code', projectId: 'proj_1', environmentId: 'env_1', parentThreadId: null, archived: false, status: 'idle', queued: 0, ...patch };
}

function ports(threads: NativeSourceThread[], extra: Partial<NativeAdoptPorts> = {}) {
  const seeds = new Map<string, AdoptSeed>();
  const spawned: Parameters<NativeAdoptPorts['spawn']>[0][] = [];
  let now = NOW;
  let reads = 0;
  const p: NativeAdoptPorts = {
    getThread: async () => threads[Math.min(reads++, threads.length - 1)] ?? null,
    sessionId: async () => SRC,
    saveSeed: async (nonce, seed) => { seeds.set(nonce, seed); },
    dropSeed: async nonce => { seeds.delete(nonce); },
    spawn: async args => { spawned.push(args); return 'thr_new'; },
    sleep: async ms => { now += ms; },
    now: () => now,
    randomId: () => '0123456789abcdef0123',
    ...extra,
  };
  return { p, seeds, spawned };
}

const OPTS = { threadId: 'thr_src', dryRun: false, model: 'auto', prompt: 'контрольные вопросы', waitSeconds: 60, providerId: 'subscriptions-cascade' };

test('adopt --native: разбор аргументов — только один тред', () => {
  assert.ok('error' in parseAdoptArgs(['--native', '--project', 'p']));
  const parsed = parseAdoptArgs(['--native', '--thread', 'thr_src', '--dry-run', '--wait', '30', '--prompt', 'вопрос']);
  assert.ok(!('error' in parsed) && parsed.native && parsed.waitSeconds === 30 && parsed.prompt === 'вопрос' && parsed.model === 'auto');
});

test('adopt --native --dry-run: план без изменений — то же окружение, сессия, профиль auto; живой тред не трогается', async () => {
  const { p, seeds, spawned } = ports([source({ status: 'active', queued: 1 })]);
  const r = await runNativeAdopt(p, { ...OPTS, dryRun: true });
  assert.equal(r.action, 'native');
  assert.equal(r.sessionId, SRC);
  assert.equal(r.environmentId, 'env_1');
  assert.match(r.reason, /каскад «auto»/u);
  assert.match(r.reason, /дождётся простоя/u);
  assert.equal(spawned.length, 0);
  assert.equal(seeds.size, 0);
});

test('adopt --native: ждёт простоя, кладёт посев, создаёт тред каскада в том же окружении с тем же названием', async () => {
  const { p, seeds, spawned } = ports([source({ status: 'active' }), source({ status: 'active' }), source()]);
  const r = await runNativeAdopt(p, OPTS);
  assert.equal(r.newThreadId, 'thr_new');
  assert.deepEqual(spawned, [{ projectId: 'proj_1', environmentId: 'env_1', parentThreadId: null, title: 'Отчёт за неделю', model: 'auto', prompt: 'контрольные вопросы', nonce: '0123456789abcdef0123' }]);
  assert.deepEqual(seeds.get('0123456789abcdef0123'), { sourceThreadId: 'thr_src', sourceSessionId: SRC, profileId: 'auto', createdAt: NOW + 10_000 });
});

test('adopt --native: отказы — не простаивает, Codex, нет сессии, нет окружения; сбой создания убирает посев', async () => {
  const busy = await runNativeAdopt(ports([source({ status: 'active' })]).p, { ...OPTS, waitSeconds: 10 });
  assert.equal(busy.action, 'skip');
  assert.match(busy.reason, /не освободился/u);
  assert.match((await runNativeAdopt(ports([source({ providerId: 'codex' })]).p, OPTS)).reason, /только для Claude Code/u);
  assert.match((await runNativeAdopt(ports([source({ environmentId: null })]).p, OPTS)).reason, /нет окружения/u);
  assert.match((await runNativeAdopt(ports([source()], { sessionId: async () => null }).p, OPTS)).reason, /нет сессии Claude/u);
  const failing = ports([source()], { spawn: async () => { throw new Error('нет прав'); } });
  const r = await runNativeAdopt(failing.p, OPTS);
  assert.equal(r.error, 'нет прав');
  assert.equal(failing.seeds.size, 0, 'посев убран');
});

test('посев: ключ из метаданных срабатывает один раз и закрепляется за тредом; чужой или старый ключ — нет', async () => {
  const pending = new Map<string, AdoptSeed>([['n1', { sourceThreadId: 'thr_src', sourceSessionId: SRC, profileId: 'auto', createdAt: NOW }]]);
  const claimed = new Map<string, AdoptSeed>();
  const store: SeedStore = {
    pending: async n => pending.get(n) ?? null,
    claim: async (n, t, s) => { claimed.set(t, s); pending.delete(n); },
    claimed: async t => claimed.get(t) ?? null,
  };
  assert.equal((await seedFor(store, 'thr_new', 'n1', NOW + 1000))?.sourceSessionId, SRC);
  assert.equal(await seedFor(store, 'thr_other', 'n1', NOW + 1000), null, 'ключ уже использован');
  assert.equal((await seedFor(store, 'thr_new', null, NOW + 1000))?.sourceSessionId, SRC, 'тред помнит свой посев');
  pending.set('old', { sourceThreadId: 'x', sourceSessionId: SRC, profileId: 'auto', createdAt: NOW });
  assert.equal(await seedFor(store, 'thr_late', 'old', NOW + 25 * 3_600_000), null, 'старше суток');
  assert.equal(sessionFromEvents([{ type: 'item/completed', data: {} }, { type: 'turn/completed', data: { providerThreadId: SRC } }]), SRC);
  assert.equal(sessionFromEvents([{ type: 'turn/completed', data: { providerThreadId: '../../etc' } }]), null);
});

test('маршрут: первый ход переведённого треда несёт seedSession; после удачного хода — больше нет', async () => {
  const store = new Map<string, StoredThreadState>();
  let asked = 0;
  const deps: RouteDeps = {
    loadConfig: async () => config(), accounts: () => ACCOUNTS, health: () => () => ok, refreshLimits: async () => {}, observeLimit: () => {},
    threadInfo: async () => ({ projectId: 'proj_1', hostId: TRU, parentThreadId: null, providerId: 'subscriptions-cascade' }),
    load: async id => store.get(id), save: async (id, s) => { store.set(id, s); }, sync: null, now: () => NOW,
    adoptSeed: async () => { asked += 1; return { sourceSessionId: SRC, sourceThreadId: 'thr_src' }; },
  };
  const routes = createRouteService(deps);
  const turn = { threadId: 'thr_new', projectId: 'proj_1', provider: 'claude-code' as const, requestedModel: 'auto', cwd: '/srv/p' };
  const r1 = await routes.routeTurn(turn);
  assert.ok(r1.action === 'run' && r1.seedSession?.sessionId === SRC);
  // Ход упал — посев остаётся на повтор.
  await routes.finishTurn({ threadId: 'thr_new', stepId: r1.action === 'run' ? r1.stepId : '', hostId: TRU, exitCode: 1, limits: [] });
  const r2 = await routes.routeTurn(turn);
  assert.ok(r2.action === 'run' && r2.seedSession?.sessionId === SRC);
  await routes.finishTurn({ threadId: 'thr_new', stepId: r2.action === 'run' ? r2.stepId : '', hostId: TRU, exitCode: 0, limits: [] });
  const r3 = await routes.routeTurn(turn);
  assert.ok(r3.action === 'run' && !r3.seedSession);
  assert.equal(asked, 1, 'метаданные спрашиваются только до первого хода');
  // Обычный тред без посева: seedSession нет.
  const plain = createRouteService({ ...deps, adoptSeed: async () => null });
  const p = await plain.routeTurn({ ...turn, threadId: 'thr_plain' });
  assert.ok(p.action === 'run' && !p.seedSession);
});

test('запускатель: копия исходной сессии под ID нового треда — поле sessionId заменено, разговор не затирается', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cascade-adopt-')));
  const cwd = join(root, 'proj');
  mkdirSync(cwd);
  const env = { CLAUDE_CONFIG_DIR: join(root, 'claude') };
  const src = claudeSessionPath(cwd, SRC, env);
  mkdirSync(join(src, '..'), { recursive: true });
  const lines = [
    { type: 'user', sessionId: SRC, uuid: 'u1', message: { content: 'решили: ветка feat/x' } },
    { type: 'assistant', sessionId: SRC, uuid: 'a1', parentUuid: 'u1', message: { content: 'ок' } },
  ];
  writeFileSync(src, `${lines.map(l => JSON.stringify(l)).join('\n')}\n{обрывок`);
  const io = { cwd, env };
  assert.equal(materializeSeed(io, { seedSession: { sessionId: SRC } }, NEW), true);
  const copy = readFileSync(claudeSessionPath(cwd, NEW, env), 'utf8').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>);
  assert.deepEqual(copy.map(l => l.sessionId), [NEW, NEW]);
  assert.deepEqual(copy.map(l => l.uuid), ['u1', 'a1'], 'цепочка сообщений та же');
  assert.equal(readFileSync(src, 'utf8').includes(NEW), false, 'исходный файл не тронут');
  // Повтор: в копии уже идёт разговор — не перезаписывается.
  writeFileSync(claudeSessionPath(cwd, NEW, env), `${JSON.stringify({ type: 'user', sessionId: NEW, message: { content: 'новый ход' } })}\n`);
  assert.equal(materializeSeed(io, { seedSession: { sessionId: SRC } }, NEW), false);
  assert.match(readFileSync(claudeSessionPath(cwd, NEW, env), 'utf8'), /новый ход/u);
  // Без посева или без исходного файла — ничего.
  assert.equal(materializeSeed(io, {}, NEW), false);
  assert.equal(materializeSeed(io, { seedSession: { sessionId: 'cccccccc-0000-0000-0000-000000000000' } }, 'dddddddd-0000-0000-0000-000000000000'), false);
  assert.equal(hasConversation('{"type":"summary"}'), false);
  assert.equal(forkSessionLines('', SRC, NEW), '');
});

test('реле: первый ход переведённого треда — посев до запуска CLI ступени, затем --resume', async () => {
  const { runSessionRelay } = await import('../launcher/session-relay.ts');
  const { PassThrough } = await import('node:stream');
  type Route = { action: 'run'; stepId: string; hostId: string; providerId: string; modelId: string | null; local: boolean; cwd: string | null; env: Record<string, string>; stage: { machine: string }; notes: never[]; seedSession?: { sessionId: string } | null };
  const turn: Route = { action: 'run', stepId: 's', hostId: TRU, providerId: 'claude-code', modelId: null, local: true, cwd: null, env: {}, stage: { machine: 'Tru' }, notes: [], seedSession: { sessionId: SRC } };
  let seeded = false;
  const started: string[][] = [];
  const stdin = new PassThrough();
  const relay = runSessionRelay({ ...turn, stepId: '', seedSession: null }, ['--input-format', 'stream-json', `--session-id=${NEW}`], NEW, {
    start(_r, args, onLine) {
      started.push(args);
      let resolveDone!: (v: { code: number; transportError: null }) => void;
      const done = new Promise<{ code: number; transportError: null }>(r => { resolveDone = r; });
      return { write(line) { if ((JSON.parse(line) as { type: string }).type === 'user') setTimeout(() => onLine('{"type":"result"}'), 5); }, end() { resolveDone({ code: 0, transportError: null }); }, kill() {}, done };
    },
    prepareSession: r => { if (r.seedSession) seeded = true; },
    sessionExists: () => seeded,
    routeTurn: async () => turn,
    finishTurn: async () => {}, feed: async () => {}, limitFromLine: () => null,
    stdin, stdout: { write() {} }, stderr: { write() {} }, now: Date.now, log() {},
  }, { routeFirst: true });
  stdin.write('{"type":"user","message":{"content":"контрольный вопрос"}}\n');
  await new Promise(r => setTimeout(r, 40));
  stdin.end();
  assert.equal(await relay, 0);
  assert.ok(started[0]!.includes(`--session-id=${NEW}`), 'начало сессии — без продолжения');
  assert.ok(started[1]!.includes(`--resume=${NEW}`), 'ход — продолжение копии');
});
