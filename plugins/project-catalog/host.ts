// Runs on each enrolled machine: reads the state of project folders there.
// `scan` is read-only: never fetches, never writes into a project.
// `pull` runs only when an agent or a person asks: git fetch, then a
// fast-forward of a clean branch. It never merges, rebases, stashes or resets.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { experimental_defineHostEntry } from '@get-bb/plugin-sdk/host';
import { hostContract } from './contract';
import { isolationNames } from './core';
import type { GitState, IsolateResult, LandResult, Manifest, PlainState, PullResult, RepoSync, Scan } from './core';

const SKIP = new Set(['.git', 'node_modules', '.venv', 'venv', 'env', '__pycache__', '.mypy_cache', '.pytest_cache', '.ruff_cache', 'dist', 'build', '.next', '.nuxt', '.cache', '.turbo', 'target', '.gradle', '.idea', '.vscode', '.playwright-cli', '.playwright-mcp', 'Pods', 'DerivedData', '.DS_Store', '.Trash', 'tmp', 'logs']);
const MAX_FILES = 4000;
const MAX_DEPTH = 10;
const MAX_HASH_BYTES = 2 * 1024 * 1024;
const DOCS = ['README.md', 'README', 'readme.md', 'Readme.md', 'AGENTS.md', 'CLAUDE.md'];

function git(cwd: string, args: string[], signal: AbortSignal) {
  return new Promise<string | null>(resolve => {
    execFile('git', ['-C', cwd, ...args], { timeout: 8000, maxBuffer: 8 * 1024 * 1024, signal, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } },
      (error, stdout) => resolve(error ? null : stdout));
  });
}

async function gitState(path: string, signal: AbortSignal): Promise<GitState | null> {
  if ((await git(path, ['rev-parse', '--is-inside-work-tree'], signal))?.trim() !== 'true') return null;
  const status = await git(path, ['status', '--porcelain=v2', '--branch', '--untracked-files=normal'], signal);
  if (status === null) return null;
  const state: GitState = { branch: null, head: null, headTime: null, dirty: 0, untracked: 0, ahead: 0, behind: 0, hasUpstream: false, remote: null, stash: 0 };
  for (const line of status.split('\n')) {
    if (line.startsWith('# branch.oid ')) state.head = line.slice(13) === '(initial)' ? null : line.slice(13);
    else if (line.startsWith('# branch.head ')) state.branch = line.slice(14) === '(detached)' ? null : line.slice(14);
    else if (line.startsWith('# branch.upstream ')) state.hasUpstream = true;
    else if (line.startsWith('# branch.ab ')) {
      const match = /\+(\d+) -(\d+)/.exec(line);
      if (match) { state.ahead = Number(match[1]); state.behind = Number(match[2]); }
    } else if (line.startsWith('? ')) state.untracked++;
    else if (/^[12u] /.test(line)) state.dirty++;
  }
  if (state.head) {
    const time = Number((await git(path, ['log', '-1', '--format=%ct'], signal))?.trim());
    state.headTime = Number.isFinite(time) && time > 0 ? time * 1000 : null;
  }
  const remote = (await git(path, ['config', '--get', 'remote.origin.url'], signal))?.trim();
  // Never keep credentials embedded in a remote URL.
  state.remote = remote ? remote.replace(/^(https?:\/\/)[^/@]+@/i, '$1') : null;
  const stash = await git(path, ['stash', 'list'], signal);
  state.stash = stash ? stash.split('\n').filter(Boolean).length : 0;
  return state;
}

type HashCache = Record<string, [size: number, mtime: number, hash: string]>;

async function plainState(root: string, withManifest: boolean, cache: HashCache, signal: AbortSignal): Promise<{ state: PlainState; manifest: Manifest | null; nested: string[] }> {
  // Sub-folders that are git repositories of their own are reported by git state, not by file hashes.
  const nested: string[] = [];
  const state: PlainState = { files: 0, bytes: 0, latestMtime: null, digest: null, truncated: false };
  const manifest: Manifest = {};
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (signal.aborted || state.truncated) return;
    let names: import('node:fs').Dirent[];
    try { names = await readdir(dir, { withFileTypes: true }); } catch { return; }
    names.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const item of names) {
      if (SKIP.has(item.name) || item.name.startsWith('._') || item.isSymbolicLink()) continue;
      const full = join(dir, item.name);
      const path = rel ? `${rel}/${item.name}` : item.name;
      if (item.isDirectory()) {
        if (depth < 3 && nested.length < 20) { try { await stat(join(full, '.git')); nested.push(path); continue; } catch { /* not a repository */ } }
        if (depth < MAX_DEPTH) await walk(full, path, depth + 1);
        continue;
      }
      if (!item.isFile()) continue;
      if (state.files >= MAX_FILES) { state.truncated = true; return; }
      let info: import('node:fs').Stats;
      try { info = await stat(full); } catch { continue; }
      state.files++;
      state.bytes += info.size;
      const mtime = Math.floor(info.mtimeMs);
      if (state.latestMtime === null || mtime > state.latestMtime) state.latestMtime = mtime;
      if (!withManifest) continue;
      const cached = cache[full];
      let hash: string;
      if (cached && cached[0] === info.size && cached[1] === mtime) hash = cached[2];
      else if (info.size > MAX_HASH_BYTES) hash = `size:${info.size}`;
      else {
        try { hash = createHash('sha1').update(await readFile(full)).digest('hex'); } catch { hash = 'unreadable'; }
      }
      cache[full] = [info.size, mtime, hash];
      manifest[path] = [hash, mtime];
    }
  };
  await walk(root, '', 0);
  if (withManifest) {
    const digest = createHash('sha256');
    for (const path of Object.keys(manifest).sort()) digest.update(`${path}\0${manifest[path]![0]}\n`);
    state.digest = digest.digest('hex');
  }
  return { state, manifest: withManifest ? manifest : null, nested };
}

async function docHash(root: string) {
  const hash = createHash('sha1');
  let found = false;
  for (const name of DOCS) {
    try {
      const text = await readFile(join(root, name));
      hash.update(name).update(text.subarray(0, 200_000));
      found = true;
    } catch { /* absent */ }
  }
  return found ? hash.digest('hex') : null;
}

async function scanOne(path: string, withManifest: boolean, cache: HashCache, signal: AbortSignal): Promise<{ scan: Scan; manifest: Manifest | null }> {
  const scannedAt = Date.now();
  try {
    try { if (!(await stat(path)).isDirectory()) return { scan: { scannedAt, kind: 'missing', docHash: null }, manifest: null }; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { scan: { scannedAt, kind: 'missing', docHash: null }, manifest: null };
      throw error;
    }
    const doc = await docHash(path);
    const state = await gitState(path, signal);
    if (state) return { scan: { scannedAt, kind: 'git', git: state, docHash: doc }, manifest: null };
    const plain = await plainState(path, withManifest, cache, signal);
    const parts: { path: string; git: GitState }[] = [];
    for (const rel of plain.nested) { const part = await gitState(join(path, rel), signal); if (part) parts.push({ path: rel, git: part }); }
    return { scan: { scannedAt, kind: 'plain', plain: plain.state, docHash: doc, ...(parts.length ? { parts } : {}) }, manifest: plain.manifest };
  } catch (error) {
    return { scan: { scannedAt, kind: 'error', error: String((error as Error).message).slice(0, 200), docHash: null }, manifest: null };
  }
}

// ---------- Safe pull: the only handler that writes, and only fast-forwards ----------

const NETWORK_ENV = {
  ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C',
  // Never hang on a password or host-key prompt in the background.
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes -o ConnectTimeout=15',
};

function run(cwd: string, args: string[], timeout: number, signal: AbortSignal) {
  return new Promise<{ ok: boolean; out: string; err: string }>(resolve => {
    execFile('git', ['-C', cwd, ...args], { timeout, maxBuffer: 4 * 1024 * 1024, signal, env: NETWORK_ENV },
      (error, stdout, stderr) => resolve({ ok: !error, out: String(stdout), err: String(stderr || (error ? error.message : '')).trim().slice(0, 300) }));
  });
}

export async function nestedRepos(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, rel: string, depth: number) => {
    let names: import('node:fs').Dirent[];
    try { names = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const item of names) {
      if (!item.isDirectory() || SKIP.has(item.name) || found.length >= 20) continue;
      const path = rel ? `${rel}/${item.name}` : item.name;
      try { await stat(join(dir, item.name, '.git')); found.push(path); continue; } catch { /* not a repository */ }
      if (depth < 2) await walk(join(dir, item.name), path, depth + 1);
    }
  };
  await walk(root, '', 0);
  return found.sort();
}

export async function pullRepo(root: string, rel: string, apply: boolean, signal: AbortSignal): Promise<RepoSync> {
  const path = rel ? join(root, rel) : root;
  const result: RepoSync = { path: rel, branch: null, before: null, after: null, fetched: false, fetchError: null,
    action: 'skipped', reason: null, ahead: 0, behind: 0, dirty: 0, commits: [], stat: null };
  const hasRemote = Boolean((await git(path, ['remote'], signal))?.trim());
  if (hasRemote) {
    // --no-write-fetch-head: never overwrite FETCH_HEAD someone else in this folder relies on.
    const fetch = await run(path, ['fetch', '--quiet', '--no-write-fetch-head'], 45_000, signal);
    result.fetched = fetch.ok;
    if (!fetch.ok) result.fetchError = fetch.err || 'git fetch не удался';
  }
  const state = await gitState(path, signal);
  if (!state) { result.reason = 'error'; result.fetchError ??= 'git status не удался'; return result; }
  Object.assign(result, { branch: state.branch, before: state.head, after: state.head, ahead: state.ahead, behind: state.behind, dirty: state.dirty });
  if (!hasRemote) { result.reason = 'no-remote'; return result; }
  if (!state.branch) { result.reason = 'detached'; return result; }
  if (!state.hasUpstream) { result.reason = 'no-upstream'; return result; }
  if (!result.fetched) { result.reason = 'fetch-failed'; return result; }
  if (state.behind === 0) { result.action = 'up-to-date'; result.reason = state.ahead > 0 ? 'ahead' : null; return result; }
  if (state.ahead > 0) { result.reason = 'diverged'; }
  else if (state.dirty > 0) { result.reason = 'dirty'; }
  if (result.reason || !apply) {
    const incoming = await git(path, ['log', '--oneline', '--no-decorate', '-15', 'HEAD..@{u}'], signal);
    result.commits = (incoming ?? '').split('\n').filter(Boolean);
    return result;
  }
  const merge = await run(path, ['merge', '--ff-only', '--quiet', '@{u}'], 10 * 60_000, signal);
  if (!merge.ok) {
    // A hook (post-merge, LFS) may fail after the branch already moved: report what really happened.
    const now = (await git(path, ['rev-parse', 'HEAD'], signal))?.trim() ?? null;
    if (!now || now === state.head) { result.reason = 'merge-failed'; result.fetchError = merge.err; return result; }
    result.fetchError = `git сообщил об ошибке после обновления: ${merge.err}`;
  }
  const after = (await git(path, ['rev-parse', 'HEAD'], signal))?.trim() ?? null;
  result.after = after;
  result.action = 'pulled';
  result.behind = 0;
  if (state.head && after) {
    result.commits = ((await git(path, ['log', '--oneline', '--no-decorate', '-15', `${state.head}..${after}`], signal)) ?? '').split('\n').filter(Boolean);
    result.stat = (await git(path, ['diff', '--shortstat', state.head, after], signal))?.trim() || null;
  }
  return result;
}

/** Disk usage in bytes via `du -sk` (Linux and macOS); null when unknown or too slow. */
function diskUsage(path: string, signal: AbortSignal) {
  return new Promise<number | null>(resolve => {
    execFile('du', ['-sk', path], { timeout: 60_000, maxBuffer: 64 * 1024, signal }, (_error, stdout) => {
      const kb = Number(String(stdout).split(/\s/)[0]);
      // du exits non-zero when a few entries are unreadable but still prints the total.
      resolve(Number.isFinite(kb) && String(stdout).trim() !== '' ? kb * 1024 : null);
    });
  });
}

// ---------- Isolation: a second thread in a busy folder works in its own copy ----------

/** Untracked files the project asks to copy into new copies (`.worktreeinclude`, gitignore syntax). */
async function includedFiles(main: string, signal: AbortSignal): Promise<string[]> {
  try { await stat(join(main, '.worktreeinclude')); } catch { return []; }
  const listed = await run(main, ['ls-files', '--others', '--ignored', '--exclude-from=.worktreeinclude', '-z'], 60_000, signal);
  return listed.out.split('\0').filter(Boolean).filter(f => !f.split('/').some(part => SKIP.has(part))).slice(0, 2000);
}

export async function isolate(main: string, target: string, branch: string, signal: AbortSignal, runSetup = true): Promise<IsolateResult> {
  if ((await git(main, ['rev-parse', '--is-inside-work-tree'], signal))?.trim() !== 'true') return { ok: false, path: null, branch: null, base: null, message: 'папка без git — отдельную копию сделать нельзя', copied: 0, setup: null };
  try { await stat(target); return { ok: false, path: null, branch: null, base: null, message: `копия ${target} уже существует`, copied: 0, setup: null }; } catch { /* free */ }
  const base = (await git(main, ['rev-parse', 'HEAD'], signal))?.trim() ?? null;
  if (!base) return { ok: false, path: null, branch: null, base: null, message: 'в репозитории нет коммитов', copied: 0, setup: null };
  await mkdir(join(target, '..'), { recursive: true });
  const added = await run(main, ['worktree', 'add', '--quiet', '-b', branch, target, base], 120_000, signal);
  if (!added.ok) return { ok: false, path: null, branch: null, base, message: `git worktree add: ${added.err}`, copied: 0, setup: null };
  let copied = 0;
  for (const file of await includedFiles(main, signal)) {
    try {
      const to = join(target, file);
      try { await stat(to); continue; } catch { /* do not replace */ }
      await mkdir(join(to, '..'), { recursive: true });
      await writeFile(to, await readFile(join(main, file)));
      copied++;
    } catch { /* unreadable: skip */ }
  }
  let setup: string | null = null;
  if (runSetup) {
    try {
      await stat(join(target, '.bb-env-setup.sh'));
      setup = await new Promise<string>(resolve => {
        execFile('bash', ['.bb-env-setup.sh'], { cwd: target, timeout: 15 * 60_000, maxBuffer: 4 * 1024 * 1024, signal },
          error => resolve(error ? `.bb-env-setup.sh не удался: ${String(error.message).slice(0, 200)}` : '.bb-env-setup.sh выполнен'));
      });
    } catch { /* no setup script */ }
  }
  return { ok: true, path: target, branch, base, message: 'копия создана', copied, setup };
}

/**
 * Bring a copy's commits back into the main folder's branch, then remove the copy.
 * Only when the copy has no uncommitted work and the main folder is clean; a fast-forward
 * when possible, otherwise a rebase of the copy's own branch. Conflicts change nothing.
 */
export async function land(main: string, copy: string, branch: string, signal: AbortSignal): Promise<LandResult> {
  const out = (state: LandResult['state'], message: string, commits = 0): LandResult => ({ state, message, commits });
  try { await stat(copy); } catch { return out('gone', 'копии уже нет'); }
  if ((await git(copy, ['status', '--porcelain'], signal))?.trim()) return out('uncommitted', 'в копии есть незакоммиченные правки — сначала закоммитьте законченное');
  const mainBranch = (await git(main, ['branch', '--show-current'], signal))?.trim();
  if (!mainBranch) return out('waiting', 'основная папка не на ветке (detached) — вливать некуда');
  const mainHead = (await git(main, ['rev-parse', 'HEAD'], signal))?.trim() ?? '';
  const ahead = Number((await git(copy, ['rev-list', '--count', `${mainHead}..${branch}`], signal))?.trim() ?? '0');
  const remove = async () => {
    await run(main, ['worktree', 'remove', copy], 60_000, signal);
    await run(main, ['branch', '-D', branch], 30_000, signal);
  };
  if (ahead === 0) { await remove(); return out('landed', 'новых коммитов нет — копия убрана'); }
  if ((await git(main, ['status', '--porcelain', '--untracked-files=no'], signal))?.trim()) return out('waiting', 'в основной папке есть незакоммиченные правки — волью, когда она станет чистой');
  const isAncestor = (await run(main, ['merge-base', '--is-ancestor', mainHead, branch], 30_000, signal)).ok;
  if (!isAncestor) {
    const rebased = await run(copy, ['rebase', '--quiet', mainHead], 120_000, signal);
    if (!rebased.ok) {
      await run(copy, ['rebase', '--abort'], 30_000, signal);
      return out('conflict', `конфликт при переносе коммитов на свежую версию основной папки — копия и ветка ${branch} оставлены как есть`);
    }
  }
  const merged = await run(main, ['merge', '--ff-only', '--quiet', branch], 60_000, signal);
  if (!merged.ok) return out('waiting', `основная папка не приняла коммиты: ${merged.err}`);
  await remove();
  return out('landed', `влито коммитов: ${ahead} в ${mainBranch}; копия убрана`, ahead);
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    // Background refresh of what the server has: updates remote refs only, never files or branches.
    fetch: async ({ paths }, ctx) => {
      const results: { path: string; ok: boolean; error: string | null }[] = [];
      for (const path of paths) {
        try { await stat(join(path, '.bb', 'hands-off')); results.push({ path, ok: false, error: 'hands-off' }); continue; } catch { /* allowed */ }
        const repos = (await git(path, ['rev-parse', '--is-inside-work-tree'], ctx.signal))?.trim() === 'true' ? [''] : await nestedRepos(path).catch(() => []);
        let ok = true; let error: string | null = null;
        for (const rel of repos) {
          const dir = rel ? join(path, rel) : path;
          if (!(await git(dir, ['remote'], ctx.signal))?.trim()) continue;
          const done = await run(dir, ['fetch', '--quiet', '--no-write-fetch-head'], 45_000, ctx.signal);
          if (!done.ok) { ok = false; error = done.err; }
        }
        results.push({ path, ok, error });
      }
      return { results };
    },
    sizes: async ({ paths, measure }, ctx) => {
      const sizes: { path: string; bytes: number | null; exists: boolean }[] = [];
      for (const path of paths) {
        let exists = true;
        try { await stat(path); } catch (error) { exists = (error as NodeJS.ErrnoException).code !== 'ENOENT'; }
        sizes.push({ path, exists, bytes: exists && measure !== false ? await diskUsage(path, ctx.signal) : null });
      }
      return { sizes };
    },
    isolate: async ({ path, threadId }, ctx): Promise<IsolateResult> => {
      try { const names = isolationNames(threadId, path, ctx.experimental_paths.dataDir); return await isolate(path, names.target, names.branch, ctx.signal); }
      catch (error) { return { ok: false, path: null, branch: null, base: null, message: String((error as Error).message).slice(0, 300), copied: 0, setup: null }; }
    },
    land: async ({ path, copy, branch }, ctx): Promise<LandResult> => {
      try { return await land(path, copy, branch, ctx.signal); }
      catch (error) { return { state: 'error', message: String((error as Error).message).slice(0, 300), commits: 0 }; }
    },
    pull: async ({ path, apply }, ctx): Promise<PullResult> => {
      try {
        try { if (!(await stat(path)).isDirectory()) return { kind: 'missing', repos: [], error: null }; }
        catch { return { kind: 'missing', repos: [], error: null }; }
        try { await stat(join(path, '.bb', 'hands-off')); return { kind: 'hands-off', repos: [], error: null }; } catch { /* allowed */ }
        if ((await git(path, ['rev-parse', '--is-inside-work-tree'], ctx.signal))?.trim() === 'true') {
          return { kind: 'git', repos: [await pullRepo(path, '', apply, ctx.signal)], error: null };
        }
        const repos: RepoSync[] = [];
        for (const rel of await nestedRepos(path)) repos.push(await pullRepo(path, rel, apply, ctx.signal));
        return { kind: 'plain', repos, error: null };
      } catch (error) {
        return { kind: 'error', repos: [], error: String((error as Error).message).slice(0, 200) };
      }
    },
    scan: async ({ targets }, ctx) => {
      const cacheFile = join(ctx.experimental_paths.dataDir, 'hashes.json');
      let cache: HashCache = {};
      const wantsHashes = targets.some(target => target.manifest);
      if (wantsHashes) { try { cache = JSON.parse(await readFile(cacheFile, 'utf8')) as HashCache; } catch { cache = {}; } }
      const results: { id: string; scan: Scan; manifest: Manifest | null }[] = [];
      let next = 0;
      const worker = async () => {
        while (next < targets.length && !ctx.signal.aborted) {
          const target = targets[next++]!;
          const local: HashCache = target.manifest ? cache : {};
          const result = await scanOne(target.path, target.manifest, local, ctx.signal);
          results.push({ id: target.id, ...result });
        }
      };
      await Promise.all(Array.from({ length: 4 }, worker));
      if (wantsHashes) {
        try { await mkdir(ctx.experimental_paths.dataDir, { recursive: true }); await writeFile(cacheFile, JSON.stringify(cache)); } catch { /* cache is optional */ }
      }
      return { results };
    },
  },
});
