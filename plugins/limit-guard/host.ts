// Runs on the machine that holds a thread's folder. Saves "snapshots" of
// unfinished work: a commit of the whole folder state under a service ref,
// built through a temporary copy of the index. Working files, the current
// branch and the real index are never touched. Folders without git get a
// shadow repository in this plugin's data directory, so no .git appears in
// them; git repositories nested in such a folder get their own snapshots.
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { experimental_defineHostEntry } from '@get-bb/plugin-sdk/host';
import { hostContract, type RestoreResult, type SnapshotResult } from './contract.ts';
import { findSecrets, MAX_SHADOW_BYTES, MAX_SNAPSHOT_FILE_BYTES, MAX_SNAPSHOT_FILES, nestedRef, SKIP_DIRS, unsafeShadowRoot } from './snapshot-logic.ts';

const IDENTITY = { GIT_AUTHOR_NAME: 'bb limit-guard', GIT_AUTHOR_EMAIL: 'limit-guard@bb.local', GIT_COMMITTER_NAME: 'bb limit-guard', GIT_COMMITTER_EMAIL: 'limit-guard@bb.local' };
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function git(args: string[], opts: { cwd: string; env?: Record<string, string>; timeout?: number; input?: string; signal: AbortSignal }) {
  return new Promise<{ ok: boolean; out: string; err: string }>(done => {
    const child = execFile('git', args, {
      cwd: opts.cwd, timeout: opts.timeout ?? 60_000, maxBuffer: 64 * 1024 * 1024, signal: opts.signal,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0',
        GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes -o ConnectTimeout=15', ...opts.env },
    }, (error, stdout, stderr) => done({ ok: !error, out: String(stdout), err: String(stderr || (error ? error.message : '')).trim().slice(0, 300) }));
    if (opts.input !== undefined) { child.stdin?.end(opts.input); }
  });
}

const empty = (kind: SnapshotResult['kind'], extra: Partial<SnapshotResult> = {}): SnapshotResult => ({
  kind, commit: null, base: null, changed: false, files: 0, skippedFiles: 0, pushed: false, pushNote: null, secrets: [], removed: false, kept: false, error: null, nested: [], ...extra,
});

async function isGitRepo(path: string, signal: AbortSignal) {
  return (await git(['rev-parse', '--is-inside-work-tree'], { cwd: path, signal })).out.trim() === 'true';
}

/** Untracked (not ignored) files small enough for a snapshot. Untracked nested repositories ("dir/") are left out. */
async function smallUntracked(path: string, env: Record<string, string>, signal: AbortSignal) {
  const listed = await git(['ls-files', '--others', '--exclude-standard', '-z'], { cwd: path, env, signal, timeout: 60_000 });
  const files = listed.out.split('\0').filter(Boolean).filter(f => !f.endsWith('/') && !f.split('/').some(part => SKIP_DIRS.has(part)));
  const kept: string[] = [];
  let skipped = 0;
  for (const file of files) {
    if (kept.length >= MAX_SNAPSHOT_FILES) { skipped++; continue; }
    try { if ((await stat(join(path, file))).size <= MAX_SNAPSHOT_FILE_BYTES) kept.push(file); else skipped++; } catch { skipped++; }
  }
  return { kept, skipped };
}

/** Files of a plain folder for the shadow repository; nested repositories are reported, not walked. */
async function plainFiles(root: string) {
  const kept: string[] = [];
  const nested: string[] = [];
  const secrets: string[] = [];
  let skipped = 0;
  let bytes = 0;
  let tooBig = false;
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (tooBig) return;
    let names: import('node:fs').Dirent[];
    try { names = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const item of names) {
      if (SKIP_DIRS.has(item.name) || item.name === '.git' || item.isSymbolicLink()) continue;
      const path = rel ? `${rel}/${item.name}` : item.name;
      const full = join(dir, item.name);
      if (item.isDirectory()) {
        try { await stat(join(full, '.git')); nested.push(path); continue; } catch { /* not a repository */ }
        if (depth < 12) await walk(full, path, depth + 1);
        continue;
      }
      if (!item.isFile()) continue;
      if (kept.length >= MAX_SNAPSHOT_FILES) { skipped++; continue; }
      let size: number;
      try { size = (await stat(full)).size; } catch { skipped++; continue; }
      if (size > MAX_SNAPSHOT_FILE_BYTES) { skipped++; continue; }
      let text = '';
      if (size <= 512 * 1024) { try { text = (await readFile(full)).toString('utf8'); } catch { /* unreadable */ } }
      if (findSecrets(path, text)) { secrets.push(path); continue; }
      bytes += size;
      if (bytes > MAX_SHADOW_BYTES) { tooBig = true; return; }
      kept.push(path);
    }
  };
  await walk(root, '', 0);
  return { kept, skipped, nested, secrets, tooBig };
}

async function scanSecrets(path: string, files: string[]) {
  const hits: string[] = [];
  for (const file of files.slice(0, 5000)) {
    try {
      const text = (await readFile(join(path, file))).subarray(0, 2 * 1024 * 1024).toString('utf8');
      if (findSecrets(file, text)) hits.push(file);
    } catch { /* deleted or unreadable: ignore */ }
    if (hits.length >= 20) break;
  }
  return hits;
}

/**
 * Every file version a push of `commit` would upload: all commits not yet on origin, read from git
 * objects (a secret added and later deleted is still in history), not only the net tree diff.
 */
export async function scanOutgoing(path: string, commit: string, signal: AbortSignal) {
  const hits = new Set<string>();
  const list = await git(['rev-list', '--max-count=200', commit, '--not', '--remotes=origin'], { cwd: path, signal });
  for (const sha of list.out.split('\n').filter(Boolean)) {
    const changed = (await git(['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '-m', '--root', sha], { cwd: path, signal })).out.split('\0').filter(Boolean);
    for (const file of [...new Set(changed)].slice(0, 5000)) {
      if (hits.has(file)) continue;
      const blob = await git(['cat-file', '-p', `${sha}:${file}`], { cwd: path, signal });
      // A deleted path has no blob in this commit; its name alone may still look like a secret.
      if (findSecrets(file, blob.ok ? blob.out.slice(0, 2 * 1024 * 1024) : '')) hits.add(file);
      if (hits.size >= 20) return [...hits];
    }
  }
  return [...hits];
}

async function isPrivateRemote(path: string, signal: AbortSignal): Promise<boolean | null> {
  const url = (await git(['config', '--get', 'remote.origin.url'], { cwd: path, signal })).out.trim();
  const match = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url);
  if (!match) return null;
  return new Promise(done => {
    execFile('gh', ['api', `repos/${match[1]}/${match[2]}`, '--jq', '.private'], { timeout: 20_000, signal }, (error, stdout) => {
      const value = String(stdout).trim();
      done(error ? null : value === 'true' ? true : value === 'false' ? false : null);
    });
  });
}

/** A temporary index that starts as a copy of the real one, so staged work is kept and unchanged files are not re-read. */
async function tempIndex(path: string, signal: AbortSignal) {
  const index = join(tmpdir(), `bb-limit-guard-${randomBytes(6).toString('hex')}.index`);
  const real = (await git(['rev-parse', '--git-path', 'index'], { cwd: path, signal })).out.trim();
  const realPath = real ? (isAbsolute(real) ? real : resolve(path, real)) : '';
  let copied = false;
  if (realPath) { try { await copyFile(realPath, index); copied = true; } catch { /* no index yet */ } }
  return { index, copied };
}

export async function snapshotGit(path: string, ref: string, message: string, push: boolean, signal: AbortSignal): Promise<SnapshotResult> {
  const result = empty('git');
  const { index, copied } = await tempIndex(path, signal);
  const env = { GIT_INDEX_FILE: index, ...IDENTITY };
  try {
    const head = (await git(['rev-parse', '--verify', '-q', 'HEAD'], { cwd: path, signal })).out.trim() || null;
    result.base = head;
    if (!copied) {
      if (head) { if (!(await git(['read-tree', 'HEAD'], { cwd: path, env, signal })).ok) throw new Error('read-tree не удался'); }
      else await git(['read-tree', '--empty'], { cwd: path, env, signal });
    }
    const tracked = await git(['add', '-u', '--', '.'], { cwd: path, env, signal, timeout: 300_000 });
    if (!tracked.ok) throw new Error(`git add -u: ${tracked.err}`);
    const untracked = await smallUntracked(path, env, signal);
    result.skippedFiles = untracked.skipped;
    if (untracked.kept.length) {
      const added = await git(['add', '--pathspec-from-file=-', '--pathspec-file-nul'], { cwd: path, env, signal, timeout: 300_000, input: untracked.kept.join('\0') });
      if (!added.ok) throw new Error(`git add: ${added.err}`);
    }
    const tree = (await git(['write-tree'], { cwd: path, env, signal })).out.trim();
    if (!tree) throw new Error('write-tree не удался');
    const headTree = head ? (await git(['rev-parse', 'HEAD^{tree}'], { cwd: path, signal })).out.trim() : EMPTY_TREE;
    const previous = (await git(['rev-parse', '--verify', '-q', ref], { cwd: path, signal })).out.trim() || null;
    const previousTree = previous ? (await git(['rev-parse', `${previous}^{tree}`], { cwd: path, signal })).out.trim() : null;
    if (tree === headTree) {
      // Drop the old snapshot only when its work is in the branch. A clean folder after
      // `checkout .` or `reset --hard` keeps it: it may be the only copy of thrown-away work.
      if (previous && previousTree === headTree) {
        await git(['update-ref', '-d', ref], { cwd: path, signal });
        result.removed = true;
        if (push && (await git(['ls-remote', 'origin', ref], { cwd: path, signal, timeout: 30_000 })).out.trim()) {
          await git(['push', '--quiet', 'origin', `:${ref}`], { cwd: path, signal, timeout: 60_000 });
        }
      } else if (previous) { result.kept = true; result.commit = previous; }
      return result;
    }
    const upstream = (await git(['rev-parse', '--verify', '-q', '@{u}'], { cwd: path, signal })).out.trim() || null;
    const diffNames = (await git(['diff', '--name-only', '-z', head ?? EMPTY_TREE, tree], { cwd: path, signal })).out.split('\0').filter(Boolean);
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
    // Everything that would leave the machine: the current files, and every version in the commits the
    // push uploads (earlier snapshots and unpushed commits), not only the net difference.
    const outgoing = (await git(['diff', '--name-only', '-z', upstream ?? EMPTY_TREE, tree], { cwd: path, signal })).out.split('\0').filter(Boolean);
    result.secrets = await scanSecrets(path, outgoing);
    if (result.secrets.length) { result.pushNote = 'похоже на секреты в файлах — снимок только на этой машине'; return result; }
    let toPush = result.commit;
    let history = await scanOutgoing(path, toPush, signal);
    if (history.length && previous) {
      // An earlier local snapshot held the secret: push this state without that snapshot chain.
      const fresh = await git(['commit-tree', tree, ...(head ? ['-p', head] : []), '-F', '-'], { cwd: path, env: IDENTITY, signal, input: message });
      if (fresh.ok) { toPush = fresh.out.trim(); history = await scanOutgoing(path, toPush, signal); }
    }
    if (history.length) { result.secrets = history; result.pushNote = 'похоже на секреты в истории снимка или неотправленных коммитах — снимок только на этой машине'; return result; }
    if (toPush !== result.commit) { await git(['update-ref', ref, toPush], { cwd: path, signal }); result.commit = toPush; }
    const pushed = await git(['push', '--quiet', 'origin', `${toPush}:${ref}`], { cwd: path, signal, timeout: 120_000 });
    result.pushed = pushed.ok;
    if (!pushed.ok) result.pushNote = `push не удался: ${pushed.err}`;
    return result;
  } finally {
    await rm(index, { force: true });
  }
}

export async function snapshotShadow(path: string, dataDir: string, ref: string, message: string, signal: AbortSignal): Promise<SnapshotResult> {
  const unsafe = unsafeShadowRoot(path, homedir());
  if (unsafe) return empty('skipped', { pushNote: unsafe });
  const result = empty('shadow', { pushNote: 'папка без git — снимок в теневом репозитории на этой машине' });
  const files = await plainFiles(path);
  result.skippedFiles = files.skipped;
  result.secrets = files.secrets.slice(0, 20);
  // Repositories inside the folder get ordinary git snapshots with their own refs.
  for (const rel of files.nested.slice(0, 20)) {
    const inner = await snapshotGit(join(path, rel), nestedRef(ref, rel), message, false, signal).catch(error => empty('error', { error: String((error as Error).message) }));
    result.nested.push({ path: rel, commit: inner.commit, files: inner.files, error: inner.error });
  }
  if (files.tooBig) { result.kind = 'skipped'; result.pushNote = `папка больше ${Math.round(MAX_SHADOW_BYTES / 1024 / 1024)} МБ — теневой снимок не делается`; return result; }
  const gitDir = join(dataDir, 'shadow', `${createHash('sha1').update(path).digest('hex').slice(0, 16)}.git`);
  const env = { GIT_DIR: gitDir, GIT_WORK_TREE: path, ...IDENTITY };
  try { await stat(join(gitDir, 'HEAD')); }
  catch {
    await mkdir(gitDir, { recursive: true });
    if (!(await git(['init', '--quiet', '--bare', gitDir], { cwd: path, signal })).ok) throw new Error('не удалось создать теневой репозиторий');
    await writeFile(join(gitDir, 'description'), 'bb limit-guard shadow snapshots\n');
  }
  const index = join(tmpdir(), `bb-limit-guard-${randomBytes(6).toString('hex')}.index`);
  try {
    const ienv = { ...env, GIT_INDEX_FILE: index };
    await git(['read-tree', '--empty'], { cwd: path, env: ienv, signal });
    if (files.kept.length) {
      const added = await git(['add', '-f', '--pathspec-from-file=-', '--pathspec-file-nul'], { cwd: path, env: ienv, signal, timeout: 300_000, input: files.kept.join('\0') });
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

/** Lay a snapshot out as uncommitted changes, only on a clean folder at the snapshot's base. The newer of the local and the server copy wins. */
export async function restoreGit(path: string, ref: string, signal: AbortSignal): Promise<RestoreResult> {
  const remoteRef = ref.replace(/^refs\/wip\//, 'refs/wip-remote/');
  await git(['fetch', '--quiet', '--no-write-fetch-head', 'origin', `+${ref}:${remoteRef}`], { cwd: path, signal, timeout: 120_000 });
  const local = (await git(['rev-parse', '--verify', '-q', ref], { cwd: path, signal })).out.trim() || null;
  const remote = (await git(['rev-parse', '--verify', '-q', remoteRef], { cwd: path, signal })).out.trim() || null;
  const time = async (c: string) => Number((await git(['log', '-1', '--format=%ct', c], { cwd: path, signal })).out.trim()) || 0;
  const commit = local && remote ? ((await time(local)) >= (await time(remote)) ? local : remote) : local ?? remote;
  if (!commit) return { ok: false, message: 'снимок не найден ни на этой машине, ни на сервере' };
  const status = (await git(['status', '--porcelain'], { cwd: path, signal })).out.trim();
  if (status) return { ok: false, message: 'в папке есть правки — сначала сохраните или уберите их; снимок не применён' };
  const head = (await git(['rev-parse', 'HEAD'], { cwd: path, signal })).out.trim();
  const parents = (await git(['rev-list', '--parents', '-n', '1', commit], { cwd: path, signal })).out.trim().split(' ').slice(1);
  const base = parents[parents.length - 1] ?? null;
  if (base !== head) return { ok: false, message: `снимок сделан от ${base?.slice(0, 8) ?? '?'}, а папка на ${head.slice(0, 8)}: примените в отдельной копии (worktree) от ${base?.slice(0, 8) ?? 'базы'}` };
  const diff = await git(['diff', '--binary', head, commit], { cwd: path, signal, timeout: 120_000 });
  if (!diff.ok) return { ok: false, message: `не удалось получить изменения снимка: ${diff.err}` };
  const applied = await git(['apply', '--whitespace=nowarn'], { cwd: path, signal, input: diff.out });
  return applied.ok ? { ok: true, message: `снимок ${commit.slice(0, 8)} разложен как незакоммиченные правки` } : { ok: false, message: `git apply не удался: ${applied.err}` };
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    snapshot: async ({ path, ref, message, push }, ctx): Promise<SnapshotResult> => {
      try {
        try { if (!(await stat(path)).isDirectory()) throw new Error('not a directory'); }
        catch { return empty('missing', { error: 'папка не найдена' }); }
        try { await stat(join(path, '.bb', 'hands-off')); return empty('hands-off'); } catch { /* allowed */ }
        if (await isGitRepo(path, ctx.signal)) return await snapshotGit(path, ref, message, push, ctx.signal);
        return await snapshotShadow(path, ctx.experimental_paths.dataDir, ref, message, ctx.signal);
      } catch (error) {
        return empty('error', { error: String((error as Error).message).slice(0, 300) });
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
