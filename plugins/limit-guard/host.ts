// Runs on the machine that holds a thread's folder. Saves "snapshots" of
// unfinished work: a commit of the whole folder state under a service ref,
// built through a temporary index. Working files, the current branch and the
// real index are never touched. Folders without git get a shadow repository
// in this plugin's data directory, so no .git appears in them.
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { experimental_defineHostEntry } from '@get-bb/plugin-sdk/host';
import { hostContract, type RestoreResult, type SnapshotResult } from './contract.ts';
import { findSecrets, MAX_SNAPSHOT_FILE_BYTES, MAX_SNAPSHOT_FILES, SKIP_DIRS } from './snapshot-logic.ts';

const IDENTITY = { GIT_AUTHOR_NAME: 'bb limit-guard', GIT_AUTHOR_EMAIL: 'limit-guard@bb.local', GIT_COMMITTER_NAME: 'bb limit-guard', GIT_COMMITTER_EMAIL: 'limit-guard@bb.local' };

function git(args: string[], opts: { cwd: string; env?: Record<string, string>; timeout?: number; input?: string; signal: AbortSignal }) {
  return new Promise<{ ok: boolean; out: string; err: string }>(resolve => {
    const child = execFile('git', args, {
      cwd: opts.cwd, timeout: opts.timeout ?? 60_000, maxBuffer: 32 * 1024 * 1024, signal: opts.signal,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0',
        GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes -o ConnectTimeout=15', ...opts.env },
    }, (error, stdout, stderr) => resolve({ ok: !error, out: String(stdout), err: String(stderr || (error ? error.message : '')).trim().slice(0, 300) }));
    if (opts.input !== undefined) { child.stdin?.end(opts.input); }
  });
}

async function isGitRepo(path: string, signal: AbortSignal) {
  return (await git(['rev-parse', '--is-inside-work-tree'], { cwd: path, signal })).out.trim() === 'true';
}

/** Untracked (not ignored) files small enough for a snapshot; bounded so huge folders stay cheap. */
async function smallUntracked(path: string, env: Record<string, string>, signal: AbortSignal) {
  const listed = await git(['ls-files', '--others', '--exclude-standard', '-z'], { cwd: path, env, signal, timeout: 60_000 });
  const files = listed.out.split('\0').filter(Boolean).filter(f => !f.split('/').some(part => SKIP_DIRS.has(part)));
  const kept: string[] = [];
  let skipped = 0;
  for (const file of files) {
    if (kept.length >= MAX_SNAPSHOT_FILES) { skipped++; continue; }
    try { if ((await stat(join(path, file))).size <= MAX_SNAPSHOT_FILE_BYTES) kept.push(file); else skipped++; } catch { skipped++; }
  }
  return { kept, skipped };
}

/** Every file of a plain folder, for the shadow repository. */
async function plainFiles(root: string) {
  const kept: string[] = [];
  let skipped = 0;
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    let names: import('node:fs').Dirent[];
    try { names = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const item of names) {
      if (SKIP_DIRS.has(item.name) || item.name === '.git' || item.isSymbolicLink()) continue;
      const path = rel ? `${rel}/${item.name}` : item.name;
      if (item.isDirectory()) { if (depth < 12) await walk(join(dir, item.name), path, depth + 1); continue; }
      if (!item.isFile()) continue;
      if (kept.length >= MAX_SNAPSHOT_FILES) { skipped++; continue; }
      try { if ((await stat(join(dir, item.name))).size <= MAX_SNAPSHOT_FILE_BYTES) kept.push(path); else skipped++; } catch { skipped++; }
    }
  };
  await walk(root, '', 0);
  return { kept, skipped };
}

async function scanSecrets(path: string, files: string[]) {
  const hits: string[] = [];
  for (const file of files.slice(0, 2000)) {
    try {
      const text = (await readFile(join(path, file))).subarray(0, 512 * 1024).toString('utf8');
      if (findSecrets(file, text)) hits.push(file);
    } catch { /* unreadable: ignore */ }
    if (hits.length >= 20) break;
  }
  return hits;
}

async function isPrivateRemote(path: string, signal: AbortSignal): Promise<boolean | null> {
  const url = (await git(['config', '--get', 'remote.origin.url'], { cwd: path, signal })).out.trim();
  const match = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url);
  if (!match) return null;
  return new Promise(resolve => {
    execFile('gh', ['api', `repos/${match[1]}/${match[2]}`, '--jq', '.private'], { timeout: 20_000, signal }, (error, stdout) => {
      const value = String(stdout).trim();
      resolve(error ? null : value === 'true' ? true : value === 'false' ? false : null);
    });
  });
}

export async function snapshotGit(path: string, ref: string, message: string, push: boolean, signal: AbortSignal): Promise<SnapshotResult> {
  const result: SnapshotResult = { kind: 'git', commit: null, base: null, changed: false, files: 0, skippedFiles: 0, pushed: false, pushNote: null, secrets: [], removed: false, error: null };
  const index = join(tmpdir(), `bb-limit-guard-${randomBytes(6).toString('hex')}.index`);
  const env = { GIT_INDEX_FILE: index, ...IDENTITY };
  try {
    const head = (await git(['rev-parse', '--verify', '-q', 'HEAD'], { cwd: path, signal })).out.trim() || null;
    result.base = head;
    if (head) { if (!(await git(['read-tree', 'HEAD'], { cwd: path, env, signal })).ok) throw new Error('read-tree не удался'); }
    else await git(['read-tree', '--empty'], { cwd: path, env, signal });
    const tracked = await git(['add', '-u', '--', '.'], { cwd: path, env, signal, timeout: 120_000 });
    if (!tracked.ok) throw new Error(`git add -u: ${tracked.err}`);
    const untracked = await smallUntracked(path, env, signal);
    result.skippedFiles = untracked.skipped;
    if (untracked.kept.length) {
      const added = await git(['add', '--pathspec-from-file=-', '--pathspec-file-nul'], { cwd: path, env, signal, timeout: 120_000, input: untracked.kept.join('\0') });
      if (!added.ok) throw new Error(`git add: ${added.err}`);
    }
    const tree = (await git(['write-tree'], { cwd: path, env, signal })).out.trim();
    const headTree = head ? (await git(['rev-parse', 'HEAD^{tree}'], { cwd: path, signal })).out.trim() : null;
    const previous = (await git(['rev-parse', '--verify', '-q', ref], { cwd: path, signal })).out.trim() || null;
    if (tree === headTree) {
      // Nothing beyond the branch: the old snapshot is no longer needed here.
      if (previous) { await git(['update-ref', '-d', ref], { cwd: path, signal }); result.removed = true; }
      return result;
    }
    const previousTree = previous ? (await git(['rev-parse', `${previous}^{tree}`], { cwd: path, signal })).out.trim() : null;
    const diffNames = (await git(['diff', '--name-only', '-z', head ?? '4b825dc642cb6eb9a060e54bf8d69288fbee4904', tree], { cwd: path, signal })).out.split('\0').filter(Boolean);
    result.files = diffNames.length;
    if (tree === previousTree) { result.commit = previous; return result; }
    const parents = [previous, head].filter((p): p is string => Boolean(p)).flatMap(p => ['-p', p]);
    const commit = await git(['commit-tree', tree, ...parents, '-F', '-'], { cwd: path, env: IDENTITY, signal, input: message });
    if (!commit.ok) throw new Error(`commit-tree: ${commit.err}`);
    result.commit = commit.out.trim();
    result.changed = true;
    await git(['update-ref', ref, result.commit], { cwd: path, signal });
    if (!push) return result;
    const remote = (await git(['remote'], { cwd: path, signal })).out.split('\n').includes('origin');
    if (!remote) { result.pushNote = 'нет remote origin — снимок только на этой машине'; return result; }
    const isPrivate = await isPrivateRemote(path, signal);
    if (isPrivate !== true) { result.pushNote = isPrivate === false ? 'репозиторий публичный — снимок только на этой машине' : 'не удалось подтвердить, что репозиторий приватный — снимок только на этой машине'; return result; }
    result.secrets = await scanSecrets(path, diffNames);
    if (result.secrets.length) { result.pushNote = 'похоже на секреты в файлах — снимок только на этой машине'; return result; }
    const pushed = await git(['push', '--quiet', 'origin', `${result.commit}:${ref}`], { cwd: path, signal, timeout: 120_000 });
    result.pushed = pushed.ok;
    if (!pushed.ok) result.pushNote = `push не удался: ${pushed.err}`;
    return result;
  } finally {
    await rm(index, { force: true });
  }
}

export async function snapshotShadow(path: string, dataDir: string, message: string, signal: AbortSignal): Promise<SnapshotResult> {
  const result: SnapshotResult = { kind: 'shadow', commit: null, base: null, changed: false, files: 0, skippedFiles: 0, pushed: false, pushNote: 'папка без git — снимок в теневом репозитории на этой машине', secrets: [], removed: false, error: null };
  const gitDir = join(dataDir, 'shadow', `${createHash('sha1').update(path).digest('hex').slice(0, 16)}.git`);
  const env = { GIT_DIR: gitDir, GIT_WORK_TREE: path, ...IDENTITY };
  try { await stat(join(gitDir, 'HEAD')); }
  catch {
    await mkdir(gitDir, { recursive: true });
    if (!(await git(['init', '--quiet', '--bare', gitDir], { cwd: path, signal })).ok) throw new Error('не удалось создать теневой репозиторий');
    await writeFile(join(gitDir, 'description'), `Shadow snapshots of ${path}\n`);
  }
  const index = join(tmpdir(), `bb-limit-guard-${randomBytes(6).toString('hex')}.index`);
  try {
    const files = await plainFiles(path);
    result.skippedFiles = files.skipped;
    const ienv = { ...env, GIT_INDEX_FILE: index };
    await git(['read-tree', '--empty'], { cwd: path, env: ienv, signal });
    if (files.kept.length) {
      const added = await git(['add', '-f', '--pathspec-from-file=-', '--pathspec-file-nul'], { cwd: path, env: ienv, signal, timeout: 180_000, input: files.kept.join('\0') });
      if (!added.ok) throw new Error(`git add: ${added.err}`);
    }
    const tree = (await git(['write-tree'], { cwd: path, env: ienv, signal })).out.trim();
    const previous = (await git(['rev-parse', '--verify', '-q', 'refs/heads/snapshots'], { cwd: path, env, signal })).out.trim() || null;
    const previousTree = previous ? (await git(['rev-parse', `${previous}^{tree}`], { cwd: path, env, signal })).out.trim() : null;
    result.files = files.kept.length;
    if (tree === previousTree) { result.commit = previous; return result; }
    const commit = await git(['commit-tree', tree, ...(previous ? ['-p', previous] : []), '-F', '-'], { cwd: path, env, signal, input: message });
    if (!commit.ok) throw new Error(`commit-tree: ${commit.err}`);
    result.commit = commit.out.trim();
    result.changed = true;
    await git(['update-ref', 'refs/heads/snapshots', result.commit], { cwd: path, env, signal });
    return result;
  } finally {
    await rm(index, { force: true });
  }
}

/** Lay a snapshot out as uncommitted changes, only on a clean folder at the snapshot's base. */
export async function restoreGit(path: string, ref: string, signal: AbortSignal): Promise<RestoreResult> {
  const fetched = await git(['fetch', '--quiet', '--no-write-fetch-head', 'origin', `+${ref}:${ref}`], { cwd: path, signal, timeout: 120_000 });
  const commit = (await git(['rev-parse', '--verify', '-q', ref], { cwd: path, signal })).out.trim();
  if (!commit) return { ok: false, message: fetched.ok ? 'снимок не найден' : `снимка нет локально, а fetch не удался: ${fetched.err}` };
  const status = (await git(['status', '--porcelain'], { cwd: path, signal })).out.trim();
  if (status) return { ok: false, message: 'в папке есть правки — сначала сохраните или уберите их; снимок не применён' };
  const head = (await git(['rev-parse', 'HEAD'], { cwd: path, signal })).out.trim();
  const parents = (await git(['rev-list', '--parents', '-n', '1', commit], { cwd: path, signal })).out.trim().split(' ').slice(1);
  const base = parents[parents.length - 1] ?? null;
  if (base !== head) return { ok: false, message: `снимок сделан от ${base?.slice(0, 8) ?? '?'}, а папка на ${head.slice(0, 8)}: примените в отдельной копии (worktree) от ${base?.slice(0, 8) ?? 'базы'}` };
  const diff = await git(['diff', '--binary', head, commit], { cwd: path, signal });
  const applied = await git(['apply', '--whitespace=nowarn'], { cwd: path, signal, input: diff.out });
  return applied.ok ? { ok: true, message: `снимок ${commit.slice(0, 8)} разложен как незакоммиченные правки` } : { ok: false, message: `git apply не удался: ${applied.err}` };
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    snapshot: async ({ path, ref, message, push }, ctx): Promise<SnapshotResult> => {
      try {
        try { if (!(await stat(path)).isDirectory()) throw new Error('not a directory'); }
        catch { return { kind: 'missing', commit: null, base: null, changed: false, files: 0, skippedFiles: 0, pushed: false, pushNote: null, secrets: [], removed: false, error: 'папка не найдена' }; }
        try { await stat(join(path, '.bb', 'hands-off')); return { kind: 'hands-off', commit: null, base: null, changed: false, files: 0, skippedFiles: 0, pushed: false, pushNote: null, secrets: [], removed: false, error: null }; } catch { /* allowed */ }
        if (await isGitRepo(path, ctx.signal)) return await snapshotGit(path, ref, message, push, ctx.signal);
        return await snapshotShadow(path, ctx.experimental_paths.dataDir, message, ctx.signal);
      } catch (error) {
        return { kind: 'error', commit: null, base: null, changed: false, files: 0, skippedFiles: 0, pushed: false, pushNote: null, secrets: [], removed: false, error: String((error as Error).message).slice(0, 300) };
      }
    },
    restore: async ({ path, ref }, ctx): Promise<RestoreResult> => {
      try {
        if (!(await isGitRepo(path, ctx.signal))) return { ok: false, message: 'папка без git: теневые снимки восстанавливаются вручную (см. навык limit-guard)' };
        return await restoreGit(path, ref, ctx.signal);
      } catch (error) { return { ok: false, message: String((error as Error).message).slice(0, 300) }; }
    },
  },
});
