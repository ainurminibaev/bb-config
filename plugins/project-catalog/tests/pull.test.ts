import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { nestedRepos, pullRepo } from '../host';

const root = mkdtempSync(join(tmpdir(), 'catalog-pull-'));
after(() => rmSync(root, { recursive: true, force: true }));
const g = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
const signal = new AbortController().signal;

function setup(name: string) {
  const bare = join(root, `${name}.git`), a = join(root, `${name}-a`), b = join(root, `${name}-b`);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  execFileSync('git', ['clone', '-q', bare, a]);
  writeFileSync(join(a, 'f.txt'), '1\n'); g(a, 'add', '.'); g(a, 'commit', '-qm', 'first'); g(a, 'push', '-q', 'origin', 'HEAD:main');
  execFileSync('git', ['clone', '-q', bare, b]);
  writeFileSync(join(a, 'f.txt'), '2\n'); g(a, 'commit', '-qam', 'second'); g(a, 'push', '-q', 'origin', 'HEAD:main');
  return { a, b };
}

test('a clean branch that is behind is fast-forwarded', async () => {
  const { b } = setup('clean');
  const r = await pullRepo(b, '', true, signal);
  assert.equal(r.action, 'pulled');
  assert.deepEqual(r.commits.map(c => c.split(' ').slice(1).join(' ')), ['second']);
  assert.equal(g(b, 'log', '-1', '--format=%s').trim(), 'second');
});

test('check only fetches and lists, but does not move the branch', async () => {
  const { b } = setup('check');
  const r = await pullRepo(b, '', false, signal);
  assert.equal(r.action, 'skipped');
  assert.equal(r.behind, 1);
  assert.equal(r.reason, null);
  assert.equal(g(b, 'log', '-1', '--format=%s').trim(), 'first');
});

test('local edits block the pull and stay untouched', async () => {
  const { b } = setup('dirty');
  writeFileSync(join(b, 'f.txt'), 'mine\n');
  const r = await pullRepo(b, '', true, signal);
  assert.equal(r.action, 'skipped');
  assert.equal(r.reason, 'dirty');
  assert.equal(g(b, 'log', '-1', '--format=%s').trim(), 'first');
  assert.equal(g(b, 'diff', '--name-only').trim(), 'f.txt');
});

test('diverged branches are never merged', async () => {
  const { b } = setup('diverged');
  writeFileSync(join(b, 'g.txt'), 'x\n'); g(b, 'add', '.'); g(b, 'commit', '-qm', 'local');
  const r = await pullRepo(b, '', true, signal);
  assert.equal(r.reason, 'diverged');
  assert.equal(g(b, 'log', '-1', '--format=%s').trim(), 'local');
});

test('repositories nested in a plain folder are found', async () => {
  const plain = join(root, 'plain');
  mkdirSync(join(plain, 'one', '.git'), { recursive: true });
  mkdirSync(join(plain, 'two', 'deep', '.git'), { recursive: true });
  mkdirSync(join(plain, 'node_modules', 'x', '.git'), { recursive: true });
  assert.deepEqual(await nestedRepos(plain), ['one', 'two/deep']);
});
