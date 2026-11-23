// The status feed: pure functions, so the ordering rules are testable.

export type AgentState = "needs" | "running" | "error" | "unread" | "idle";

export interface FeedThread {
  id: string;
  projectId: string;
  providerId?: string;
  title: string | null;
  /** bb's own title from the first message, while `title` is still empty. */
  titleFallback?: string | null;
  status: string;
  parentThreadId?: string | null;
  hasPendingInteraction?: boolean;
  lastReadAt?: number | null;
  latestAttentionAt?: number;
  updatedAt: number;
  /** The machine of the thread's environment, as bb reports it on the row. */
  environmentHostId?: string | null;
}

export interface FeedItem {
  id: string;
  title: string;
  project: string;
  machine: string;
  /** Agent provider id, e.g. "claude-code" or "codex". */
  provider: string;
  state: AgentState;
  /** Last assistant reply, one line; empty when none is known. */
  snippet: string;
  /** What a running agent is doing right now, e.g. "Команда: npm test". */
  activity: string;
  updatedAt: number;
  url: string;
}

export interface Feed {
  generatedAt: number;
  counts: { needs: number; running: number; unread: number; error: number };
  items: FeedItem[];
}

const RANK: Record<AgentState, number> = {
  needs: 0,
  running: 1,
  error: 2,
  unread: 3,
  idle: 4,
};

export function stateOf(thread: FeedThread): AgentState {
  if (thread.hasPendingInteraction) return "needs";
  if (thread.status === "active") return "running";
  if (thread.status === "error" || thread.status === "failed") return "error";
  const attention = thread.latestAttentionAt ?? 0;
  if (attention > 0 && (thread.lastReadAt == null || attention > thread.lastReadAt)) {
    return "unread";
  }
  return "idle";
}

/** One line, at most `max` characters, cut at a word where possible. */
export function oneLine(text: string | null | undefined, max = 280): string {
  const flat = (text ?? "").replace(/```[\s\S]*?```/g, " ").replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[#*_`>|]/g, "").replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${space > max * 0.6 ? cut.slice(0, space) : cut}…`;
}

export function buildFeed(input: {
  threads: readonly FeedThread[];
  projectNames: ReadonlyMap<string, string>;
  machineNames: ReadonlyMap<string, string>;
  snippets: Readonly<Record<string, string>>;
  activities?: Readonly<Record<string, string>>;
  webUrl: string;
  maxItems: number;
  now: number;
}): Feed {
  const byId = new Map(input.threads.map((thread) => [thread.id, thread]));
  // Subagents are shown through their top-level thread: a parent whose
  // subagent works is working, and one whose subagent waits is waiting.
  const rootOf = (thread: FeedThread): FeedThread => {
    let current = thread;
    for (let depth = 0; depth < 20 && current.parentThreadId; depth += 1) {
      const parent = byId.get(current.parentThreadId);
      if (!parent) break;
      current = parent;
    }
    return current;
  };
  const effective = new Map<string, { state: AgentState; activity: string }>();
  for (const thread of input.threads) {
    const root = rootOf(thread);
    const state = stateOf(thread);
    const own = root.id === thread.id;
    const current = effective.get(root.id);
    const activity = state === "running" ? (input.activities?.[thread.id] ?? "") : "";
    const candidate = {
      state: own || state === "needs" || state === "running" ? state : "idle" as AgentState,
      activity: own || !activity ? activity : `Субагент: ${activity}`,
    };
    if (!current || RANK[candidate.state] < RANK[current.state]) {
      effective.set(root.id, candidate);
    } else if (candidate.state === current.state && candidate.activity && (own || !current.activity)) {
      // Same state: the parent's own step is the one to show.
      effective.set(root.id, { state: current.state, activity: candidate.activity });
    }
  }
  const rows = input.threads
    .filter((thread) => rootOf(thread).id === thread.id)
    .map((thread) => ({ thread, ...effective.get(thread.id)! }));
  const counts = { needs: 0, running: 0, unread: 0, error: 0 };
  for (const { state } of rows) if (state !== "idle") counts[state] += 1;
  const base = input.webUrl.replace(/\/+$/, "");
  const items = rows
    // What needs a look comes first, then the most recent.
    .sort((a, b) => RANK[a.state] - RANK[b.state] || b.thread.updatedAt - a.thread.updatedAt)
    .slice(0, input.maxItems)
    .map(({ thread, state, activity }) => ({
      id: thread.id,
      title: oneLine(thread.title, 60) || oneLine(thread.titleFallback, 60) || "Без названия",
      project: input.projectNames.get(thread.projectId) ?? "",
      machine: input.machineNames.get(thread.id) ?? "",
      provider: thread.providerId ?? "",
      state,
      snippet: input.snippets[thread.id] ?? "",
      activity: state === "running" ? activity : "",
      updatedAt: thread.updatedAt,
      url: base ? `${base}/projects/${thread.projectId}/threads/${thread.id}` : "",
    }));
  return { generatedAt: input.now, counts, items };
}

/** Whether two feeds differ in anything but their timestamp. */
export function sameContent(a: Feed | null, b: Feed): boolean {
  if (a === null) return false;
  return JSON.stringify({ ...a, generatedAt: 0 }) === JSON.stringify({ ...b, generatedAt: 0 });
}

interface ActivityItem {
  type?: string;
  command?: string;
  path?: string;
  tool?: string;
  description?: string;
  changes?: { path?: string }[];
  presentation?: { label?: { pending?: string } };
}

const base = (path: string | undefined) => (path ?? "").split("/").filter(Boolean).at(-1) ?? "";

/** A short Russian phrase for the item an agent has just started. */
export function describeActivity(item: ActivityItem | null | undefined): string {
  if (!item) return "";
  switch (item.type) {
    case "agentMessage":
      return "Пишет ответ";
    case "reasoning":
      return "Думает";
    case "commandExecution": {
      if (item.description) return oneLine(item.description, 70);
      // Codex wraps commands as /bin/bash -lc '<command>'.
      const command = (item.command ?? "").replace(/^\S*\/(?:ba|z)?sh -l?c '([\s\S]*)'$/, "$1");
      return `Команда: ${oneLine(command, 60)}`;
    }
    case "fileRead":
      return `Читает ${base(item.path)}`.trim();
    case "fileChange": {
      const names = [...new Set((item.changes ?? []).map((change) => base(change.path)).filter(Boolean))];
      return `Правит ${names.slice(0, 2).join(", ")}${names.length > 2 ? "…" : ""}`.trim();
    }
    case "toolCall":
      return `Инструмент ${item.tool ?? ""}`.trim();
    case "imageView":
      return "Смотрит изображение";
    case "backgroundTask":
      return item.description ? `Фон: ${oneLine(item.description, 60)}` : "Фоновая задача";
    default:
      return oneLine(item.presentation?.label?.pending ?? "", 60);
  }
}

export interface ChatMessage {
  role: "user" | "agent" | "thread";
  text: string;
  at: number;
}

interface RawEvent {
  type: string;
  createdAt: number | string;
  data: Record<string, unknown>;
}

/**
 * The conversation as the panel shows it: what the user (or another thread)
 * sent and what the agent replied, oldest first. Tool steps are left out.
 */
export function chatFromEvents(events: readonly RawEvent[], limit = 40): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const event of events) {
    const at = typeof event.createdAt === "number" ? event.createdAt : Date.parse(event.createdAt);
    if (event.type === "client/turn/requested") {
      const data = event.data as { initiator?: string; senderThreadId?: string | null; input?: { type?: string; text?: string }[] };
      const text = (data.input ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n").trim();
      if (text) out.push({ role: data.senderThreadId ? "thread" : "user", text: text.slice(0, 4000), at });
    } else if (event.type === "item/completed") {
      const item = (event.data as { item?: { type?: string; text?: string } }).item;
      if (item?.type === "agentMessage" && item.text?.trim()) out.push({ role: "agent", text: item.text.trim().slice(0, 8000), at });
    }
  }
  return out.slice(-limit);
}

/**
 * The newest events that still hold the last `limit` conversation messages
 * (oldest first in and out). Keeps the per-thread event cache small without
 * changing what chatFromEvents shows.
 */
export function keepRecent<T extends RawEvent>(events: readonly T[], limit = 40): T[] {
  let messages = 0;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (chatFromEvents([events[index]!]).length > 0) messages += 1;
    if (messages >= limit) return events.slice(index);
  }
  return [...events];
}

/** bb's page limit for the thread list: a full page may be cut short. */
export const THREAD_PAGE = 200;

/**
 * Subthreads of `rootId` down to `depth` levels, level by level, taken from
 * one complete thread list instead of one list call per parent. Null when the
 * list may be incomplete (a full page): the caller asks bb per parent then.
 */
export function descendantsFrom(threads: readonly FeedThread[], rootId: string, depth = 3): FeedThread[] | null {
  if (threads.length >= THREAD_PAGE) return null;
  const byParent = new Map<string, FeedThread[]>();
  for (const thread of threads) {
    if (!thread.parentThreadId) continue;
    const siblings = byParent.get(thread.parentThreadId) ?? [];
    siblings.push(thread);
    byParent.set(thread.parentThreadId, siblings);
  }
  const out: FeedThread[] = [];
  let level = [rootId];
  for (let step = 0; step < depth && level.length; step += 1) {
    const children = level.flatMap((id) => byParent.get(id) ?? []);
    out.push(...children);
    level = children.map((child) => child.id);
  }
  return out;
}

/**
 * Machine name of each thread from the host bb already reports on the thread
 * row, so the machines need not be listed one by one. Null when a row has no
 * such field (an older bb): the caller lists threads per machine then.
 */
export function machineNamesFrom(
  threads: readonly FeedThread[],
  hosts: readonly { id: string; name: string; type?: string }[],
): Map<string, string> | null {
  if (threads.some((thread) => thread.environmentHostId === undefined)) return null;
  const persistent = new Map(hosts.filter((host) => host.type === "persistent").map((host) => [host.id, host.name]));
  const names = new Map<string, string>();
  for (const thread of threads) {
    const name = thread.environmentHostId ? persistent.get(thread.environmentHostId) : undefined;
    if (name !== undefined) names.set(thread.id, name);
  }
  return names;
}

/**
 * The status file as an absolute path with forward slashes, or null: a POSIX
 * path, or a Windows drive path written with either slash.
 */
export function statusFile(filePath: string): string | null {
  const path = filePath.trim();
  // A backslash is an ordinary character in a POSIX name; only a drive path is rewritten.
  if (path.startsWith("/")) return path;
  const windows = path.replace(/\\/g, "/");
  return /^[A-Za-z]:\//.test(windows) ? windows : null;
}
