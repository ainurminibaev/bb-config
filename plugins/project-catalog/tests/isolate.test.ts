import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { isolate, land } from '../host';
import { isolationNames, isolationRule } from '../core';

const root = mkdtempSync(join(tmpdir(), 'catalog-iso-'));
after(() => rmSync(root, { recursive: true, force: true }));
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const g = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env });
const signal = new AbortController().signal;

function repo(name: string) {
  const main = join(root, name);
  execFileSync('git', ['init', '-q', '-b', 'main', main]);
  writeFileSync(join(main, 'a.txt'), '1\n');
  writeFileSync(join(main, '.gitignore'), '.env\n');
  writeFileSync(join(main, '.worktreeinclude'), '.env\n');
  g(main, 'add', '.'); g(main, 'commit', '-qm', 'first');
  writeFileSync(join(main, '.env'), 'KEY=local\n');
  return main;
}

test('a copy is made from the folder HEAD, gets .worktreeinclude files, and lands by fast-forward', async () => {
  const main = repo('ff');
  writeFileSync(join(main, 'a.txt'), 'first thread is editing\n'); // the first thread's unfinished work
  const names = isolationNames('thr_abc123', main, join(root, 'data'));
  const made = await isolate(main, names.target, names.branch, signal, false);
  assert.equal(made.ok, true, made.message);
  assert.equal(readFileSync(join(names.target, 'a.txt'), 'utf8'), '1\n', 'the copy starts from the committed state');
  assert.equal(readFileSync(join(names.target, '.env'), 'utf8'), 'KEY=local\n');
  writeFileSync(join(names.target, 'b.txt'), 'second thread\n'); g(names.target, 'add', 'b.txt'); g(names.target, 'commit', '-qm', 'second');
  const waiting = await land(main, names.target, names.branch, signal);
  assert.equal(waiting.state, 'waiting', 'the main folder has edits: wait');
  g(main, 'checkout', '--', 'a.txt');
  const done = await land(main, names.target, names.branch, signal);
  assert.equal(done.state, 'landed', done.message);
  assert.equal(done.commits, 1);
  assert.equal(readFileSync(join(main, 'b.txt'), 'utf8'), 'second thread\n');
  assert.equal(existsSync(names.target), false, 'the copy is removed');
  assert.equal(g(main, 'branch', '--list', names.branch).trim(), '', 'the branch is removed');
});

test('uncommitted work in the copy is never landed or removed', async () => {
  const main = repo('dirty-copy');
  const names = isolationNames('thr_dirty', main, join(root, 'data'));
  await isolate(main, names.target, names.branch, signal, false);
  writeFileSync(join(names.target, 'c.txt'), 'not committed\n');
  const r = await land(main, names.target, names.branch, signal);
  assert.equal(r.state, 'uncommitted');
  assert.equal(existsSync(join(names.target, 'c.txt')), true);
});

test('the main branch moved on: the copy is rebased, then fast-forwarded; a conflict changes nothing', async () => {
  const main = repo('rebase');
  const names = isolationNames('thr_rebase', main, join(root, 'data'));
  await isolate(main, names.target, names.branch, signal, false);
  writeFileSync(join(names.target, 'b.txt'), 'copy\n'); g(names.target, 'add', 'b.txt'); g(names.target, 'commit', '-qm', 'copy');
  writeFileSync(join(main, 'c.txt'), 'main\n'); g(main, 'add', 'c.txt'); g(main, 'commit', '-qm', 'main moved');
  const r = await land(main, names.target, names.branch, signal);
  assert.equal(r.state, 'landed', r.message);
  assert.equal(g(main, 'log', '--format=%s', '-2').trim(), 'copy\nmain moved');

  const names2 = isolationNames('thr_conflict', main, join(root, 'data'));
  await isolate(main, names2.target, names2.branch, signal, false);
  writeFileSync(join(names2.target, 'a.txt'), 'copy version\n'); g(names2.target, 'commit', '-qam', 'copy edit');
  writeFileSync(join(main, 'a.txt'), 'main version\n'); g(main, 'commit', '-qam', 'main edit');
  const before = g(main, 'rev-parse', 'HEAD');
  const c = await land(main, names2.target, names2.branch, signal);
  assert.equal(c.state, 'conflict');
  assert.equal(g(main, 'rev-parse', 'HEAD'), before);
  assert.equal(readFileSync(join(names2.target, 'a.txt'), 'utf8'), 'copy version\n');
});

test('the agent rule names who works in the folder and what to call', () => {
  const rule = isolationRule([{ id: 'thr_x', title: 'Другая задача' }]);
  assert.match(rule, /ПАПКА ЗАНЯТА.*«Другая задача» \(thr_x\).*project_isolate.*update_environment_directory.*project_land/s);
});

test('ignored work in the copy blocks removal; identical .env and node_modules do not', async () => {
  const main = repo('ignored');
  writeFileSync(join(main, '.gitignore'), '.env\n.local/\nnode_modules/\n'); g(main, 'commit', '-qam', 'ignore more');
  const names = isolationNames('thr_ign001', main, join(root, 'data'));
  assert.equal((await isolate(main, names.target, names.branch, signal, false)).ok, true);
  execFileSync('mkdir', ['-p', join(names.target, 'node_modules/x'), join(names.target, '.local/config')]);
  writeFileSync(join(names.target, 'node_modules/x/i.js'), 'x');
  writeFileSync(join(names.target, '.local/config/snap.json'), '{}');
  const kept = await land(main, names.target, names.branch, signal);
  assert.equal(kept.state, 'uncommitted', kept.message);
  assert.match(kept.message, /\.local\/config\/snap\.json/);
  assert.equal(existsSync(join(names.target, '.local/config/snap.json')), true, 'nothing was removed');
  rmSync(join(names.target, '.local'), { recursive: true });
  const done = await land(main, names.target, names.branch, signal);
  assert.equal(done.state, 'landed', done.message);
  assert.equal(existsSync(names.target), false);
});

test('an empty copy stays while its thread may still work; removal keeps unmerged branches', async () => {
  const main = repo('empty');
  const names = isolationNames('thr_emp001', main, join(root, 'data'));
  assert.equal((await isolate(main, names.target, names.branch, signal, false)).ok, true);
  const stay = await land(main, names.target, names.branch, signal, false);
  assert.equal(stay.state, 'waiting', stay.message);
  assert.equal(existsSync(names.target), true);
  const gone = await land(main, names.target, names.branch, signal, true);
  assert.equal(gone.state, 'landed', gone.message);
  assert.equal(g(main, 'branch', '--list', names.branch).trim(), '', 'a merged branch is deleted');
});

test('a git failure changes nothing', async () => {
  const main = repo('gitfail');
  const names = isolationNames('thr_gf0001', main, join(root, 'data'));
  assert.equal((await isolate(main, names.target, names.branch, signal, false)).ok, true);
  writeFileSync(join(names.target, 'c.txt'), 'work\n'); g(names.target, 'add', 'c.txt'); g(names.target, 'commit', '-qm', 'work');
  const r = await land(main, names.target, 'no-such-branch', signal);
  assert.equal(r.state, 'error', r.message);
  assert.equal(existsSync(names.target), true);
  assert.notEqual(g(main, 'branch', '--list', names.branch).trim(), '', 'the branch with commits is kept');
});
