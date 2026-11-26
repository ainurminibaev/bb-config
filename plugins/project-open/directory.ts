/** Machines and project folders as BB knows them, for the Finder handler. */
import type { Directory } from './contract';

export type Machine = { id: string; name?: string | null };
export type Identity = { platform: string; hostKeys: string[]; user?: string | null };
type Project = { sources?: { type?: string; hostId?: string | null; path?: string | null }[] };
type Environment = { hostId?: string | null; path?: string | null };

/** A whole home folder holds keys and settings: never offered to Finder, even when a project points at it. */
const home = (path: string) => /^\/(root|home\/[^/]+|Users\/[^/]+)\/?$/.test(path);
const usable = (path: unknown): path is string => typeof path === 'string' && /^\/[^/]/.test(path)
  && !/[\x00-\x1f\x7f]/.test(path) && !path.split('/').includes('..') && !home(path);

export function publicKeys(files: string[]): string[] {
  return [...new Set(files.map(text => text.trim().split(/\s+/).slice(0, 2).join(' '))
    .filter(key => /^[a-z0-9@.-]+ [A-Za-z0-9+/=]{20,}$/.test(key)))].sort();
}

export function buildMachines(hosts: Machine[], projects: Project[], environments: Environment[], identities: Map<string, Identity>): Directory['machines'] {
  const machines: Directory['machines'] = {};
  for (const host of hosts) {
    const identity = identities.get(host.id);
    const roots = new Set<string>();
    for (const project of projects) for (const source of project.sources ?? [])
      if (source.hostId === host.id && usable(source.path)) roots.add(source.path);
    for (const environment of environments)
      if (environment.hostId === host.id && usable(environment.path)) roots.add(environment.path);
    machines[host.id] = { name: host.name || host.id, platform: identity?.platform ?? null, roots: [...roots].sort(), hostKeys: identity?.hostKeys ?? [],
      ...(identity?.user ? { user: identity.user } : {}) };
  }
  return machines;
}

/** A machine that is offline now keeps the keys it reported earlier. */
export function keepKnownKeys(next: Directory, previous: unknown): Directory {
  const old = (previous as { machines?: Record<string, Partial<Identity>> } | null)?.machines;
  if (!old || typeof old !== 'object') return next;
  const machines = { ...next.machines };
  for (const [id, machine] of Object.entries(machines)) {
    const keys = old[id]?.hostKeys;
    if (machine.platform === null && Array.isArray(keys))
      machines[id] = { ...machine, platform: old[id]?.platform ?? null, hostKeys: publicKeys(keys.filter(k => typeof k === 'string')),
        ...(typeof old[id]?.user === 'string' ? { user: old[id]!.user } : {}) };
  }
  return { ...next, machines };
}
