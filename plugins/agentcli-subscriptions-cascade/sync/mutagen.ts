// Mutagen: имена и метки сессий, аргументы команд, разбор машиночитаемого
// вывода `mutagen sync list --template '{{json .}}'` и критерий здоровья.
// Модуль чистый: команды выполняет хост-операция `mutagen` (sync/host-ops.ts).
//
// Схема (тест А2, вариант B): на каждую пару «проект × машина-исполнитель»
// две постоянные сессии, обе держит демон исполнителя, alpha — опора по SSH:
//   W — two-way-safe, работает только во время хода исполнителя;
//   R — one-way-replica опора → исполнитель: выравнивание перед ходом,
//       в «тёплом» режиме работает и между ходами.
import { createHash } from 'node:crypto';

export type SessionRole = 'w' | 'r';

/** Режим синхронизации проекта. `off` — проект ходит только по ступеням опоры. */
export type SyncModeExt = 'lazy' | 'warm' | 'off';

export const MUTAGEN_LABEL = 'bbcascade';

/** Права новых файлов и каталогов: без флагов Mutagen делает 0600/0700 (тест А). */
export const DEFAULT_FILE_MODE = '0644';
export const DEFAULT_DIRECTORY_MODE = '0755';

const hash = (text: string, length: number) => createHash('sha256').update(text).digest('hex').slice(0, length);

/** Значение метки Mutagen: буквы, цифры, «-», «_», «.», до 63 символов, края — буква или цифра. */
export function labelValue(text: string): string {
  const cleaned = text.replace(/[^A-Za-z0-9_.-]/g, '-').replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
  if (cleaned && cleaned.length <= 63 && cleaned === text) return cleaned;
  return `x${hash(text, 12)}`;
}

/** Имя сессии: стабильное, без особых символов, одно на проект, машину и роль. */
export function sessionName(projectId: string, hostId: string, role: SessionRole): string {
  return `bbc-${hash(projectId, 10)}-${hash(hostId, 6)}-${role}`;
}

export function projectSelector(projectId: string): string {
  return `${MUTAGEN_LABEL}=1,bbc-project=${labelValue(projectId)}`;
}

export interface SessionSpec {
  projectId: string;
  hostId: string;
  role: SessionRole;
  /** `<ssh-цель>:<путь на опоре>`, например `tru:/opt/bbfs/app`. */
  alpha: string;
  /** Путь на исполнителе. */
  beta: string;
  ignores: readonly string[];
  /** Режим symlink; по умолчанию posix-raw (все машины POSIX). */
  symlinkMode?: SymlinkMode;
}

/**
 * posix-raw — ссылки переносятся как есть, включая абсолютные (Linux, macOS, WSL).
 * portable — режим Mutagen по умолчанию: абсолютные ссылки отвергаются как
 * ошибки сканирования; нужен, если в каскаде есть нативный Windows.
 */
export type SymlinkMode = 'posix-raw' | 'portable';

/** Режим symlink для каскада: portable, только если среди машин есть нативный Windows. */
export function symlinkModeFor(machines: readonly { platform: string; pathTranslation?: boolean }[]): SymlinkMode {
  return machines.some(m => m.platform === 'windows' || m.pathTranslation === true) ? 'portable' : 'posix-raw';
}

/** Отпечаток настроек сессии: если он сменился, сессию пересоздаём. */
export function specFingerprint(spec: Pick<SessionSpec, 'alpha' | 'beta' | 'ignores' | 'role' | 'symlinkMode'>): string {
  // Смена режима symlink меняет отпечаток: сессии прежних версий (portable) пересоздаются.
  return hash(JSON.stringify([spec.role, spec.alpha, spec.beta, [...spec.ignores].sort(), spec.symlinkMode ?? 'posix-raw']), 10);
}

/** Аргументы `mutagen sync create` (без имени бинаря). Сессия создаётся на паузе. */
export function createArgs(spec: SessionSpec): string[] {
  const args = [
    'sync', 'create',
    '--name', sessionName(spec.projectId, spec.hostId, spec.role),
    '--label', `${MUTAGEN_LABEL}=1`,
    '--label', `bbc-project=${labelValue(spec.projectId)}`,
    '--label', `bbc-host=${labelValue(spec.hostId)}`,
    '--label', `bbc-role=${spec.role}`,
    '--label', `bbc-cfg=${specFingerprint(spec)}`,
    '--mode', spec.role === 'w' ? 'two-way-safe' : 'one-way-replica',
    // `.git` синхронизируется: пишет строго одна машина (тест А2, п. 3).
    '--no-ignore-vcs',
    '--no-global-configuration',
    `--default-file-mode=${DEFAULT_FILE_MODE}`,
    `--default-directory-mode=${DEFAULT_DIRECTORY_MODE}`,
    `--symlink-mode=${spec.symlinkMode ?? 'posix-raw'}`,
    '--paused',
  ];
  for (const ignore of spec.ignores) args.push('--ignore', ignore);
  args.push(spec.alpha, spec.beta);
  return args;
}

export const listArgs = (selector: string) => ['sync', 'list', '--template', '{{json .}}', '--label-selector', selector];
export const sessionArgs = (verb: 'pause' | 'resume' | 'flush' | 'terminate', name: string) => ['sync', verb, name];

// ---- Разбор `sync list` ----

export interface EndpointState {
  connected: boolean;
  scanProblems: string[];
  transitionProblems: string[];
  /** Файлов на стороне после сканирования (Mutagen `files`), если известно. */
  files?: number;
  /** Передача на эту сторону (`stagingProgress`): файлы и байты. */
  staging?: { receivedFiles: number; expectedFiles: number; receivedBytes: number };
}

export interface SessionState {
  name: string;
  identifier: string;
  labels: Record<string, string>;
  status: string;
  paused: boolean;
  conflicts: string[];
  lastError: string | null;
  alpha: EndpointState;
  beta: EndpointState;
}

const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {});
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function problems(value: unknown): string[] {
  return array(value).map(item => {
    const r = record(item);
    const path = typeof r.path === 'string' ? r.path : '';
    const error = typeof r.error === 'string' ? r.error : '';
    return [path, error].filter(Boolean).join(': ') || JSON.stringify(item);
  });
}

const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined);

function endpoint(value: unknown): EndpointState {
  const r = record(value);
  const out: EndpointState = { connected: r.connected === true, scanProblems: problems(r.scanProblems), transitionProblems: problems(r.transitionProblems) };
  const files = num(r.files);
  if (files !== undefined) out.files = files;
  const staging = record(r.stagingProgress);
  const expected = num(staging.expectedFiles);
  if (expected !== undefined) out.staging = { receivedFiles: num(staging.receivedFiles) ?? 0, expectedFiles: expected, receivedBytes: num(staging.totalReceivedSize) ?? 0 };
  return out;
}

/** Прогресс цикла синхронизации для строки подготовки (терпимо к версиям Mutagen). */
export interface TransferProgress { status: string; files: number | null; done: number | null; bytes: number | null }

export function transferProgress(session: SessionState | undefined): TransferProgress | null {
  if (!session) return null;
  const staging = session.beta.staging ?? session.alpha.staging;
  const files = Math.max(session.alpha.files ?? 0, session.beta.files ?? 0) || null;
  return {
    status: session.status,
    files: staging ? staging.expectedFiles : files,
    done: staging ? staging.receivedFiles : null,
    bytes: staging ? staging.receivedBytes : null,
  };
}

/** Статус Mutagen → этап подготовки по-русски. */
export function statusLabel(status: string): string {
  if (status === 'scanning' || status === 'waiting-for-rescan') return 'сканирование';
  if (status.startsWith('staging')) return 'передача';
  if (status === 'transitioning') return 'применение';
  if (status === 'saving') return 'сохранение';
  if (status.startsWith('connecting')) return 'подключение';
  if (status === 'reconciling') return 'сверка изменений';
  if (status === 'watching') return 'готово';
  return status;
}

/**
 * Читает JSON `sync list`. Неизвестные поля пропускаются, отсутствующие
 * считаются пустыми: формат могут дополнить новые версии Mutagen.
 */
export function parseSessionList(stdout: string): SessionState[] {
  const text = stdout.trim();
  if (!text) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error(`mutagen sync list: не JSON (${text.slice(0, 120)})`); }
  return array(parsed).map(raw => {
    const s = record(raw);
    const labels: Record<string, string> = {};
    for (const [key, value] of Object.entries(record(s.labels))) if (typeof value === 'string') labels[key] = value;
    const conflicts = array(s.conflicts).map(c => {
      const r = record(c);
      return typeof r.root === 'string' ? r.root : JSON.stringify(c);
    });
    return {
      name: typeof s.name === 'string' ? s.name : '',
      identifier: typeof s.identifier === 'string' ? s.identifier : '',
      labels,
      status: typeof s.status === 'string' ? s.status : 'unknown',
      paused: s.paused === true,
      conflicts,
      lastError: typeof s.lastError === 'string' && s.lastError ? s.lastError : null,
      alpha: endpoint(s.alpha),
      beta: endpoint(s.beta),
    };
  });
}

export interface Health {
  ok: boolean;
  /** Не готово только из-за переходного статуса (scanning, staging…): стоит перечитать. */
  transient: boolean;
  conflicts: string[];
  /** Причины отказа для строки в треде. Пусто, если ok. */
  reasons: string[];
  /**
   * Ошибки сканирования отдельных путей: такие пути Mutagen не переносит, но
   * остальное синхронизировано. Ход не блокируют — показываются предупреждением.
   */
  warnings: string[];
}

/**
 * Критерий передачи хода — JSON `sync list`, а не код возврата flush (тест А:
 * flush ни разу не вернул ошибку, в том числе при конфликтах и проблемах).
 */
export function evaluateHealth(session: SessionState | undefined): Health {
  if (!session) return { ok: false, transient: false, conflicts: [], reasons: ['сессия не найдена'], warnings: [] };
  const reasons: string[] = [];
  if (session.paused) reasons.push('сессия на паузе');
  const statusReason = session.status !== 'watching';
  if (statusReason) reasons.push(`статус ${session.status}`);
  if (!session.alpha.connected) reasons.push('опора не на связи');
  if (!session.beta.connected) reasons.push('исполнитель не на связи');
  if (session.conflicts.length) reasons.push(`конфликты: ${session.conflicts.slice(0, 5).join(', ')}${session.conflicts.length > 5 ? ` и ещё ${session.conflicts.length - 5}` : ''}`);
  const warnings: string[] = [];
  for (const [side, e] of [['опора', session.alpha], ['исполнитель', session.beta]] as const) {
    // Сканирование пути не удалось (ссылка, права, имя): путь пропущен, ход идёт.
    if (e.scanProblems.length) warnings.push(`${side}: не синхронизировано путей — ${e.scanProblems.length} (${e.scanProblems.slice(0, 3).join('; ')}${e.scanProblems.length > 3 ? '; …' : ''})`);
    // Ошибка записи — настоящая ошибка передачи: ход не передаётся.
    if (e.transitionProblems.length) reasons.push(`${side}: ошибки записи (${e.transitionProblems.slice(0, 3).join('; ')})`);
  }
  if (session.lastError) reasons.push(`ошибка: ${session.lastError}`);
  const transient = statusReason && reasons.length === 1 && TRANSIENT_STATUSES.has(session.status);
  return { ok: reasons.length === 0, transient, conflicts: session.conflicts, reasons, warnings };
}

/** Статусы цикла синхронизации, которые проходят сами (после flush идёт пересканирование). */
export const TRANSIENT_STATUSES = new Set(['scanning', 'reconciling', 'staging-alpha', 'staging-beta', 'transitioning', 'saving', 'waiting-for-rescan', 'connecting-alpha', 'connecting-beta']);

/** Конфликт только в `.git/index` разрешается в пользу пишущей стороны (тест А2, п. 3). */
export function onlyGitIndexConflict(health: Health): boolean {
  return health.conflicts.length > 0 && health.conflicts.every(path => path === '.git/index');
}
