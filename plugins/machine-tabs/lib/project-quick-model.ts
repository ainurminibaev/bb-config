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

const BUSY = new Set(["active", "starting", "stopping", "pending", "provisioning", "waiting-for-host"]);
const BUSY_INDICATORS = new Set([
  "runtime", "background-agent", "background-command", "workflow", "working-draft", "queued-waiting",
]);

export function threadState(thread: QuickThread): QuickState {
  if (thread.hasPendingInteraction || thread.indicator === "waiting-for-input") return "input";
  if (thread.status === "error" || thread.runtimeStatus === "error" ||
    thread.indicator === "unread-error" || thread.indicator === "queued-failed") return "error";
  if (BUSY.has(thread.runtimeStatus ?? "") || BUSY.has(thread.status ?? "") ||
    BUSY_INDICATORS.has(thread.indicator ?? "")) return "working";
  if (thread.indicator === "unread-success" || thread.isUnread) return "unread";
  return "idle";
}

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
  counts: Record<QuickState, number>;
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
    const counts = emptyCounts();
    for (const thread of own) counts[threadState(thread)] += 1;
    return { project, threads: own, counts, latest: own.length ? at(own[0]!) : -1, index };
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

/** How many projects each quick filter would leave. */
export function filterCounts(summaries: readonly ProjectSummary[]): Record<QuickFilter, number> {
  const result: Record<QuickFilter, number> = { all: summaries.length, input: 0, error: 0, working: 0, unread: 0 };
  for (const summary of summaries) {
    for (const filter of ["input", "error", "working", "unread"] as const) {
      if (summary.counts[filter] > 0) result[filter] += 1;
    }
  }
  return result;
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
