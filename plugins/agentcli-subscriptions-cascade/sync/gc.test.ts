// Сборка брошенных реплик (gc).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, stat, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema } from '../contract.ts';
import { formatGc, judgeUnit, replicaTargets, runGc, threadFromWorkspace, unitOwners, type GcPorts, type UnitRecord } from './gc.ts';
import { listReplicas, retireReplica, writeSnapshot } from './host-ops.ts';
import { labelValue } from './mutagen.ts';
import { syncUnitId } from './service.ts';

const TRU = 'host_tru';
const MAC = 'host_mac';
const UA = 'host_ua';
const WT = (t: string) => `/data/worktrees/${t}-1/proj`;
const config = configSchema.parse({ machines: [
  { hostId: TRU, label: 'Tru', anchor: true, platform: 'linux' },
  { hostId: MAC, label: 'Mac', platform: 'macos' },
  { hostId: UA, label: 'UA', platform: 'linux', enabled: false },
] });
const unit = (t: string, extra: Partial<UnitRecord> = {}): UnitRecord => ({ unitId: syncUnitId('proj_1', WT(t), '/srv/projects/proj'), projectId: 'proj_1', workspace: WT(t), ...extra });

test('владельцы единицы: записанные, по состоянию треда и по пути worktree', () => {
  assert.equal(threadFromWorkspace('/root/x/worktrees/thr_abc123-1/bb-config'), 'thr_abc123');
  assert.equal(threadFromWorkspace('/srv/projects/proj'), null);
  const u = unit('thr_a', { threads: ['thr_z'] });
  const owners = unitOwners(u, [{ threadId: 'thr_b', projectId: 'proj_1', workspace: WT('thr_a') }, { threadId: 'thr_c', projectId: 'proj_1', workspace: WT('thr_c') }], () => '/srv/projects/proj');
  assert.deepEqual([...owners].sort(), ['thr_a', 'thr_b', 'thr_z']);
});

test('решение: живой тред, живая блокировка писателя, ход на опоре — оставить; все владельцы мертвы — собрать; основная папка и неизвестный владелец — не трогать', () => {
  const u = unit('thr_a');
  const owners = new Set(['thr_a']);
  assert.equal(judgeUnit(u, owners, new Set(['thr_a']), undefined).action, 'keep');
  assert.equal(judgeUnit(u, owners, new Set(['thr_w']), { version: 1, writer: { hostId: MAC, threadId: 'thr_w', since: 0, env600: [] }, anchorTurns: {} }).action, 'keep');
  assert.equal(judgeUnit(u, owners, new Set(['thr_o']), { version: 1, writer: null, anchorTurns: { thr_o: 1 } }).action, 'keep');
  const dead = judgeUnit(u, owners, new Set(), { version: 1, writer: { hostId: MAC, threadId: 'thr_a', since: 0, env600: [] }, anchorTurns: {} });
  assert.equal(dead.action, 'retire');
  assert.match(dead.reason, /блокировка брошенного хода thr_a на host_mac: его изменения уйдут в карантин/u);
  assert.equal(judgeUnit({ unitId: 'proj_1', projectId: 'proj_1', workspace: '/srv/projects/proj' }, owners, new Set(), undefined).action, 'keep');
  assert.equal(judgeUnit({ ...u, workspace: '/somewhere/else' }, new Set(), new Set(), undefined).action, 'keep');
});

test('реплики только на исполнителях: опора и нативный Windows исключены', () => {
  const targets = replicaTargets(config, unit('thr_a'), null);
  assert.deepEqual(targets.map(t => t.machine.hostId), [MAC, UA]);
  assert.match(targets[0]!.name, /^proj-w[0-9a-f]{8}$/u);
  assert.equal(replicaTargets(config, { unitId: 'proj_1', projectId: 'proj_1', workspace: '/srv/projects/proj' }, null).length, 0);
});

function ports(opts: { units: UnitRecord[]; live: string[]; replicas?: string[]; failRetire?: boolean }) {
  const calls: string[] = [];
  const forgot: string[] = [];
  let listCalls = 0;
  const p: GcPorts = {
    loadConfig: async () => config,
    units: async () => opts.units,
    threads: async () => [],
    projectDefault: async () => '/srv/projects/proj',
    unitState: async () => undefined,
    liveThreads: async ids => { listCalls += 1; return new Set(ids.filter(id => opts.live.includes(id))); },
    call: (async (hostId: string, method: string, input: Record<string, unknown>) => {
      calls.push(`${hostId} ${method} ${method === 'syncMutagen' ? (input.args as string[]).slice(0, 2).join(' ') : method === 'syncRetireReplica' ? `${String(input.name)} dry=${String(input.dryRun)}` : ''}`.trim());
      if (method === 'syncMutagen') {
        const list = (input.args as string[])[1] === 'list';
        return { exitCode: 0, stdout: list ? JSON.stringify(opts.units.map(u => ({ name: `bbc-${u.unitId}-w`, labels: { 'bbc-project': labelValue(u.unitId) } }))) : '', stderr: '', seconds: 0, binary: 'mutagen' };
      }
      if (method === 'syncReplicaList') return { names: opts.replicas ?? [] };
      if (method === 'syncRetireReplica') {
        if (opts.failRetire) throw new Error('нет связи');
        return { exists: true, files: 10, changed: input.dryRun ? 2 : 2, deleted: 0, hadSnapshot: true, quarantined: input.dryRun ? null : '/home/u/bbfs-quarantine/x', removed: !input.dryRun };
      }
      throw new Error(method);
    }) as never,
    forgetUnit: async id => { forgot.push(id); },
  };
  return { p, calls, forgot, listCalls: () => listCalls };
}

test('gc: предпросмотр ничего не меняет; запуск — сессии сняты, реплика в карантин и удалена, запись забыта; живой — не тронут; опора — никогда', async () => {
  const dead = unit('thr_dead');
  const alive = unit('thr_alive');
  const fx = ports({ units: [dead, alive], live: ['thr_alive'], replicas: ['proj-wdeadbeef'] });
  const dry = await runGc(fx.p, { dryRun: true });
  assert.equal(fx.listCalls(), 1, 'один вызов списка тредов');
  assert.deepEqual(dry.units.map(u => [u.unitId === dead.unitId ? 'dead' : 'alive', u.verdict.action]), [['dead', 'retire'], ['alive', 'keep']]);
  assert.ok(fx.calls.every(c => !c.includes('terminate')), 'в предпросмотре сессии не снимаются');
  assert.ok(fx.calls.some(c => c.includes('dry=true')));
  assert.deepEqual(fx.forgot, []);
  assert.deepEqual(dry.unknownReplicas.map(r => r.name), ['proj-wdeadbeef'], 'реплика без записи — только в отчёт');
  assert.match(formatGc(dry), /предпросмотр[\s\S]*→ карантин и удаление/u);
  assert.ok(fx.calls.every(c => !c.startsWith(TRU)), 'на опору — ни одного вызова');

  const run = ports({ units: [dead], live: [] });
  const done = await runGc(run.p, { dryRun: false });
  assert.deepEqual(run.forgot, [dead.unitId]);
  assert.ok(run.calls.some(c => c.includes('dry=false')));
  assert.ok(run.calls.some(c => c === `${MAC} syncMutagen sync terminate`), 'сессии Mutagen единицы сняты');
  assert.ok(run.calls.indexOf(`${MAC} syncMutagen sync terminate`) < run.calls.findIndex(c => c.includes('dry=false')), 'сначала сессии, потом папка');
  assert.equal(done.units[0]!.machines[0]!.removed, true);
  assert.ok(run.calls.every(c => !c.startsWith(TRU)));

  const failing = ports({ units: [dead], live: [], failRetire: true });
  const partial = await runGc(failing.p, { dryRun: false });
  assert.deepEqual(failing.forgot, [], 'ошибка на машине — запись единицы остаётся для следующего gc');
  assert.match(partial.units[0]!.machines[0]!.error ?? '', /нет связи/u);
});

test('retireReplica на настоящей ФС: изменения после снимка — в карантин, папка удалена; не реплика и точка вне общего пути — отказ', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cxgc-'));
  const base = join(root, 'bbfs');
  const data = join(root, 'data');
  const replica = join(base, 'proj-w1a2b3c4d');
  await mkdir(join(replica, 'src'), { recursive: true });
  await writeFile(join(replica, 'src', 'a.ts'), 'old');
  await writeFile(join(replica, 'keep.txt'), 'same');
  const key = `proj_1~w1a2b3c4d:${'host_mac'}:${replica}`;
  await writeSnapshot(data, replica, key, []);
  // После последнего хода: изменён a.ts, добавлен new.txt.
  await writeFile(join(replica, 'src', 'a.ts'), 'NEW CONTENT');
  await utimes(join(replica, 'src', 'a.ts'), new Date(), new Date(Date.now() + 5_000));
  await writeFile(join(replica, 'new.txt'), 'late');
  assert.deepEqual((await listReplicas(base)).names, ['proj-w1a2b3c4d']);

  const q = join(root, 'quarantine');
  const dry = await retireReplica(data, { base, name: 'proj-w1a2b3c4d', key, ignores: [], quarantineBase: q, dryRun: true });
  assert.deepEqual([dry.exists, dry.files, dry.changed, dry.removed], [true, 3, 2, false]);
  assert.ok(await stat(replica).then(() => true), 'предпросмотр папку не трогает');

  const done = await retireReplica(data, { base, name: 'proj-w1a2b3c4d', key, ignores: [], quarantineBase: q, dryRun: false });
  assert.equal(done.removed, true);
  assert.equal(await stat(replica).then(() => true, () => false), false);
  assert.equal(await readFile(join(done.quarantined!, 'src', 'a.ts'), 'utf8'), 'NEW CONTENT');
  assert.equal(await readFile(join(done.quarantined!, 'new.txt'), 'utf8'), 'late');
  assert.deepEqual((await readdir(done.quarantined!)).sort(), ['new.txt', 'src'], 'неизменённое в карантин не копируется');

  await assert.rejects(retireReplica(data, { base, name: 'proj', key, ignores: [], quarantineBase: q, dryRun: false }), /не реплика каскада/u);
  await assert.rejects(retireReplica(data, { base, name: '../etc-w1a2b3c4d', key, ignores: [], quarantineBase: q, dryRun: false }));

  // Снимка нет — в карантин вся реплика.
  const other = join(base, 'proj-w99999999');
  await mkdir(other, { recursive: true });
  await writeFile(join(other, 'x.txt'), 'x');
  const noSnap = await retireReplica(data, { base, name: 'proj-w99999999', key: 'none', ignores: [], quarantineBase: q, dryRun: false });
  assert.equal(noSnap.hadSnapshot, false);
  assert.equal(await readFile(join(noSnap.quarantined!, 'x.txt'), 'utf8'), 'x');
  assert.ok((await readdir(noSnap.quarantined!)).includes('_no-snapshot.txt'));

  // Файл не читается — в карантин не попал, реплика остаётся (изменения не теряются).
  if (process.getuid?.() !== 0) {
    const locked = join(base, 'proj-w88888888');
    await mkdir(locked, { recursive: true });
    await writeFile(join(locked, 'secret.txt'), 'x');
    await chmod(join(locked, 'secret.txt'), 0o000);
    await assert.rejects(retireReplica(data, { base, name: 'proj-w88888888', key: 'none', ignores: [], quarantineBase: q, dryRun: false }), /реплика оставлена/u);
    assert.ok(await stat(join(locked, 'secret.txt')).then(() => true));
    await chmod(join(locked, 'secret.txt'), 0o600);
  }
});

test('0.3.1 п.12: реплики машин, выбывших из каскада (выключена или убрана), собираются и у живой единицы; открытый выход писателя — не трогать', async () => {
  const OLD = 'host_old';
  const alive = unit('thr_alive');
  const locked = unit('thr_locked');
  const fx = ports({ units: [alive, locked], live: ['thr_alive', 'thr_locked'] });
  fx.p.retiredMachines = async () => [
    { hostId: UA, label: 'UA', sharedPath: '/opt/bbfs', platform: 'linux' },
    { hostId: OLD, label: 'Старый Mac', sharedPath: '/opt/bbfs', platform: 'macos' },
  ];
  fx.p.unitState = async id => (id === locked.unitId ? { version: 1, writer: { hostId: OLD, threadId: 'thr_locked', since: 0, env600: [] }, anchorTurns: {} } : undefined);
  const report = await runGc(fx.p, { dryRun: false });
  const a = report.units.find(u => u.unitId === alive.unitId)!;
  assert.equal(a.verdict.action, 'keep', 'единица жива');
  assert.deepEqual(a.machines.map(m => [m.hostId, m.removed]), [[UA, true], [OLD, true]], 'собраны только выбывшие машины');
  assert.ok(fx.calls.includes(`${UA} syncMutagen sync terminate`) && fx.calls.includes(`${OLD} syncMutagen sync terminate`));
  assert.ok(!fx.calls.some(c => c.startsWith(`${MAC} syncRetireReplica`)), 'включённый исполнитель не тронут');
  const l = report.units.find(u => u.unitId === locked.unitId)!;
  assert.match(l.machines.find(m => m.hostId === OLD)!.error ?? '', /открыт выход писателя/u);
  assert.deepEqual(fx.forgot, [], 'живые единицы не забываются');
  assert.match(formatGc(report), /↺ .* — реплики машин, выбывших из каскада/u);
});
