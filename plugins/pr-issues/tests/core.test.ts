import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bucketOf, relevant, diffEvents, firstSeen, githubRepo, parseRepos, status, view, type Item } from '../core';
import { act, plan, toItem } from '../github';

const ME = 'me';
const item = (extra: Partial<Item> = {}): Item => ({
  key: 'github:o/r#1', provider: 'github', kind: 'pr', repo: 'o/r', number: 1, title: 'T', url: 'https://github.com/o/r/pull/1', author: ME,
  state: 'open', stateReason: null, draft: false, createdAt: 1000, updatedAt: 2000, closedAt: null, reviewDecision: null, checks: null, mergeable: 'MERGEABLE',
  permission: 'READ', reviewRequestedFromMe: false, assignedToMe: false, changesRequestedAt: null, lastMine: 1000, lastOther: null, comments: 0, unresolvedThreads: 0,
  labels: [], relations: ['authored'], ...extra,
});
const other = (at: number, login = 'bob') => ({ login, at, url: null, text: 'hi', kind: 'comment' as const });

test('statuses in plain words', () => {
  assert.equal(status(item({ state: 'merged' })).label, 'Принят (влит)');
  assert.equal(status(item({ state: 'closed' })).label, 'Отклонён (закрыт без слияния)');
  assert.equal(status(item({ kind: 'issue', state: 'closed', stateReason: 'NOT_PLANNED' })).label, 'Отклонён (не будут делать)');
  assert.equal(status(item({ kind: 'issue', state: 'closed', stateReason: 'COMPLETED' })).label, 'Решён (закрыт)');
  assert.equal(status(item({ reviewDecision: 'CHANGES_REQUESTED' })).label, 'Просят изменения');
});

test('my PR: waiting by default, action on reply, changes, conflict, failed checks', () => {
  assert.equal(bucketOf(item(), ME).bucket, 'waiting');
  assert.equal(bucketOf(item({ lastOther: other(5000) }), ME).bucket, 'action');
  assert.equal(bucketOf(item({ lastOther: other(500) }), ME).bucket, 'waiting');
  assert.equal(bucketOf(item({ mergeable: 'CONFLICTING' }), ME).bucket, 'action');
  assert.equal(bucketOf(item({ checks: 'FAILURE' }), ME).bucket, 'action');
  assert.equal(bucketOf(item({ reviewDecision: 'CHANGES_REQUESTED', changesRequestedAt: 3000 }), ME).bucket, 'action');
  // Pushed after the change request: now waiting for a re-review.
  assert.equal(bucketOf(item({ reviewDecision: 'CHANGES_REQUESTED', changesRequestedAt: 3000, lastMine: 4000 }), ME).bucket, 'waiting');
  assert.equal(bucketOf(item({ reviewDecision: 'APPROVED' }), ME).bucket, 'waiting');
  assert.equal(bucketOf(item({ reviewDecision: 'APPROVED', permission: 'ADMIN' }), ME).reason, 'Одобрен — можно влить');
});

test('others in my repository and review requests need me', () => {
  assert.equal(bucketOf(item({ author: 'bob', permission: 'ADMIN', lastMine: null }), ME).bucket, 'action');
  assert.equal(bucketOf(item({ author: 'bob', permission: 'ADMIN', lastMine: 3000, lastOther: other(2000) }), ME).bucket, 'waiting');
  assert.equal(bucketOf(item({ author: 'bob', reviewRequestedFromMe: true }), ME).bucket, 'action');
  assert.equal(bucketOf(item({ author: 'bob', lastMine: null, lastOther: other(2000) }), ME).bucket, 'waiting');
  assert.equal(bucketOf(item({ kind: 'issue', author: 'bob', permission: 'WRITE', lastMine: null }), ME).bucket, 'action');
});

test('closed is done; mute hides until a new reply', () => {
  assert.equal(bucketOf(item({ state: 'merged' }), ME).bucket, 'done');
  const muted = view(item({ lastOther: other(5000) }), ME, undefined, { at: 6000 });
  assert.equal(muted.bucket, 'done');
  assert.equal(muted.muted, true);
  assert.equal(view(item({ lastOther: other(7000) }), ME, undefined, { at: 6000 }).bucket, 'action');
});

test('unread: status change or new reply since seen; baseline marks everything seen', () => {
  const it = item({ lastOther: other(5000) });
  assert.equal(view(it, ME, { at: 6000, status: 'Ждёт ревью' }, undefined).unread, false);
  assert.equal(view(it, ME, { at: 4000, status: 'Ждёт ревью' }, undefined).unread, true);
  assert.equal(view(item({ state: 'merged' }), ME, { at: 9000, status: 'Ждёт ревью' }, undefined).unread, true);
  const fresh = item({ author: 'bob' });
  assert.equal(view(fresh, ME, firstSeen(fresh, ME, false, 1), undefined).unread, false);
  assert.equal(view(fresh, ME, firstSeen(fresh, ME, true, 1), undefined).unread, true);
  assert.equal(view(item(), ME, firstSeen(item(), ME, true, 1), undefined).unread, false);
});

test('feed events for status change and replies', () => {
  const events = diffEvents(item(), item({ state: 'merged', closedAt: 9000, lastOther: other(8000) }), ME, 10000);
  assert.deepEqual(events.map(e => e.text), ['Ждёт ревью → Принят (влит)', '@bob написал: «hi»']);
  assert.equal(diffEvents(undefined, item({ author: 'bob' }), ME, 1).length, 1);
  assert.equal(diffEvents(undefined, item(), ME, 1).length, 0);
});

test('repositories from remotes and settings', () => {
  assert.equal(githubRepo('git@github.com:Owner/Repo.git'), 'Owner/Repo');
  assert.equal(githubRepo('https://github.com/o/r'), 'o/r');
  assert.equal(githubRepo('https://gitlab.com/o/r.git'), null);
  assert.deepEqual(parseRepos('o/r, https://github.com/A/B\n bad'), ['o/r', 'a/b']);
  assert.equal(plan(Array.from({ length: 7 }, (_, i) => `o/r${i}`), 0).length, 4 + 2 * 2);
});

test('GraphQL node becomes an item; bots are ignored', () => {
  const node = {
    __typename: 'PullRequest', number: 5, title: 'X', url: 'u', state: 'OPEN', isDraft: false, merged: false, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-03T00:00:00Z',
    author: { login: 'Me', __typename: 'User' }, repository: { nameWithOwner: 'O/R', viewerPermission: 'READ' }, reviewDecision: 'CHANGES_REQUESTED', mergeable: 'MERGEABLE',
    comments: { totalCount: 2, nodes: [{ author: { login: 'bob', __typename: 'User' }, createdAt: '2026-01-02T00:00:00Z', bodyText: 'please' }, { author: { login: 'ci[bot]', __typename: 'Bot' }, createdAt: '2026-01-04T00:00:00Z', bodyText: 'x' }] },
    reviews: { nodes: [{ author: { login: 'bob', __typename: 'User' }, state: 'CHANGES_REQUESTED', submittedAt: '2026-01-02T01:00:00Z', bodyText: '' }] },
    reviewThreads: { nodes: [{ isResolved: false }, { isResolved: true }] }, commits: { nodes: [{ commit: { committedDate: '2026-01-01T00:00:00Z', statusCheckRollup: { state: 'SUCCESS' } } }] },
  };
  const it = toItem(node, 'me', 'authored')!;
  assert.equal(it.key, 'github:o/r#5');
  assert.equal(it.lastOther?.login, 'bob');
  assert.equal(it.lastOther?.kind, 'review');
  assert.equal(it.unresolvedThreads, 1);
  assert.equal(bucketOf(it, 'me').reason, 'Ревьюер просит изменения');
});

test('writes go through gh with argument arrays', async () => {
  const calls: { args: string[]; input?: string }[] = [];
  const run = async (args: string[], input?: string) => { calls.push({ args, input }); return 'ok'; };
  await act(run, { kind: 'issue', repo: 'o/r', number: 3 }, 'comment', 'hello; rm -rf /');
  await act(run, { kind: 'pr', repo: 'o/r', number: 4 }, 'merge');
  assert.deepEqual(calls[0], { args: ['issue', 'comment', '3', '--repo', 'o/r', '--body-file', '-'], input: 'hello; rm -rf /' });
  assert.deepEqual(calls[1]!.args, ['pr', 'merge', '4', '--repo', 'o/r', '--squash']);
  await assert.rejects(act(run, { kind: 'issue', repo: 'o/r', number: 3 }, 'merge'));
});

test('project-only items count only in repositories you maintain', () => {
  assert.equal(relevant(item({ author: 'bob', relations: ['project'] })), false);
  assert.equal(relevant(item({ author: 'bob', relations: ['project'], permission: 'ADMIN' })), true);
  assert.equal(relevant(item({ author: 'bob', relations: ['project', 'involved'] })), true);
});
