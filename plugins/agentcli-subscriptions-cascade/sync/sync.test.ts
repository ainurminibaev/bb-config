// Синхронизация: оркестратор на фейковом Mutagen, разбор JSON, шаги мастера,
// хост-операции на временных папках.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeMutagen } from './fake-mutagen.ts';
import { chmodFiles, ensureBindMount, envModes, gitLocks, ignoreMatcher, parseMountPoints, prepareBeta, quarantine, removeGitFiles, safeRel, writeSnapshot } from './host-ops.ts';
import { createArgs, evaluateHealth, labelValue, onlyGitIndexConflict, parseSessionList, sessionName } from './mutagen.ts';
import { projectSlug, SyncOrchestrator, type ProjectSyncState, type SyncProjectContext } from './orchestrator.ts';
import { mutagenInstallScript, setupPlan } from './setup.ts';
import { buildContext, folderIn, projectSourceOn, syncModeOf } from './service.ts';
import { summaryLine, timingLines } from './lines.ts';
import { configSchema } from '../contract.ts';

const TRU = 'host_tru';
const MAC = 'host_mac';
const UA = 'host_ua';

function context(overrides: Partial<SyncProjectContext> = {}): SyncProjectContext {
  return {
    projectId: 'proj_1', slug: 'app', anchorRealPath: '/srv/projects/app',
    anchor: { hostId: TRU, label: 'Tru', sharedPath: '/opt/bbfs', platform: 'linux' },
    executors: [
      { hostId: MAC, label: 'Mac', sharedPath: '/opt/bbfs', platform: 'macos' },
      { hostId: UA, label: 'UA', sharedPath: '/opt/bbfs', platform: 'linux' },
    ],
    mode: 'lazy', ignores: ['node_modules', 'dist'],
    anchorSsh: () => 'tru',
    ...overrides,
  };
}

function setup(ctx: Partial<SyncProjectContext> = {}) {
  const fake = new FakeMutagen();
  const states = new Map<string, ProjectSyncState>();
  let current = context(ctx);
  let now = 1_000_000;
  const sync = new SyncOrchestrator({
    call: fake.call,
    store: { get: async id => structuredClone(states.get(id)), set: async (id, s) => { states.set(id, structuredClone(s)); } },
    context: async () => current,
    now: () => now,
    sleep: async ms => { now += ms; },
    gitWaitMs: 3_000,
  });
  return { fake, sync, states, setContext: (c: Partial<SyncProjectContext>) => { current = context(c); }, tick: (ms: number) => { now += ms; } };
}

/** Журнал без имён: `bbc-…-w` → W, `bbc-…-r` → R. */
const steps = (log: string[]) => log.map(line => line.replace(/bbc-[0-9a-f]+-[0-9a-f]+-([wr])/g, (_, r: string) => r.toUpperCase()).replace(/ \{\{json \.\}\}/, ''));
const T = { threadId: 'thr_a', projectId: 'proj_1' };
const T2 = { threadId: 'thr_b', projectId: 'proj_1' };

test('первый ход на Mac: mount, создание R и W на паузе, выравнивание, W открыт', async () => {
  const { fake, sync, states } = setup();
  fake.envFiles = [{ path: '.env', mode: 0o600 }, { path: 'pkg/.env.local', mode: 0o644 }];
  const result = await sync.prepareTurn(T, { hostId: MAC });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.ok && result.cwd, '/opt/bbfs/app');
  assert.deepEqual(steps(fake.log), [
    'host_tru: syncEnsureBindMount',
    'host_mac: mutagen list',
    'host_mac: syncPrepareBeta',
    'host_mac: mutagen create R',
    'host_mac: mutagen create W',
    'host_tru: syncEnvModes',
    'host_mac: mutagen resume R', 'host_mac: mutagen flush R', 'host_mac: mutagen list', 'host_mac: mutagen pause R',
    'host_mac: mutagen resume W', 'host_mac: mutagen flush W', 'host_mac: mutagen list',
  ]);
  assert.equal(fake.session(MAC, 'w')!.paused, false);
  assert.equal(fake.session(MAC, 'r')!.paused, true);
  assert.equal(fake.session(MAC, 'w')!.mode, 'two-way-safe');
  assert.equal(fake.session(MAC, 'r')!.mode, 'one-way-replica');
  assert.deepEqual(states.get('proj_1')!.writer, { hostId: MAC, threadId: 'thr_a', since: 1_000_000, env600: ['.env'], threads: { thr_a: 1_000_000 }, root: '/opt/bbfs/app', label: 'Mac' });
  const align = result.timings.find(t => t.step === 'align')!;
  assert.deepEqual([align.from, align.to, align.ok], [TRU, MAC, true]);
  assert.ok(result.timings.every(t => typeof t.seconds === 'number'));
});

test('конец хода Mac: flush, lock, проверка, 0600 для .env, pause W, снимок; R остаётся на паузе', async () => {
  const { fake, sync, states } = setup();
  fake.envFiles = [{ path: '.env', mode: 0o600 }];
  await sync.prepareTurn(T, { hostId: MAC });
  fake.log.length = 0;
  const result = await sync.finishTurn(T, { hostId: MAC });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(steps(fake.log), [
    'host_mac: mutagen flush W', 'host_mac: syncGitLocks', 'host_mac: mutagen list',
    'host_tru: syncChmod .env', 'host_mac: mutagen pause W', 'host_mac: syncSnapshot',
  ]);
  assert.equal(states.get('proj_1')!.writer, null);
  assert.equal(fake.session(MAC, 'w')!.paused, true);
  const flush = result.timings.find(t => t.step === 'flush')!;
  assert.deepEqual([flush.from, flush.to], [MAC, TRU]);
});

test('второй ход «Ленивый»: сессии не пересоздаются, сначала карантин опоздавших записей', async () => {
  const { fake, sync } = setup();
  await sync.prepareTurn(T, { hostId: MAC });
  await sync.finishTurn(T, { hostId: MAC });
  fake.log.length = 0;
  fake.quarantineResult = { changed: 2, deleted: 1, dir: '/home/user/bbfs-quarantine/app/t', hadSnapshot: true };
  const result = await sync.prepareTurn(T, { hostId: MAC });
  assert.equal(result.ok, true);
  const s = steps(fake.log);
  assert.ok(!s.some(l => l.includes('create')));
  assert.ok(s.indexOf('host_mac: syncQuarantine') < s.indexOf('host_mac: mutagen resume R'));
  assert.match(result.notices.join('\n'), /Отложено файлов Mac: 2 изменённых, 1 удалённых/);
});

test('«Тёплый»: R работает между ходами, карантина нет', async () => {
  const { fake, sync } = setup({ mode: 'warm' });
  await sync.prepareTurn(T, { hostId: MAC });
  await sync.finishTurn(T, { hostId: MAC });
  assert.equal(fake.session(MAC, 'r')!.paused, false);
  assert.equal(steps(fake.log).at(-1), 'host_mac: mutagen resume R');
  fake.log.length = 0;
  await sync.prepareTurn(T, { hostId: MAC });
  assert.ok(!fake.log.some(l => l.includes('syncQuarantine')));
  assert.equal(fake.session(MAC, 'r')!.paused, true);
});

test('конфликт при передаче хода: отказ, W не на паузе, писатель остаётся; следующий ход снова отказ', async () => {
  const { fake, sync, states } = setup();
  await sync.prepareTurn(T, { hostId: MAC });
  fake.conflictsAfterFlush = ['src/a.ts'];
  const result = await sync.finishTurn(T, { hostId: MAC });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, 'conflict');
  assert.deepEqual(!result.ok && result.conflicts, ['src/a.ts']);
  assert.equal(fake.session(MAC, 'w')!.paused, false);
  assert.equal(states.get('proj_1')!.writer?.hostId, MAC);
  const next = await sync.prepareTurn(T, { hostId: TRU });
  assert.equal(!next.ok && next.reason, 'conflict');
  // После ручного разрешения ход переходит.
  fake.session(MAC, 'w')!.conflicts = [];
  const again = await sync.prepareTurn(T, { hostId: TRU });
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(states.get('proj_1')!.writer, null);
});

test('конфликт только в .git/index — решается в пользу пишущей машины', async () => {
  const { fake, sync } = setup();
  await sync.prepareTurn(T, { hostId: MAC });
  fake.conflictsAfterFlush = ['.git/index'];
  fake.log.length = 0;
  const result = await sync.finishTurn(T, { hostId: MAC });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(steps(fake.log).includes('host_tru: syncRemoveGitFiles .git/index'));
  assert.match(result.notices.join(), /\.git\/index решён в пользу Mac/);
});

test('застрявший index.lock без живого git снимается, с живым git — отказ git-busy', async () => {
  const a = setup();
  await a.sync.prepareTurn(T, { hostId: MAC });
  a.fake.gitLocks = [{ locks: ['.git/index.lock'], gitRunning: false }];
  a.fake.log.length = 0;
  const ok = await a.sync.finishTurn(T, { hostId: MAC });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const s = steps(a.fake.log);
  assert.ok(s.includes('host_mac: syncRemoveGitFiles .git/index.lock'));
  assert.equal(s.filter(l => l === 'host_mac: mutagen flush W').length, 2);

  const b = setup();
  await b.sync.prepareTurn(T, { hostId: MAC });
  b.fake.gitLocks = [{ locks: ['.git/index.lock'], gitRunning: true }];
  const busy = await b.sync.finishTurn(T, { hostId: MAC });
  assert.equal(!busy.ok && busy.reason, 'git-busy');
});

test('писатель на исполнителе: другая машина ждёт, опора не блокируется (two-way-safe), брошенный ход истекает', async () => {
  const { sync, tick, states } = setup();
  assert.equal((await sync.prepareTurn(T, { hostId: MAC })).ok, true);
  const onAnchor = await sync.prepareTurn(T2, { hostId: TRU });
  assert.equal(onAnchor.ok, true, 'ход на опоре при писателе на Mac идёт (0.3.0)');
  assert.ok(onAnchor.notices.some(n => /пишут рабочую папку одновременно/u.test(n)), onAnchor.notices.join('\n'));
  assert.equal(states.get('proj_1')!.writer!.threadId, T.threadId, 'писатель на Mac остаётся');
  const onUa = await sync.prepareTurn({ ...T2, threadId: 'thr_c' }, { hostId: UA });
  assert.equal(!onUa.ok && onUa.reason, 'busy', 'третья машина ждёт');
  await sync.finishTurn(T, { hostId: MAC });
  // Ход на опоре идёт — исполнитель тоже не ждёт: выравнивание по опоре, дальше two-way-safe.
  const macWhileAnchor = await sync.prepareTurn(T, { hostId: MAC });
  assert.equal(macWhileAnchor.ok, true);
  assert.ok(macWhileAnchor.notices.some(n => /пишут рабочую папку одновременно/u.test(n)));
  tick(7 * 3600_000);
  assert.equal((await sync.prepareTurn({ ...T2, threadId: 'thr_c' }, { hostId: UA })).ok, true, 'брошенный писатель Mac истёк');
});

test('0.3.0 п.9: два треда одной папки на одной машине пишут вместе; ждёт только писатель с другой машины', async () => {
  const { fake, sync, states } = setup();
  assert.equal((await sync.prepareTurn(T, { hostId: MAC })).ok, true);
  const second = await sync.prepareTurn(T2, { hostId: MAC });
  assert.equal(second.ok, true, second.ok ? '' : second.message);
  assert.ok(second.ok && second.cwd === (await sync.prepareTurn(T2, { hostId: MAC }).then(r => r.ok ? r.cwd : null)), 'та же реплика');
  assert.deepEqual(Object.keys(states.get('proj_1')!.writer!.threads!).sort(), [T.threadId, T2.threadId].sort());
  const fromUa = await sync.prepareTurn({ ...T2, threadId: 'thr_c' }, { hostId: UA });
  assert.equal(!fromUa.ok && fromUa.reason, 'busy', 'другая машина ждёт');
  const onAnchor = await sync.prepareTurn({ ...T2, threadId: 'thr_c' }, { hostId: TRU });
  assert.equal(onAnchor.ok, true, 'ход на опоре не блокируется');
  await sync.finishTurn({ ...T2, threadId: 'thr_c' }, { hostId: TRU });
  // Первый закончил — реплика открыта для второго, блокировка за ним.
  assert.equal((await sync.finishTurn(T, { hostId: MAC })).ok, true);
  assert.equal(fake.session(MAC, 'w')!.paused, false, 'W идёт, пока пишет второй');
  assert.equal(states.get('proj_1')!.writer!.threadId, T2.threadId);
  // Последний закончил — обычное освобождение.
  assert.equal((await sync.finishTurn(T2, { hostId: MAC })).ok, true);
  assert.equal(fake.session(MAC, 'w')!.paused, true);
  assert.equal(states.get('proj_1')!.writer, null);
  assert.equal((await sync.prepareTurn({ ...T2, threadId: 'thr_c' }, { hostId: UA })).ok, true, 'теперь UA входит');
});

test('0.3.0 п.9: два треда на Mac параллельно — второй без выравнивания и карантина, правки обоих доходят до Tru', async () => {
  const { fake, sync } = setup();
  await sync.prepareTurn(T, { hostId: MAC });
  await sync.finishTurn(T, { hostId: MAC });
  // Второй ход A (lazy): первый писатель делает карантин и выравнивание.
  fake.log.length = 0;
  assert.equal((await sync.prepareTurn(T, { hostId: MAC })).ok, true);
  const first = steps(fake.log);
  assert.ok(first.some(l => /syncQuarantine/u.test(l)) && first.some(l => /flush R/u.test(l)), first.join('\n'));
  fake.log.length = 0;
  const b = await sync.prepareTurn(T2, { hostId: MAC });
  assert.equal(b.ok, true);
  const join = steps(fake.log);
  assert.ok(!join.some(l => /syncQuarantine|flush R|resume R/u.test(l)), `второй — без карантина и выравнивания:\n${join.join('\n')}`);
  assert.ok(join.some(l => /flush W/u.test(l)), 'только flush W');
  // Конец хода A: flush W на опору, без паузы и снимка; конец B — пауза и снимок.
  fake.log.length = 0;
  const doneA = await sync.finishTurn(T, { hostId: MAC });
  assert.ok(doneA.ok && doneA.timings.some(t => t.step === 'flush' && t.from === MAC && t.to === TRU), 'правки A — на Tru');
  assert.ok(!steps(fake.log).some(l => /pause W|syncSnapshot/u.test(l)), steps(fake.log).join('\n'));
  fake.log.length = 0;
  const doneB = await sync.finishTurn(T2, { hostId: MAC });
  assert.ok(doneB.ok && doneB.timings.some(t => t.step === 'flush' && t.from === MAC && t.to === TRU), 'правки B — на Tru');
  assert.ok(steps(fake.log).some(l => /pause W/u.test(l)) && steps(fake.log).some(l => /syncSnapshot/u.test(l)));
});

test('0.3.0 п.9: один из двух писателей упал — конец хода второго освобождает реплику, счётчик не залипает', async () => {
  const fake = new FakeMutagen();
  const states = new Map<string, ProjectSyncState>();
  let aliveA = true;
  const sync = new SyncOrchestrator({
    call: fake.call, context: async () => context(),
    store: { get: async id => structuredClone(states.get(id)), set: async (id, st) => { states.set(id, structuredClone(st)); } },
    now: () => 1_000_000, sleep: async () => {}, gitWaitMs: 0,
    threadActive: async id => (id === 'thr_a' ? aliveA : true),
  });
  await sync.prepareTurn(T, { hostId: MAC });
  await sync.prepareTurn(T2, { hostId: MAC });
  aliveA = false; // A упал посреди хода
  assert.equal((await sync.finishTurn(T2, { hostId: MAC })).ok, true);
  assert.equal(states.get('proj_1')!.writer, null, 'блокировка снята');
  assert.equal(fake.session(MAC, 'w')!.paused, true);
  assert.equal((await sync.prepareTurn({ ...T2, threadId: 'thr_c' }, { hostId: UA })).ok, true, 'другая машина входит сразу');
});

test('0.3.1 п.12: писатель на машине, убранной из каскада, — ход сам закрывает его выход (flush до опоры, пауза) и идёт', async () => {
  const fake = new FakeMutagen();
  const states = new Map<string, ProjectSyncState>();
  let ctx = context();
  let aliveA = true;
  const sync = new SyncOrchestrator({
    call: fake.call, context: async () => ctx,
    store: { get: async id => structuredClone(states.get(id)), set: async (id, st) => { states.set(id, structuredClone(st)); } },
    now: () => 1_000_000, sleep: async () => {}, gitWaitMs: 0, threadActive: async id => (id === 'thr_a' ? aliveA : true),
  });
  assert.equal((await sync.prepareTurn(T, { hostId: MAC })).ok, true);
  // Mac убрали из каскада (в настройках его больше нет): ход A там ещё идёт — ждём его.
  ctx = context({ executors: [{ hostId: UA, label: 'UA', sharedPath: '/opt/bbfs', platform: 'linux' }] });
  const wait = await sync.prepareTurn(T2, { hostId: UA });
  assert.ok(!wait.ok && /^Жду: последние правки на Mac ещё не вернулись/u.test(wait.message));
  aliveA = false; // ход A закончился
  fake.log.length = 0;
  const r = await sync.prepareTurn(T2, { hostId: UA });
  assert.equal(r.ok, true, r.ok ? '' : r.message);
  const log = steps(fake.log);
  const flushMac = log.findIndex(l => l.startsWith(`${MAC}:`) && /flush W/u.test(l));
  const pauseMac = log.findIndex(l => l.startsWith(`${MAC}:`) && /pause W/u.test(l));
  const firstUa = log.findIndex(l => l.startsWith(`${UA}:`));
  assert.ok(flushMac !== -1 && pauseMac > flushMac && firstUa > pauseMac, `сначала выход писателя Mac, потом ход на UA:\n${log.join('\n')}`);
  assert.equal(states.get('proj_1')!.writer!.hostId, UA);
});

test('0.3.1 п.12: конец хода самого писателя после того, как его машину убрали, — обычный выход, без отказа', async () => {
  const { sync, states, setContext } = setup();
  await sync.prepareTurn(T, { hostId: MAC });
  setContext({ executors: [{ hostId: UA, label: 'UA', sharedPath: '/opt/bbfs', platform: 'linux' }] });
  const done = await sync.finishTurn(T, { hostId: MAC });
  assert.equal(done.ok, true, done.ok ? '' : done.message);
  assert.ok(done.timings.some(t => t.step === 'flush' && t.from === MAC && t.to === TRU));
  assert.equal(states.get('proj_1')!.writer, null);
});

test('0.3.1 п.12: выбывшая машина недоступна — ждём со строкой, потом снимаем блокировку и пишем, где могли остаться правки', async () => {
  const fake = new FakeMutagen();
  const states = new Map<string, ProjectSyncState>();
  let now = 1_000_000;
  let ctx = context();
  const call: typeof fake.call = (hostId, method, input) => (hostId === MAC && !ctx.executors.some(m => m.hostId === MAC) ? Promise.reject(new Error('host offline')) : fake.call(hostId, method, input));
  const sync = new SyncOrchestrator({
    call, context: async () => ctx,
    store: { get: async id => structuredClone(states.get(id)), set: async (id, st) => { states.set(id, structuredClone(st)); } },
    now: () => now, sleep: async () => {}, gitWaitMs: 0, retiredWaitMs: 5 * 60_000,
  });
  await sync.prepareTurn(T, { hostId: MAC });
  ctx = context({ executors: [{ hostId: UA, label: 'UA', sharedPath: '/opt/bbfs', platform: 'linux' }], retired: [{ hostId: MAC, label: 'Mac', sharedPath: '/opt/bbfs', platform: 'macos' }] });
  const waiting = await sync.prepareTurn(T2, { hostId: UA });
  assert.ok(!waiting.ok && waiting.reason === 'busy' && /^Жду: последние правки на Mac ещё не вернулись/u.test(waiting.message), JSON.stringify(waiting));
  now += 6 * 60_000;
  const taken = await sync.prepareTurn(T2, { hostId: UA });
  assert.equal(taken.ok, true, taken.ok ? '' : taken.message);
  assert.ok(taken.notices.some(n => /правки, возможно, остались на Mac в \/opt\/bbfs\/app/u.test(n)), taken.notices.join('\n'));
  assert.equal(states.get('proj_1')!.writer!.hostId, UA);
});

test('свой незакрытый ход закрывается перед следующим (ход перешёл Mac → UA)', async () => {
  const { fake, sync, states } = setup();
  await sync.prepareTurn(T, { hostId: MAC });
  const result = await sync.prepareTurn(T, { hostId: UA });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(fake.session(MAC, 'w')!.paused, true);
  assert.equal(fake.session(UA, 'w')!.paused, false);
  assert.equal(states.get('proj_1')!.writer?.hostId, UA);
});

test('«Выключено»: на исполнителе отказ, на опоре ход идёт; applyMode убирает сессии', async () => {
  const { fake, sync, setContext } = setup();
  await sync.prepareTurn(T, { hostId: MAC });
  await sync.finishTurn(T, { hostId: MAC });
  setContext({ mode: 'off' });
  const remote = await sync.prepareTurn(T, { hostId: MAC });
  assert.equal(!remote.ok && remote.reason, 'sync-off');
  assert.equal((await sync.prepareTurn(T, { hostId: TRU })).ok, true);
  await sync.finishTurn(T, { hostId: TRU });
  assert.equal((await sync.applyMode('proj_1')).ok, true);
  assert.equal(fake.session(MAC, 'w'), undefined);
});

test('смена исключений пересоздаёт сессии; без SSH — not-configured; Windows — unsupported', async () => {
  const { fake, sync, setContext } = setup();
  await sync.prepareTurn(T, { hostId: MAC });
  await sync.finishTurn(T, { hostId: MAC });
  setContext({ ignores: ['node_modules'] });
  fake.log.length = 0;
  fake.prepareBetaResult = { created: false, movedTo: null };
  assert.equal((await sync.prepareTurn(T, { hostId: MAC })).ok, true);
  const s = steps(fake.log);
  assert.deepEqual(s.filter(l => /terminate|create/.test(l)), ['host_mac: mutagen terminate R', 'host_mac: mutagen terminate W', 'host_mac: mutagen create R', 'host_mac: mutagen create W']);
  // Папка уже знакомая (снимок есть) — карантин всё равно выполняется.
  assert.ok(s.includes('host_mac: syncQuarantine'));
  await sync.finishTurn(T, { hostId: MAC });

  setContext({ anchorSsh: () => null });
  const noSsh = await sync.prepareTurn(T, { hostId: MAC });
  assert.equal(!noSsh.ok && noSsh.reason, 'not-configured');
  setContext({ executors: [{ hostId: MAC, label: 'Win', sharedPath: 'C:\\bbfs', platform: 'windows', pathTranslation: true }] });
  const win = await sync.prepareTurn(T, { hostId: MAC });
  assert.equal(!win.ok && win.reason, 'unsupported');
});

test('статус scanning сразу после flush — перечитываем, ход не отклоняется', async () => {
  const { fake, sync } = setup();
  await sync.prepareTurn(T, { hostId: MAC });
  fake.scanningLists = 2;
  const result = await sync.finishTurn(T, { hostId: MAC });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal((await sync.prepareTurn(T, { hostId: MAC })).ok, true);
  fake.scanningLists = 100;
  const stuck = await sync.finishTurn(T, { hostId: MAC });
  assert.equal(!stuck.ok && stuck.reason, 'error');
  assert.match(!stuck.ok ? stuck.message : '', /статус scanning/);
});

test('ошибка команды Mutagen — отказ error с текстом, а не исключение', async () => {
  const { fake, sync } = setup();
  fake.failCommand = 'resume';
  const result = await sync.prepareTurn(T, { hostId: MAC });
  assert.equal(!result.ok && result.reason, 'error');
  assert.match(!result.ok ? result.message : '', /fake resume failed/);
  assert.equal(result.timings.find(t => t.step === 'align')?.ok, false);
});

// ---- mutagen.ts ----

const LIST_JSON = JSON.stringify([{
  identifier: 'sync_x', name: 'bbc-1-2-w', labels: { bbcascade: '1', 'bbc-role': 'w' }, status: 'watching', paused: false,
  alpha: { protocol: 'ssh', connected: true, scanProblems: [{ path: 'abs', error: 'invalid symbolic link: target is absolute' }] },
  beta: { protocol: 'local', connected: true, transitionProblems: [{ path: 'Readme.md', error: 'file exists' }] },
  conflicts: [{ root: 'same.txt', alphaChanges: [{ path: 'same.txt' }], betaChanges: [{ path: 'same.txt' }] }],
  futureField: { anything: true },
}]);

test('разбор sync list: конфликты, проблемы сканирования и записи, неизвестные поля пропускаются', () => {
  const [s] = parseSessionList(LIST_JSON);
  assert.equal(s!.name, 'bbc-1-2-w');
  assert.deepEqual(s!.conflicts, ['same.txt']);
  const health = evaluateHealth(s);
  assert.equal(health.ok, false);
  assert.match(health.reasons.join('\n'), /конфликты: same.txt/);
  assert.match(health.warnings.join('\n'), /опора: не синхронизировано путей — 1 \(abs: invalid symbolic link/);
  assert.doesNotMatch(health.reasons.join('\n'), /сканирования/u, 'ошибка сканирования хода не блокирует');
  assert.match(health.reasons.join('\n'), /исполнитель: ошибки записи \(Readme.md: file exists/);
  assert.deepEqual(parseSessionList(''), []);
  assert.throws(() => parseSessionList('Error: daemon'), /не JSON/);
  assert.equal(evaluateHealth(undefined).ok, false);
  const clean = { ...s!, conflicts: [], alpha: { ...s!.alpha, scanProblems: [] }, beta: { ...s!.beta, transitionProblems: [] } };
  assert.equal(evaluateHealth(clean).ok, true);
  assert.equal(onlyGitIndexConflict(evaluateHealth({ ...clean, conflicts: ['.git/index'] })), true);
  assert.equal(onlyGitIndexConflict(evaluateHealth({ ...clean, conflicts: ['.git/index', 'a'] })), false);
});

test('аргументы create: .git синхронизируется, права 0644/0755, portable, на паузе, исключения', () => {
  const args = createArgs({ projectId: 'proj_1', hostId: MAC, role: 'w', alpha: 'tru:/opt/bbfs/app', beta: '/opt/bbfs/app', ignores: ['node_modules', '.env.*'] });
  assert.ok(args.includes('--no-ignore-vcs') && !args.includes('--ignore-vcs'));
  for (const flag of ['--default-file-mode=0644', '--default-directory-mode=0755', '--symlink-mode=posix-raw', '--paused', '--no-global-configuration']) assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf('--mode') + 1], 'two-way-safe');
  assert.deepEqual(args.slice(-2), ['tru:/opt/bbfs/app', '/opt/bbfs/app']);
  assert.ok(args.join(' ').includes('--ignore node_modules --ignore .env.*'));
  assert.match(sessionName('proj_1', MAC, 'r'), /^bbc-[0-9a-f]{10}-[0-9a-f]{6}-r$/);
  assert.equal(labelValue('proj_sample'), 'proj_sample');
  assert.match(labelValue('проект'), /^x[0-9a-f]{12}$/);
  assert.equal(projectSlug('Мой Проект', 'proj_1'), 'proj_1');
  assert.equal(projectSlug('Cascade Sync Test', 'proj_1'), 'cascade-sync-test');
});

// ---- setup.ts ----

test('мастер: Mac — окно пароля и Mutagen из архива с SHA-256; опора Linux — /usr/local и проверка bind mount', () => {
  const mac = setupPlan({ sharedPath: '/opt/bbfs', anchor: false }, { platform: 'macos', isRoot: false })!;
  assert.deepEqual(mac.map(s => s.id), ['probe', 'folder', 'mutagen', 'ssh', 'verify']);
  assert.equal(mac[1]!.privilege, 'macos-dialog');
  assert.match(mac[2]!.apply!, /6f810416d9e5fc4fd5e18431146f8b3c5a2056ba5a24f76c1e66da86eb3257e2/);
  assert.match(mac[2]!.apply!, /\$HOME\/\.local/);
  assert.doesNotMatch(mac[2]!.apply!, /brew/);
  const tru = setupPlan({ sharedPath: '/opt/bbfs', anchor: true }, { platform: 'linux', isRoot: true })!;
  assert.equal(tru[1]!.apply, "mkdir -p '/opt/bbfs'");
  assert.match(tru[2]!.apply!, /p=\/usr\/local/);
  assert.match(tru[2]!.check!, /^for b in .*"\$m" version/u);
  assert.match(tru[3]!.check!, /command -v mount/);
  const ua = setupPlan({ sharedPath: '/opt/bbfs', anchor: false }, { platform: 'linux', isRoot: false })!;
  assert.equal(ua[1]!.privilege, 'manual');
  assert.match(ua[2]!.apply!, /\$HOME\/\.local/);
  assert.equal(setupPlan({ sharedPath: 'C:\\bbfs', anchor: false }, { platform: 'windows', isRoot: false }), null);
  assert.equal(setupPlan({ sharedPath: "/opt/b'b", anchor: false }, { platform: 'linux', isRoot: true })![1]!.privilege, 'manual');
  // Скрипты синтаксически верны для sh.
  for (const step of [...mac, ...tru, ...ua]) for (const script of [step.check, step.apply]) if (script) execFileSync('/bin/sh', ['-n', '-c', script]);
  assert.match(mutagenInstallScript('/usr/local'), /Linux-aarch64\|Linux-arm64\) f=mutagen_linux_arm64/);
});

// ---- host-ops.ts на временных папках ----

async function tempTree() {
  const dir = await mkdtemp(join(tmpdir(), 'bbc-sync-test-'));
  const root = join(dir, 'proj');
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'node_modules/x'), { recursive: true });
  await mkdir(join(root, '.git/refs'), { recursive: true });
  await writeFile(join(root, 'src/a.ts'), 'a');
  await writeFile(join(root, 'src/b.ts'), 'b');
  await writeFile(join(root, 'node_modules/x/i.js'), 'i');
  await writeFile(join(root, '.env'), 'S=1');
  await chmod(join(root, '.env'), 0o600);
  await writeFile(join(root, 'src/.env.local'), 'L=1');
  await writeFile(join(root, '.git/HEAD'), 'ref');
  await symlink('src/a.ts', join(root, 'link'));
  return { dir, root, data: join(dir, 'data'), qbase: join(dir, 'q') };
}

test('исключения: имя на любой глубине, путь от корня, glob', () => {
  const ignored = ignoreMatcher(['node_modules', '/dist', '.env.*', '!keep', 'build/out']);
  assert.ok(ignored('node_modules'));
  assert.ok(ignored('pkg/node_modules'));
  assert.ok(ignored('dist'));
  assert.ok(!ignored('pkg/dist'));
  assert.ok(ignored('pkg/.env.local'));
  assert.ok(!ignored('.env'));
  assert.ok(ignored('build/out'));
  assert.equal(safeRel('../x'), null);
  assert.equal(safeRel('/etc/passwd'), null);
  assert.equal(safeRel('a/../b'), 'b');
});

test('снимок и карантин: опоздавшая правка, новый файл и удаление уходят в карантин, дерево не меняется', async () => {
  const t = await tempTree();
  try {
    const snap = await writeSnapshot(t.data, t.root, 'k', ['node_modules']);
    assert.equal(snap.entries, 6);
    const none = await quarantine(t.data, t.root, 'k', ['node_modules'], t.qbase);
    assert.deepEqual([none.changed, none.deleted, none.dir], [0, 0, null]);
    await writeFile(join(t.root, 'src/a.ts'), 'late write');
    await utimes(join(t.root, 'src/a.ts'), new Date(), new Date(Date.now() + 5_000));
    await writeFile(join(t.root, 'src/new.ts'), 'new');
    await rm(join(t.root, 'src/b.ts'));
    await writeFile(join(t.root, 'node_modules/x/i.js'), 'ignored change');
    const q = await quarantine(t.data, t.root, 'k', ['node_modules'], t.qbase);
    assert.deepEqual([q.changed, q.deleted, q.hadSnapshot], [2, 1, true]);
    assert.equal(await readFile(join(q.dir!, 'src/a.ts'), 'utf8'), 'late write');
    assert.equal(await readFile(join(q.dir!, 'src/new.ts'), 'utf8'), 'new');
    assert.equal((await readFile(join(q.dir!, '_deleted.txt'), 'utf8')).trim(), 'src/b.ts');
    assert.equal(await readFile(join(t.root, 'src/a.ts'), 'utf8'), 'late write');
    const missing = await quarantine(t.data, t.root, 'other', [], t.qbase);
    assert.equal(missing.hadSnapshot, false);
  } finally { await rm(t.dir, { recursive: true, force: true }); }
});

test('prepareBeta: пустая папка создаётся, чужое содержимое без снимка — в карантин целиком', async () => {
  const t = await tempTree();
  try {
    const fresh = await prepareBeta(t.data, join(t.dir, 'new'), 'n', t.qbase);
    assert.deepEqual(fresh, { created: true, movedTo: null });
    const moved = await prepareBeta(t.data, t.root, 'k', t.qbase);
    assert.ok(moved.movedTo?.endsWith('-preexisting'));
    assert.deepEqual(await readdir(t.root), []);
    assert.equal(await readFile(join(moved.movedTo!, 'src/a.ts'), 'utf8'), 'a');
    await writeFile(join(t.root, 'x'), 'x');
    await writeSnapshot(t.data, t.root, 'k', []);
    assert.deepEqual(await prepareBeta(t.data, t.root, 'k', t.qbase), { created: false, movedTo: null });
  } finally { await rm(t.dir, { recursive: true, force: true }); }
});

test('.env: права читаются, 0600 возвращается только файлам внутри корня', async () => {
  const t = await tempTree();
  try {
    const { files } = await envModes(t.root, ['node_modules']);
    assert.deepEqual(files.map(f => [f.path, f.mode]).sort(), [['.env', 0o600], ['src/.env.local', 0o644]]);
    await chmod(join(t.root, '.env'), 0o644);
    const out = await chmodFiles(t.root, ['.env', '../escape', 'missing'], 0o600);
    assert.deepEqual(out.changed, ['.env']);
    assert.equal((await stat(join(t.root, '.env'))).mode & 0o777, 0o600);
  } finally { await rm(t.dir, { recursive: true, force: true }); }
});

test('git: lock-файлы находятся, удаляются только внутри .git', async () => {
  const t = await tempTree();
  try {
    await writeFile(join(t.root, '.git/index.lock'), '');
    await writeFile(join(t.root, '.git/refs/main.lock'), '');
    const found = await gitLocks(t.root);
    assert.deepEqual(found.locks, ['.git/index.lock', '.git/refs/main.lock']);
    assert.equal(found.gitRunning, false);
    const removed = await removeGitFiles(t.root, ['.git/index.lock', 'src/a.ts', '.git/../src/b.ts']);
    assert.deepEqual(removed.removed, ['.git/index.lock']);
    assert.equal(await readFile(join(t.root, 'src/a.ts'), 'utf8'), 'a');
  } finally { await rm(t.dir, { recursive: true, force: true }); }
});

test('bind mount: тот же путь, разбор mountinfo, отказ монтировать поверх непустой папки', async () => {
  const t = await tempTree();
  try {
    assert.equal((await ensureBindMount(t.root, `${t.root}/`)).status, 'same-path');
    const points = parseMountPoints('36 35 98:0 /srv/p /opt/bbfs/p rw - ext4 /dev/sda1 rw\n37 35 98:0 / /opt/my\\040dir rw - ext4 x rw\n');
    assert.ok(points.has('/opt/bbfs/p') && points.has('/opt/my dir'));
    const mounted: string[] = [];
    const deps = { mountinfo: async () => '', mount: async (s: string, d: string) => { mounted.push(`${s}->${d}`); return { exitCode: 0, stdout: '', stderr: '' }; } };
    const target = join(t.dir, 'bbfs/proj');
    assert.equal((await ensureBindMount(t.root, target, deps)).status, 'mounted');
    assert.deepEqual(mounted, [`${t.root}->${target}`]);
    await writeFile(join(target, 'other'), 'x');
    await assert.rejects(ensureBindMount(t.root, target, deps), /не пуст/);
    await assert.rejects(ensureBindMount(join(t.dir, 'nope'), target, deps), /Нет папки проекта/);
  } finally { await rm(t.dir, { recursive: true, force: true }); }
});

// ---- service.ts, lines.ts ----

test('контекст проекта: папка на опоре из sources, имя папки, режим, исключения, SSH', () => {
  const config = configSchema.parse({
    machines: [
      { hostId: TRU, label: 'Tru', platform: 'linux', anchor: true },
      { hostId: MAC, label: 'Mac', platform: 'macos' },
      { hostId: UA, label: 'UA', platform: 'linux', enabled: false },
    ],
    files: { projectSyncModes: { proj_1: 'warm' }, syncEnv: false },
  });
  const project = { name: 'Мой проект', sources: [
    { hostId: MAC, path: '/home/user/app', isDefault: true },
    { hostId: TRU, path: '/srv/projects/my-app/', isDefault: false },
  ] };
  assert.equal(projectSourceOn(project, TRU), '/srv/projects/my-app/');
  assert.equal(projectSourceOn({ project }, MAC), '/home/user/app');
  assert.equal(projectSourceOn(null, TRU), null);
  const ctx = buildContext({ config, projectId: 'proj_1', projectName: 'Мой проект', anchorSource: '/srv/projects/my-app/', ssh: new Map([[MAC, 'tru']]) });
  assert.equal(ctx.slug, 'my-app');
  assert.equal(ctx.anchorRealPath, '/srv/projects/my-app');
  assert.equal(ctx.anchor.hostId, TRU);
  assert.deepEqual(ctx.executors.map(m => m.hostId), [MAC]);
  assert.equal(ctx.mode, 'warm');
  assert.ok(ctx.ignores.includes('.env') && ctx.ignores.includes('node_modules'));
  assert.equal(ctx.anchorSsh(MAC), 'tru');
  assert.equal(ctx.anchorSsh(UA), null);
  const inShared = buildContext({ config, projectId: 'p2', projectName: 'x', anchorSource: '/opt/bbfs/Some_Name', ssh: new Map() });
  assert.deepEqual([inShared.slug, inShared.anchorRealPath, inShared.mode], ['Some_Name', '/opt/bbfs/Some_Name', 'lazy']);
  assert.throws(() => buildContext({ config, projectId: 'p3', projectName: 'x', anchorSource: null, ssh: new Map() }), /нет папки на опорной машине Tru/);
  assert.equal(syncModeOf({ ...config, files: { ...config.files, projectSyncModes: { p: 'off' as never } } }, 'p'), 'off');
  assert.equal(syncModeOf({ ...config, files: { ...config.files, projectSyncModes: { p: 'future' as never } } }, 'p'), 'lazy');
  // 0.3.3: папка рабочей копии на машине — для паспорта (открыть папку, файлы, код).
  const macShared = ctx.executors.find(m => m.hostId === MAC)!.sharedPath.replace(/\/+$/u, '');
  assert.equal(folderIn(ctx, TRU), '/srv/projects/my-app');
  assert.equal(folderIn(ctx, MAC), `${macShared}/my-app`);
  assert.equal(folderIn(ctx, 'host_unknown'), null);
  const wt = buildContext({ config, projectId: 'proj_1', projectName: 'x', anchorSource: '/data/worktrees/thr_1-1/my-app', ssh: new Map(), unitId: 'proj_1~wabc12345', unitSuffix: 'abc12345' });
  assert.equal(folderIn(wt, TRU), '/data/worktrees/thr_1-1/my-app');
  assert.equal(folderIn(wt, MAC), `${macShared}/my-app-wabc12345`);
  assert.equal(folderIn({ ...ctx, executors: ctx.executors.map(m => ({ ...m, pathTranslation: true })) }, MAC), null);
});

test('строки ленты: flush и выравнивание с направлением, отказ с причиной', async () => {
  const { sync } = setup();
  const prepared = await sync.prepareTurn(T, { hostId: MAC });
  const label = (h: string) => ({ [TRU]: 'Tru', [MAC]: 'Mac' } as Record<string, string>)[h] ?? h;
  const lines = timingLines(prepared.timings, label);
  assert.ok(lines.some(l => /^Tru → Mac: выравнивание \d+,\d с ✓$/.test(l)), lines.join('\n'));
  assert.ok(lines.some(l => /^Tru → Mac: flush \d+,\d с ✓$/.test(l)));
  assert.match(summaryLine(prepared, label, 'prepare'), /^Файлы готовы к ходу за \d+,\d с \(Tru, Mac\) ✓$/);
  const busy = await sync.prepareTurn(T2, { hostId: UA });
  assert.match(summaryLine(busy, label, 'prepare'), /^Синхронизация: Рабочую папку сейчас пишет другой тред \(thr_a\) на Mac/);
});

test('SSH к опоре: из настроек машины; недопустимое значение не используется', async () => {
  const { machineAnchorSsh } = await import('./service.ts');
  assert.equal(machineAnchorSsh({ anchorSsh: 'de-vpn-vps' }), 'de-vpn-vps');
  assert.equal(machineAnchorSsh({ anchorSsh: 'root@10.0.0.1' }), 'root@10.0.0.1');
  assert.equal(machineAnchorSsh({ anchorSsh: 'tru; rm -rf /' }), null);
  assert.equal(machineAnchorSsh({ anchorSsh: null }), null);
  const parsed = configSchema.parse({ machines: [{ hostId: 'h', label: 'Mac' }] });
  assert.equal(parsed.machines[0]!.anchorSsh, null, 'старые настройки без поля читаются');
});

test('абсолютный symlink: POSIX-каскад — posix-raw, ход идёт; Windows — portable, путь пропущен с предупреждением', async () => {
  const { symlinkModeFor, evaluateHealth } = await import('./mutagen.ts');
  assert.equal(symlinkModeFor([{ platform: 'linux' }, { platform: 'macos' }, { platform: 'wsl' }]), 'posix-raw');
  assert.equal(symlinkModeFor([{ platform: 'linux' }, { platform: 'windows' }]), 'portable');
  assert.equal(symlinkModeFor([{ platform: 'linux' }, { platform: 'linux', pathTranslation: true }]), 'portable');

  // POSIX: сессии создаются с posix-raw, абсолютная ссылка не мешает.
  const posix = setup();
  posix.fake.absoluteLinks = ['.local/config'];
  const ok = await posix.sync.prepareTurn(T, { hostId: MAC });
  assert.equal(ok.ok, true, ok.ok ? '' : ok.message);
  assert.equal(posix.fake.session(MAC, 'w')!.symlinkMode, 'posix-raw');
  assert.equal(posix.fake.session(MAC, 'r')!.symlinkMode, 'posix-raw');

  // Есть нативный Windows: portable; абсолютная ссылка — ошибка сканирования, но ход не блокируется.
  const win = setup({ symlinkMode: 'portable' });
  win.fake.absoluteLinks = ['.local/config'];
  const warned = await win.sync.prepareTurn(T, { hostId: MAC });
  assert.equal(warned.ok, true, warned.ok ? '' : warned.message);
  assert.ok(warned.notices.some(n => /не синхронизировано путей — 1 \(\.local\/config: invalid symbolic link: target is absolute\)/u.test(n)), warned.notices.join('\n'));
  assert.ok(warned.notices.some(n => /portable/u.test(n)));

  // Ошибка записи по-прежнему блокирует передачу.
  const base = { name: 'w', identifier: 'x', labels: {}, status: 'watching', paused: false, conflicts: [], lastError: null };
  const scan = evaluateHealth({ ...base, alpha: { connected: true, scanProblems: ['a: bad'], transitionProblems: [] }, beta: { connected: true, scanProblems: [], transitionProblems: [] } });
  assert.equal(scan.ok, true);
  assert.equal(scan.warnings.length, 1);
  const write = evaluateHealth({ ...base, alpha: { connected: true, scanProblems: [], transitionProblems: ['b: permission denied'] }, beta: { connected: true, scanProblems: [], transitionProblems: [] } });
  assert.equal(write.ok, false);
});

test('смена режима symlink пересоздаёт сессии прежних версий', async () => {
  const { specFingerprint } = await import('./mutagen.ts');
  const spec = { role: 'w' as const, alpha: 'tru:/opt/bbfs/app', beta: '/opt/bbfs/app', ignores: ['node_modules'] };
  assert.notEqual(specFingerprint({ ...spec, symlinkMode: 'portable' }), specFingerprint({ ...spec, symlinkMode: 'posix-raw' }));
  assert.equal(specFingerprint(spec), specFingerprint({ ...spec, symlinkMode: 'posix-raw' }));
});

// ---- Блокировка «один писатель»: устаревшая и по рабочей папке ----

test('блокировка упавшего треда: тред не идёт — изменения возвращаются, блокировка снимается; живой — busy', async () => {
  const fake = new FakeMutagen();
  const states = new Map<string, ProjectSyncState>();
  let alive = true;
  const sync = new SyncOrchestrator({
    call: fake.call, context: async () => context(),
    store: { get: async id => structuredClone(states.get(id)), set: async (id, s) => { states.set(id, structuredClone(s)); } },
    now: () => 1_000_000, sleep: async () => {}, gitWaitMs: 0,
    threadActive: async id => (id === 'thr_a' ? alive : true),
  });
  assert.equal((await sync.prepareTurn(T, { hostId: MAC })).ok, true, 'тред A начал ход на Mac');
  const busy = await sync.prepareTurn(T2, { hostId: UA });
  assert.equal(!busy.ok && busy.reason, 'busy', 'A ещё идёт на Mac — B с другой машины ждёт');
  alive = false; // A упал / заархивирован
  const taken = await sync.prepareTurn(T2, { hostId: MAC });
  assert.equal(taken.ok, true, taken.ok ? '' : taken.message);
  assert.ok(taken.notices.some(n => /Снята блокировка брошенного хода треда thr_a/u.test(n)), taken.notices.join('\n'));
  assert.equal(states.get('proj_1')!.writer!.threadId, 'thr_b');
});

test('блокировка брошенного треда снимается, даже если его изменения не вернулись на опору', async () => {
  const fake = new FakeMutagen();
  const states = new Map<string, ProjectSyncState>();
  const sync = new SyncOrchestrator({
    call: fake.call, context: async () => context(),
    store: { get: async id => structuredClone(states.get(id)), set: async (id, s) => { states.set(id, structuredClone(s)); } },
    now: () => 1_000_000, sleep: async () => {}, gitWaitMs: 0, threadActive: async id => id !== 'thr_a',
  });
  assert.equal((await sync.prepareTurn(T, { hostId: MAC })).ok, true);
  fake.conflictsAfterFlush = ['src/a.ts']; // возврат A на опору упрётся в конфликт
  const taken = await sync.prepareTurn(T2, { hostId: UA });
  assert.equal(taken.ok, true, taken.ok ? '' : taken.message);
  assert.ok(taken.notices.some(n => /не вернулись на Tru .*остались на Mac/u.test(n)), taken.notices.join('\n'));
  assert.equal(states.get('proj_1')!.writer!.hostId, UA);
});

test('два worktree одного проекта: свои единицы, папки, сессии и блокировки — не мешают друг другу', async () => {
  const { syncUnitId, parseUnitId } = await import('./service.ts');
  const main = '/srv/projects/app';
  const wt1 = '/data/worktrees/thr_a-1/app';
  const wt2 = '/data/worktrees/thr_b-1/app';
  assert.equal(syncUnitId('proj_1', main, main), 'proj_1', 'основная папка — ключ проекта');
  assert.equal(syncUnitId('proj_1', `${main}/`, main), 'proj_1');
  assert.equal(syncUnitId('proj_1', null, main), 'proj_1');
  const u1 = syncUnitId('proj_1', wt1, main);
  const u2 = syncUnitId('proj_1', wt2, main);
  assert.notEqual(u1, u2);
  assert.match(u1, /^proj_1~w[0-9a-f]{8}$/u);
  assert.deepEqual(parseUnitId(u1), { projectId: 'proj_1', suffix: u1.slice(-8) });
  const config = configSchema.parse({ machines: [{ hostId: TRU, label: 'Tru', anchor: true, platform: 'linux' }, { hostId: MAC, label: 'Mac', platform: 'macos' }] });
  const ctx1 = buildContext({ config, projectId: 'proj_1', projectName: 'app', anchorSource: wt1, ssh: new Map([[MAC, 'tru']]), unitId: u1, unitSuffix: parseUnitId(u1).suffix });
  assert.equal(ctx1.projectId, u1);
  assert.equal(ctx1.slug, `app-w${parseUnitId(u1).suffix}`, 'своя папка в общем пути, рядом с основной');
  assert.equal(ctx1.anchorRealPath, wt1);

  // Оркестратор: два треда пишут каждый свой worktree на Mac одновременно.
  const fake = new FakeMutagen();
  const states = new Map<string, ProjectSyncState>();
  const sync = new SyncOrchestrator({
    call: fake.call,
    context: async id => ({ ...context(), projectId: id, slug: id === u1 ? 'app-w1' : 'app-w2' }),
    store: { get: async id => structuredClone(states.get(id)), set: async (id, s) => { states.set(id, structuredClone(s)); } },
    now: () => 1_000_000, sleep: async () => {}, gitWaitMs: 0, threadActive: async () => true,
  });
  const a = await sync.prepareTurn({ threadId: 'thr_a', projectId: u1 }, { hostId: MAC });
  const b = await sync.prepareTurn({ threadId: 'thr_b', projectId: u2 }, { hostId: MAC });
  assert.equal(a.ok && a.cwd, '/opt/bbfs/app-w1');
  assert.equal(b.ok && b.cwd, '/opt/bbfs/app-w2');
  assert.equal(states.get(u1)!.writer!.threadId, 'thr_a');
  assert.equal(states.get(u2)!.writer!.threadId, 'thr_b');
  assert.equal(fake.sessions.get(MAC)!.size, 4, 'по две сессии (R, W) на каждый worktree');
});

test('жив ли тред: архив, удаление, статус хода, непонятный ответ', async () => {
  const { threadActiveFrom } = await import('./service.ts');
  assert.equal(threadActiveFrom({ missing: true }), false);
  assert.equal(threadActiveFrom({ thread: { archivedAt: 1, runtime: { displayStatus: 'active' } } }), false);
  assert.equal(threadActiveFrom({ thread: { archivedAt: null, runtime: { displayStatus: 'idle' } } }), false);
  assert.equal(threadActiveFrom({ thread: { archivedAt: null, runtime: { displayStatus: 'error' } } }), false);
  assert.equal(threadActiveFrom({ thread: { archivedAt: null, runtime: { displayStatus: 'active' } } }), true);
  assert.equal(threadActiveFrom({ thread: { status: 'running' } }), true);
  assert.equal(threadActiveFrom(undefined), null);
  assert.equal(threadActiveFrom({ thread: {} }), null);
});

test('прогресс подготовки: шаги начались/закончились, счётчики передачи во время долгого flush', async () => {
  const fake = new FakeMutagen();
  const states = new Map<string, ProjectSyncState>();
  const sync = new SyncOrchestrator({
    call: fake.call, context: async () => context(),
    store: { get: async id => structuredClone(states.get(id)), set: async (id, s) => { states.set(id, structuredClone(s)); } },
    now: () => 1_000_000, sleep: async () => {}, gitWaitMs: 0, progressPollMs: 10,
  });
  fake.flushDelayMs = 80;
  fake.staging = { receivedFiles: 2341, expectedFiles: 10520, totalReceivedSize: 5_000_000 };
  const events: { kind: string; step: string; state?: string; done?: number | null; files?: number | null }[] = [];
  const result = await sync.prepareTurn(T, { hostId: MAC }, e => events.push(e.kind === 'step' ? { kind: e.kind, step: e.step, state: e.state } : { kind: e.kind, step: e.step, done: e.progress.done, files: e.progress.files }));
  assert.equal(result.ok, true);
  assert.ok(events.some(e => e.kind === 'step' && e.step === 'align' && e.state === 'running'));
  assert.ok(events.some(e => e.kind === 'step' && e.step === 'flush' && e.state === 'done'));
  const transfer = events.find(e => e.kind === 'transfer');
  assert.deepEqual(transfer && { done: transfer.done, files: transfer.files }, { done: 2341, files: 10520 }, 'счётчики Mutagen во время передачи');
});
