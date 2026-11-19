import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { restoreGit, snapshotGit, snapshotShadow } from './host.ts';
import { findSecrets, snapshotRef } from './snapshot-logic.ts';

const root = mkdtempSync(join(tmpdir(), 'limit-guard-snap-'));
after(() => rmSync(root, { recursive: true, force: true }));
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const g = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env });
const signal = new AbortController().signal;
const REF = snapshotRef('env_test');

function repo(name: string) {
  const bare = join(root, `${name}.git`), a = join(root, name);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  execFileSync('git', ['clone', '-q', bare, a], { env });
  writeFileSync(join(a, '.gitignore'), 'secret.txt\n');
  writeFileSync(join(a, 'f.txt'), '1\n');
  g(a, 'add', '.'); g(a, 'commit', '-qm', 'first'); g(a, 'push', '-q', 'origin', 'HEAD:main');
  return { bare, a };
}
const state = (dir: string) => ({ status: g(dir, 'status', '--porcelain'), head: g(dir, 'rev-parse', 'HEAD'), index: g(dir, 'ls-files', '-s'), branch: g(dir, 'branch', '--show-current') });

test('a snapshot keeps files, index and branch untouched and takes new files but not ignored ones', async () => {
  const { a } = repo('keep');
  writeFileSync(join(a, 'f.txt'), 'changed\n');
  writeFileSync(join(a, 'new.txt'), 'new\n');
  writeFileSync(join(a, 'secret.txt'), 'ignored\n');
  g(a, 'add', 'f.txt'); // a staged change must stay staged
  const before = state(a);
  const r = await snapshotGit(a, REF, 'bb snapshot: test', false, signal);
  assert.deepEqual(state(a), before);
  assert.equal(r.kind, 'git'); assert.equal(r.changed, true); assert.ok(r.commit);
  const files = g(a, 'ls-tree', '-r', '--name-only', r.commit!).split('\n').filter(Boolean).sort();
  assert.deepEqual(files, ['.gitignore', 'f.txt', 'new.txt']);
  assert.equal(g(a, 'show', `${r.commit}:f.txt`), 'changed\n');
  assert.equal(g(a, 'rev-parse', REF).trim(), r.commit);
  assert.equal(g(a, 'branch', '--list').includes('wip'), false, 'no branch appears in the branch list');
});

test('an unchanged snapshot is not repeated; a clean folder drops the old one', async () => {
  const { a } = repo('repeat');
  writeFileSync(join(a, 'n.txt'), 'x\n');
  const first = await snapshotGit(a, REF, 'm', false, signal);
  const second = await snapshotGit(a, REF, 'm', false, signal);
  assert.equal(second.changed, false); assert.equal(second.commit, first.commit);
  writeFileSync(join(a, 'n.txt'), 'y\n');
  const third = await snapshotGit(a, REF, 'm', false, signal);
  assert.equal(g(a, 'rev-parse', `${third.commit}^1`).trim(), first.commit, 'previous snapshot is the first parent: no force push needed');
  rmSync(join(a, 'n.txt'));
  const clean = await snapshotGit(a, REF, 'm', false, signal);
  assert.equal(clean.removed, true);
  assert.throws(() => g(a, 'rev-parse', '--verify', '-q', REF));
});

test('push is refused for a remote that is not confirmed private', async () => {
  const { a } = repo('pub');
  writeFileSync(join(a, 'w.txt'), 'w\n');
  const r = await snapshotGit(a, REF, 'm', true, signal);
  assert.equal(r.pushed, false);
  assert.match(r.pushNote ?? '', /приватный|только на этой машине/);
});

test('a snapshot is laid out on another clean copy at the same base', async () => {
  const { bare, a } = repo('restore');
  writeFileSync(join(a, 'f.txt'), 'work in progress\n');
  writeFileSync(join(a, 'added.txt'), 'added\n');
  const r = await snapshotGit(a, REF, 'm', false, signal);
  g(a, 'push', '-q', 'origin', `${r.commit}:${REF}`);
  const b = join(root, 'restore-b');
  execFileSync('git', ['clone', '-q', bare, b], { env });
  const done = await restoreGit(b, REF, signal);
  assert.equal(done.ok, true, done.message);
  assert.equal(readFileSync(join(b, 'f.txt'), 'utf8'), 'work in progress\n');
  assert.equal(readFileSync(join(b, 'added.txt'), 'utf8'), 'added\n');
  assert.equal(g(b, 'rev-parse', 'HEAD').trim(), g(a, 'rev-parse', 'HEAD').trim(), 'branch did not move');
  writeFileSync(join(b, 'f.txt'), 'other\n');
  assert.equal((await restoreGit(b, REF, signal)).ok, false, 'a dirty folder is refused');
});

test('a folder without git gets a shadow repository and stays without .git', async () => {
  const plain = join(root, 'plain'); const data = join(root, 'data');
  mkdirSync(join(plain, 'node_modules', 'x'), { recursive: true });
  writeFileSync(join(plain, 'notes.md'), 'hello\n');
  writeFileSync(join(plain, 'node_modules', 'x', 'big.js'), 'skip\n');
  const r = await snapshotShadow(plain, data, 'm', signal);
  assert.equal(r.kind, 'shadow'); assert.equal(r.changed, true); assert.equal(r.files, 1);
  assert.equal(existsSync(join(plain, '.git')), false);
  const again = await snapshotShadow(plain, data, 'm', signal);
  assert.equal(again.changed, false);
});

test('secret detection by name and by token shape', () => {
  assert.equal(findSecrets('.env', ''), true);
  assert.equal(findSecrets('.env.example', ''), false);
  assert.equal(findSecrets('config/app.ts', 'const t = "ghp_' + 'a'.repeat(36) + '"'), true);
  assert.equal(findSecrets('notes.md', '-----BEGIN OPENSSH PRIVATE KEY-----'), true);
  assert.equal(findSecrets('notes.md', 'just text'), false);
});
