import assert from 'node:assert/strict';
import { test } from 'node:test';
import { threadTree, ago, filterCounts, passesFilter, projectThreads, summarizeProjects, threadState } from '../lib/project-quick-model.ts';

const projects = [
  { id: 'a', name: 'Alpha', isPersonal: false },
  { id: 'b', name: 'Beta', isPersonal: false },
  { id: 'c', name: 'Gamma', isPersonal: false },
];
const t = (id, projectId, updatedAt, extra = {}) => ({ id, projectId, displayTitle: id, updatedAt, status: 'idle', indicator: 'none', ...extra });

test('one state per thread, waiting for the user first', () => {
  assert.equal(threadState(t('x', 'a', 1, { status: 'active', hasPendingInteraction: true })), 'input');
  assert.equal(threadState(t('x', 'a', 1, { status: 'error' })), 'error');
  assert.equal(threadState(t('x', 'a', 1, { indicator: 'unread-error' })), 'error');
  assert.equal(threadState(t('x', 'a', 1, { status: 'active' })), 'working');
  assert.equal(threadState(t('x', 'a', 1, { runtimeStatus: 'provisioning' })), 'working');
  assert.equal(threadState(t('x', 'a', 1, { indicator: 'background-agent' })), 'working');
  assert.equal(threadState(t('x', 'a', 1, { indicator: 'unread-success' })), 'unread');
  assert.equal(threadState(t('x', 'a', 1)), 'idle');
});

test('projects by latest live thread; archived and hidden threads do not count', () => {
  const threads = [
    t('a1', 'a', 10), t('b1', 'b', 20),
    t('a2', 'a', 99, { isArchived: true }), t('c1', 'c', 50, { isHidden: true }),
  ];
  const rows = summarizeProjects(projects, threads);
  assert.deepEqual(rows.map(row => row.project.id), ['b', 'a', 'c']);
  assert.equal(rows[2].threads.length, 0);
  assert.deepEqual(rows[1].threads.map(thread => thread.id), ['a1']);
});

test('counts and quick filters', () => {
  const threads = [
    t('a1', 'a', 10, { status: 'active' }), t('a2', 'a', 11, { status: 'error' }),
    t('b1', 'b', 20, { hasPendingInteraction: true }), t('b2', 'b', 5),
  ];
  const rows = summarizeProjects(projects, threads);
  const b = rows.find(row => row.project.id === 'b');
  assert.deepEqual(b.counts, { input: 1, error: 0, working: 0, unread: 0, idle: 1 });
  assert.deepEqual(filterCounts(rows), { all: 3, input: 1, error: 1, working: 1, unread: 0 });
  assert.deepEqual(rows.filter(row => passesFilter(row, 'error')).map(row => row.project.id), ['a']);
  const a = rows.find(row => row.project.id === 'a');
  assert.deepEqual(projectThreads(a, 'working').map(thread => thread.id), ['a1', 'a2']);
  assert.deepEqual(projectThreads(a, 'all').map(thread => thread.id), ['a2', 'a1']);
});

test('short relative time', () => {
  const now = 1_000_000_000;
  assert.equal(ago(now - 10_000, now), 'сейчас');
  assert.equal(ago(now - 5 * 60_000, now), '5 мин');
  assert.equal(ago(now - 3 * 3_600_000, now), '3 ч');
  assert.equal(ago(now - 2 * 86_400_000, now), '2 д');
  assert.equal(ago(0, now), '');
});

test('subthreads fold under their parent; orphans of other projects stay roots', () => {
  const threads = [t('c1', 'a', 30, { parentThreadId: 'p' }), t('p', 'a', 20), t('x', 'a', 10, { parentThreadId: 'elsewhere' })];
  const { roots, children } = threadTree(threads);
  assert.deepEqual(roots.map(thread => thread.id), ['p', 'x']);
  assert.deepEqual(children.get('p').map(thread => thread.id), ['c1']);
});

test('a message waiting to send is not counted as working', () => {
  assert.equal(threadState(t('x', 'a', 1, { indicator: 'queued-waiting' })), 'idle');
});
