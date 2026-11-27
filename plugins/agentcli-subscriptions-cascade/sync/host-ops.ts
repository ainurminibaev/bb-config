// Реализация хост-операций синхронизации (sync/contract.ts) на node.
// Выполняется в хост-воркере плагина на каждой машине. Команды — без
// оболочки (execFile), пути проверяются, чужое за пределами корня не трогаем.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, appendFile, chmod, copyFile, cp, lstat, mkdir, readdir, readFile, readlink, rename, rm, rmdir, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, join, posix, resolve } from 'node:path';

export interface ExecOutput { exitCode: number | null; stdout: string; stderr: string }

export function run(file: string, args: readonly string[], options: { timeoutMs: number; env?: NodeJS.ProcessEnv } = { timeoutMs: 30_000 }): Promise<ExecOutput> {
  return new Promise(done => {
    execFile(file, [...args], { timeout: options.timeoutMs, maxBuffer: 32 * 1024 * 1024, env: options.env ?? process.env }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : null) : 0;
      done({ exitCode: code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || (error && code === null ? error.message : '') });
    });
  });
}

export function expandHome(path: string): string {
  return path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

const exists = (path: string) => access(path, constants.F_OK).then(() => true, () => false);

/** Где искать mutagen: PATH воркера может не содержать ~/.local/bin и Homebrew. */
export function mutagenCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const dirs = [...(env.PATH ?? '').split(delimiter), join(homedir(), '.local/bin'), '/usr/local/bin', '/opt/homebrew/bin'];
  return [...new Set(dirs.filter(Boolean))].map(dir => join(dir, process.platform === 'win32' ? 'mutagen.exe' : 'mutagen'));
}

export async function locateMutagen(): Promise<string | null> {
  for (const candidate of mutagenCandidates()) if (await exists(candidate)) return candidate;
  return null;
}

export async function mutagen(args: readonly string[], timeoutMs: number): Promise<ExecOutput & { seconds: number; binary: string | null }> {
  const binary = await locateMutagen();
  if (!binary) return { exitCode: null, stdout: '', stderr: 'mutagen не установлен на машине (запустите мастер «Настроить»)', seconds: 0, binary: null };
  const started = performance.now();
  // ssh для транспорта Mutagen берётся из PATH: добавляем системные каталоги.
  const env = { ...process.env, PATH: [process.env.PATH, '/usr/bin', '/bin', '/usr/local/bin', dirname(binary)].filter(Boolean).join(delimiter) };
  const out = await run(binary, args, { timeoutMs, env });
  return { ...out, seconds: (performance.now() - started) / 1000, binary };
}

// ---- Исключения (подмножество синтаксиса Mutagen) ----

function globToRegExp(glob: string): RegExp {
  let source = '';
  for (const ch of glob) source += ch === '*' ? '[^/]*' : ch === '?' ? '[^/]' : ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${source}$`);
}

export type IgnoreMatcher = (relPath: string) => boolean;

/**
 * Образец без «/» совпадает с именем на любой глубине (`node_modules`, `.env.*`),
 * образец с «/» — путь от корня (`/dist`, `build/out`). `!` не поддерживается и пропускается.
 */
export function ignoreMatcher(patterns: readonly string[]): IgnoreMatcher {
  const names: RegExp[] = [];
  const anchored: RegExp[] = [];
  for (const raw of patterns) {
    const pattern = raw.trim().replace(/\/+$/, '');
    if (!pattern || pattern.startsWith('!') || pattern.startsWith('#')) continue;
    if (pattern.includes('/')) anchored.push(globToRegExp(pattern.replace(/^\/+/, '')));
    else names.push(globToRegExp(pattern));
  }
  return relPath => {
    if (anchored.some(re => re.test(relPath))) return true;
    const name = relPath.slice(relPath.lastIndexOf('/') + 1);
    return names.some(re => re.test(name));
  };
}

export interface Entry { size: number; mtimeMs: number; mode: number; link?: string }

/** Обход дерева: файлы и ссылки (каталоги не записываются). Исключённое не заходит в снимок. */
export async function walk(root: string, ignores: readonly string[], options: { skip?: (rel: string) => boolean } = {}): Promise<Map<string, Entry>> {
  const ignored = ignoreMatcher(ignores);
  const out = new Map<string, Entry>();
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop()!;
    let names: string[];
    try { names = await readdir(rel ? join(root, rel) : root); } catch { continue; }
    for (const name of names) {
      const childRel = rel ? `${rel}/${name}` : name;
      if (ignored(childRel) || options.skip?.(childRel)) continue;
      let info;
      try { info = await lstat(join(root, childRel)); } catch { continue; }
      if (info.isDirectory()) stack.push(childRel);
      else if (info.isSymbolicLink()) out.set(childRel, { size: 0, mtimeMs: Math.trunc(info.mtimeMs), mode: info.mode & 0o777, link: await readlink(join(root, childRel)).catch(() => '') });
      else if (info.isFile()) out.set(childRel, { size: info.size, mtimeMs: Math.trunc(info.mtimeMs), mode: info.mode & 0o777 });
    }
  }
  return out;
}

const snapshotFile = (dataDir: string, key: string) => join(dataDir, 'sync-snapshots', `${createHash('sha256').update(key).digest('hex').slice(0, 24)}.json`);

export async function writeSnapshot(dataDir: string, root: string, key: string, ignores: readonly string[]) {
  const started = performance.now();
  const entries = await walk(root, ignores);
  const file = snapshotFile(dataDir, key);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify({ root, key, at: new Date().toISOString(), entries: Object.fromEntries(entries) }));
  await rename(`${file}.tmp`, file);
  return { entries: entries.size, seconds: (performance.now() - started) / 1000 };
}

async function readSnapshot(dataDir: string, key: string): Promise<Map<string, Entry> | null> {
  try {
    const parsed = JSON.parse(await readFile(snapshotFile(dataDir, key), 'utf8')) as { entries?: Record<string, Entry> };
    return new Map(Object.entries(parsed.entries ?? {}));
  } catch { return null; }
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

function same(a: Entry, b: Entry): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.mode === b.mode && (a.link ?? null) === (b.link ?? null);
}

/**
 * Карантин опоздавших записей: всё, что изменилось на машине после конца её
 * прошлого хода, копируется в отдельную папку, удалённое — в `_deleted.txt`.
 * Само дерево не меняется: выравнивание по опоре делает реплика R.
 */
export async function quarantine(dataDir: string, root: string, key: string, ignores: readonly string[], quarantineBase: string) {
  const started = performance.now();
  const before = await readSnapshot(dataDir, key);
  if (!before) return { changed: 0, deleted: 0, dir: null, hadSnapshot: false, seconds: (performance.now() - started) / 1000 };
  const now = await walk(root, ignores);
  const changed = [...now].filter(([rel, entry]) => { const old = before.get(rel); return !old || !same(old, entry); }).map(([rel]) => rel);
  const deleted = [...before.keys()].filter(rel => !now.has(rel));
  if (!changed.length && !deleted.length) return { changed: 0, deleted: 0, dir: null, hadSnapshot: true, seconds: (performance.now() - started) / 1000 };
  const dir = join(expandHome(quarantineBase), stamp());
  await mkdir(dir, { recursive: true });
  for (const rel of changed) {
    const from = join(root, rel);
    const to = join(dir, rel);
    await mkdir(dirname(to), { recursive: true });
    const entry = now.get(rel)!;
    if (entry.link !== undefined) await symlink(entry.link, to).catch(() => undefined);
    else await copyFile(from, to).catch(() => appendFile(join(dir, '_unreadable.txt'), `${rel}\n`));
  }
  if (deleted.length) await writeFile(join(dir, '_deleted.txt'), `${deleted.join('\n')}\n`);
  return { changed: changed.length, deleted: deleted.length, dir, hadSnapshot: true, seconds: (performance.now() - started) / 1000 };
}

/** Корень на исполнителе перед созданием сессий: чужое содержимое — в карантин целиком. */
export async function prepareBeta(dataDir: string, root: string, key: string, quarantineBase: string) {
  const names = await readdir(root).catch(() => null);
  if (names === null) {
    await mkdir(root, { recursive: true });
    return { created: true, movedTo: null };
  }
  if (!names.length || (await readSnapshot(dataDir, key))) return { created: false, movedTo: null };
  const movedTo = join(expandHome(quarantineBase), `${stamp()}-preexisting`);
  await mkdir(dirname(movedTo), { recursive: true });
  try {
    await rename(root, movedTo);
  } catch {
    await cp(root, movedTo, { recursive: true, verbatimSymlinks: true });
    await rm(root, { recursive: true, force: true });
  }
  await mkdir(root, { recursive: true });
  return { created: true, movedTo };
}

const isEnvName = (name: string) => name === '.env' || name.startsWith('.env.');

export async function envModes(root: string, ignores: readonly string[]) {
  const entries = await walk(root, ignores, { skip: rel => rel === '.git' || rel.startsWith('.git/') });
  return { files: [...entries].filter(([rel, e]) => e.link === undefined && isEnvName(rel.slice(rel.lastIndexOf('/') + 1))).map(([path, e]) => ({ path, mode: e.mode })) };
}

/** Относительный путь внутри корня, без «..» и абсолютных частей. */
export function safeRel(rel: string): string | null {
  const normalized = posix.normalize(rel.replace(/\\/g, '/'));
  if (!normalized || normalized === '.' || normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../')) return null;
  return normalized;
}

export async function chmodFiles(root: string, paths: readonly string[], mode: number) {
  const changed: string[] = [];
  for (const raw of paths) {
    const rel = safeRel(raw);
    if (!rel) continue;
    const info = await lstat(join(root, rel)).catch(() => null);
    if (!info?.isFile() || (info.mode & 0o777) === mode) continue;
    await chmod(join(root, rel), mode);
    changed.push(rel);
  }
  return { changed };
}

/** Живые процессы git, у которых рабочая папка внутри root (macOS — lsof, Linux — /proc). */
export async function gitRunningUnder(root: string): Promise<boolean> {
  const base = resolve(root);
  const inside = (cwd: string) => cwd === base || cwd.startsWith(`${base}/`);
  if (process.platform === 'linux') {
    const pids = (await readdir('/proc').catch(() => [] as string[])).filter(name => /^\d+$/.test(name));
    for (const pid of pids) {
      const comm = (await readFile(`/proc/${pid}/comm`, 'utf8').catch(() => '')).trim();
      if (comm !== 'git') continue;
      if (inside(await readlink(`/proc/${pid}/cwd`).catch(() => ''))) return true;
    }
    return false;
  }
  const out = await run('lsof', ['-a', '-c', 'git', '-d', 'cwd', '-Fn'], { timeoutMs: 10_000 });
  // lsof без совпадений возвращает 1; иной сбой — считаем, что git может работать.
  if (out.exitCode !== 0 && out.exitCode !== 1) return true;
  return out.stdout.split('\n').some(line => line.startsWith('n') && inside(line.slice(1)));
}

export async function gitLocks(root: string) {
  const gitDir = join(root, '.git');
  const locks: string[] = [];
  if (await exists(gitDir)) {
    const entries = await walk(gitDir, [], { skip: rel => rel === 'objects' });
    for (const rel of entries.keys()) if (rel.endsWith('.lock')) locks.push(`.git/${rel}`);
    // Lock в objects/pack — редкость, но проверяем без обхода всех объектов.
    for (const name of await readdir(join(gitDir, 'objects/pack')).catch(() => [] as string[])) if (name.endsWith('.lock')) locks.push(`.git/objects/pack/${name}`);
  }
  return { locks: locks.sort(), gitRunning: await gitRunningUnder(root) };
}

export async function removeGitFiles(root: string, paths: readonly string[]) {
  const removed: string[] = [];
  for (const raw of paths) {
    const rel = safeRel(raw);
    if (!rel || !rel.startsWith('.git/')) continue;
    try { await unlink(join(root, rel)); removed.push(rel); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return { removed };
}

// ---- Bind mount на опоре ----

/** Точки монтирования из /proc/self/mountinfo (поле 5, с раскодированием \040 и т. п.). */
export function parseMountPoints(mountinfo: string): Set<string> {
  const decode = (s: string) => s.replace(/\\([0-7]{3})/g, (_, oct: string) => String.fromCharCode(parseInt(oct, 8)));
  return new Set(mountinfo.split('\n').map(line => line.split(' ')[4]).filter((p): p is string => Boolean(p)).map(decode));
}

async function sameInode(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([stat(a).catch(() => null), stat(b).catch(() => null)]);
  return Boolean(x && y && x.dev === y.dev && x.ino === y.ino);
}

export async function ensureBindMount(source: string, target: string, deps: { mountinfo?: () => Promise<string>; mount?: (source: string, target: string) => Promise<ExecOutput> } = {}) {
  const started = performance.now();
  const seconds = () => (performance.now() - started) / 1000;
  const src = resolve(source);
  const dst = resolve(target);
  if (src === dst) return { status: 'same-path' as const, seconds: seconds() };
  if (!(await stat(src).catch(() => null))?.isDirectory()) throw new Error(`Нет папки проекта на опоре: ${src}`);
  if (process.platform !== 'linux' && !deps.mount) throw new Error(`Bind mount есть только на Linux: на опоре папка проекта должна лежать прямо в ${dst}`);
  const mounts = parseMountPoints(await (deps.mountinfo ?? (() => readFile('/proc/self/mountinfo', 'utf8')))());
  if (mounts.has(dst)) {
    if (await sameInode(src, dst)) return { status: 'already' as const, seconds: seconds() };
    throw new Error(`${dst} уже занят другим монтированием`);
  }
  await mkdir(dst, { recursive: true });
  if ((await readdir(dst)).length) {
    if (await sameInode(src, dst)) return { status: 'already' as const, seconds: seconds() };
    throw new Error(`${dst} не пуст и не связан с ${src}: не монтирую поверх`);
  }
  const out = await (deps.mount ?? ((s, t) => run('mount', ['--bind', s, t], { timeoutMs: 15_000 })))(src, dst);
  if (out.exitCode !== 0) throw new Error(`mount --bind: ${(out.stderr || out.stdout).trim().slice(0, 300)}`);
  if (!deps.mount && !(await sameInode(src, dst))) throw new Error(`После mount --bind ${dst} не указывает на ${src}`);
  return { status: 'mounted' as const, seconds: seconds() };
}

export async function removeBindMount(target: string) {
  const dst = resolve(target);
  let unmounted = false;
  if (process.platform === 'linux') {
    const mounts = parseMountPoints(await readFile('/proc/self/mountinfo', 'utf8').catch(() => ''));
    if (mounts.has(dst)) {
      const out = await run('umount', [dst], { timeoutMs: 15_000 });
      if (out.exitCode !== 0) throw new Error(`umount: ${(out.stderr || out.stdout).trim().slice(0, 300)}`);
      unmounted = true;
    }
  }
  const removed = await rmdir(dst).then(() => true, () => false);
  return { unmounted, removed };
}
