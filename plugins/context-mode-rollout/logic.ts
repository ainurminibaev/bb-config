// Pure decisions of the rollout: kept free of I/O so they are unit-tested.

export const AGENTS = ['claude-code', 'codex'] as const;
export type AgentId = (typeof AGENTS)[number];

export const VERSION_RE = /^\d+\.\d+\.\d+$/;

/** -1, 0 or 1; unparsable versions sort first so they get replaced. */
export function compareVersions(a: string | null, b: string): number {
  if (!a || !/^\d+\.\d+\.\d+/.test(a)) return -1;
  const pa = a.split(/[.+-]/).slice(0, 3).map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1;
  }
  return 0;
}

/** Installed and at least the pinned version (a newer one from ctx_upgrade is kept, never downgraded). */
export function packageIsCurrent(installed: string | null, pinned: string): boolean {
  return compareVersions(installed, pinned) >= 0;
}

export interface AgentState {
  id: string;
  status: string;
  changes: number;
}

/** Reads `context-mode setup|doctor --json` output tolerantly: unknown fields are ignored. */
export function parseAgents(stdout: string): AgentState[] | null {
  const start = stdout.indexOf('{');
  if (start < 0) return null;
  try {
    const data = JSON.parse(stdout.slice(start)) as { agents?: unknown };
    if (!Array.isArray(data.agents)) return null;
    return data.agents.flatMap((raw): AgentState[] => {
      if (!raw || typeof raw !== 'object') return [];
      const a = raw as Record<string, unknown>;
      if (typeof a.id !== 'string') return [];
      return [{ id: a.id, status: typeof a.status === 'string' ? a.status : 'UNKNOWN', changes: Array.isArray(a.changes) ? a.changes.length : 0 }];
    });
  } catch {
    return null;
  }
}

/** Agents whose setup is missing or drifted according to a dry run. */
export function agentsNeedingSetup(wanted: readonly string[], dryRun: AgentState[] | null): string[] {
  if (!dryRun) return [...wanted];
  return wanted.filter(id => {
    const a = dryRun.find(item => item.id === id);
    return !a || a.status !== 'PASS' || a.changes > 0;
  });
}

export interface HostRecord {
  lastRunAt: number;
  ok: boolean;
}

export const RECHECK_MS = 24 * 60 * 60 * 1000;
export const RECONNECT_MIN_MS = 30 * 60 * 1000;
export const RETRY_MS = 60 * 60 * 1000;

/** Whether the server should run the host check now. */
export function shouldRun(record: HostRecord | undefined, justConnected: boolean, now: number): boolean {
  if (!record) return true;
  const age = now - record.lastRunAt;
  if (!record.ok) return age >= RETRY_MS || (justConnected && age >= RECONNECT_MIN_MS);
  if (justConnected) return age >= RECONNECT_MIN_MS;
  return age >= RECHECK_MS;
}
