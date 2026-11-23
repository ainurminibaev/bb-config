import assert from 'node:assert/strict';
import { test } from 'node:test';
import { threadTree, ago, errorHiddenByRow, duration, filterCounts, insideStates, passesFilter, projectThreads, summarizeProjects, threadState } from '../lib/project-quick-model.ts';

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
  assert.equal(threadState(t('x', 'a', 1, { isUnread: true })), 'unread');
  // bb never marks a subthread unread; neither does the "↳" mark of its parent.
  assert.equal(threadState(t('x', 'a', 1, { isUnread: true, parentThreadId: 'p' })), 'idle');
  const inside = insideStates([t('p', 'a', 1), t('k', 'a', 2, { isUnread: true, parentThreadId: 'p' })]).get('p');
  assert.equal(inside.top, null);
});

test('an error bb draws as a clock or nothing gets its own mark', () => {
  // A read error with a waiting message: bb's row shows the clock, the project counts an error.
  assert.equal(errorHiddenByRow(t('x', 'a', 1, { status: 'error', indicator: 'queued-waiting' })), true);
  assert.equal(errorHiddenByRow(t('x', 'a', 1, { status: 'error' })), true);
  // bb already shows the error mark.
  assert.equal(errorHiddenByRow(t('x', 'a', 1, { status: 'error', indicator: 'unread-error' })), false);
  assert.equal(errorHiddenByRow(t('x', 'a', 1, { indicator: 'queued-failed' })), false);
  assert.equal(errorHiddenByRow(t('x', 'a', 1, { indicator: 'queued-waiting' })), false);
  assert.equal(errorHiddenByRow(t('x', 'a', 1, { status: 'error', hasPendingInteraction: true })), false);
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
  const counts = filterCounts(rows);
  assert.deepEqual(Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v.projects])), { all: 3, input: 1, error: 1, working: 1, unread: 0 });
  assert.deepEqual(counts.working, { projects: 1, roots: 1, nested: 0 });
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

test('subthreads: top-level and nested apart, states rolled up the tree', () => {
  const threads = [
    t('root', 'a', 50),                                            // idle itself
    t('kid1', 'a', 40, { parentThreadId: 'root', status: 'active' }),
    t('kid2', 'a', 30, { parentThreadId: 'root', status: 'error' }),
    t('grand', 'a', 20, { parentThreadId: 'kid1', status: 'active' }),
    t('solo', 'a', 10, { status: 'active' }),
    t('orphan', 'a', 5, { parentThreadId: 'gone', status: 'active' }), // parent not live: top-level
  ];
  const [a] = summarizeProjects(projects, threads);
  assert.equal(a.roots, 3);
  assert.deepEqual([a.rootCounts.working, a.nestedCounts.working, a.nestedCounts.error], [2, 2, 1]);
  const counts = filterCounts([a]);
  assert.deepEqual(counts.working, { projects: 1, roots: 2, nested: 2 });
  const inside = insideStates(threads);
  assert.equal(inside.get('root').total, 3);
  assert.deepEqual([inside.get('root').counts.working, inside.get('root').counts.error], [2, 1]);
  assert.equal(inside.get('root').top, 'error');
  assert.equal(inside.get('kid1').top, 'working');
  assert.equal(inside.get('solo').top, null);
});
test('a parent cycle neither loops nor double-counts', () => {
  const threads = [t('x', 'a', 2, { parentThreadId: 'y', status: 'active' }), t('y', 'a', 1, { parentThreadId: 'x' })];
  const inside = insideStates(threads);
  assert.ok(inside.get('x').total <= 1 && inside.get('y').total <= 1);
});
test('running time labels', () => {
  assert.equal(duration(0), '');
  assert.equal(duration(45_000), '45 с');
  assert.equal(duration(12 * 60_000), '12 мин');
  assert.equal(duration(65 * 60_000), '1 ч 05 мин');
});
test('a thread whose parent is in another project heads its tree in its own project', () => {
  const threads = [t('p', 'a', 2), t('c', 'b', 1, { parentThreadId: 'p', status: 'active' })];
  const b = summarizeProjects(projects, threads).find(row => row.project.id === 'b');
  assert.equal(b.roots, 1);
  assert.equal(b.rootCounts.working, 1);
});
