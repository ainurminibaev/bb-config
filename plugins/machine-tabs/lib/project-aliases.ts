export interface LinkedThread {
  id: string;
  projectId: string;
  parentThreadId?: string | null;
  isHidden?: boolean;
  isArchived?: boolean;
  pinnedAt?: number | null;
  isPinned?: boolean;
}

export type ProjectRoot =
  | { kind: "thread"; node: { thread: LinkedThread } }
  | { kind: "environment"; group: { nodes: { thread: LinkedThread }[] } }
  | { kind: "section" };

type ThreadComparator = {
  (left: LinkedThread, right: LinkedThread): number;
  compareItems?: (left: ProjectRoot, right: ProjectRoot) => number;
};

export function mergeProjectRoots(
  roots: readonly ProjectRoot[],
  aliases: readonly ProjectRoot[],
  compareThreads: ThreadComparator,
): ProjectRoot[] {
  // Keep the native order of sections and existing rows, including during a
  // drag. Insert each alias where the same comparator puts an ordinary row.
  const headThread = (root: Exclude<ProjectRoot, { kind: "section" }>) =>
    root.kind === "thread" ? root.node.thread : root.group.nodes[0].thread;
  const compare = (left: ProjectRoot, right: ProjectRoot) => {
    if (left.kind === "section") return right.kind === "section" ? 0 : -1;
    if (right.kind === "section") return 1;
    return compareThreads.compareItems
      ? compareThreads.compareItems(left, right)
      : compareThreads(headThread(left), headThread(right));
  };
  const remaining = [...aliases].sort(compare);
  const merged: ProjectRoot[] = [];
  let next = 0;
  for (const root of roots) {
    while (next < remaining.length && compare(remaining[next], root) < 0) {
      merged.push(remaining[next++]);
    }
    merged.push(root);
  }
  return merged.concat(remaining.slice(next));
}

const isPinned = (thread: LinkedThread) =>
  Boolean(thread.isPinned) || thread.pinnedAt != null;

/** Additional native tree input for a project's own threads that bb lists
 * elsewhere: cross-project children (under the parent's project) and pinned
 * threads with their subtree (under Pinned).
 * Preserve objects, IDs and parent links: these are views, never new sessions.
 */
export function projectAliases<T extends LinkedThread>(
  threads: readonly T[], projectId: string, existing: readonly T[],
): T[] {
  const visible = threads.filter(t => !t.isHidden && !t.isArchived);
  const byId = new Map(visible.map(t => [t.id, t]));
  const present = new Set(existing.map(t => t.id));
  const selected = new Set<string>();
  for (const thread of visible) {
    if (thread.projectId !== projectId || present.has(thread.id)) continue;
    let root = thread;
    let pinned = isPinned(thread);
    const seen = new Set([root.id]);
    while (root.parentThreadId && byId.has(root.parentThreadId)) {
      const parent = byId.get(root.parentThreadId)!;
      if (seen.has(parent.id)) break;
      seen.add(parent.id);
      root = parent;
      pinned ||= isPinned(root);
    }
    if (pinned || root.projectId !== projectId) selected.add(thread.id);
  }
  // Include descendants so the alias has the same expandable subtree.
  let changed = true;
  while (changed) {
    changed = false;
    for (const thread of visible) {
      if (!selected.has(thread.id) && !present.has(thread.id) &&
          thread.parentThreadId && selected.has(thread.parentThreadId)) {
        selected.add(thread.id);
        changed = true;
      }
    }
  }
  return visible.filter(t => selected.has(t.id));
}
