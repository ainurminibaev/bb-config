import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describePull, eventSummary, otherCopies, pushHistory, syncEvent, type PullResult, type RepoSync, type SourceView } from '../core';

const repo = (extra: Partial<RepoSync> = {}): RepoSync => ({
  path: '', branch: 'main', before: 'a1', after: 'a1', fetched: true, fetchError: null, action: 'up-to-date', reason: null,
  ahead: 0, behind: 0, dirty: 0, commits: [], stat: null, ...extra,
});
const result = (...repos: RepoSync[]): PullResult => ({ kind: 'git', repos, error: null });
const base = { at: 1, hostId: 'h1', hostName: 'Tru', path: '/srv/p', threadId: 't1', apply: true };

test('pulled commits are listed with their stat', () => {
  const text = describePull(result(repo({ action: 'pulled', commits: ['abc fix', 'def add'], stat: '2 files changed', after: 'b2' })), 'Tru: /srv/p');
  assert.match(text, /подтянуто 2 коммит\(ов\), 2 files changed/);
  assert.match(text, /abc fix/);
});

test('a dirty or diverged folder is explained, never pulled', () => {
  assert.match(describePull(result(repo({ action: 'skipped', reason: 'dirty', behind: 3, dirty: 2, commits: ['x new'] })), 'p'), /на сервере 3 новых.*незакоммиченные правки.*изменённых файлов: 2/s);
  assert.match(describePull(result(repo({ action: 'skipped', reason: 'diverged', behind: 1, ahead: 2 })), 'p'), /разошлись/);
  assert.match(describePull(result(repo({ action: 'skipped', reason: 'fetch-failed', fetchError: 'Permission denied' })), 'p'), /сеть или авторизация[\s\S]*Permission denied/);
});

test('up to date with unpushed commits says so', () => {
  assert.match(describePull(result(repo({ reason: 'ahead', ahead: 4 })), 'p'), /актуально; .*не отправлены\) \(4\)/);
});

test('plain folders and nested repositories', () => {
  assert.match(describePull({ kind: 'plain', repos: [], error: null }, 'Mac: ~/notes'), /без git/);
  const nested = describePull({ kind: 'plain', repos: [repo({ path: 'app-a' }), repo({ path: 'app-b', action: 'pulled', commits: ['c1'] })], error: null }, 'Tru: /srv/m');
  assert.match(nested, /сама папка без git/);
  assert.match(nested, /app-a\/ \(main\): актуально/);
  assert.match(nested, /app-b\/ \(main\): подтянуто 1/);
});

test('history keeps the newest events first and is capped', () => {
  let history = [] as ReturnType<typeof syncEvent>[];
  for (let i = 0; i < 45; i++) history = pushHistory(history, syncEvent(result(repo()), { ...base, at: i }));
  assert.equal(history.length, 40);
  assert.equal(history[0]!.at, 44);
  const event = syncEvent(result(repo({ action: 'pulled', commits: ['a', 'b', 'c'] })), base);
  assert.equal(event.repos[0]!.commits, 3);
  assert.equal(eventSummary(event), 'подтянуто 3');
  assert.equal(eventSummary(syncEvent(result(repo({ action: 'skipped', reason: 'dirty', behind: 2 })), base)), 'есть правки, отстаёт на 2');
  assert.equal(eventSummary(syncEvent({ kind: 'plain', repos: [], error: null }, base)), 'без git');
});

test('other machines come from the last scan', () => {
  const sources: SourceView[] = [
    { id: 's1', hostId: 'h1', hostName: 'Tru', path: '/srv/p', connected: true, scan: null },
    { id: 's2', hostId: 'h2', hostName: 'Mac', path: '~/p', connected: false, scan: { scannedAt: 0, kind: 'git', docHash: null,
      git: { branch: 'main', head: 'abcdef1234', headTime: null, dirty: 1, untracked: 1, ahead: 2, behind: 0, hasUpstream: true, remote: null, stash: 0 } } },
    { id: 's3', hostId: 'h3', hostName: 'UA', path: '/p', connected: true, scan: { scannedAt: 0, kind: 'plain', docHash: null } },
  ];
  const lines = otherCopies(sources, 'h1', 10 * 60_000);
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /^Mac \(не на связи\): main, abcdef12, не закоммичено: 2, не отправлено: 2 \(проверено 10 мин назад\)$/);
  assert.match(lines[1]!, /^UA: без git/);
});

import { formatBytes, worktreeState, IDLE_AFTER_MS } from '../core';

test('worktree states', () => {
  const now = 10 * IDLE_AFTER_MS;
  assert.equal(worktreeState({ liveThreads: 1, lastActivity: now - 1000, retireAt: null }, now), 'active');
  assert.equal(worktreeState({ liveThreads: 2, lastActivity: now - IDLE_AFTER_MS - 1, retireAt: null }, now), 'idle');
  assert.equal(worktreeState({ liveThreads: 0, lastActivity: now, retireAt: null }, now), 'orphan');
  assert.equal(worktreeState({ liveThreads: 0, lastActivity: null, retireAt: now + 5 }, now), 'retiring');
});

test('sizes read naturally', () => {
  assert.equal(formatBytes(null), 'размер неизвестен');
  assert.equal(formatBytes(10), '1 КБ');
  assert.equal(formatBytes(5 * 1024 * 1024), '5 МБ');
  assert.equal(formatBytes(3.26 * 1024 ** 3), '3.3 ГБ');
});
