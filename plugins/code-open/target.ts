/** Where the editor opens. Mirrors KodaForge's own `kind/id` deep-link scopes. */
export type Target = { kind: 'thread' | 'environment' | 'project'; id: string };

export const FORGE_PREFIX = '/plugins/kodaforge/forge';

export function forgePath(target: Target): string {
  return `${FORGE_PREFIX}/${target.kind}/${encodeURIComponent(target.id)}`;
}

/** KodaForge keeps "chat panel open" per workspace under this localStorage key. */
export function chatOpenKey(target: Target): string {
  return `kodaforge:side:${target.kind}:${target.id}:open`;
}

/** KodaForge resolves the project scope on its default source machine. */
export function projectTarget(projectId: string): Target {
  return { kind: 'project', id: projectId };
}

/** KodaForge keeps editor settings as one JSON object under this localStorage key. */
export const FORGE_SETTINGS_KEY = 'kodaforge:settings';
export const RESTORE_FLAG = 'code-open:kodaforge-settings-restored:v3';
export const OVERRIDDEN_KEYS = ['smoothScrolling', 'minimap', 'stickyScroll'] as const;

/**
 * Versions 0.3.0–0.3.2 overrode three KodaForge editor settings while chasing a
 * scroll stutter that turned out to come from machine-tabs CSS. Hand them back:
 * drop the three keys so KodaForge's own defaults apply again. Other keys stay.
 */
export function withoutOverrides(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const rest = { ...(parsed as Record<string, unknown>) };
    for (const key of OVERRIDDEN_KEYS) delete rest[key];
    return Object.keys(rest).length ? JSON.stringify(rest) : null;
  } catch { return null; }
}
