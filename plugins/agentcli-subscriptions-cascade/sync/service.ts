// Серверная обвязка синхронизации: оркестратор поверх хост-RPC плагина,
// конфигурации каскада и проектов BB. Исполнитель хода получает отсюда
// prepareTurn / finishTurn.
//
// SSH-цель опоры для каждой машины-исполнителя (`tru`, `root@host`) задаётся
// в настройках машины (`machine.anchorSsh`, секция «Машины»). Прежнее значение
// из bb.storage.kv `sync:anchor-ssh:<hostId>` читается, если поле пустое.
import { defineRpcContract, type BbPluginApi } from '@get-bb/plugin-sdk';
import { posix } from 'node:path';
import { z } from 'zod';
import { syncIgnores } from '../config.ts';
import type { CascadeConfig, Machine } from '../contract.ts';
import { syncHostContract } from './contract.ts';
import { symlinkModeFor, type SyncModeExt } from './mutagen.ts';
import { projectSlug, SyncOrchestrator, type ProjectSyncState, type SyncHostCall, type SyncMachine, type SyncProjectContext, type SyncResult, type SyncStepRef, type SyncThreadRef } from './orchestrator.ts';

export interface SyncService {
  prepareTurn(thread: SyncThreadRef, step: SyncStepRef): Promise<SyncResult>;
  finishTurn(thread: SyncThreadRef, step: SyncStepRef): Promise<SyncResult>;
  applyMode(projectId: string): Promise<SyncResult>;
  teardown(projectId: string, options?: { removeMount?: boolean }): Promise<SyncResult>;
  status(projectId: string): Promise<ProjectSyncState & { mode: SyncModeExt }>;
  anchorSsh(hostId: string): Promise<string | null>;
  setAnchorSsh(hostId: string, target: string | null): Promise<void>;
}

const SSH_KEY = (hostId: string) => `sync:anchor-ssh:${hostId}`;
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

export function buildContext(args: { config: CascadeConfig; projectId: string; projectName: string; anchorSource: string | null; ssh: ReadonlyMap<string, string> }): SyncProjectContext {
  const { config, projectId } = args;
  const anchor = config.machines.find(m => m.anchor) ?? null;
  if (!anchor) throw new Error('В каскаде не выбрана опорная машина');
  if (!args.anchorSource) throw new Error(`У проекта нет папки на опорной машине ${anchor.label}`);
  const real = args.anchorSource.replace(/\/+$/, '');
  const shared = anchor.sharedPath.replace(/\/+$/, '');
  // Проект уже лежит в общем пути — его имя и есть папка; иначе имя реальной папки.
  const slug = posix.dirname(real) === shared ? posix.basename(real) : projectSlug(posix.basename(real) || args.projectName, projectId);
  return {
    projectId,
    slug,
    anchorRealPath: real,
    anchor: toSyncMachine(anchor),
    executors: config.machines.filter(m => m.enabled && !m.anchor).map(toSyncMachine),
    mode: syncModeOf(config, projectId),
    ignores: syncIgnores(config),
    symlinkMode: symlinkModeFor([anchor, ...config.machines.filter(m => m.enabled && !m.anchor)]),
    anchorSsh: hostId => args.ssh.get(hostId) ?? null,
  };
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

  async function context(projectId: string): Promise<SyncProjectContext> {
    const { config } = await loadConfig();
    const anchor = config.machines.find(m => m.anchor);
    const project = await bb.sdk.projects.get({ projectId } as Parameters<typeof bb.sdk.projects.get>[0]).catch(() => null);
    const ssh = new Map<string, string>();
    for (const m of config.machines) {
      if (m.anchor) continue;
      const target = machineAnchorSsh(m) ?? await anchorSsh(m.hostId);
      if (target) ssh.set(m.hostId, target);
    }
    const name = (project as { name?: unknown } | null)?.name;
    return buildContext({ config, projectId, projectName: typeof name === 'string' ? name : projectId, anchorSource: anchor ? projectSourceOn(project, anchor.hostId) : null, ssh });
  }

  const orchestrator = new SyncOrchestrator({
    call,
    context,
    store: {
      get: id => bb.storage.kv.get<ProjectSyncState>(STATE_KEY(id)),
      set: (id, state) => bb.storage.kv.set(STATE_KEY(id), state),
    },
  });

  return {
    prepareTurn: (thread, step) => orchestrator.prepareTurn(thread, step),
    finishTurn: (thread, step) => orchestrator.finishTurn(thread, step),
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
  });
  return service;
}
