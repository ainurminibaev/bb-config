// GitHub through the `gh` CLI of the BB server: it already holds the user's
// login, so the plugin stores no token. Reads use GraphQL search; writes use
// plain `gh` subcommands with argument arrays (no shell).
import { execFile } from 'node:child_process';
import { isBot, repoChunks, type Activity, type Item, type Relation } from './core';

export type Runner = (args: string[], input?: string) => Promise<string>;

export const ghRunner: Runner = (args, input) => new Promise((resolve, reject) => {
  const child = execFile('gh', args, { maxBuffer: 64 * 1024 * 1024, timeout: 90_000, env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } }, (error, stdout, stderr) => {
    if (error) reject(new Error(clean(stderr) || error.message));
    else resolve(stdout);
  });
  if (input !== undefined) child.stdin?.end(input);
});
const clean = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 400);

const ACTOR = 'author{login __typename}';
const REPO = 'repository{nameWithOwner viewerPermission}';
const PR_FIELDS = `__typename id number title url state isDraft merged mergedAt closedAt createdAt updatedAt ${ACTOR} ${REPO}
  reviewDecision mergeable labels(first:6){nodes{name}} assignees(first:6){nodes{login}}
  reviewRequests(first:10){nodes{requestedReviewer{__typename ... on User{login}}}}
  comments(last:12){totalCount nodes{${ACTOR} createdAt url bodyText}}
  reviews(last:12){nodes{${ACTOR} state submittedAt url bodyText}}
  reviewThreads(first:60){nodes{isResolved}}
  commits(last:1){nodes{commit{committedDate statusCheckRollup{state}}}}`;
const ISSUE_FIELDS = `__typename id number title url state stateReason closedAt createdAt updatedAt ${ACTOR} ${REPO}
  labels(first:6){nodes{name}} assignees(first:6){nodes{login}}
  comments(last:12){totalCount nodes{${ACTOR} createdAt url bodyText}}`;
const SEARCH = `query($q:String!,$after:String){viewer{login} search(query:$q,type:ISSUE,first:50,after:$after){issueCount pageInfo{hasNextPage endCursor} nodes{... on PullRequest{${PR_FIELDS}} ... on Issue{${ISSUE_FIELDS}}}}}`;

type Node = Record<string, any>;
const ms = (value: unknown) => typeof value === 'string' && value ? Date.parse(value) : null;
const login = (actor: Node | null | undefined) => (actor?.login as string | undefined) ?? 'ghost';

/** Flatten one GraphQL node into an Item. */
export function toItem(node: Node, me: string, relation: Relation): Item | null {
  if (node?.__typename !== 'PullRequest' && node?.__typename !== 'Issue') return null;
  const isPr = node.__typename === 'PullRequest';
  const repo = node.repository?.nameWithOwner as string;
  const author = login(node.author);
  const meLower = me.toLowerCase();
  const isMe = (name: string) => name.toLowerCase() === meLower;
  const mineTimes: number[] = [];
  const others: Activity[] = [];
  if (isMe(author)) mineTimes.push(ms(node.createdAt) ?? 0);
  else if (!isBot(author, node.author?.__typename)) others.push({ login: author, at: ms(node.createdAt) ?? 0, url: node.url, text: node.title ?? '', kind: 'opened' });
  for (const comment of node.comments?.nodes ?? []) {
    const name = login(comment.author); const at = ms(comment.createdAt) ?? 0;
    if (isMe(name)) mineTimes.push(at);
    else if (!isBot(name, comment.author?.__typename)) others.push({ login: name, at, url: comment.url ?? null, text: comment.bodyText ?? '', kind: 'comment' });
  }
  let changesRequestedAt: number | null = null;
  for (const review of node.reviews?.nodes ?? []) {
    const name = login(review.author); const at = ms(review.submittedAt) ?? 0;
    if (isMe(name)) { mineTimes.push(at); continue; }
    if (isBot(name, review.author?.__typename)) continue;
    if (review.state === 'CHANGES_REQUESTED') changesRequestedAt = Math.max(changesRequestedAt ?? 0, at);
    // An empty "commented" review is the container of inline comments; still activity.
    others.push({ login: name, at, url: review.url ?? null, text: review.bodyText || (review.state === 'APPROVED' ? 'одобрил' : review.state === 'CHANGES_REQUESTED' ? 'просит изменения' : ''), kind: 'review' });
  }
  const commit = node.commits?.nodes?.[0]?.commit;
  if (isPr && isMe(author) && commit?.committedDate) mineTimes.push(ms(commit.committedDate) ?? 0);
  others.sort((a, b) => b.at - a.at);
  const state = isPr ? (node.merged ? 'merged' : node.state === 'OPEN' ? 'open' : 'closed') : node.state === 'OPEN' ? 'open' : 'closed';
  return {
    key: `github:${repo}#${node.number}`.toLowerCase(),
    provider: 'github',
    kind: isPr ? 'pr' : 'issue',
    repo, number: node.number, title: node.title ?? '', url: node.url, author,
    state,
    stateReason: isPr ? null : node.stateReason ?? null,
    draft: Boolean(node.isDraft),
    createdAt: ms(node.createdAt) ?? 0,
    updatedAt: ms(node.updatedAt) ?? 0,
    closedAt: ms(node.mergedAt) ?? ms(node.closedAt),
    reviewDecision: isPr ? node.reviewDecision ?? null : null,
    checks: commit?.statusCheckRollup?.state ?? null,
    mergeable: isPr ? node.mergeable ?? null : null,
    permission: node.repository?.viewerPermission ?? null,
    reviewRequestedFromMe: (node.reviewRequests?.nodes ?? []).some((r: Node) => r.requestedReviewer?.login && isMe(r.requestedReviewer.login)),
    assignedToMe: (node.assignees?.nodes ?? []).some((a: Node) => isMe(login(a))),
    changesRequestedAt,
    lastMine: mineTimes.length ? Math.max(...mineTimes) : null,
    lastOther: others[0] ?? null,
    comments: node.comments?.totalCount ?? 0,
    unresolvedThreads: (node.reviewThreads?.nodes ?? []).filter((t: Node) => !t.isResolved).length,
    labels: (node.labels?.nodes ?? []).map((l: Node) => l.name as string),
    relations: [relation],
  };
}

export interface FetchPlan { query: string; relation: Relation; pages: number }

/** Every search the page needs: yours anywhere, review requests, mentions, and open items in your projects. */
export interface Targets { orgs: string[]; repos: string[] }

export function plan(targets: Targets, now: number, from = 0): FetchPlan[] {
  const since = new Date(Math.max(now - 30 * 86_400_000, from)).toISOString().slice(0, 10);
  const window = from > 0 ? ` updated:>=${new Date(from).toISOString().slice(0, 10)}` : '';
  const out: FetchPlan[] = [
    { query: `is:pr author:@me${window} sort:updated-desc`, relation: 'authored', pages: 4 },
    { query: `is:issue author:@me${window} sort:updated-desc`, relation: 'authored', pages: 4 },
    { query: 'is:open review-requested:@me sort:updated-desc', relation: 'review', pages: 2 },
    { query: `involves:@me -author:@me updated:>=${since} sort:updated-desc`, relation: 'involved', pages: 2 },
  ];
  for (const org of targets.orgs) {
    // `user:` matches both personal accounts and organizations.
    out.push({ query: `user:${org} is:open sort:updated-desc`, relation: 'project', pages: 4 });
    out.push({ query: `user:${org} is:closed closed:>=${since} -author:@me sort:updated-desc`, relation: 'project', pages: 2 });
  }
  for (const chunk of repoChunks(targets.repos)) {
    const repos = chunk.map(repo => `repo:${repo}`).join(' ');
    out.push({ query: `${repos} is:open sort:updated-desc`, relation: 'project', pages: 2 });
    out.push({ query: `${repos} is:closed closed:>=${since} -author:@me sort:updated-desc`, relation: 'project', pages: 1 });
  }
  return out;
}

export interface FetchResult { me: string; items: Item[]; errors: string[] }

/** Run all searches, merging duplicates (an item found by several searches keeps all its relations). */
export async function fetchAll(run: Runner, targets: Targets, now: number, from = 0): Promise<FetchResult> {
  const byKey = new Map<string, Item>();
  const errors: string[] = [];
  let me = '';
  for (const step of plan(targets, now, from)) {
    let after: string | null = null;
    for (let page = 0; page < step.pages; page++) {
      let data: Node;
      try {
        const body = JSON.stringify({ query: SEARCH, variables: { q: step.query, after } });
        data = JSON.parse(await run(['api', 'graphql', '--input', '-'], body));
      } catch (error) {
        // A repository that no longer exists makes the whole search fail; note it and go on.
        errors.push(`${step.query}: ${(error as Error).message}`);
        break;
      }
      if (data.errors?.length && !data.data?.search) { errors.push(`${step.query}: ${data.errors[0].message}`); break; }
      me = data.data?.viewer?.login ?? me;
      for (const node of data.data?.search?.nodes ?? []) {
        const item = toItem(node, me, step.relation);
        if (!item) continue;
        const known = byKey.get(item.key);
        if (known) { if (!known.relations.includes(step.relation)) known.relations.push(step.relation); }
        else byKey.set(item.key, item);
      }
      const info = data.data?.search?.pageInfo;
      if (!info?.hasNextPage) break;
      after = info.endCursor;
    }
  }
  if (!me) throw new Error(errors[0] ?? 'GitHub не ответил: проверьте `gh auth status` на сервере BB');
  return { me, items: [...byKey.values()], errors };
}

/** Organizations the user belongs to. */
export async function myOrgs(run: Runner): Promise<string[]> {
  const out = await run(['api', 'user/orgs', '--paginate', '--jq', '.[].login']);
  return out.split('\n').map(line => line.trim()).filter(Boolean);
}

export type Action = 'comment' | 'close' | 'reopen' | 'merge' | 'approve';

/** Write to GitHub on the user's behalf. Always called from an explicit click. */
export async function act(run: Runner, item: Pick<Item, 'kind' | 'repo' | 'number'>, action: Action, body = ''): Promise<string> {
  const target = [String(item.number), '--repo', item.repo];
  const group = item.kind === 'pr' ? 'pr' : 'issue';
  switch (action) {
    case 'comment':
      if (!body.trim()) throw new Error('Пустой комментарий');
      return run([group, 'comment', ...target, '--body-file', '-'], body);
    case 'close': return run([group, 'close', ...target]);
    case 'reopen': return run([group, 'reopen', ...target]);
    case 'merge':
      if (item.kind !== 'pr') throw new Error('Влить можно только PR');
      return run(['pr', 'merge', ...target, '--squash']);
    case 'approve':
      if (item.kind !== 'pr') throw new Error('Одобрить можно только PR');
      return run(['pr', 'review', ...target, '--approve', ...(body.trim() ? ['--body', body] : [])]);
  }
}
