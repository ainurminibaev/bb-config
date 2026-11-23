/**
 * The model behind the quick project menu next to the sidebar search: one
 * state per thread, per-project counts of live threads, recent-first order
 * and the quick filters. Pure functions; the menu itself is project-quick.tsx.
 */

/** What a thread is doing, as the sidebar shows it. One per thread, in this priority. */
export type QuickState = "input" | "error" | "working" | "unread" | "idle";

export const QUICK_STATES: readonly QuickState[] = ["input", "error", "working", "unread", "idle"];

export const STATE_LABEL: Record<QuickState, string> = {
  input: "Ждёт ответа",
  error: "Ошибка",
  working: "Работает",
  unread: "Завершён, не прочитан",
  idle: "Завершён",
};

export type QuickThread = {
  id: string;
  projectId: string;
  parentThreadId?: string | null;
  displayTitle: string;
  status?: string;
  runtimeStatus?: string;
  indicator?: string;
  hasPendingInteraction?: boolean;
  isUnread?: boolean;
  isPinned?: boolean;
  isArchived?: boolean;
  isHidden?: boolean;
  updatedAt?: number;
  createdAt?: number;
  host?: { id: string; name: string } | null;
};

export type QuickProject = { id: string; name: string; isPersonal: boolean };

const BUSY = new Set(["active", "starting", "stopping", "pending", "queued", "provisioning", "waiting-for-host"]);
const BUSY_INDICATORS = new Set([
  "runtime", "background-agent", "background-command", "workflow", "working-draft",
]);

export function threadState(thread: QuickThread): QuickState {
  if (thread.hasPendingInteraction || thread.indicator === "waiting-for-input") return "input";
  if (thread.status === "error" || thread.runtimeStatus === "error" ||
    thread.indicator === "unread-error" || thread.indicator === "queued-failed") return "error";
  if (BUSY.has(thread.runtimeStatus ?? "") || BUSY.has(thread.status ?? "") ||
    BUSY_INDICATORS.has(thread.indicator ?? "")) return "working";
  if (thread.indicator === "unread-success" || (thread.isUnread && !thread.parentThreadId)) return "unread";
  return "idle";
}
/**
 * A thread in error whose bb row shows no error mark: bb draws ⊗ only for an unread error or a
 * failed send, so a read error, or one with a waiting message (clock), looks fine in its row
 * while the project counts it under «Ошибки».
 */
export function errorHiddenByRow(thread: QuickThread): boolean {
  return threadState(thread) === "error" &&
    thread.indicator !== "unread-error" && thread.indicator !== "queued-failed";
}

// bb marks unread only on top-level threads: a subthread reports to its parent and its row never
// shows an unread mark. Counting a subthread's isUnread here drew "↳ ● 1" with no visible match.

/** Live means what the sidebar lists: not archived and not a hidden helper thread. */
export function isLive(thread: QuickThread): boolean {
  return !thread.isArchived && !thread.isHidden;
}

function at(thread: QuickThread): number {
  return thread.updatedAt ?? thread.createdAt ?? 0;
}

export type ProjectSummary<P extends QuickProject = QuickProject> = {
  project: P;
  /** Live threads, latest first. */
  threads: QuickThread[];
  /** States of all live threads, subthreads included. */
  counts: Record<QuickState, number>;
  /** Top-level threads only (no live parent), and subthreads only. */
  rootCounts: Record<QuickState, number>;
  nestedCounts: Record<QuickState, number>;
  roots: number;
  latest: number;
};

function emptyCounts(): Record<QuickState, number> {
  return { input: 0, error: 0, working: 0, unread: 0, idle: 0 };
}

/**
 * Every project with live threads, the most recently used first; projects
 * without live threads follow in bb's order so they stay reachable by search.
 */
export function summarizeProjects<P extends QuickProject>(
  projects: readonly P[],
  threads: readonly QuickThread[],
): ProjectSummary<P>[] {
  const byProject = new Map<string, QuickThread[]>();
  for (const thread of threads) {
    if (!isLive(thread)) continue;
    const list = byProject.get(thread.projectId);
    if (list) list.push(thread);
    else byProject.set(thread.projectId, [thread]);
  }
  const rows = projects.map((project, index) => {
    const own = [...(byProject.get(project.id) ?? [])].sort((a, b) => at(b) - at(a));
    const counts = emptyCounts(), rootCounts = emptyCounts(), nestedCounts = emptyCounts();
    // Within a project a thread whose parent lives in another project heads its own tree here.
    const here = new Set(own.map((thread) => thread.id));
    let roots = 0;
    for (const thread of own) {
      const state = threadState(thread);
      counts[state] += 1;
      if (isNested(thread, here)) nestedCounts[state] += 1;
      else { rootCounts[state] += 1; roots += 1; }
    }
    return { project, threads: own, counts, rootCounts, nestedCounts, roots, latest: own.length ? at(own[0]!) : -1, index };
  });
  rows.sort((a, b) => b.latest - a.latest || a.index - b.index);
  return rows.map(({ index: _index, ...row }) => row);
}

export type QuickFilter = "all" | "input" | "error" | "working" | "unread";

export const QUICK_FILTERS: readonly { id: QuickFilter; label: string }[] = [
  { id: "all", label: "Все" },
  { id: "working", label: "Работают" },
  { id: "input", label: "Ждут" },
  { id: "error", label: "Ошибки" },
  { id: "unread", label: "Новое" },
];

export function passesFilter(summary: ProjectSummary, filter: QuickFilter): boolean {
  return filter === "all" || summary.counts[filter] > 0;
}

/** A subthread: its parent is a live thread too. A parent outside the live set makes it top-level, as bb's list does. */
export function isNested(thread: QuickThread, liveIds: ReadonlySet<string>): boolean {
  const parent = thread.parentThreadId;
  return Boolean(parent && parent !== thread.id && liveIds.has(parent));
}

export type FilterCount = { projects: number; roots: number; nested: number };

/**
 * Per quick filter: how many projects it leaves, and how many threads are in that state,
 * top-level and subthreads apart. The chip shows threads; the filter still picks projects.
 */
export function filterCounts(summaries: readonly ProjectSummary[]): Record<QuickFilter, FilterCount> {
  const zero = (): FilterCount => ({ projects: 0, roots: 0, nested: 0 });
  const result: Record<QuickFilter, FilterCount> = { all: zero(), input: zero(), error: zero(), working: zero(), unread: zero() };
  result.all.projects = summaries.length;
  for (const summary of summaries) {
    result.all.roots += summary.roots;
    result.all.nested += summary.threads.length - summary.roots;
    for (const filter of ["input", "error", "working", "unread"] as const) {
      if (summary.counts[filter] > 0) result[filter].projects += 1;
      result[filter].roots += summary.rootCounts[filter];
      result[filter].nested += summary.nestedCounts[filter];
    }
  }
  return result;
}

/** What a thread's subthreads (all levels below it) are doing. */
export type Inside = { counts: Record<QuickState, number>; total: number; top: QuickState | null };

/**
 * For every live thread, the states of its live descendants. One pass over the tree; a cycle in
 * parent links is cut at the first repeat, so a broken link never loops or double-counts.
 */
export function insideStates(threads: readonly QuickThread[]): Map<string, Inside> {
  const live = threads.filter(isLive);
  const { children } = threadTree(live);
  const result = new Map<string, Inside>();
  const visiting = new Set<string>();
  const visit = (thread: QuickThread): Inside => {
    const known = result.get(thread.id);
    if (known) return known;
    const inside: Inside = { counts: emptyCounts(), total: 0, top: null };
    if (visiting.has(thread.id)) return inside;
    visiting.add(thread.id);
    for (const kid of children.get(thread.id) ?? []) {
      if (visiting.has(kid.id)) continue;
      inside.counts[threadState(kid)] += 1;
      inside.total += 1;
      const below = visit(kid);
      for (const state of QUICK_STATES) inside.counts[state] += below.counts[state];
      inside.total += below.total;
    }
    visiting.delete(thread.id);
    inside.top = QUICK_STATES.find((state) => state !== "idle" && inside.counts[state] > 0) ?? null;
    result.set(thread.id, inside);
    return inside;
  };
  for (const thread of live) visit(thread);
  return result;
}

/** "45 с", "12 мин", "1 ч 05 мин" — how long a turn has been running. */
export function duration(ms: number): string {
  if (!(ms > 0)) return "";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return `${Math.max(1, Math.floor(ms / 1000))} с`;
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  return `${hours} ч ${String(minutes % 60).padStart(2, "0")} мин`;
}

/** Threads of one project for the side list; with a state filter on, its threads first. */
export function projectThreads(summary: ProjectSummary, filter: QuickFilter): QuickThread[] {
  if (filter === "all") return summary.threads;
  const first = summary.threads.filter((thread) => threadState(thread) === filter);
  return [...first, ...summary.threads.filter((thread) => threadState(thread) !== filter)];
}

/** "сейчас", "5 мин", "3 ч", "2 д", "12 нояб." */
export function ago(timestamp: number, now: number): string {
  if (timestamp <= 0) return "";
  const minutes = Math.max(0, Math.round((now - timestamp) / 60_000));
  if (minutes < 1) return "сейчас";
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ч`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} д`;
  return new Date(timestamp).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
}

/**
 * Threads as bb's list nests them: roots (no parent among these threads), and
 * each thread's children, all latest first. Input is expected latest first.
 */
export function threadTree(threads: readonly QuickThread[]): { roots: QuickThread[]; children: Map<string, QuickThread[]> } {
  const ids = new Set(threads.map((thread) => thread.id));
  const roots: QuickThread[] = [];
  const children = new Map<string, QuickThread[]>();
  for (const thread of threads) {
    const parent = thread.parentThreadId;
    if (parent && ids.has(parent) && parent !== thread.id) {
      const list = children.get(parent);
      if (list) list.push(thread);
      else children.set(parent, [thread]);
    } else roots.push(thread);
  }
  return { roots, children };
}
