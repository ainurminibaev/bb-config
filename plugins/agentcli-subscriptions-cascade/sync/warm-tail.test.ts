// 0.3.6: тёплый хвост ленивого режима и быстрый путь повторного хода на той же машине.
// Фейковые часы: каждый вызов на машину сдвигает время на типичную длительность
// (замер живого хода на iTAB BI: выравнивание 3,6 с, запуск 2,7 с, flush 1,9 с …).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeMutagen } from './fake-mutagen.ts';
import { SyncOrchestrator, type ProjectSyncState, type SyncProjectContext } from './orchestrator.ts';

const TRU = 'host_tru';
const MAC = 'host_mac';
const UA = 'host_ua';
const TAIL = 30 * 60_000;
const T = { threadId: 'thr_a', projectId: 'proj_1' };

/** Длительность вызова: mutagen по подкоманде, хост-операции по имени, мс. */
function cost(line: string): number {
  if (/mutagen resume/u.test(line)) return 1_300;
  if (/mutagen flush/u.test(line)) return 1_900;
  if (/mutagen (pause|list)/u.test(line)) return 300;
  if (/syncEnsureBindMount/u.test(line)) return 400;
  if (/syncQuarantine/u.test(line)) return 100;
  if (/syncEnvModes/u.test(line)) return 200;
  if (/syncSnapshot/u.test(line)) return 500;
  return 100;
}

function setup(tailMs = TAIL) {
  const fake = new FakeMutagen();
  const states = new Map<string, ProjectSyncState>();
  let now = 1_000_000;
  const scheduled: { at: number; fn: () => void }[] = [];
  const ctx: SyncProjectContext = {
    projectId: 'proj_1', slug: 'app', anchorRealPath: '/srv/projects/app',
    anchor: { hostId: TRU, label: 'Tru', sharedPath: '/opt/bbfs', platform: 'linux' },
    executors: [{ hostId: MAC, label: 'Mac', sharedPath: '/opt/bbfs', platform: 'macos' }, { hostId: UA, label: 'UA', sharedPath: '/opt/bbfs', platform: 'linux' }],
    mode: 'lazy', ignores: ['node_modules'], anchorSsh: () => 'tru', tailMs,
  };
  // Каждая строка журнала стоит своё время один раз; параллельные вызовы (env + flush)
  // складываются — оценка сверху.
  let counted = 0;
  const call: typeof fake.call = async (hostId, method, input) => {
    const out = await fake.call(hostId, method, input);
    if (fake.log.length < counted) counted = 0;
    for (const line of fake.log.slice(counted)) now += cost(line);
    counted = fake.log.length;
    return out;
  };
  const sync = new SyncOrchestrator({
    call, store: { get: async id => structuredClone(states.get(id)), set: async (id, s) => { states.set(id, structuredClone(s)); } },
    context: async () => ctx, now: () => now, sleep: async ms => { now += ms; },
    schedule: (ms, fn) => scheduled.push({ at: now + ms, fn }),
  });
  return {
    fake, sync, states, scheduled,
    clock: () => now, tick: (ms: number) => { now += ms; },
    async timed<R>(fn: () => Promise<R>) { const t0 = now; const r = await fn(); return { r, ms: now - t0 }; },
  };
}

const steps = (log: string[]) => log.map(l => l.replace(/bbc-[0-9a-f]+-[0-9a-f]+-([wr])/g, (_, r: string) => r.toUpperCase()).replace(/ \{\{json \.\}\}/, ''));

test('конец хода с хвостом: правки на опоре (flush + проверка), W работает, снимка и паузы нет', async () => {
  const s = setup();
  await s.sync.prepareTurn(T, { hostId: MAC });
  s.fake.log.length = 0;
  const r = await s.sync.finishTurn(T, { hostId: MAC });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(steps(s.fake.log), ['host_mac: mutagen flush W', 'host_mac: syncGitLocks', 'host_mac: mutagen list']);
  assert.equal(s.fake.session(MAC, 'w')!.paused, false);
  const st = s.states.get('proj_1')!;
  assert.equal(st.writer, null);
  assert.deepEqual(st.tail && [st.tail.hostId, st.tail.threadId, st.tail.until - s.clock()], [MAC, 'thr_a', TAIL]);
  assert.equal(s.scheduled.length, 1, 'закрытие хвоста поставлено на срок');
});

test('повторный ход на той же машине в хвосте: одна сверка + flush W, ≤ 3 с вместо ~9 с полного цикла', async () => {
  const s = setup();
  const full = await s.timed(() => s.sync.prepareTurn(T, { hostId: MAC }));
  await s.sync.finishTurn(T, { hostId: MAC });
  s.tick(5 * 60_000);
  s.fake.log.length = 0;
  const fast = await s.timed(() => s.sync.prepareTurn(T, { hostId: MAC }));
  assert.equal(fast.r.ok, true, JSON.stringify(fast.r));
  assert.deepEqual(steps(s.fake.log), ['host_mac: mutagen list', 'host_tru: syncEnvModes', 'host_mac: mutagen flush W', 'host_mac: mutagen list']);
  assert.ok(fast.ms <= 3_000, `быстрый путь ${fast.ms} мс`);
  assert.ok(full.ms > 3 * fast.ms, `полный путь ${full.ms} мс против ${fast.ms} мс`);
  const st = s.states.get('proj_1')!;
  assert.equal(st.tail, null);
  assert.equal(st.writer?.threadId, 'thr_a');
  // Тот же путь без хвоста (0.3.5) — полный цикл.
  const old = setup(0);
  await old.sync.prepareTurn(T, { hostId: MAC });
  await old.sync.finishTurn(T, { hostId: MAC });
  const again = await old.timed(() => old.sync.prepareTurn(T, { hostId: MAC }));
  assert.ok(again.ms > 3_000, `без хвоста ${again.ms} мс`);
});

test('свой незакрытый ход (finishTurn не дошёл) на той же машине — тоже быстрый путь', async () => {
  const s = setup();
  await s.sync.prepareTurn(T, { hostId: MAC });
  s.fake.log.length = 0;
  const again = await s.timed(() => s.sync.prepareTurn(T, { hostId: MAC }));
  assert.equal(again.r.ok, true);
  assert.deepEqual(steps(s.fake.log), ['host_mac: mutagen flush W']);
  assert.ok(again.ms <= 3_000);
});

test('срок хвоста вышел: обычное закрытие (flush до опоры, пауза W, снимок), затем полный цикл', async () => {
  const s = setup();
  await s.sync.prepareTurn(T, { hostId: MAC });
  await s.sync.finishTurn(T, { hostId: MAC });
  s.tick(TAIL + 1);
  s.fake.log.length = 0;
  const r = await s.sync.prepareTurn(T, { hostId: MAC });
  assert.equal(r.ok, true);
  const log = steps(s.fake.log);
  assert.deepEqual(log.slice(0, 4), ['host_mac: mutagen flush W', 'host_mac: mutagen list', 'host_mac: mutagen pause W', 'host_mac: syncSnapshot']);
  assert.ok(log.includes('host_mac: mutagen resume R'), 'полный цикл с выравниванием');
});

test('ход на другой машине закрывает хвост первой; ход на опоре его не трогает', async () => {
  const s = setup();
  await s.sync.prepareTurn(T, { hostId: MAC });
  await s.sync.finishTurn(T, { hostId: MAC });
  s.fake.log.length = 0;
  await s.sync.prepareTurn({ threadId: 'thr_b', projectId: 'proj_1' }, { hostId: TRU });
  assert.ok(!steps(s.fake.log).some(l => l.startsWith('host_mac')), 'опора: хвост Mac работает (W двусторонний)');
  assert.ok(s.states.get('proj_1')!.tail);
  s.fake.log.length = 0;
  const ua = await s.sync.prepareTurn({ threadId: 'thr_c', projectId: 'proj_1' }, { hostId: UA });
  assert.equal(ua.ok, true);
  const log = steps(s.fake.log);
  assert.deepEqual(log.slice(0, 4), ['host_mac: mutagen flush W', 'host_mac: mutagen list', 'host_mac: mutagen pause W', 'host_mac: syncSnapshot']);
  assert.equal(s.fake.session(MAC, 'w')!.paused, true);
  assert.equal(s.states.get('proj_1')!.writer?.hostId, UA);
});

test('таймер срока закрывает хвост сам; при идущем ходе — не трогает', async () => {
  const s = setup();
  await s.sync.prepareTurn(T, { hostId: MAC });
  await s.sync.finishTurn(T, { hostId: MAC });
  s.tick(TAIL + 2_000);
  s.scheduled[0]!.fn();
  await new Promise(r => setTimeout(r, 10));
  assert.equal(s.states.get('proj_1')!.tail, null);
  assert.equal(s.fake.session(MAC, 'w')!.paused, true);
  // Срок не вышел — closeExpiredTail ничего не делает.
  const s2 = setup();
  await s2.sync.prepareTurn(T, { hostId: MAC });
  await s2.sync.finishTurn(T, { hostId: MAC });
  await s2.sync.closeExpiredTail('proj_1');
  assert.ok(s2.states.get('proj_1')!.tail);
});
