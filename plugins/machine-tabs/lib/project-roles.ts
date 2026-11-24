export function activeRoles(raw: unknown): Record<string, number> {
  const ranks: Record<string, number> = Object.create(null);
  if (!Array.isArray(raw)) return ranks;
  for (const role of raw) {
    const rank = role?.kind === "agent" ? 0 : role?.kind === "orchestrator" ? 1 : undefined;
    const id = role?.active?.threadId;
    if (rank !== undefined && role.active?.kind === "thread" && typeof id === "string") {
      ranks[id] = Math.min(ranks[id] ?? rank, rank);
    }
  }
  return ranks;
}

type Item = { kind?: string; node?: { thread?: { id: string; updatedAt: number } } };

export function projectRolesFirst(items: Item[], ranks: Record<string, number>) {
  const roles: { item: Item; rank: number; updatedAt: number }[] = [];
  const rest: Item[] = [];
  for (const item of items) {
    const thread = item?.kind === "thread" && item.node?.thread;
    if (thread && Object.hasOwn(ranks, thread.id)) {
      roles.push({ item, rank: ranks[thread.id], updatedAt: thread.updatedAt });
    } else {
      rest.push(item);
    }
  }
  roles.sort((a, b) => a.rank - b.rank || b.updatedAt - a.updatedAt);
  return { items: roles.length ? [...roles.map(({ item }) => item), ...rest] : items,
    firstPage: Math.max(5, roles.length) };
}
