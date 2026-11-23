/** Pure rules shared by the server, the page script and the tests. */

export type HostLike = { id: string; name: string; status: string; type: string; phase: string; cleanupFailed: boolean };
export type QuietState = {
  /** Current names of the machines the user chose to be quiet about. */
  quietNames: string[];
  /** Every machine BB warns about right now is a quiet one. */
  allWarningsQuiet: boolean;
};

/** Split the setting: commas or new lines, names or host IDs, any case. */
export function parseList(raw: string): string[] {
  return [...new Set(raw.split(/[,\n]/u).map(s => s.trim()).filter(Boolean))];
}

/** Read one host from the SDK leniently; unknown shapes are skipped. */
export function toHostLike(value: unknown): HostLike | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || typeof v.name !== 'string') return null;
  const lifecycle = (typeof v.lifecycle === 'object' && v.lifecycle !== null ? v.lifecycle : {}) as Record<string, unknown>;
  const teardown = (typeof lifecycle.teardown === 'object' && lifecycle.teardown !== null ? lifecycle.teardown : {}) as Record<string, unknown>;
  return {
    id: v.id, name: v.name,
    status: typeof v.status === 'string' ? v.status : 'unknown',
    type: typeof v.type === 'string' ? v.type : 'persistent',
    phase: typeof lifecycle.phase === 'string' ? lifecycle.phase : 'active',
    cleanupFailed: lifecycle.phase === 'removing' && teardown.status === 'failed',
  };
}

/** Mirrors BB 0.50: machines that get the "is offline" / "cleanup failed" warning. */
export function warned(host: HostLike): boolean {
  if (host.type === 'ephemeral') return false;
  if (host.cleanupFailed) return true;
  return host.phase === 'active' && host.status !== 'connected';
}

export function quietState(hosts: HostLike[], list: string[]): QuietState {
  const wanted = new Set(list.map(s => s.toLowerCase()));
  const isQuiet = (h: HostLike) => wanted.has(h.name.toLowerCase()) || wanted.has(h.id.toLowerCase());
  const warnings = hosts.filter(warned);
  return {
    quietNames: hosts.filter(isQuiet).map(h => h.name),
    // Cleanup failures always stay visible: they need action.
    allWarningsQuiet: warnings.length > 0 && warnings.every(h => isQuiet(h) && !h.cleanupFailed),
  };
}

/** Labels BB 0.50 uses for one machine; anything else is left alone. */
export function offlineName(label: string): string | null {
  const match = /^(.+) is offline$/u.exec(label.trim());
  return match ? match[1]! : null;
}

/** Sidebar label for several machines at once. */
export function isSummaryLabel(label: string): boolean {
  return /^Machines offline$|^\d+ machines (need attention|are offline)$/u.test(label.trim());
}
