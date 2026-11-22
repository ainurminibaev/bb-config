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

const STABLE_RE = /^\d+\.\d+\.\d+$/;

/**
 * Target for "latest": the highest stable release not above the npm `latest` tag that has been
 * public for at least `minAgeMs` (a broken release is usually yanked or fixed within a day or two).
 * Falls back to `latest` itself only when nothing is old enough. Prereleases are never chosen.
 */
export function pickVersion(latest: string | undefined, times: Record<string, string>, now: number, minAgeMs: number): string | null {
  return pickCandidates(latest, times, {}, now, minAgeMs, 1)[0]?.version ?? null;
}

/** A release a host may install, with its `engines.node` range (null = no requirement published). */
export interface Candidate { version: string; node: string | null }

/**
 * Releases a host may install, newest first: stable, not above `latest`, past the quarantine.
 * Several are offered so a host whose Node is too old for the newest one takes the newest it can run.
 */
export function pickCandidates(latest: string | undefined, times: Record<string, string>, engines: Record<string, string | null>, now: number, minAgeMs: number, limit = 10): Candidate[] {
  const stable = Object.keys(times).filter(v => STABLE_RE.test(v) && (!latest || compareVersions(v, latest) <= 0));
  let list = stable.filter(v => now - Date.parse(times[v]!) >= minAgeMs);
  if (!list.length) list = latest && STABLE_RE.test(latest) ? [latest] : stable;
  return list.sort((a, b) => compareVersions(b, a)).slice(0, limit).map(version => ({ version, node: engines[version] ?? null }));
}

const parse3 = (v: string): number[] | null => {
  const m = /^v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]) || 0, Number(m[3]) || 0] : null;
};
const cmp3 = (a: number[], b: number[]) => (a[0]! - b[0]!) || (a[1]! - b[1]!) || (a[2]! - b[2]!);

/**
 * Does Node `nodeVersion` satisfy an npm `engines.node` range? Handles `||`, space-separated
 * comparators (>=, >, <=, <, =), `^`, `~`, bare and x-ranges. Anything else counts as NOT
 * satisfied: an unreadable requirement must not replace a working install.
 */
export function satisfiesNode(nodeVersion: string, range: string | null): boolean {
  if (range === null || range.trim() === '' || range.trim() === '*') return true;
  const v = parse3(nodeVersion);
  if (!v) return false;
  return range.split('||').some(part => {
    const tokens = part.trim().replace(/(>=|<=|>|<|=)\s+/g, '$1').split(/\s+/).filter(Boolean);
    if (!tokens.length) return false;
    return tokens.every(token => {
      const m = /^(>=|<=|>|<|=|\^|~)?(v?\d+(?:\.(?:\d+|x|\*)){0,2})$/.exec(token);
      if (!m) return false;
      const op = m[1] ?? '';
      const base = parse3(m[2]!)!;
      const c = cmp3(v, base);
      const parts = m[2]!.replace(/^v/, '').split('.').filter(p => /^\d+$/.test(p)).length;
      switch (op) {
        case '>=': return c >= 0;
        case '>': return c > 0;
        case '<=': return c <= 0;
        case '<': return c < 0;
        case '^': return c >= 0 && (base[0]! > 0 ? v[0] === base[0] : v[0] === 0 && v[1] === base[1]);
        case '~': return c >= 0 && v[0] === base[0] && (parts < 2 || v[1] === base[1]);
        default: return parts === 3 ? c === 0 : v[0] === base[0] && (parts < 2 || v[1] === base[1]);
      }
    });
  });
}

/** The newest candidate this host's Node can run, or null. */
export function chooseCandidate(candidates: Candidate[], nodeVersion: string): Candidate | null {
  return candidates.find(c => satisfiesNode(nodeVersion, c.node)) ?? null;
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
