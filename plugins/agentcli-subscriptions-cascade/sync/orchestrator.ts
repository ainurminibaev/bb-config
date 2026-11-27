// Оркестрация Mutagen для исполнителя хода: prepareTurn / finishTurn.
// Порядок — из теста А2 (research/test-a2-mutagen.md, «Порядок передачи хода»):
//
// Начало хода на исполнителе M (не опора):
//   bind mount на опоре → сессии W и R (создать, если нет) → карантин опоздавших
//   записей M («Ленивый») → права `.env*` на опоре → R: resume, flush, проверка,
//   pause (копия M = опора) → W: resume, flush, проверка. Ошибка — ход не идёт.
// Конец хода на M:
//   flush W → застрявшие `.git/**/*.lock` (без живого git — снять, flush) →
//   `sync list` JSON: конфликт только в `.git/index` — в пользу M, иначе отказ →
//   0600 файлам `.env*`, которые были 0600 → pause W → stat-снимок M →
//   «Тёплый»: resume R.
// Ход на опоре — только учёт (кто пишет), команд Mutagen нет.
//
// В каждый момент проект пишет одна машина: пока W открыт у одного треда,
// ход другого треда того же проекта на другой машине получает отказ `busy`.
import { posix } from 'node:path';
import type { z } from 'zod';
import type { SyncHostContract } from './contract.ts';
import { createArgs, evaluateHealth, listArgs, onlyGitIndexConflict, parseSessionList, projectSelector, sessionArgs, sessionName, specFingerprint, type SymlinkMode, type SessionRole, type SessionSpec, type SessionState, type SyncModeExt } from './mutagen.ts';

type Method = keyof SyncHostContract & string;
export type SyncInput<M extends Method> = z.input<SyncHostContract[M]['input']>;
export type SyncOutput<M extends Method> = z.output<SyncHostContract[M]['output']>;
/** Вызов хост-RPC синхронизации на машине (в сервере — bb.hosts.experimental_client). */
export type SyncHostCall = <M extends Method>(hostId: string, method: M, input: SyncInput<M>) => Promise<SyncOutput<M>>;

/** Git-читатели на опоре во время хода другой машины — только так (тест А2, п. 3). */
export const ANCHOR_GIT_ENV: Readonly<Record<string, string>> = Object.freeze({ GIT_OPTIONAL_LOCKS: '0' });

export interface SyncMachine {
  hostId: string;
  label: string;
  sharedPath: string;
  platform: string;
  pathTranslation?: boolean;
}

/** Всё, что нужно знать о проекте на этот ход. Собирает регистрация в сервере. */
export interface SyncProjectContext {
  projectId: string;
  /** Имя папки в общем пути: `/opt/bbfs/<slug>`. */
  slug: string;
  /** Реальная папка проекта на опоре (её подключает bind mount). */
  anchorRealPath: string;
  anchor: SyncMachine;
  /** Включённые машины-исполнители (без опоры). */
  executors: SyncMachine[];
  mode: SyncModeExt;
  ignores: string[];
  /** Режим symlink сессий (symlinkModeFor); не задан — posix-raw. */
  symlinkMode?: SymlinkMode;
  /** SSH-цель опоры с машины-исполнителя (`tru`, `root@host`); null — не настроено. */
  anchorSsh(hostId: string): string | null;
}

export interface WriterState {
  hostId: string;
  threadId: string;
  since: number;
  /** Файлы `.env*` на опоре, у которых до хода было 0600. */
  env600: string[];
}

export interface ProjectSyncState {
  version: 1;
  writer: WriterState | null;
  /** Ходы на опоре: threadId → начало. */
  anchorTurns: Record<string, number>;
}

export interface SyncStore {
  get(projectId: string): Promise<ProjectSyncState | undefined>;
  set(projectId: string, state: ProjectSyncState): Promise<void>;
}

export type SyncStepKind = 'mount' | 'create' | 'quarantine' | 'env-read' | 'align' | 'resume' | 'flush' | 'health' | 'locks' | 'resolve-index' | 'env-restore' | 'pause' | 'snapshot' | 'warm';

/** Замер шага для строки в ленте: «Mac → Tru: flush 0,6 с ✓». */
export interface SyncTiming {
  step: SyncStepKind;
  hostId: string;
  /** Направление для flush/выравнивания: откуда → куда. */
  from?: string;
  to?: string;
  seconds: number;
  ok: boolean;
  detail?: string;
}

export type SyncRefusal = 'sync-off' | 'busy' | 'conflict' | 'git-busy' | 'unsupported' | 'not-configured' | 'error';

export type SyncResult =
  | { ok: true; cwd: string; env: Record<string, string>; timings: SyncTiming[]; notices: string[] }
  | { ok: false; reason: SyncRefusal; message: string; conflicts: string[]; timings: SyncTiming[]; notices: string[] };

export interface SyncThreadRef { threadId: string; projectId: string }
export interface SyncStepRef { hostId: string }

export interface SyncOrchestratorDeps {
  call: SyncHostCall;
  store: SyncStore;
  context(projectId: string): Promise<SyncProjectContext>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Ход другого треда старше этого считается брошенным. По умолчанию 6 ч. */
  staleAfterMs?: number;
  /** Сколько ждать живой git перед отказом. По умолчанию 10 с. */
  gitWaitMs?: number;
  /** Карантин на исполнителе: `<база>/<slug>/<время>/`. */
  quarantineBase?: string;
}

class Refused extends Error {
  readonly reason: SyncRefusal;
  readonly conflicts: string[];
  constructor(reason: SyncRefusal, message: string, conflicts: string[] = []) {
    super(message);
    this.reason = reason;
    this.conflicts = conflicts;
  }
}

const emptyState = (): ProjectSyncState => ({ version: 1, writer: null, anchorTurns: {} });

export function projectRoot(machine: Pick<SyncMachine, 'sharedPath'>, slug: string): string {
  return posix.join(machine.sharedPath.replace(/\/+$/, '') || '/', slug);
}

/** Имя папки проекта в общем пути: латиница, цифры, «-», «_», «.». */
export function projectSlug(name: string, fallbackId: string): string {
  const slug = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 64);
  return slug || fallbackId.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
}

export class SyncOrchestrator {
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  private readonly deps: SyncOrchestratorDeps;

  constructor(deps: SyncOrchestratorDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
  }

  /** Подготовить файлы к ходу треда на машине ступени. Повтор безопасен. */
  prepareTurn(thread: SyncThreadRef, step: SyncStepRef): Promise<SyncResult> {
    return this.exclusive(thread.projectId, () => this.run((timings, notices) => this.doPrepare(thread, step, timings, notices)));
  }

  /** Закрыть ход: вернуть изменения на опору и снять писателя. Повтор безопасен. */
  finishTurn(thread: SyncThreadRef, step: SyncStepRef): Promise<SyncResult> {
    return this.exclusive(thread.projectId, () => this.run((timings, notices) => this.doFinish(thread, step, timings, notices)));
  }

  /** Привести сессии проекта к режиму (после смены настройки). Писателя не трогает. */
  applyMode(projectId: string): Promise<SyncResult> {
    return this.exclusive(projectId, () => this.run(async (timings, notices) => {
      const ctx = await this.deps.context(projectId);
      const state = await this.load(projectId);
      for (const machine of ctx.executors) {
        if (state.writer?.hostId === machine.hostId) { notices.push(`${machine.label}: идёт ход, режим применится после него`); continue; }
        const sessions = await this.sessions(machine.hostId, projectId);
        const r = sessions.get(sessionName(projectId, machine.hostId, 'r'));
        if (ctx.mode === 'off') {
          await this.mutagenOk(machine.hostId, ['sync', 'terminate', '--label-selector', projectSelector(projectId)], 60_000);
        } else if (ctx.mode === 'warm' && r?.paused) {
          await this.timed(timings, 'warm', machine.hostId, () => this.mutagenOk(machine.hostId, sessionArgs('resume', r.name), 60_000));
        } else if (ctx.mode === 'lazy' && r && !r.paused) {
          await this.timed(timings, 'pause', machine.hostId, () => this.mutagenOk(machine.hostId, sessionArgs('pause', r.name), 60_000));
        }
      }
      return { cwd: projectRoot(ctx.anchor, ctx.slug), env: {} };
    }));
  }

  /** Убрать сессии проекта на всех исполнителях (и при желании bind mount на опоре). */
  teardown(projectId: string, options: { removeMount?: boolean } = {}): Promise<SyncResult> {
    return this.exclusive(projectId, () => this.run(async () => {
      const ctx = await this.deps.context(projectId);
      const state = await this.load(projectId);
      if (state.writer) throw new Refused('busy', `Идёт ход на ${this.label(ctx, state.writer.hostId)}: сначала закройте его`);
      for (const machine of ctx.executors) await this.mutagenOk(machine.hostId, ['sync', 'terminate', '--label-selector', projectSelector(projectId)], 60_000);
      if (options.removeMount) await this.deps.call(ctx.anchor.hostId, 'syncRemoveBindMount', { target: projectRoot(ctx.anchor, ctx.slug) });
      await this.deps.store.set(projectId, emptyState());
      return { cwd: projectRoot(ctx.anchor, ctx.slug), env: {} };
    }));
  }

  /** Кто сейчас пишет в проект (для публичного статуса треда). */
  async status(projectId: string): Promise<ProjectSyncState> {
    return this.load(projectId);
  }

  // ---- Шаги ----

  private async doPrepare(thread: SyncThreadRef, step: SyncStepRef, timings: SyncTiming[], notices: string[]) {
    const ctx = await this.deps.context(thread.projectId);
    const state = await this.load(thread.projectId);
    const host = step.hostId;
    const anchor = ctx.anchor.hostId;
    const now = this.now();
    const stale = (since: number) => now - since > (this.deps.staleAfterMs ?? 6 * 3600_000);

    // Открытый писатель: свой незакрытый ход закрываем, чужой живой — отказ.
    if (state.writer) {
      const writer = state.writer;
      if (writer.threadId !== thread.threadId && !stale(writer.since)) {
        throw new Refused('busy', `Проект сейчас пишет другой тред на ${this.label(ctx, writer.hostId)}: ход подождёт его конца`);
      }
      await this.release(ctx, state, timings, notices);
    }
    for (const [threadId, since] of Object.entries(state.anchorTurns)) if (threadId === thread.threadId || stale(since)) delete state.anchorTurns[threadId];

    if (host === anchor) {
      const cwd = await this.ensureMount(ctx, timings, ctx.mode === 'off');
      state.anchorTurns[thread.threadId] = now;
      await this.deps.store.set(thread.projectId, state);
      return { cwd, env: {} };
    }

    if (ctx.mode === 'off') throw new Refused('sync-off', 'Синхронизация проекта выключена: ход возможен только на опорной машине');
    const machine = ctx.executors.find(m => m.hostId === host);
    if (!machine) throw new Refused('unsupported', `Машина ${host} не участвует в синхронизации проекта`);
    if (machine.pathTranslation || machine.platform === 'windows') throw new Refused('unsupported', `${machine.label}: нативный Windows пока не синхронизируется (нужен перевод путей)`);
    const busy = Object.keys(state.anchorTurns);
    if (busy.length) throw new Refused('busy', `На ${ctx.anchor.label} идёт ход другого треда этого проекта: ход подождёт его конца`);
    const ssh = ctx.anchorSsh(host);
    if (!ssh) throw new Refused('not-configured', `${machine.label}: не задан SSH-доступ к ${ctx.anchor.label} для Mutagen. Задайте его в настройках «Каскада»: Машины → ${machine.label} → «SSH к опоре» (имя из ~/.ssh/config на ${machine.label} или user@host).`);

    await this.ensureMount(ctx, timings, false);
    const root = projectRoot(machine, ctx.slug);
    const anchorRoot = projectRoot(ctx.anchor, ctx.slug);
    const created = await this.ensureSessions(ctx, machine, ssh, timings, notices);

    // Карантин опоздавших записей M: только «Ленивый» (в «Тёплом» R работает между ходами).
    if (ctx.mode === 'lazy' && !created.beta) {
      const q = await this.timed(timings, 'quarantine', host, () => this.deps.call(host, 'syncQuarantine', { root, key: this.snapshotKey(ctx, machine), ignores: ctx.ignores, quarantineBase: this.quarantineBase(ctx) }),
        out => (out.changed || out.deleted ? `отложено ${out.changed} изм., ${out.deleted} удал.` : undefined));
      if (q.dir) notices.push(`Отложено файлов ${machine.label}: ${q.changed} изменённых, ${q.deleted} удалённых — ${q.dir}`);
    }

    const env = await this.timed(timings, 'env-read', anchor, () => this.deps.call(anchor, 'syncEnvModes', { root: anchorRoot, ignores: ctx.ignores }));
    const env600 = env.files.filter(f => (f.mode & 0o777) === 0o600).map(f => f.path);

    // Выравнивание по опоре через реплику R.
    const r = sessionName(ctx.projectId, host, 'r');
    const w = sessionName(ctx.projectId, host, 'w');
    await this.timed(timings, 'align', host, async () => {
      await this.mutagenOk(host, sessionArgs('resume', r), 120_000);
      await this.mutagenOk(host, sessionArgs('flush', r), created.fresh ? 600_000 : 180_000);
      const health = await this.health(host, ctx.projectId, r);
      await this.mutagenOk(host, sessionArgs('pause', r), 60_000);
      pushWarnings(notices, `Выравнивание ${machine.label}`, health.warnings);
      if (!health.ok) throw new Refused('error', `Выравнивание ${machine.label} по ${ctx.anchor.label} не прошло: ${health.reasons.join('; ')}`, health.conflicts);
    }, undefined, { from: anchor, to: host });

    await this.timed(timings, 'resume', host, () => this.mutagenOk(host, sessionArgs('resume', w), 120_000));
    await this.timed(timings, 'flush', host, () => this.mutagenOk(host, sessionArgs('flush', w), 180_000), undefined, { from: anchor, to: host });
    const health = await this.timed(timings, 'health', host, () => this.health(host, ctx.projectId, w), h => (h.ok ? undefined : h.reasons.join('; ')));
    if (!health.ok) {
      await this.mutagenOk(host, sessionArgs('pause', w), 60_000).catch(() => undefined);
      throw new Refused(health.conflicts.length ? 'conflict' : 'error', `${machine.label}: синхронизация не готова — ${health.reasons.join('; ')}`, health.conflicts);
    }
    pushWarnings(notices, `${ctx.anchor.label} → ${machine.label}`, health.warnings);

    state.writer = { hostId: host, threadId: thread.threadId, since: now, env600 };
    await this.deps.store.set(thread.projectId, state);
    return { cwd: root, env: {} };
  }

  private async doFinish(thread: SyncThreadRef, step: SyncStepRef, timings: SyncTiming[], notices: string[]) {
    const ctx = await this.deps.context(thread.projectId);
    const state = await this.load(thread.projectId);
    if (step.hostId === ctx.anchor.hostId) {
      delete state.anchorTurns[thread.threadId];
      await this.deps.store.set(thread.projectId, state);
      return { cwd: projectRoot(ctx.anchor, ctx.slug), env: {} };
    }
    const machine = ctx.executors.find(m => m.hostId === step.hostId);
    if (!state.writer || state.writer.threadId !== thread.threadId || state.writer.hostId !== step.hostId) {
      return { cwd: machine ? projectRoot(machine, ctx.slug) : projectRoot(ctx.anchor, ctx.slug), env: {} };
    }
    await this.release(ctx, state, timings, notices);
    return { cwd: projectRoot(ctx.anchor, ctx.slug), env: {} };
  }

  /** Конец хода писателя: вернуть его изменения на опору и поставить W на паузу. */
  private async release(ctx: SyncProjectContext, state: ProjectSyncState, timings: SyncTiming[], notices: string[]) {
    const writer = state.writer!;
    const host = writer.hostId;
    const anchor = ctx.anchor.hostId;
    const machine = ctx.executors.find(m => m.hostId === host);
    if (!machine) throw new Refused('unsupported', `Пишущая машина ${host} больше не в каскаде: закройте её сессию вручную`);
    const root = projectRoot(machine, ctx.slug);
    const anchorRoot = projectRoot(ctx.anchor, ctx.slug);
    const w = sessionName(ctx.projectId, host, 'w');
    const flush = () => this.mutagenOk(host, sessionArgs('flush', w), 180_000);

    await this.timed(timings, 'flush', host, flush, undefined, { from: host, to: anchor });

    // Застрявшие lock-файлы git на исполнителе.
    let locks = await this.deps.call(host, 'syncGitLocks', { root });
    if (locks.locks.length) {
      const started = this.now();
      while (locks.gitRunning && this.now() - started < (this.deps.gitWaitMs ?? 10_000)) {
        await this.sleep(1_000);
        locks = await this.deps.call(host, 'syncGitLocks', { root });
      }
      if (locks.locks.length && locks.gitRunning) throw new Refused('git-busy', `${machine.label}: git ещё работает (${locks.locks.join(', ')}) — ход не передаётся`);
      if (locks.locks.length) {
        const removed = await this.timed(timings, 'locks', host, () => this.deps.call(host, 'syncRemoveGitFiles', { root, paths: locks.locks }), out => `снято: ${out.removed.join(', ')}`);
        if (removed.removed.length) notices.push(`${machine.label}: снят застрявший ${removed.removed.join(', ')}`);
        await flush();
      }
    }

    let health = await this.timed(timings, 'health', host, () => this.health(host, ctx.projectId, w), h => (h.ok ? undefined : h.reasons.join('; ')));
    if (!health.ok && onlyGitIndexConflict(health)) {
      const session = (await this.sessions(host, ctx.projectId)).get(w);
      if (session && evaluateHealth({ ...session, conflicts: [] }).ok) {
        // Читатель на опоре обновил stat-кэш индекса: побеждает пишущая сторона.
        await this.timed(timings, 'resolve-index', anchor, async () => {
          await this.deps.call(anchor, 'syncRemoveGitFiles', { root: anchorRoot, paths: ['.git/index'] });
          await flush();
        }, undefined, { from: host, to: anchor });
        health = await this.health(host, ctx.projectId, w);
        if (health.ok) notices.push(`Конфликт .git/index решён в пользу ${machine.label}`);
      }
    }
    pushWarnings(notices, `${machine.label} → ${ctx.anchor.label}`, health.warnings);
    if (!health.ok) {
      throw new Refused(health.conflicts.length ? 'conflict' : 'error', `${machine.label} → ${ctx.anchor.label}: ход не передаётся — ${health.reasons.join('; ')}`, health.conflicts);
    }

    if (writer.env600.length) {
      await this.timed(timings, 'env-restore', anchor, () => this.deps.call(anchor, 'syncChmod', { root: anchorRoot, paths: writer.env600, mode: 0o600 }),
        out => (out.changed.length ? `0600: ${out.changed.join(', ')}` : undefined));
    }
    await this.timed(timings, 'pause', host, () => this.mutagenOk(host, sessionArgs('pause', w), 60_000));
    await this.timed(timings, 'snapshot', host, () => this.deps.call(host, 'syncSnapshot', { root, key: this.snapshotKey(ctx, machine), ignores: ctx.ignores }), out => `${out.entries} записей`);
    if (ctx.mode === 'warm') await this.timed(timings, 'warm', host, () => this.mutagenOk(host, sessionArgs('resume', sessionName(ctx.projectId, host, 'r')), 120_000));

    state.writer = null;
    await this.deps.store.set(ctx.projectId, state);
  }

  /** W и R есть и с нужными настройками; нет — создаются (на паузе). */
  private async ensureSessions(ctx: SyncProjectContext, machine: SyncMachine, ssh: string, timings: SyncTiming[], notices: string[]): Promise<{ beta: boolean; fresh: boolean }> {
    const host = machine.hostId;
    const root = projectRoot(machine, ctx.slug);
    const alpha = `${ssh}:${projectRoot(ctx.anchor, ctx.slug)}`;
    const sessions = await this.sessions(host, ctx.projectId);
    const missing: SessionSpec[] = [];
    for (const role of ['r', 'w'] as SessionRole[]) {
      const spec: SessionSpec = { projectId: ctx.projectId, hostId: host, role, alpha, beta: root, ignores: ctx.ignores, symlinkMode: ctx.symlinkMode ?? 'posix-raw' };
      const existing = sessions.get(sessionName(ctx.projectId, host, role));
      if (existing && existing.labels['bbc-cfg'] === specFingerprint(spec)) continue;
      if (existing) await this.mutagenOk(host, sessionArgs('terminate', existing.name), 60_000);
      missing.push(spec);
    }
    if (!missing.length) return { beta: false, fresh: false };
    let beta = false;
    await this.timed(timings, 'create', host, async () => {
      // Обе сессии пересоздаются — корень исполнителя готовится заново (снимка нет — чужое в карантин).
      if (missing.length === 2) {
        const prepared = await this.deps.call(host, 'syncPrepareBeta', { root, key: this.snapshotKey(ctx, machine), quarantineBase: this.quarantineBase(ctx) });
        beta = prepared.created;
        if (prepared.movedTo) notices.push(`${machine.label}: прежнее содержимое ${root} перенесено в ${prepared.movedTo}`);
      }
      for (const spec of missing) await this.mutagenOk(host, createArgs(spec), 120_000);
      if (ctx.symlinkMode === 'portable') notices.push('В каскаде есть нативный Windows: символические ссылки переносятся в режиме portable, абсолютные ссылки не синхронизируются');
    }, () => `${missing.map(s => s.role.toUpperCase()).join(' и ')}${beta ? ', первая синхронизация' : ''}`);
    return { beta, fresh: missing.length === 2 };
  }

  private async ensureMount(ctx: SyncProjectContext, timings: SyncTiming[], tolerate: boolean): Promise<string> {
    const target = projectRoot(ctx.anchor, ctx.slug);
    try {
      await this.timed(timings, 'mount', ctx.anchor.hostId, () => this.deps.call(ctx.anchor.hostId, 'syncEnsureBindMount', { source: ctx.anchorRealPath, target }), out => out.status);
      return target;
    } catch (error) {
      if (tolerate) return ctx.anchorRealPath;
      throw error;
    }
  }

  // ---- Вспомогательное ----

  /** Здоровье сессии; переходный статус сразу после flush перечитываем до ~5 с. */
  private async health(hostId: string, projectId: string, name: string) {
    let health = evaluateHealth((await this.sessions(hostId, projectId)).get(name));
    for (let attempt = 0; !health.ok && health.transient && attempt < 10; attempt++) {
      await this.sleep(500);
      health = evaluateHealth((await this.sessions(hostId, projectId)).get(name));
    }
    return health;
  }

  private async sessions(hostId: string, projectId: string): Promise<Map<string, SessionState>> {
    const out = await this.mutagenOk(hostId, listArgs(projectSelector(projectId)), 60_000);
    return new Map(parseSessionList(out.stdout).map(s => [s.name, s]));
  }

  private async mutagenOk(hostId: string, args: string[], timeoutMs: number) {
    const out = await this.deps.call(hostId, 'syncMutagen', { args, timeoutMs });
    if (out.exitCode !== 0) throw new Refused('error', `mutagen ${args.slice(0, 2).join(' ')}: ${(out.stderr || out.stdout).trim().split('\n').slice(-2).join(' ').slice(0, 300) || `код ${out.exitCode}`}`);
    return out;
  }

  private async timed<T>(timings: SyncTiming[], step: SyncStepKind, hostId: string, fn: () => Promise<T>, detail?: (value: T) => string | undefined, route?: { from: string; to: string }): Promise<T> {
    const t0 = performance.now();
    try {
      const value = await fn();
      timings.push({ step, hostId, ...route, seconds: round((performance.now() - t0) / 1000), ok: true, ...(detail?.(value) ? { detail: detail(value) } : {}) });
      return value;
    } catch (error) {
      timings.push({ step, hostId, ...route, seconds: round((performance.now() - t0) / 1000), ok: false, detail: error instanceof Error ? error.message.slice(0, 200) : String(error) });
      throw error;
    }
  }

  private async run(fn: (timings: SyncTiming[], notices: string[]) => Promise<{ cwd: string; env: Record<string, string> }>): Promise<SyncResult> {
    const timings: SyncTiming[] = [];
    const notices: string[] = [];
    try {
      const { cwd, env } = await fn(timings, notices);
      return { ok: true, cwd, env, timings, notices };
    } catch (error) {
      if (error instanceof Refused) return { ok: false, reason: error.reason, message: error.message, conflicts: error.conflicts, timings, notices };
      return { ok: false, reason: 'error', message: error instanceof Error ? error.message : String(error), conflicts: [], timings, notices };
    }
  }

  private exclusive<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(projectId) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.locks.set(projectId, tail);
    void tail.then(() => { if (this.locks.get(projectId) === tail) this.locks.delete(projectId); });
    return next;
  }

  private async load(projectId: string): Promise<ProjectSyncState> {
    const saved = await this.deps.store.get(projectId).catch(() => undefined);
    if (!saved || saved.version !== 1) return emptyState();
    return { version: 1, writer: saved.writer ?? null, anchorTurns: { ...(saved.anchorTurns ?? {}) } };
  }

  private snapshotKey(ctx: SyncProjectContext, machine: SyncMachine) {
    return `${ctx.projectId}:${machine.hostId}:${projectRoot(machine, ctx.slug)}`;
  }

  private quarantineBase(ctx: SyncProjectContext) {
    return posix.join(this.deps.quarantineBase ?? '~/bbfs-quarantine', ctx.slug);
  }

  private label(ctx: SyncProjectContext, hostId: string) {
    return hostId === ctx.anchor.hostId ? ctx.anchor.label : ctx.executors.find(m => m.hostId === hostId)?.label ?? hostId;
  }
}

const round = (n: number) => Math.round(n * 100) / 100;

/** Предупреждения сканирования → строки уведомлений (без дублей, не длиннее строки ленты). */
function pushWarnings(notices: string[], where: string, warnings: readonly string[]): void {
  for (const w of warnings) {
    const line = `${where}: ${w}`.slice(0, 280);
    if (!notices.includes(line)) notices.push(line);
  }
}
