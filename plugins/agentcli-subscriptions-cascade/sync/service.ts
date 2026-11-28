// Серверная обвязка синхронизации: оркестратор поверх хост-RPC плагина,
// конфигурации каскада и проектов BB. Исполнитель хода получает отсюда
// prepareTurn / finishTurn.
//
// SSH-цель опоры для каждой машины-исполнителя (`tru`, `root@host`) задаётся
// в настройках машины (`machine.anchorSsh`, секция «Машины»). Прежнее значение
// из bb.storage.kv `sync:anchor-ssh:<hostId>` читается, если поле пустое.
import { defineRpcContract, type BbPluginApi } from '@get-bb/plugin-sdk';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { z } from 'zod';
import { syncIgnores } from '../config.ts';
import type { CascadeConfig, Machine } from '../contract.ts';
import { syncHostContract } from './contract.ts';
import { runGc, type GcOptions, type GcPorts, type GcReport, type ThreadRecord, type UnitRecord } from './gc.ts';
import { symlinkModeFor, type SyncModeExt } from './mutagen.ts';
import { projectSlug, SyncOrchestrator, type ProjectSyncState, type SyncHostCall, type SyncMachine, type SyncProgress, type SyncProjectContext, type SyncResult, type SyncStepRef, type SyncThreadRef } from './orchestrator.ts';

/** Тред для синхронизации: проект и рабочая папка треда на опоре (worktree), если известна. */
export interface SyncThreadInput { threadId: string; projectId: string; workspace?: string | null }

export interface SyncService {
  /** Сборка брошенных реплик единиц-worktree (gc). */
  gc(options: GcOptions): Promise<GcReport>;
  prepareTurn(thread: SyncThreadInput, step: SyncStepRef, progress?: SyncProgress): Promise<SyncResult>;
  finishTurn(thread: SyncThreadInput, step: SyncStepRef): Promise<SyncResult>;
  /** Кто сейчас пишет рабочую папку треда на исполнителе: машина и треды (0.3.0). */
  writerOf(thread: SyncThreadInput): Promise<{ hostId: string; threadIds: string[] } | null>;
  /**
   * Папка рабочей копии треда на машине (0.3.3): на опоре — настоящая папка
   * (checkout или worktree), на исполнителе — его реплика `<общий путь>/<slug>`.
   * Машина не в каскаде или с трансляцией путей — null.
   */
  folderOn(thread: SyncThreadInput, hostId: string): Promise<string | null>;
  applyMode(projectId: string): Promise<SyncResult>;
  teardown(projectId: string, options?: { removeMount?: boolean }): Promise<SyncResult>;
  status(projectId: string): Promise<ProjectSyncState & { mode: SyncModeExt }>;
  anchorSsh(hostId: string): Promise<string | null>;
  setAnchorSsh(hostId: string, target: string | null): Promise<void>;
}

const SSH_KEY = (hostId: string) => `sync:anchor-ssh:${hostId}`;
const UNIT_KEY = (unitId: string) => `sync:unit:${unitId}`;
const UNIT_MARK = '~w';

/**
 * Единица синхронизации: основная папка проекта на опоре — ключ = ID проекта;
 * отдельная рабочая папка треда (worktree) — `<проект>~w<хеш пути>`. У каждой
 * единицы своя папка в общем пути, свои сессии Mutagen и своя блокировка
 * «один писатель»: треды одного проекта в разных worktree не мешают друг другу.
 */
export function syncUnitId(projectId: string, workspace: string | null | undefined, projectDefault: string | null): string {
  const norm = (path: string) => path.replace(/\/+$/u, '');
  if (!workspace || (projectDefault !== null && norm(workspace) === norm(projectDefault))) return projectId;
  return `${projectId}${UNIT_MARK}${createHash('sha256').update(norm(workspace)).digest('hex').slice(0, 8)}`;
}

export function parseUnitId(unitId: string): { projectId: string; suffix: string | null } {
  const at = unitId.lastIndexOf(UNIT_MARK);
  return at === -1 ? { projectId: unitId, suffix: null } : { projectId: unitId.slice(0, at), suffix: unitId.slice(at + UNIT_MARK.length) };
}
const STATE_KEY = (projectId: string) => `sync:project:${projectId}`;
const SSH_TARGET = /^[A-Za-z0-9_.@-]+$/;

/** Режим проекта: значения вне известных (новые версии схемы) — «Ленивый». */
export function syncModeOf(config: CascadeConfig, projectId: string): SyncModeExt {
  const modes = config.files.projectSyncModes as Record<string, string>;
  const value = modes[projectId] ?? (config.files.defaultSyncMode as string);
  return value === 'warm' || value === 'off' || value === 'lazy' ? value : 'lazy';
}

const toSyncMachine = (m: Machine): SyncMachine => ({ hostId: m.hostId, label: m.label, sharedPath: m.sharedPath, platform: m.platform, pathTranslation: m.pathTranslation });

interface ProjectSourceLike { hostId?: unknown; path?: unknown; isDefault?: unknown }

/** Папка проекта на машине из ответа projects.get; читается терпимо. */
export function projectSourceOn(project: unknown, hostId: string): string | null {
  const record = (project && typeof project === 'object' ? project : {}) as { sources?: unknown; project?: { sources?: unknown } };
  const sources = (Array.isArray(record.sources) ? record.sources : Array.isArray(record.project?.sources) ? record.project.sources : []) as ProjectSourceLike[];
  const onHost = sources.filter(s => s?.hostId === hostId && typeof s.path === 'string');
  const chosen = onHost.find(s => s.isDefault === true) ?? onHost[0];
  return typeof chosen?.path === 'string' ? chosen.path : null;
}

/** SSH-цель из настроек машины, если она допустима. */
export function machineAnchorSsh(machine: Pick<Machine, 'anchorSsh'>): string | null {
  return machine.anchorSsh && SSH_TARGET.test(machine.anchorSsh) ? machine.anchorSsh : null;
}

/** Машина-исполнитель, которую каскад видел (kv `sync:machine:<hostId>`): нужна, когда её уберут из настроек. */
export interface SeenMachine { hostId: string; label: string; sharedPath: string; platform: string; pathTranslation?: boolean }

/**
 * Выбывшие исполнители (0.3.1): выключенные в настройках и убранные из них
 * (по записям `sync:machine:*`). Опора, включённые исполнители и нативный Windows — нет.
 */
export function retiredMachines(config: CascadeConfig, seen: readonly SeenMachine[]): SeenMachine[] {
  const anchor = config.machines.find(m => m.anchor)?.hostId;
  const active = new Set(config.machines.filter(m => m.enabled).map(m => m.hostId));
  const out = new Map<string, SeenMachine>();
  for (const m of config.machines) if (!m.enabled && !m.anchor) out.set(m.hostId, { hostId: m.hostId, label: m.label, sharedPath: m.sharedPath, platform: m.platform, pathTranslation: m.pathTranslation });
  for (const m of seen) if (!out.has(m.hostId) && !config.machines.some(c => c.hostId === m.hostId)) out.set(m.hostId, m);
  return [...out.values()].filter(m => m.hostId !== anchor && !active.has(m.hostId) && m.platform !== 'windows' && !m.pathTranslation);
}

export function buildContext(args: { config: CascadeConfig; projectId: string; projectName: string; anchorSource: string | null; ssh: ReadonlyMap<string, string>; unitId?: string; unitSuffix?: string | null; seen?: readonly SeenMachine[] }): SyncProjectContext {
  const { config, projectId } = args;
  const anchor = config.machines.find(m => m.anchor) ?? null;
  if (!anchor) throw new Error('В каскаде не выбрана опорная машина');
  if (!args.anchorSource) throw new Error(`У проекта нет папки на опорной машине ${anchor.label}`);
  const real = args.anchorSource.replace(/\/+$/, '');
  const shared = anchor.sharedPath.replace(/\/+$/, '');
  // Проект уже лежит в общем пути — его имя и есть папка; иначе имя реальной папки.
  const base = posix.dirname(real) === shared ? posix.basename(real) : projectSlug(posix.basename(real) || args.projectName, projectId);
  // Рабочая папка треда: своя папка в общем пути рядом с основной.
  const slug = args.unitSuffix ? `${base}-w${args.unitSuffix}` : base;
  return {
    projectId: args.unitId ?? projectId,
    slug,
    anchorRealPath: real,
    anchor: toSyncMachine(anchor),
    executors: config.machines.filter(m => m.enabled && !m.anchor).map(toSyncMachine),
    retired: retiredMachines(config, args.seen ?? []).map(m => ({ hostId: m.hostId, label: m.label, sharedPath: m.sharedPath, platform: m.platform, pathTranslation: m.pathTranslation ?? false })),
    mode: syncModeOf(config, projectId),
    ignores: syncIgnores(config),
    symlinkMode: symlinkModeFor([anchor, ...config.machines.filter(m => m.enabled && !m.anchor)]),
    anchorSsh: hostId => args.ssh.get(hostId) ?? null,
  };
}

/**
 * Папка единицы на машине: опора — настоящая папка; исполнитель (в том числе
 * выбывший) — `<его общий путь>/<slug>`. Неизвестная машина или машина с
 * трансляцией путей (нативный Windows) — null: путь там другой, не угадываем.
 */
export function folderIn(ctx: Pick<SyncProjectContext, 'anchor' | 'anchorRealPath' | 'executors' | 'retired' | 'slug'>, hostId: string): string | null {
  if (hostId === ctx.anchor.hostId) return ctx.anchorRealPath;
  const machine = [...ctx.executors, ...(ctx.retired ?? [])].find(m => m.hostId === hostId);
  if (!machine || machine.pathTranslation) return null;
  return posix.join(machine.sharedPath.replace(/\/+$/u, ''), ctx.slug);
}

/** Статусы треда, при которых его ход ещё может идти. */
const LIVE_STATUSES = new Set(['active', 'running', 'starting', 'stopping', 'working', 'busy']);

const isNotFound = (error: unknown) => /not[ _-]?found|404|no such thread/iu.test(error instanceof Error ? error.message : String(error));

/**
 * Жив ли тред-владелец блокировки (читается терпимо): удалён или заархивирован —
 * false; статус хода известен и не «идёт» — false; ответ непонятен — null.
 */
export function threadActiveFrom(raw: unknown): boolean | null {
  if (raw === undefined || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.missing === true) return false;
  const thread = (r.thread && typeof r.thread === 'object' ? r.thread : r) as Record<string, unknown>;
  if (thread.archivedAt !== null && thread.archivedAt !== undefined) return false;
  if (thread.deletedAt !== null && thread.deletedAt !== undefined) return false;
  const runtime = (thread.runtime && typeof thread.runtime === 'object' ? thread.runtime : {}) as Record<string, unknown>;
  const status = typeof runtime.displayStatus === 'string' ? runtime.displayStatus : typeof thread.status === 'string' ? thread.status : null;
  if (status === null) return null;
  return LIVE_STATUSES.has(status);
}

export function createSyncService(bb: BbPluginApi, loadConfig: () => Promise<{ config: CascadeConfig }>): SyncService {
  const client = bb.hosts.experimental_client({ contract: syncHostContract });
  const call: SyncHostCall = (hostId, method, input) => {
    const timeoutMs = method === 'syncMutagen' ? Number((input as { timeoutMs?: number }).timeoutMs ?? 120_000) + 15_000 : 120_000;
    return client.call(method, input, { hostId, signal: AbortSignal.timeout(timeoutMs) }) as never;
  };

  async function anchorSsh(hostId: string): Promise<string | null> {
    const value = await bb.storage.kv.get<string>(SSH_KEY(hostId)).catch(() => undefined);
    return typeof value === 'string' && SSH_TARGET.test(value) ? value : null;
  }

  async function projectOf(projectId: string): Promise<unknown> {
    return bb.sdk.projects.get({ projectId } as Parameters<typeof bb.sdk.projects.get>[0]).catch(() => null);
  }

  /** Единица синхронизации треда; путь рабочей папки запоминается для context(). */
  async function unitOf(thread: SyncThreadInput): Promise<SyncThreadRef> {
    if (!thread.workspace) return { threadId: thread.threadId, projectId: thread.projectId };
    const { config } = await loadConfig();
    const anchor = config.machines.find(m => m.anchor);
    const projectDefault = anchor ? projectSourceOn(await projectOf(thread.projectId), anchor.hostId) : null;
    const unitId = syncUnitId(thread.projectId, thread.workspace, projectDefault);
    if (unitId !== thread.projectId) {
      // Треды единицы — для gc (единица живёт, пока жив хоть один её тред).
      const prev = await bb.storage.kv.get<{ threads?: string[] }>(UNIT_KEY(unitId)).catch(() => undefined);
      const threads = [...new Set([...(prev?.threads ?? []), thread.threadId])].slice(-50);
      if (!prev || threads.length !== (prev.threads?.length ?? 0)) await bb.storage.kv.set(UNIT_KEY(unitId), { projectId: thread.projectId, workspace: thread.workspace, threads });
    }
    return { threadId: thread.threadId, projectId: unitId };
  }

  async function context(unitId: string): Promise<SyncProjectContext> {
    const { config } = await loadConfig();
    const anchor = config.machines.find(m => m.anchor);
    const { projectId, suffix } = parseUnitId(unitId);
    const unit = suffix ? await bb.storage.kv.get<{ projectId: string; workspace: string }>(UNIT_KEY(unitId)).catch(() => undefined) : undefined;
    if (suffix && !unit) throw new Error(`Рабочая папка ${unitId} неизвестна: начните ход заново`);
    const project = await projectOf(projectId);
    const ssh = new Map<string, string>();
    for (const m of config.machines) {
      if (m.anchor) continue;
      const target = machineAnchorSsh(m) ?? await anchorSsh(m.hostId);
      if (target) ssh.set(m.hostId, target);
    }
    const name = (project as { name?: unknown } | null)?.name;
    const anchorSource = unit ? unit.workspace : anchor ? projectSourceOn(project, anchor.hostId) : null;
    return buildContext({ config, projectId, projectName: typeof name === 'string' ? name : projectId, anchorSource, ssh, unitId, unitSuffix: suffix, seen: await seenMachines() });
  }

  const MACHINE_KEY = (hostId: string) => `sync:machine:${hostId}`;
  async function seenMachines(): Promise<SeenMachine[]> {
    const keys = await bb.storage.kv.list('sync:machine:').catch(() => [] as string[]);
    const out: SeenMachine[] = [];
    for (const key of keys) {
      const m = await bb.storage.kv.get<SeenMachine>(key).catch(() => undefined);
      if (m && typeof m.hostId === 'string' && typeof m.sharedPath === 'string') out.push(m);
    }
    return out;
  }
  /** Запомнить исполнителя хода: если его уберут из настроек, каскад закроет его блокировки и соберёт реплики. */
  async function rememberMachine(hostId: string): Promise<void> {
    const { config } = await loadConfig();
    const m = config.machines.find(x => x.hostId === hostId && !x.anchor);
    if (!m) return;
    const rec: SeenMachine = { hostId: m.hostId, label: m.label, sharedPath: m.sharedPath, platform: m.platform, pathTranslation: m.pathTranslation };
    const prev = await bb.storage.kv.get<SeenMachine>(MACHINE_KEY(hostId)).catch(() => undefined);
    if (JSON.stringify(prev) !== JSON.stringify(rec)) await bb.storage.kv.set(MACHINE_KEY(hostId), rec);
  }

  const orchestrator = new SyncOrchestrator({
    call,
    context,
    store: {
      get: id => bb.storage.kv.get<ProjectSyncState>(STATE_KEY(id)),
      set: (id, state) => bb.storage.kv.set(STATE_KEY(id), state),
    },
    threadActive: async threadId => threadActiveFrom(await bb.sdk.threads.get({ threadId }).catch(error => (isNotFound(error) ? { missing: true } : undefined))),
  });

  const gcPorts: GcPorts = {
    loadConfig: async () => (await loadConfig()).config,
    async units() {
      const keys = await bb.storage.kv.list('sync:unit:');
      const out: UnitRecord[] = [];
      for (const key of keys) {
        const rec = await bb.storage.kv.get<{ projectId?: string; workspace?: string; threads?: string[] }>(key).catch(() => undefined);
        if (rec?.projectId && rec.workspace) out.push({ unitId: key.slice('sync:unit:'.length), projectId: rec.projectId, workspace: rec.workspace, threads: rec.threads ?? [] });
      }
      return out;
    },
    async threads() {
      const keys = await bb.storage.kv.list('exec:thread:');
      const out: ThreadRecord[] = [];
      for (const key of keys) {
        const st = await bb.storage.kv.get<{ workspace?: string | null; engine?: { projectId?: string } }>(key).catch(() => undefined);
        if (st?.engine?.projectId) out.push({ threadId: key.slice('exec:thread:'.length), projectId: st.engine.projectId, workspace: st.workspace ?? null });
      }
      return out;
    },
    async projectDefault(projectId) {
      const { config } = await loadConfig();
      const anchor = config.machines.find(m => m.anchor);
      return anchor ? projectSourceOn(await projectOf(projectId), anchor.hostId) : null;
    },
    unitState: unitId => bb.storage.kv.get<ProjectSyncState>(STATE_KEY(unitId)),
    async liveThreads(ids) {
      const live = new Set<string>();
      for (let i = 0; i < ids.length; i += 200) {
        const raw = await bb.sdk.threads.list({ threadIds: ids.slice(i, i + 200), archived: false, includeHidden: true } as never) as unknown;
        const items = Array.isArray(raw) ? raw : Array.isArray((raw as { threads?: unknown[] })?.threads) ? (raw as { threads: unknown[] }).threads : [];
        for (const item of items as { id?: unknown; archivedAt?: unknown; deletedAt?: unknown }[]) {
          if (typeof item.id === 'string' && !item.archivedAt && !item.deletedAt) live.add(item.id);
        }
      }
      return live;
    },
    async retiredMachines() { const { config } = await loadConfig(); return retiredMachines(config, await seenMachines()); },
    call,
    async forgetUnit(unitId) { await bb.storage.kv.delete(UNIT_KEY(unitId)); await bb.storage.kv.delete(STATE_KEY(unitId)); },
    log: line => bb.log.info(line),
  };

  return {
    gc: async options => {
      const { config } = await loadConfig();
      return runGc(gcPorts, { ...options, ignores: options.ignores ?? syncIgnores(config) });
    },
    prepareTurn: async (thread, step, progress) => {
      await rememberMachine(step.hostId).catch(() => undefined);
      return orchestrator.prepareTurn(await unitOf(thread), step, progress);
    },
    finishTurn: async (thread, step) => orchestrator.finishTurn(await unitOf(thread), step),
    writerOf: async thread => orchestrator.writerOf((await unitOf(thread)).projectId),
    folderOn: async (thread, hostId) => folderIn(await context((await unitOf(thread)).projectId), hostId),
    applyMode: projectId => orchestrator.applyMode(projectId),
    teardown: (projectId, options) => orchestrator.teardown(projectId, options),
    async status(projectId) {
      const { config } = await loadConfig();
      return { ...(await orchestrator.status(projectId)), mode: syncModeOf(config, projectId) };
    },
    anchorSsh,
    async setAnchorSsh(hostId, target) {
      if (target === null) { await bb.storage.kv.delete(SSH_KEY(hostId)); return; }
      if (!SSH_TARGET.test(target)) throw new Error('SSH-цель: имя из ~/.ssh/config или user@host, без пробелов и особых символов');
      await bb.storage.kv.set(SSH_KEY(hostId), target);
    },
  };
}

// ---- RPC экрана и CLI: статус проекта, SSH-цель опоры, режим, уборка ----

const resultSchema = z.object({
  ok: z.boolean(), reason: z.string().nullable(), message: z.string().nullable(), conflicts: z.array(z.string()),
  timings: z.array(z.object({ step: z.string(), hostId: z.string(), from: z.string().optional(), to: z.string().optional(), seconds: z.number(), ok: z.boolean(), detail: z.string().optional() })),
  notices: z.array(z.string()),
});

export const syncRpcContract = defineRpcContract({
  syncStatus: {
    input: z.object({ projectId: z.string().min(1) }),
    output: z.object({ mode: z.enum(['lazy', 'warm', 'off']), writer: z.object({ hostId: z.string(), threadId: z.string(), since: z.number() }).nullable(), anchorTurns: z.array(z.string()) }),
  },
  syncAnchorSsh: { input: z.object({ hostId: z.string().min(1) }), output: z.object({ target: z.string().nullable() }) },
  syncSetAnchorSsh: { input: z.object({ hostId: z.string().min(1), target: z.string().nullable() }), output: z.object({ target: z.string().nullable() }) },
  syncApplyMode: { input: z.object({ projectId: z.string().min(1) }), output: resultSchema },
  syncTeardown: { input: z.object({ projectId: z.string().min(1), removeMount: z.boolean().default(false) }), output: resultSchema },
});

const toWire = (r: SyncResult) => ({
  ok: r.ok, reason: r.ok ? null : r.reason, message: r.ok ? null : r.message, conflicts: r.ok ? [] : r.conflicts, timings: r.timings, notices: r.notices,
});

/** Сервис синхронизации и его RPC. Исполнитель хода берёт prepareTurn / finishTurn из результата. */
export function registerSyncServer(bb: BbPluginApi, loadConfig: () => Promise<{ config: CascadeConfig }>): SyncService {
  const service = createSyncService(bb, loadConfig);
  bb.rpc.register(syncRpcContract, {
    syncStatus: async ({ projectId }) => {
      const status = await service.status(projectId);
      return { mode: status.mode, writer: status.writer ? { hostId: status.writer.hostId, threadId: status.writer.threadId, since: status.writer.since } : null, anchorTurns: Object.keys(status.anchorTurns) };
    },
    syncAnchorSsh: async ({ hostId }) => ({ target: await service.anchorSsh(hostId) }),
    syncSetAnchorSsh: async ({ hostId, target }) => { await service.setAnchorSsh(hostId, target); return { target: await service.anchorSsh(hostId) }; },
    syncApplyMode: async ({ projectId }) => toWire(await service.applyMode(projectId)),
    syncTeardown: async ({ projectId, removeMount }) => toWire(await service.teardown(projectId, { removeMount })),
  }, { experimental_discoverable: true, experimental_description: 'Каскад подписок: синхронизация проекта — статус, SSH к опоре (лучше задавать в настройках «Машины»), режим, уборка.' });
  return service;
}
