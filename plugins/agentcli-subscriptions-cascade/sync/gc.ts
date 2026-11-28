// Сборка брошенных реплик (gc): единица синхронизации отдельного worktree треда
// (`<проект>~w<хеш>`, папка `/opt/bbfs/<проект>-w<хеш>` на исполнителях) живёт,
// пока жив хоть один её тред. Тред архивирован или удалён — сессии Mutagen
// снимаются, реплика на исполнителях удаляется (изменения после последнего хода —
// в карантин). Опора не трогается никогда: там настоящая папка worktree.
// Основная папка проекта (единица = ID проекта) gc не касается.
import type { CascadeConfig, Machine } from '../contract.ts';
import { MUTAGEN_LABEL, labelValue } from './mutagen.ts';
import type { ProjectSyncState } from './orchestrator.ts';
import { buildContext, parseUnitId, syncUnitId } from './service.ts';

export interface UnitRecord { unitId: string; projectId: string; workspace: string; threads?: string[] }
export interface ThreadRecord { threadId: string; projectId: string; workspace: string | null }

/** Тред из пути worktree BB: `…/worktrees/<thr_id>-<n>/<repo>`. */
export function threadFromWorkspace(workspace: string): string | null {
  return /\/worktrees\/(thr_[a-z0-9]+)-\d+(?:\/|$)/u.exec(workspace)?.[1] ?? null;
}

/** Владельцы единицы: записанные при ходе, по состоянию тредов и по пути worktree. */
export function unitOwners(unit: UnitRecord, threads: readonly ThreadRecord[], projectDefault: (projectId: string) => string | null): Set<string> {
  const owners = new Set(unit.threads ?? []);
  for (const t of threads) {
    if (t.workspace && t.projectId === unit.projectId && syncUnitId(t.projectId, t.workspace, projectDefault(t.projectId)) === unit.unitId) owners.add(t.threadId);
  }
  const fromPath = threadFromWorkspace(unit.workspace);
  if (fromPath) owners.add(fromPath);
  return owners;
}

export type GcVerdict =
  | { action: 'keep'; reason: string }
  | { action: 'retire'; reason: string };

/** Решение по единице. live — треды, которые не архивированы и не удалены. */
export function judgeUnit(unit: UnitRecord, owners: ReadonlySet<string>, live: ReadonlySet<string>, state: ProjectSyncState | undefined): GcVerdict {
  if (!parseUnitId(unit.unitId).suffix) return { action: 'keep', reason: 'основная папка проекта — gc не трогает' };
  if (owners.size === 0) return { action: 'keep', reason: 'владелец неизвестен — не трогаю' };
  const alive = [...owners].filter(t => live.has(t));
  if (alive.length) return { action: 'keep', reason: `живой тред ${alive.join(', ')}` };
  if (state?.writer && live.has(state.writer.threadId)) return { action: 'keep', reason: `блокировка писателя живого треда ${state.writer.threadId}` };
  const anchorTurn = Object.keys(state?.anchorTurns ?? {}).find(t => live.has(t));
  if (anchorTurn) return { action: 'keep', reason: `идёт ход ${anchorTurn} на опоре` };
  const lock = state?.writer ? ` (блокировка брошенного хода ${state.writer.threadId} на ${state.writer.hostId}: его изменения уйдут в карантин)` : '';
  return { action: 'retire', reason: `треды ${[...owners].join(', ')} архивированы или удалены${lock}` };
}

/** Где лежат реплики единицы: исполнители (не опора, не нативный Windows) и имя папки. */
export function replicaTargets(config: CascadeConfig, unit: UnitRecord, onlyHost: string | null): { machine: Machine; base: string; name: string; key: string }[] {
  const { projectId, suffix } = parseUnitId(unit.unitId);
  if (!suffix) return [];
  const ctx = buildContext({ config, projectId, projectName: projectId, anchorSource: unit.workspace, ssh: new Map(), unitId: unit.unitId, unitSuffix: suffix });
  const anchor = config.machines.find(m => m.anchor);
  return config.machines
    .filter(m => !m.anchor && m.hostId !== anchor?.hostId && m.platform !== 'windows' && !m.pathTranslation)
    .filter(m => onlyHost === null || m.hostId === onlyHost)
    .map(m => {
      const base = m.sharedPath.replace(/\/+$/u, '') || '/';
      return { machine: m, base, name: ctx.slug, key: `${unit.unitId}:${m.hostId}:${base}/${ctx.slug}` };
    });
}

/** Селектор сессий Mutagen единицы (как в orchestrator.ts). */
export const unitSelector = (unitId: string) => `${MUTAGEN_LABEL}=1,bbc-project=${labelValue(unitId)}`;

export interface GcMachineResult {
  hostId: string; label: string; name: string;
  sessions: number; exists: boolean; files: number; changed: number; deleted: number; hadSnapshot: boolean;
  quarantined: string | null; removed: boolean; error: string | null;
}
export interface GcUnitResult { unitId: string; workspace: string; owners: string[]; verdict: GcVerdict; machines: GcMachineResult[] }
export interface GcReport { dryRun: boolean; units: GcUnitResult[]; unknownReplicas: { hostId: string; label: string; name: string }[]; errors: string[] }

/** Текст отчёта для CLI. */
export function formatGc(report: GcReport): string {
  const lines: string[] = [report.dryRun ? 'Сборка реплик — предпросмотр (ничего не удалено):' : 'Сборка реплик:'];
  const retire = report.units.filter(u => u.verdict.action === 'retire');
  const keep = report.units.filter(u => u.verdict.action === 'keep');
  for (const u of retire) {
    lines.push(`✗ ${u.unitId} — ${u.verdict.reason}`);
    for (const m of u.machines) {
      if (m.error) { lines.push(`    ${m.label} ${m.name}: ошибка — ${m.error}`); continue; }
      const what = m.exists ? `файлов ${m.files}, после последнего хода изменено ${m.changed}, удалено ${m.deleted}${m.hadSnapshot ? '' : ' (снимка нет — в карантин вся реплика)'}` : 'реплики нет';
      const done = report.dryRun ? (m.changed || m.deleted ? ' → карантин и удаление' : m.exists ? ' → удаление' : '') : `${m.quarantined ? ` → карантин ${m.quarantined}` : ''}${m.removed ? ' → удалена' : ''}`;
      lines.push(`    ${m.label} ${m.name}: сессий Mutagen ${m.sessions}; ${what}${done}`);
    }
  }
  if (keep.length) lines.push(`Остаются: ${keep.length} (${[...new Set(keep.map(u => u.verdict.reason.replace(/ thr_\S+/gu, '')))].join('; ')})`);
  for (const r of report.unknownReplicas) lines.push(`? ${r.label} ${r.name}: реплика без записи каскада — не трогаю`);
  for (const e of report.errors) lines.push(`! ${e}`);
  lines.push(`Итого: к сборке ${retire.length}, остаются ${keep.length}, неизвестных реплик ${report.unknownReplicas.length}.`);
  return `${lines.join('\n')}\n`;
}

// ---- Исполнение (через порты: тестируется без SDK) ----

export interface GcPorts {
  loadConfig(): Promise<CascadeConfig>;
  units(): Promise<UnitRecord[]>;
  threads(): Promise<ThreadRecord[]>;
  /** Основная папка проекта на опоре (для ключа единицы). */
  projectDefault(projectId: string): Promise<string | null>;
  unitState(unitId: string): Promise<ProjectSyncState | undefined>;
  /** Живые (не архивные, не удалённые) треды среди переданных — одним вызовом на 200 ID. */
  liveThreads(threadIds: readonly string[]): Promise<Set<string>>;
  call: import('./orchestrator.ts').SyncHostCall;
  forgetUnit(unitId: string): Promise<void>;
  log?(line: string): void;
}

export interface GcOptions { dryRun: boolean; hostId?: string | null; quarantineBase?: string; ignores?: readonly string[]; onlyThreads?: readonly string[] }

export async function runGc(ports: GcPorts, options: GcOptions): Promise<GcReport> {
  const config = await ports.loadConfig();
  const [units, threads] = await Promise.all([ports.units(), ports.threads()]);
  const defaults = new Map<string, string | null>();
  for (const projectId of new Set([...units.map(u => u.projectId), ...threads.map(t => t.projectId)])) defaults.set(projectId, await ports.projectDefault(projectId).catch(() => null));
  const owned = units.map(unit => ({ unit, owners: unitOwners(unit, threads, p => defaults.get(p) ?? null) }));
  const scoped = options.onlyThreads ? owned.filter(o => [...o.owners].some(t => options.onlyThreads!.includes(t))) : owned;
  const live = await ports.liveThreads([...new Set(scoped.flatMap(o => [...o.owners]))]);
  const report: GcReport = { dryRun: options.dryRun, units: [], unknownReplicas: [], errors: [] };
  const onlyHost = options.hostId ?? null;

  // Сессии каскада и реплики — по одному вызову на машину.
  const machines = config.machines.filter(m => !m.anchor && m.enabled && m.platform !== 'windows' && !m.pathTranslation && (onlyHost === null || m.hostId === onlyHost));
  const sessionsBy = new Map<string, Map<string, string[]>>();
  const replicasBy = new Map<string, Set<string>>();
  for (const m of machines) {
    const list = await ports.call(m.hostId, 'syncMutagen', { args: ['sync', 'list', '--template', '{{json .}}', '--label-selector', `${MUTAGEN_LABEL}=1`], timeoutMs: 60_000 }).catch(error => { report.errors.push(`${m.label}: сессии Mutagen не прочитаны — ${String(error)}`); return null; });
    const byUnit = new Map<string, string[]>();
    try {
      for (const s of JSON.parse(list?.stdout?.trim() || '[]') as { name?: string; labels?: Record<string, string> }[]) {
        const key = s.labels?.['bbc-project'];
        if (key && s.name) byUnit.set(key, [...(byUnit.get(key) ?? []), s.name]);
      }
    } catch { /* пустой или непонятный вывод */ }
    sessionsBy.set(m.hostId, byUnit);
    const base = m.sharedPath.replace(/\/+$/u, '') || '/';
    const names = await ports.call(m.hostId, 'syncReplicaList', { base }).then(r => r.names, () => [] as string[]);
    replicasBy.set(m.hostId, new Set(names));
  }

  const known = new Map<string, Set<string>>();
  for (const { unit, owners } of scoped) {
    const verdict = judgeUnit(unit, owners, live, await ports.unitState(unit.unitId).catch(() => undefined));
    const result: GcUnitResult = { unitId: unit.unitId, workspace: unit.workspace, owners: [...owners], verdict, machines: [] };
    for (const t of replicaTargets(config, unit, onlyHost)) known.set(t.machine.hostId, (known.get(t.machine.hostId) ?? new Set()).add(t.name));
    report.units.push(result);
    if (verdict.action !== 'retire') continue;
    let clean = true;
    for (const t of replicaTargets(config, unit, onlyHost)) {
      if (!t.machine.enabled) continue;
      const row: GcMachineResult = { hostId: t.machine.hostId, label: t.machine.label, name: t.name, sessions: sessionsBy.get(t.machine.hostId)?.get(labelValue(unit.unitId))?.length ?? 0, exists: false, files: 0, changed: 0, deleted: 0, hadSnapshot: false, quarantined: null, removed: false, error: null };
      try {
        if (!options.dryRun && row.sessions > 0) {
          const out = await ports.call(t.machine.hostId, 'syncMutagen', { args: ['sync', 'terminate', '--label-selector', unitSelector(unit.unitId)], timeoutMs: 60_000 });
          if (out.exitCode !== 0) throw new Error(`mutagen terminate: ${(out.stderr || out.stdout).trim().slice(0, 200)}`);
        }
        const retired = await ports.call(t.machine.hostId, 'syncRetireReplica', {
          base: t.base, name: t.name, key: t.key, ignores: [...(options.ignores ?? [])], quarantineBase: `${options.quarantineBase ?? '~/bbfs-quarantine'}/${t.name}`, dryRun: options.dryRun,
        });
        Object.assign(row, retired);
      } catch (error) {
        row.error = error instanceof Error ? error.message : String(error);
        clean = false;
      }
      result.machines.push(row);
    }
    if (!options.dryRun && clean) await ports.forgetUnit(unit.unitId).catch(error => report.errors.push(`запись ${unit.unitId}: ${String(error)}`));
    ports.log?.(`gc ${unit.unitId}: ${options.dryRun ? 'предпросмотр' : clean ? 'собрана' : 'частично'} — ${verdict.reason}`);
  }
  if (!options.onlyThreads) {
    for (const m of machines) {
      for (const name of replicasBy.get(m.hostId) ?? []) if (!known.get(m.hostId)?.has(name)) report.unknownReplicas.push({ hostId: m.hostId, label: m.label, name });
    }
  }
  return report;
}
