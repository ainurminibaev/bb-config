// Pure rules of the PR & Issues page: how a raw GitHub item becomes a status,
// a bucket (your move / waiting for others / done) and an "unread" mark.
// No I/O here, so every rule is covered by tests/core.test.ts.

export type Kind = 'pr' | 'issue';
export type State = 'open' | 'merged' | 'closed';
export type Relation = 'authored' | 'review' | 'involved' | 'project';
export type Bucket = 'action' | 'waiting' | 'done';
export type Tone = 'good' | 'bad' | 'warn' | 'info' | 'neutral';

export interface Activity { login: string; at: number; url: string | null; text: string; kind: 'comment' | 'review' | 'opened' }

/** A pull request or issue as the provider reports it, flattened. */
export interface Item {
  key: string;
  provider: 'github';
  kind: Kind;
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  state: State;
  /** Issues: COMPLETED, NOT_PLANNED, DUPLICATE, REOPENED; PRs: null. */
  stateReason: string | null;
  draft: boolean;
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  checks: 'SUCCESS' | 'FAILURE' | 'ERROR' | 'PENDING' | 'EXPECTED' | null;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' | null;
  /** WRITE, MAINTAIN or ADMIN lets the viewer merge, close and label. */
  permission: string | null;
  reviewRequestedFromMe: boolean;
  assignedToMe: boolean;
  /** Last change request by someone else, ms. */
  changesRequestedAt: number | null;
  /** Latest activity by the viewer: their comment, review, push or the opening itself. */
  lastMine: number | null;
  /** Latest activity by another human (bots are ignored). */
  lastOther: Activity | null;
  comments: number;
  unresolvedThreads: number;
  labels: string[];
  relations: Relation[];
}

export interface Seen { at: number; status: string }
export interface Mute { at: number }

export interface ItemView extends Item {
  status: string;
  tone: Tone;
  bucket: Bucket;
  /** Why the item needs you, or what it waits for. */
  reason: string;
  unread: boolean;
  muted: boolean;
  mine: boolean;
  /** A recent outcome (merged, rejected, solved) shown under "your move" until you dismiss it. */
  notice: boolean;
}

export interface FeedEvent { at: number; key: string; repo: string; number: number; kind: Kind; title: string; url: string; text: string; tone: Tone }

const CAN_WRITE = new Set(['WRITE', 'MAINTAIN', 'ADMIN']);
export const canWrite = (item: Pick<Item, 'permission'>) => CAN_WRITE.has(item.permission ?? '');
export const isBot = (login: string, typename?: string) => typename === 'Bot' || /\[bot\]$/i.test(login) || /-bot$/i.test(login);

/** Status label for people who do not know GitHub's vocabulary. */
export function status(item: Item): { label: string; tone: Tone } {
  if (item.kind === 'pr') {
    if (item.state === 'merged') return { label: 'Принят (влит)', tone: 'good' };
    if (item.state === 'closed') return { label: 'Отклонён (закрыт без слияния)', tone: 'bad' };
    if (item.draft) return { label: 'Черновик', tone: 'neutral' };
    if (item.mergeable === 'CONFLICTING') return { label: 'Конфликт с основной веткой', tone: 'bad' };
    if (item.checks === 'FAILURE' || item.checks === 'ERROR') return { label: 'Проверки упали', tone: 'bad' };
    if (item.reviewDecision === 'CHANGES_REQUESTED') return { label: 'Просят изменения', tone: 'warn' };
    if (item.reviewDecision === 'APPROVED') return { label: 'Одобрен', tone: 'good' };
    return { label: 'Ждёт ревью', tone: 'info' };
  }
  if (item.state === 'closed') {
    if (item.stateReason === 'NOT_PLANNED') return { label: 'Отклонён (не будут делать)', tone: 'bad' };
    if (item.stateReason === 'DUPLICATE') return { label: 'Закрыт как дубликат', tone: 'neutral' };
    return { label: 'Решён (закрыт)', tone: 'good' };
  }
  return { label: 'Открыт', tone: 'info' };
}

const answered = (item: Item) => item.lastOther !== null && (item.lastMine === null || item.lastOther.at > item.lastMine);
const who = (item: Item) => item.lastOther ? `@${item.lastOther.login}` : 'кто-то';

/** Your move or theirs. Closed and merged items are always done. */
export function bucketOf(item: Item, me: string): { bucket: Bucket; reason: string } {
  if (item.state !== 'open') return { bucket: 'done', reason: status(item).label };
  const mine = item.author.toLowerCase() === me.toLowerCase();
  const reply = answered(item);
  if (item.kind === 'pr') {
    if (mine) {
      if (item.draft) return reply ? { bucket: 'action', reason: `Новый комментарий от ${who(item)}` } : { bucket: 'waiting', reason: 'Черновик: доделайте и отправьте на ревью, когда будет готов' };
      if (item.mergeable === 'CONFLICTING') return { bucket: 'action', reason: 'Конфликт с основной веткой — обновите ветку' };
      if (item.checks === 'FAILURE' || item.checks === 'ERROR') return { bucket: 'action', reason: 'Упали автоматические проверки (CI)' };
      if (item.reviewDecision === 'CHANGES_REQUESTED' && (item.lastMine === null || (item.changesRequestedAt ?? 0) > item.lastMine)) return { bucket: 'action', reason: 'Ревьюер просит изменения' };
      if (reply) return { bucket: 'action', reason: `Новый комментарий от ${who(item)}` };
      if (item.reviewDecision === 'APPROVED') return canWrite(item) ? { bucket: 'action', reason: 'Одобрен — можно влить' } : { bucket: 'waiting', reason: 'Одобрен, ждёт слияния мейнтейнером' };
      if (item.reviewDecision === 'CHANGES_REQUESTED') return { bucket: 'waiting', reason: 'Исправлено, ждёт повторного ревью' };
      if (canWrite(item)) return { bucket: 'waiting', reason: 'Ваш репозиторий: влейте или закройте, когда будет готов' };
      return { bucket: 'waiting', reason: 'Ждёт ревью мейнтейнеров' };
    }
    if (item.reviewRequestedFromMe) return { bucket: 'action', reason: `Просят ваше ревью (${item.author})` };
    if (canWrite(item) && !item.draft) {
      if (item.lastMine === null) return { bucket: 'action', reason: `Новый PR от @${item.author}` };
      if (reply) return { bucket: 'action', reason: `Новый комментарий от ${who(item)}` };
      return { bucket: 'waiting', reason: `Ждёт автора (@${item.author})` };
    }
    if (reply && item.lastMine !== null) return { bucket: 'action', reason: `Ответил ${who(item)}` };
    return { bucket: 'waiting', reason: item.draft ? `Черновик @${item.author}` : `PR @${item.author}, вы участвуете` };
  }
  if (mine) {
    if (reply) return { bucket: 'action', reason: `Ответил ${who(item)}` };
    if (canWrite(item)) return { bucket: 'waiting', reason: 'Открытая задача в вашем репозитории' };
    return { bucket: 'waiting', reason: 'Ждёт ответа мейнтейнеров' };
  }
  if (item.assignedToMe && (item.lastMine === null || reply)) return { bucket: 'action', reason: 'Назначен на вас' };
  if (canWrite(item)) {
    if (item.lastMine === null) return { bucket: 'action', reason: `Новый issue от @${item.author}` };
    if (reply) return { bucket: 'action', reason: `Новый комментарий от ${who(item)}` };
    return { bucket: 'waiting', reason: `Ждёт автора (@${item.author})` };
  }
  if (reply && item.lastMine !== null) return { bucket: 'action', reason: `Ответил ${who(item)}` };
  return { bucket: 'waiting', reason: `Issue @${item.author}, вы участвуете` };
}

/** "Something new": a reply from someone else or a status change since you last looked. */
export function unread(item: Item, seen: Seen | undefined, statusLabel: string): boolean {
  if (!seen) return false;
  if (statusLabel !== seen.status) return true;
  return Boolean(item.lastOther && item.lastOther.at > seen.at);
}

/** A dismissed item stays hidden until GitHub reports any update after the dismissal (reply, push, label, status). */
export function stillMuted(item: Item, mute: Mute | undefined): boolean {
  if (!mute) return false;
  return Math.max(item.updatedAt, item.lastOther?.at ?? 0) <= mute.at;
}

/** How long a merged or closed item of yours stays in "your move" as a notice to dismiss. */
export const NOTICE_MS = 14 * 86_400_000;

function noticeText(item: Item): string {
  if (item.kind === 'pr') return item.state === 'merged' ? 'Ваш PR приняли 🎉' : 'Ваш PR закрыли без слияния';
  if (item.stateReason === 'NOT_PLANNED') return 'Ваш issue отклонили: делать не будут';
  if (item.stateReason === 'DUPLICATE') return 'Ваш issue закрыли как дубликат';
  return 'Ваш issue решён и закрыт';
}

/**
 * `mute` is the user's ×: on an open item it hides it until someone writes again;
 * on a recent outcome it dismisses the notice.
 */
export function view(item: Item, me: string, seen: Seen | undefined, mute: Mute | undefined, now = Date.now()): ItemView {
  const st = status(item);
  const mine = item.author.toLowerCase() === me.toLowerCase();
  let { bucket, reason } = bucketOf(item, me);
  let notice = false;
  let muted = false;
  if (bucket === 'done') {
    const closed = item.closedAt ?? item.updatedAt;
    if (mine && now - closed < NOTICE_MS && !(mute && mute.at >= Math.max(closed, item.updatedAt))) { bucket = 'action'; reason = noticeText(item); notice = true; }
  } else if (stillMuted(item, mute)) { muted = true; bucket = 'done'; reason = `Скинуто вами · ${reason}`; }
  return { ...item, status: st.label, tone: st.tone, bucket, reason, unread: unread(item, seen, st.label), muted, mine, notice };
}

/** Items untouched since the cut-off date are not shown at all. */
export function recentEnough(item: Item, since: number): boolean {
  return Math.max(item.updatedAt, item.closedAt ?? 0) >= since;
}

/** "2025-01-01" → ms; empty or invalid → 0 (no cut-off). */
export function parseSince(text: string): number {
  const value = Date.parse(text.trim());
  return Number.isFinite(value) ? value : 0;
}

/** Seen record for an item that appears for the first time. Before the first full sync everything counts as already seen. */
export function firstSeen(item: Item, me: string, baselineDone: boolean, now: number): Seen {
  const label = status(item).label;
  if (!baselineDone || item.author.toLowerCase() === me.toLowerCase()) return { at: now, status: label };
  return { at: 0, status: '' };
}

/** Feed lines for what changed between two fetches of the same item. */
export function diffEvents(before: Item | undefined, after: Item, me: string, now: number): FeedEvent[] {
  const base = { key: after.key, repo: after.repo, number: after.number, kind: after.kind, title: after.title, url: after.url };
  const out: FeedEvent[] = [];
  const next = status(after);
  if (!before) {
    if (after.author.toLowerCase() !== me.toLowerCase() && after.state === 'open') out.push({ ...base, at: after.createdAt || now, text: `Новый ${after.kind === 'pr' ? 'PR' : 'issue'} от @${after.author}`, tone: 'info' });
    return out;
  }
  const prev = status(before);
  if (prev.label !== next.label) out.push({ ...base, at: after.closedAt && after.state !== 'open' ? after.closedAt : after.updatedAt || now, text: `${prev.label} → ${next.label}`, tone: next.tone });
  if (after.lastOther && (!before.lastOther || after.lastOther.at > before.lastOther.at)) {
    const verb = after.lastOther.kind === 'review' ? 'оставил ревью' : 'написал';
    out.push({ ...base, at: after.lastOther.at, text: `@${after.lastOther.login} ${verb}${after.lastOther.text ? `: «${clip(after.lastOther.text, 140)}»` : ''}`, tone: 'info' });
  }
  return out;
}

export const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** owner/repo from a GitHub remote URL, or null for other hosts. */
export function githubRepo(remote: string | null | undefined): string | null {
  if (!remote) return null;
  const match = remote.trim().match(/github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return match ? `${match[1]}/${match[2]}` : null;
}

/** Repository list typed by the user: "owner/repo" or GitHub URLs, separated by commas, spaces or new lines. */
export function parseRepos(text: string): string[] {
  const out = new Set<string>();
  for (const part of text.split(/[\s,;]+/)) {
    const value = part.trim();
    if (!value) continue;
    const repo = githubRepo(value) ?? (/^[\w.-]+\/[\w.-]+$/.test(value) ? value : null);
    if (repo) out.add(repo.toLowerCase());
  }
  return [...out];
}

/** GitHub search allows a limited query length, so repositories are queried in groups. */
export function repoChunks(repos: string[], size = 6): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < repos.length; i += size) out.push(repos.slice(i, i + size));
  return out;
}

/**
 * Tracking mode of an organization or repository:
 * all — every PR and issue there; mine — only yours and where you take part; hidden — nothing.
 */
export type SourceMode = 'all' | 'mine' | 'hidden';
/** Explicit choices keyed `org:<login>` or `repo:<owner/name>`, lower-case. */
export type SourceChoices = Record<string, SourceMode>;

/** Organizations tracked in full until the user says otherwise. */
export const DEFAULT_ALL_ORGS = ['erp-engineering'];

export interface SourceContext {
  me: string;
  myOrgs: string[];
  /** GitHub repositories of BB projects, lower-case owner/name. */
  bbRepos: string[];
  choices: SourceChoices;
  /** Legacy text settings: extra → all, ignore → hidden. */
  extra?: string[];
  ignore?: string[];
}

export const ownerOf = (repo: string) => repo.split('/')[0]!.toLowerCase();

export function orgMode(org: string, ctx: SourceContext): SourceMode {
  const login = org.toLowerCase();
  const explicit = ctx.choices[`org:${login}`];
  if (explicit) return explicit;
  return login === ctx.me.toLowerCase() || DEFAULT_ALL_ORGS.includes(login) ? 'all' : 'mine';
}

/** Default for a repository: BB project repos of yours or your organizations are tracked in full; otherwise the organization decides. */
export function repoDefault(repo: string, ctx: SourceContext): SourceMode {
  const name = repo.toLowerCase();
  if (ctx.ignore?.includes(name)) return 'hidden';
  if (ctx.extra?.includes(name)) return 'all';
  const owner = ownerOf(name);
  const org = orgMode(owner, ctx);
  if (org === 'hidden') return 'hidden';
  if (ctx.bbRepos.includes(name) && (owner === ctx.me.toLowerCase() || ctx.myOrgs.map(o => o.toLowerCase()).includes(owner))) return 'all';
  return org;
}

export function repoMode(repo: string, ctx: SourceContext): SourceMode {
  return ctx.choices[`repo:${repo.toLowerCase()}`] ?? repoDefault(repo, ctx);
}

/** Shown when the repository is not hidden, and either tracked in full or the item involves you. */
export function visible(item: Item, ctx: SourceContext): boolean {
  const mode = repoMode(item.repo, ctx);
  if (mode === 'hidden') return false;
  return mode === 'all' || item.relations.some(relation => relation !== 'project');
}

/** What to search: whole organizations and single repositories tracked in full outside them. */
export function trackedTargets(ctx: SourceContext, knownRepos: string[]): { orgs: string[]; repos: string[] } {
  const orgs = new Set<string>();
  for (const key of [...ctx.myOrgs, ctx.me, ...DEFAULT_ALL_ORGS, ...Object.keys(ctx.choices).filter(k => k.startsWith('org:')).map(k => k.slice(4))]) {
    if (orgMode(key, ctx) === 'all') orgs.add(key.toLowerCase());
  }
  const repos = new Set<string>();
  for (const repo of [...knownRepos, ...ctx.bbRepos, ...(ctx.extra ?? []), ...Object.keys(ctx.choices).filter(k => k.startsWith('repo:')).map(k => k.slice(5))]) {
    const name = repo.toLowerCase();
    if (repoMode(name, ctx) === 'all' && !orgs.has(ownerOf(name))) repos.add(name);
  }
  return { orgs: [...orgs].sort(), repos: [...repos].sort() };
}

export const BUCKET_ORDER: Record<Bucket, number> = { action: 0, waiting: 1, done: 2 };
export function sortViews(items: ItemView[]): ItemView[] {
  return [...items].sort((a, b) => BUCKET_ORDER[a.bucket] - BUCKET_ORDER[b.bucket] || Number(b.unread) - Number(a.unread) || (b.bucket === 'done' ? (b.closedAt ?? b.updatedAt) - (a.closedAt ?? a.updatedAt) : b.updatedAt - a.updatedAt));
}

export type Bucket3 = 'action' | 'waiting' | 'done';
export interface ViewFilter { kind: 'all' | 'pr' | 'issue'; scope: string; mine: boolean; q: string }

/** '' — everything; 'org:<login>' — a whole organization; 'repo:<owner/name>' — one repository. */
export function inScope(repo: string, scope: string): boolean {
  if (!scope) return true;
  return scope.startsWith('org:') ? repo.split('/')[0]!.toLowerCase() === scope.slice(4) : repo.toLowerCase() === scope.slice(5);
}

type Pageable = Pick<ItemView, 'key' | 'kind' | 'repo' | 'number' | 'title' | 'author' | 'status' | 'reason' | 'labels' | 'bucket' | 'unread' | 'mine'>;

function haystack(item: Pageable): string {
  return `${item.title} ${item.repo}#${item.number} #${item.number} ${item.author} @${item.author} ${item.status} ${item.reason} ${item.labels.join(' ')} ${item.kind === 'pr' ? 'pr pull request пулреквест' : 'issue задача'}`.toLowerCase();
}

/** Search words, kind and "only mine" — everything except the scope, which the scope menu needs untouched. */
export function matchesExceptScope(item: Pageable, f: ViewFilter): boolean {
  if (f.kind !== 'all' && item.kind !== f.kind) return false;
  if (f.mine && !item.mine) return false;
  const words = f.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = haystack(item);
  return words.every(word => text.includes(word));
}

/**
 * One page of a bucket plus the counters the page header needs. The client never
 * receives the whole list: it asks for the next page when the user scrolls.
 */
export function pageOf<T extends Pageable>(all: T[], bucket: Bucket3, f: ViewFilter, offset: number, limit: number) {
  const counts = { action: 0, waiting: 0, done: 0 };
  const fresh = { action: 0, waiting: 0, done: 0 };
  const kinds = { all: 0, pr: 0, issue: 0 };
  const scopes = new Map<string, number>();
  const rows: T[] = [];
  const unread: string[] = [];
  for (const item of all) {
    const rest = matchesExceptScope(item, f);
    if (rest && item.bucket === bucket) scopes.set(item.repo, (scopes.get(item.repo) ?? 0) + 1);
    if (!inScope(item.repo, f.scope)) continue;
    if (item.bucket === bucket && (!f.mine || item.mine) && matchesExceptScope(item, { ...f, kind: 'all' })) { kinds.all++; kinds[item.kind]++; }
    if (!rest) continue;
    counts[item.bucket]++;
    if (item.unread) fresh[item.bucket]++;
    if (item.bucket !== bucket) continue;
    rows.push(item);
    if (item.unread) unread.push(item.key);
  }
  return {
    items: rows.slice(offset, offset + limit), total: rows.length, counts, fresh, kinds, unread,
    scopes: [...scopes].map(([repo, count]) => ({ repo, count })).sort((a, b) => b.count - a.count || a.repo.localeCompare(b.repo)),
  };
}

/** Newest first, one line per item, moment and text: a repeated sync must not double the feed. */
export function dedupeEvents(list: FeedEvent[]): FeedEvent[] {
  const seenLines = new Set<string>();
  return [...list].sort((a, b) => b.at - a.at).filter(event => {
    const id = `${event.key}|${event.at}|${event.text}`;
    if (seenLines.has(id)) return false;
    seenLines.add(id);
    return true;
  });
}
