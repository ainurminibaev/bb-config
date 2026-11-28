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
import { AsyncLocalStorage } from 'node:async_hooks';
import { transferProgress, type TransferProgress } from './mutagen.ts';
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
  /**
   * Машины, которые раньше были исполнителями, а теперь выключены или убраны из
   * каскада (0.3.1): нужны, чтобы закрыть оставшийся там выход писателя и для gc.
   */
  retired?: SyncMachine[];
  mode: SyncModeExt;
  ignores: string[];
  /** Режим symlink сессий (symlinkModeFor); не задан — posix-raw. */
  symlinkMode?: SymlinkMode;
  /** SSH-цель опоры с машины-исполнителя (`tru`, `root@host`); null — не настроено. */
  anchorSsh(hostId: string): string | null;
  /**
   * 0.3.6: «тёплый хвост» ленивого режима, мс. После хода W остаётся запущенным столько
   * (правки обеих сторон продолжают ходить), повторный ход на той же машине готовится
   * одним flush. 0/нет — как раньше: W на паузу и снимок сразу после хода.
   */
  tailMs?: number;
}

export interface WriterState {
  hostId: string;
  threadId: string;
  since: number;
  /** Файлы `.env*` на опоре, у которых до хода было 0600. */
  env600: string[];
  /**
   * Все треды, пишущие сейчас на этой машине (0.3.0): тред → начало хода.
   * Писатели одной машины пишут одну реплику — входят без ожидания; ждут только
   * писатели с другой машины. Нет поля — писатель один (`threadId`).
   */
  threads?: Record<string, number>;
  /** Папка реплики на машине писателя и подпись машины — на случай, если машину уберут из каскада (0.3.1). */
  root?: string;
  label?: string;
  /** Машина писателя выбыла, а правки ещё не вернулись: с какого момента ждём (0.3.1). */
  drainSince?: number;
}

/** Писатели машины-писателя: тред → начало хода. */
export function writerThreads(writer: WriterState): Record<string, number> {
  return writer.threads && Object.keys(writer.threads).length > 0 ? { ...writer.threads } : { [writer.threadId]: writer.since };
}

/** 0.3.6: после хода W ещё работает до `until` (ленивый режим, тёплый хвост). */
export interface TailState {
  hostId: string;
  threadId: string;
  until: number;
  root: string;
  label: string;
}

export interface ProjectSyncState {
  version: 1;
  writer: WriterState | null;
  /** Ходы на опоре: threadId → начало. */
  anchorTurns: Record<string, number>;
  /** 0.3.6: открытый тёплый хвост; null/нет — W на паузе. */
  tail?: TailState | null;
}

export interface SyncStore {
  get(projectId: string): Promise<ProjectSyncState | undefined>;
  set(projectId: string, state: ProjectSyncState): Promise<void>;
}

export type SyncStepKind = 'mount' | 'create' | 'quarantine' | 'env-read' | 'align' | 'resume' | 'flush' | 'health' | 'locks' | 'resolve-index' | 'env-restore' | 'pause' | 'snapshot' | 'warm' | 'tail';

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

/** Событие подготовки для строки ленты: шаг начался/закончился, счётчики передачи. */
export type SyncProgressEvent =
  | { kind: 'step'; step: SyncStepKind; hostId: string; from?: string; to?: string; state: 'running' | 'done' | 'failed'; ms: number; detail?: string }
  | { kind: 'transfer'; step: SyncStepKind; hostId: string; from?: string; to?: string; progress: TransferProgress };

export type SyncProgress = (event: SyncProgressEvent) => void;

export type SyncRefusal = 'sync-off' | 'busy' | 'conflict' | 'git-busy' | 'unsupported' | 'not-configured' | 'error';

export type SyncResult =
  | { ok: true; cwd: string; env: Record<string, string>; timings: SyncTiming[]; notices: string[] }
  | { ok: false; reason: SyncRefusal; message: string; conflicts: string[]; timings: SyncTiming[]; notices: string[] };

export interface SyncThreadRef {
  threadId: string;
  /**
   * Ключ единицы синхронизации: ID проекта для основной папки проекта или
   * `<проект>~w<хеш>` для отдельной рабочей папки треда (worktree). Блокировка
   * «один писатель», сессии Mutagen и папка в общем пути — свои у каждой единицы.
   */
  projectId: string;
}
export interface SyncStepRef { hostId: string }

export interface SyncOrchestratorDeps {
  call: SyncHostCall;
  store: SyncStore;
  context(projectId: string): Promise<SyncProjectContext>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Ход другого треда старше этого считается брошенным. По умолчанию 6 ч. */
  /** Сколько ждать возврата правок с выбывшей из каскада машины, прежде чем снять её блокировку (0.3.1). По умолчанию 5 мин. */
  retiredWaitMs?: number;
  staleAfterMs?: number;
  /** Сколько ждать живой git перед отказом. По умолчанию 10 с. */
  gitWaitMs?: number;
  /** 0.3.6: отложенное закрытие тёплого хвоста (таймер сервера); нет — закрывает следующая подготовка. */
  schedule?(ms: number, fn: () => void): void;
  /** Карантин на исполнителе: `<база>/<slug>/<время>/`. */
  quarantineBase?: string;
  /** Как часто опрашивать прогресс передачи во время долгого шага. По умолчанию 2 с. */
  progressPollMs?: number;
  /**
   * Жив ли тред (идёт ход): false — блокировка этого треда устарела (тред упал,
   * заархивирован, удалён, ход не идёт). null/undefined — неизвестно: только срок.
   */
  threadActive?(threadId: string): Promise<boolean | null>;
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

  /** Подготовить файлы к ходу треда на машине ступени. Повтор безопасен. `progress` — шаги для строки ленты. */
  prepareTurn(thread: SyncThreadRef, step: SyncStepRef, progress?: SyncProgress): Promise<SyncResult> {
    return this.exclusive(thread.projectId, () => this.withProgress(progress, () => this.run((timings, notices) => this.doPrepare(thread, step, timings, notices))));
  }

  /** Закрыть ход: вернуть изменения на опору и снять писателя. Повтор безопасен. */
  finishTurn(thread: SyncThreadRef, step: SyncStepRef, progress?: SyncProgress): Promise<SyncResult> {
    return this.exclusive(thread.projectId, () => this.withProgress(progress, () => this.run((timings, notices) => this.doFinish(thread, step, timings, notices))));
  }

  private readonly progressStore = new AsyncLocalStorage<SyncProgress>();

  private withProgress<T>(progress: SyncProgress | undefined, fn: () => Promise<T>): Promise<T> {
    return progress ? this.progressStore.run(progress, fn) : fn();
  }

  private emit(event: SyncProgressEvent): void {
    try { this.progressStore.getStore()?.(event); } catch { /* прогресс не обязателен */ }
  }

  /**
   * Пока идёт долгий шаг Mutagen (выравнивание, flush) — опрос `sync list`
   * раз в `progressPollMs` и событие с счётчиками передачи. Без слушателя не опрашивает.
   */
  private async watching<T>(step: SyncStepKind, host: string, unit: string, session: string, route: { from: string; to: string } | undefined, fn: () => Promise<T>): Promise<T> {
    if (!this.progressStore.getStore()) return fn();
    let stopped = false;
    const poll = async () => {
      while (!stopped) {
        await this.sleepReal(this.deps.progressPollMs ?? 2_000);
        if (stopped) break;
        const state = await this.sessions(host, unit).then(m => m.get(session)).catch(() => undefined);
        const progress = transferProgress(state);
        if (progress && !stopped) this.emit({ kind: 'transfer', step, hostId: host, ...route, progress });
      }
    };
    const poller = poll();
    try { return await fn(); } finally { stopped = true; await poller.catch(() => undefined); }
  }

  /** Пауза опроса прогресса: настоящий таймер (тестовый sleep сдвигает часы). */
  private sleepReal(ms: number): Promise<void> {
    return new Promise(resolve => { const t = setTimeout(resolve, ms); (t as { unref?: () => void }).unref?.(); });
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

    const abandoned = (threadId: string, since: number) => this.abandoned(threadId, since, now);
    void stale;

    // 0.3.6: тёплый хвост. Та же машина, срок не вышел, писателя нет — быстрый путь
    // (flush W + проверка). Другая машина-исполнитель или срок вышел — сначала обычное
    // закрытие хвоста (flush до опоры, пауза W, снимок). Ход на опоре хвосту не мешает:
    // W двусторонний, как при живом писателе.
    if (state.tail && !state.writer) {
      const tail = state.tail;
      if (tail.hostId === host && now < tail.until && ctx.mode === 'lazy') {
        const fast = await this.tailFastPath(ctx, state, thread, tail, timings, notices);
        if (fast) return fast;
      }
      if (state.tail && (host !== anchor || now >= tail.until)) await this.closeTail(ctx, state, timings, notices);
    }

    // Открытый писатель: свой незакрытый ход закрываем, чужой живой — отказ «busy»
    // (исполнитель ждёт), брошенный — возвращаем его изменения на опору и снимаем.
    // Писатель на машине, которая выбыла из каскада (выключена или убрана), — сначала
    // его обычный выход (flush до опоры, пауза), потом ход; машина недоступна — ждём до
    // N мин, затем снимаем блокировку со строкой, где могли остаться правки (0.3.1).
    if (state.writer && this.writerMachine(ctx, state.writer).retired) {
      await this.drainRetired(ctx, state, thread, timings, notices, now);
    }
    let liveWriters: Record<string, number> = {};
    if (state.writer) {
      const writer = state.writer;
      // Живые писатели, кроме этого треда (свой незакрытый ход закрывается ниже).
      const others: Record<string, number> = {};
      for (const [threadId, since] of Object.entries(writerThreads(writer))) {
        if (threadId !== thread.threadId && !(await abandoned(threadId, since))) others[threadId] = since;
      }
      const liveOthers = Object.keys(others);
      liveWriters = others;
      if (liveOthers.length > 0 && writer.hostId === host) {
        // Та же машина, та же реплика: ещё один писатель, как два треда одной папки в штатном BB.
        return this.joinWriter(ctx, state, thread, writer, others, timings);
      }
      // 0.3.6: свой незакрытый ход на той же машине (finishTurn не дошёл) в ленивом режиме с
      // тёплым хвостом — W ещё работает: тот же быстрый путь (flush W), без полного цикла.
      if (liveOthers.length === 0 && writer.hostId === host && host !== anchor && ctx.mode === 'lazy' && (ctx.tailMs ?? 0) > 0
        && writer.threadId === thread.threadId && !this.writerMachine(ctx, writer).retired) {
        return this.joinWriter(ctx, state, thread, writer, {}, timings);
      }
      if (liveOthers.length > 0 && host !== anchor) {
        throw new Refused('busy', `Рабочую папку сейчас пишет другой тред (${liveOthers.join(', ')}) на ${this.label(ctx, writer.hostId)}`);
      }
    }
    if (state.writer && host === anchor && Object.keys(liveWriters).length > 0) {
      // Ход на опоре при живом писателе на исполнителе: не блокируем. W (two-way-safe) идёт,
      // обе стороны пишут; конфликт одного файла — по правилам two-way-safe, строкой в ленте при возврате.
      const writer = state.writer;
      const threads = liveWriters;
      state.writer = { ...writer, threadId: writer.threadId in threads ? writer.threadId : Object.keys(threads)[0]!, threads };
      notices.push(`${ctx.anchor.label} и ${this.label(ctx, state.writer!.hostId)} пишут рабочую папку одновременно: двусторонняя синхронизация, конфликт одного файла — по правилам two-way-safe`);
    } else if (state.writer) {
      const writer = state.writer;
      const foreign = writer.threadId !== thread.threadId;
      try {
        await this.release(ctx, state, timings, notices);
        if (foreign) notices.push(`Снята блокировка брошенного хода треда ${writer.threadId} на ${this.label(ctx, writer.hostId)}: его изменения возвращены на ${ctx.anchor.label}`);
      } catch (error) {
        if (!foreign) throw error;
        // Брошенный ход не вернулся на опору: блокировку снимаем, его файлы остаются на машине.
        const machine = ctx.executors.find(m => m.hostId === writer.hostId);
        await this.mutagenOk(writer.hostId, sessionArgs('pause', sessionName(ctx.projectId, writer.hostId, 'w')), 60_000).catch(() => undefined);
        state.writer = null;
        await this.deps.store.set(ctx.projectId, state);
        notices.push(`Снята блокировка брошенного хода треда ${writer.threadId}: его изменения не вернулись на ${ctx.anchor.label} (${error instanceof Error ? error.message : String(error)}) и остались на ${this.label(ctx, writer.hostId)}${machine ? ` в ${projectRoot(machine, ctx.slug)}` : ''}`);
      }
    }
    for (const [threadId, since] of Object.entries(state.anchorTurns)) {
      if (threadId === thread.threadId || await abandoned(threadId, since)) delete state.anchorTurns[threadId];
    }

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
    // Ход на опоре идёт: не ждём (0.3.0) — после выравнивания W (two-way-safe) держит обе стороны.
    const anchorBusy = Object.keys(state.anchorTurns);
    if (anchorBusy.length) notices.push(`${ctx.anchor.label} и ${machine.label} пишут рабочую папку одновременно: двусторонняя синхронизация, конфликт одного файла — по правилам two-way-safe`);
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
      await this.watching('align', host, ctx.projectId, r, { from: anchor, to: host }, () => this.mutagenOk(host, sessionArgs('flush', r), created.fresh ? 600_000 : 180_000));
      const health = await this.health(host, ctx.projectId, r);
      await this.mutagenOk(host, sessionArgs('pause', r), 60_000);
      pushWarnings(notices, `Выравнивание ${machine.label}`, health.warnings);
      if (!health.ok) throw new Refused('error', `Выравнивание ${machine.label} по ${ctx.anchor.label} не прошло: ${health.reasons.join('; ')}`, health.conflicts);
    }, undefined, { from: anchor, to: host });

    await this.timed(timings, 'resume', host, () => this.mutagenOk(host, sessionArgs('resume', w), 120_000));
    await this.timed(timings, 'flush', host, () => this.watching('flush', host, ctx.projectId, w, { from: anchor, to: host }, () => this.mutagenOk(host, sessionArgs('flush', w), 180_000)), undefined, { from: anchor, to: host });
    const health = await this.timed(timings, 'health', host, () => this.health(host, ctx.projectId, w), h => (h.ok ? undefined : h.reasons.join('; ')));
    if (!health.ok) {
      await this.mutagenOk(host, sessionArgs('pause', w), 60_000).catch(() => undefined);
      throw new Refused(health.conflicts.length ? 'conflict' : 'error', `${machine.label}: синхронизация не готова — ${health.reasons.join('; ')}`, health.conflicts);
    }
    pushWarnings(notices, `${ctx.anchor.label} → ${machine.label}`, health.warnings);

    state.writer = { hostId: host, threadId: thread.threadId, since: now, env600, threads: { [thread.threadId]: now }, root, label: machine.label };
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
    const threads = state.writer ? writerThreads(state.writer) : {};
    if (!state.writer || !(thread.threadId in threads) || state.writer.hostId !== step.hostId) {
      return { cwd: machine ? projectRoot(machine, ctx.slug) : projectRoot(ctx.anchor, ctx.slug), env: {} };
    }
    delete threads[thread.threadId];
    // Брошенные соседи (тред не идёт) не держат реплику: счётчик не залипает.
    for (const [threadId, since] of Object.entries(threads)) if (await this.abandoned(threadId, since, this.now())) delete threads[threadId];
    const rest = Object.keys(threads);
    if (rest.length > 0 && machine) {
      // На машине пишут другие треды: реплика остаётся открытой, изменения этого хода — на опору.
      const w = sessionName(ctx.projectId, step.hostId, 'w');
      await this.timed(timings, 'flush', step.hostId, () => this.mutagenOk(step.hostId, sessionArgs('flush', w), 180_000), undefined, { from: step.hostId, to: ctx.anchor.hostId });
      state.writer = { ...state.writer, threadId: state.writer.threadId in threads ? state.writer.threadId : rest[0]!, threads };
      await this.deps.store.set(ctx.projectId, state);
      return { cwd: projectRoot(ctx.anchor, ctx.slug), env: {} };
    }
    // 0.3.6: ленивый режим с тёплым хвостом — W не ставится на паузу, следующий ход на этой машине быстрый.
    const tailMs = ctx.mode === 'lazy' && machine ? ctx.tailMs ?? 0 : 0;
    await this.release(ctx, state, timings, notices, tailMs > 0 ? { tailMs, threadId: thread.threadId } : undefined);
    return { cwd: projectRoot(ctx.anchor, ctx.slug), env: {} };
  }

  /**
   * Быстрый путь повторного хода в тёплом хвосте: сессии с той же настройкой — flush W
   * (правки опоры доходят до исполнителя) и проверка; null — настройки сессий сменились,
   * нужен полный путь (хвост закрывается вызывающим).
   */
  private async tailFastPath(ctx: SyncProjectContext, state: ProjectSyncState, thread: SyncThreadRef, tail: TailState, timings: SyncTiming[], notices: string[]) {
    const host = tail.hostId;
    const machine = ctx.executors.find(m => m.hostId === host);
    const ssh = ctx.anchorSsh(host);
    if (!machine || !ssh) return null;
    const alpha = `${ssh}:${projectRoot(ctx.anchor, ctx.slug)}`;
    const sessions = await this.sessions(host, ctx.projectId);
    const same = (['r', 'w'] as SessionRole[]).every(role => {
      const spec: SessionSpec = { projectId: ctx.projectId, hostId: host, role, alpha, beta: projectRoot(machine, ctx.slug), ignores: ctx.ignores, symlinkMode: ctx.symlinkMode ?? 'posix-raw' };
      return sessions.get(sessionName(ctx.projectId, host, role))?.labels['bbc-cfg'] === specFingerprint(spec);
    });
    const w = sessionName(ctx.projectId, host, 'w');
    if (!same || sessions.get(w)?.paused) return null;
    const anchorRoot = projectRoot(ctx.anchor, ctx.slug);
    const [env] = await Promise.all([
      this.timed(timings, 'env-read', ctx.anchor.hostId, () => this.deps.call(ctx.anchor.hostId, 'syncEnvModes', { root: anchorRoot, ignores: ctx.ignores })),
      this.timed(timings, 'flush', host, () => this.mutagenOk(host, sessionArgs('flush', w), 180_000), undefined, { from: ctx.anchor.hostId, to: host }),
    ]);
    const health = await this.timed(timings, 'health', host, () => this.health(host, ctx.projectId, w), h => (h.ok ? undefined : h.reasons.join('; ')));
    if (!health.ok) throw new Refused(health.conflicts.length ? 'conflict' : 'error', `${machine.label}: синхронизация не готова — ${health.reasons.join('; ')}`, health.conflicts);
    pushWarnings(notices, `${ctx.anchor.label} → ${machine.label}`, health.warnings);
    const now = this.now();
    state.writer = { hostId: host, threadId: thread.threadId, since: now, env600: env.files.filter(f => (f.mode & 0o777) === 0o600).map(f => f.path), threads: { [thread.threadId]: now }, root: tail.root, label: machine.label };
    state.tail = null;
    await this.deps.store.set(ctx.projectId, state);
    return { cwd: tail.root, env: {} };
  }

  /** Закрыть тёплый хвост: правки исполнителя — на опору, W на паузу, снимок (как обычный конец хода). */
  private async closeTail(ctx: SyncProjectContext, state: ProjectSyncState, timings: SyncTiming[], notices: string[]) {
    const tail = state.tail!;
    const { machine } = this.writerMachine(ctx, { hostId: tail.hostId, threadId: tail.threadId, since: 0, env600: [], root: tail.root, label: tail.label });
    const w = sessionName(ctx.projectId, tail.hostId, 'w');
    try {
      await this.timed(timings, 'tail', tail.hostId, async () => {
        await this.mutagenOk(tail.hostId, sessionArgs('flush', w), 180_000);
        const health = await this.health(tail.hostId, ctx.projectId, w);
        pushWarnings(notices, `${machine.label} → ${ctx.anchor.label}`, health.warnings);
        if (!health.ok) throw new Refused(health.conflicts.length ? 'conflict' : 'error', `${machine.label} → ${ctx.anchor.label}: хвост не закрыт — ${health.reasons.join('; ')}`, health.conflicts);
        await this.mutagenOk(tail.hostId, sessionArgs('pause', w), 60_000);
        await this.deps.call(tail.hostId, 'syncSnapshot', { root: tail.root, key: this.snapshotKey(ctx, machine), ignores: ctx.ignores });
      }, undefined, { from: tail.hostId, to: ctx.anchor.hostId });
    } catch (error) {
      // Конфликт — ход не передаётся (как у обычного конца хода); машина недоступна — хвост
      // снимается со строкой, правки после последнего хода могли остаться на ней.
      if (error instanceof Refused && error.reason === 'conflict') throw error;
      notices.push(`Тёплый хвост ${machine.label} не закрыт (${error instanceof Error ? error.message.slice(0, 160) : String(error)}): правки после последнего хода могли остаться в ${tail.root}`);
      await this.mutagenOk(tail.hostId, sessionArgs('pause', w), 30_000).catch(() => undefined);
    }
    state.tail = null;
    await this.deps.store.set(ctx.projectId, state);
  }

  /** Поставить закрытие хвоста на его срок (после перезагрузки плагина). */
  scheduleTailClose(projectId: string, until: number): void {
    this.deps.schedule?.(Math.max(0, until - this.now()) + 1_000, () => { void this.closeExpiredTail(projectId); });
  }

  /** Закрыть просроченный тёплый хвост единицы (таймер сервера). Ход идёт — не трогает. */
  closeExpiredTail(projectId: string): Promise<SyncResult> {
    return this.exclusive(projectId, () => this.run(async (timings, notices) => {
      const ctx = await this.deps.context(projectId);
      const state = await this.load(projectId);
      if (state.tail && !state.writer && this.now() >= state.tail.until) await this.closeTail(ctx, state, timings, notices);
      return { cwd: projectRoot(ctx.anchor, ctx.slug), env: {} };
    }));
  }

  /**
   * Блокировка треда устарела по сроку или тред не идёт (упал, заархивирован,
   * удалён): её снимаем, а не ждём.
   */
  private async abandoned(threadId: string, since: number, now: number): Promise<boolean> {
    if (now - since > (this.deps.staleAfterMs ?? 6 * 3600_000)) return true;
    const active = await this.deps.threadActive?.(threadId).catch(() => null);
    return active === false;
  }

  /**
   * Машина писателя: включённый исполнитель или выбывшая (выключена / убрана из
   * каскада). Для убранной путь берётся из записи писателя, иначе из общего пути
   * по умолчанию.
   */
  private writerMachine(ctx: SyncProjectContext, writer: WriterState): { machine: SyncMachine; retired: boolean } {
    const live = ctx.executors.find(m => m.hostId === writer.hostId);
    if (live) return { machine: live, retired: false };
    if (writer.hostId === ctx.anchor.hostId) return { machine: ctx.anchor, retired: false };
    const known = ctx.retired?.find(m => m.hostId === writer.hostId);
    const sharedPath = writer.root ? posix.dirname(writer.root) : known?.sharedPath ?? '/opt/bbfs';
    return { machine: { hostId: writer.hostId, label: known?.label ?? writer.label ?? writer.hostId, sharedPath, platform: known?.platform ?? 'linux' }, retired: true };
  }

  /** Подождать, пока ходы живых писателей на выбывшей машине закончатся, затем закрыть их выход. */
  private async drainRetired(ctx: SyncProjectContext, state: ProjectSyncState, thread: SyncThreadRef, timings: SyncTiming[], notices: string[], now: number) {
    const writer = state.writer!;
    const { machine } = this.writerMachine(ctx, writer);
    const root = writer.root ?? projectRoot(machine, ctx.slug);
    const waitMs = this.deps.retiredWaitMs ?? 5 * 60_000;
    const since = writer.drainSince ?? now;
    const timedOut = now - since >= waitMs;
    const remember = async () => {
      if (writer.drainSince === undefined) { state.writer = { ...writer, drainSince: since }; await this.deps.store.set(ctx.projectId, state); }
    };
    const alive: string[] = [];
    for (const [threadId, at] of Object.entries(writerThreads(writer))) if (threadId !== thread.threadId && !(await this.abandoned(threadId, at, now))) alive.push(threadId);
    if (alive.length > 0 && !timedOut) {
      await remember();
      throw new Refused('busy', `Жду: последние правки на ${machine.label} ещё не вернулись (там идёт ход ${alive.join(', ')}; ${machine.label} больше не в каскаде)`);
    }
    try {
      await this.release(ctx, state, timings, notices);
      notices.push(`${machine.label} больше не в каскаде: её последние правки возвращены на ${ctx.anchor.label}, блокировка снята`);
      return;
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      if (!timedOut) {
        await remember();
        throw new Refused('busy', `Жду: последние правки на ${machine.label} ещё не вернулись (${why.slice(0, 120)})`);
      }
      await this.mutagenOk(writer.hostId, sessionArgs('pause', sessionName(ctx.projectId, writer.hostId, 'w')), 30_000).catch(() => undefined);
      state.writer = null;
      await this.deps.store.set(ctx.projectId, state);
      notices.push(`Блокировка ${machine.label} снята: машина больше не в каскаде и не вернула правки за ${Math.round(waitMs / 60_000)} мин — последние правки, возможно, остались на ${machine.label} в ${root}`);
    }
  }

  /** Писатель единицы (для маршрута: предпочесть его машину, строка ожидания). */
  async writerOf(projectId: string): Promise<{ hostId: string; threadIds: string[] } | null> {
    const state = await this.load(projectId);
    return state.writer ? { hostId: state.writer.hostId, threadIds: Object.keys(writerThreads(state.writer)) } : null;
  }

  /**
   * Ещё один писатель на машине, где реплика уже открыта (W идёт): без
   * выравнивания и карантина — они помешали бы идущему ходу; только flush W,
   * чтобы новый ход видел свежие файлы опоры.
   */
  private async joinWriter(ctx: SyncProjectContext, state: ProjectSyncState, thread: SyncThreadRef, writer: WriterState, others: Record<string, number>, timings: SyncTiming[]) {
    const host = writer.hostId;
    const machine = ctx.executors.find(m => m.hostId === host);
    if (!machine) throw new Refused('unsupported', `Машина ${host} не участвует в синхронизации проекта`);
    const w = sessionName(ctx.projectId, host, 'w');
    await this.timed(timings, 'flush', host, () => this.mutagenOk(host, sessionArgs('flush', w), 180_000), undefined, { from: ctx.anchor.hostId, to: host });
    state.writer = { ...writer, threadId: writer.threadId in others ? writer.threadId : Object.keys(others)[0]!, threads: { ...others, [thread.threadId]: this.now() } };
    await this.deps.store.set(thread.projectId, state);
    return { cwd: projectRoot(machine, ctx.slug), env: {} };
  }

  /** Конец хода писателя: вернуть его изменения на опору и поставить W на паузу. */
  private async release(ctx: SyncProjectContext, state: ProjectSyncState, timings: SyncTiming[], notices: string[], tail?: { tailMs: number; threadId: string }) {
    const writer = state.writer!;
    const host = writer.hostId;
    const anchor = ctx.anchor.hostId;
    // Машина могла выбыть из каскада: выход писателя тот же, через её хост-RPC (0.3.1).
    const { machine } = this.writerMachine(ctx, writer);
    const root = writer.root ?? projectRoot(machine, ctx.slug);
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
    if (tail) {
      // Тёплый хвост: правки хода уже на опоре (flush и проверка выше), W работает дальше.
      const until = this.now() + tail.tailMs;
      state.writer = null;
      state.tail = { hostId: host, threadId: tail.threadId, until, root, label: machine.label };
      await this.deps.store.set(ctx.projectId, state);
      this.deps.schedule?.(tail.tailMs + 1_000, () => { void this.closeExpiredTail(ctx.projectId); });
      return;
    }
    await this.timed(timings, 'pause', host, () => this.mutagenOk(host, sessionArgs('pause', w), 60_000));
    await this.timed(timings, 'snapshot', host, () => this.deps.call(host, 'syncSnapshot', { root, key: this.snapshotKey(ctx, machine), ignores: ctx.ignores }), out => `${out.entries} записей`);
    if (ctx.mode === 'warm') await this.timed(timings, 'warm', host, () => this.mutagenOk(host, sessionArgs('resume', sessionName(ctx.projectId, host, 'r')), 120_000));

    state.writer = null;
    state.tail = null;
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
    this.emit({ kind: 'step', step, hostId, ...route, state: 'running', ms: 0 });
    try {
      const value = await fn();
      const ms = performance.now() - t0;
      timings.push({ step, hostId, ...route, seconds: round(ms / 1000), ok: true, ...(detail?.(value) ? { detail: detail(value) } : {}) });
      this.emit({ kind: 'step', step, hostId, ...route, state: 'done', ms: Math.round(ms) });
      return value;
    } catch (error) {
      const ms = performance.now() - t0;
      const message = error instanceof Error ? error.message.slice(0, 200) : String(error);
      timings.push({ step, hostId, ...route, seconds: round(ms / 1000), ok: false, detail: message });
      this.emit({ kind: 'step', step, hostId, ...route, state: 'failed', ms: Math.round(ms), detail: message });
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
    return { version: 1, writer: saved.writer ?? null, anchorTurns: { ...(saved.anchorTurns ?? {}) }, ...(saved.tail ? { tail: { ...saved.tail } } : {}) };
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
