import { finderFolderUrl } from './folder-target';

/** KodaForge's contract for Explorer menu items (docs/explorer-menu.md there). */
export const EXPLORER_MENU_EVENT = 'kodaforge:explorer-menu';

/** The folder an Explorer entry points at: itself, or a file's parent. Null for anything unexpected. */
export function explorerFolder(detail: unknown): { hostId: string; path: string } | null {
  if (!detail || typeof detail !== 'object') return null;
  const { version, hostId, path, kind } = detail as Record<string, unknown>;
  if (version !== 1 || typeof hostId !== 'string' || typeof path !== 'string' || (kind !== 'file' && kind !== 'directory')) return null;
  const folder = kind === 'file' ? path.slice(0, path.lastIndexOf('/')) || '/' : path;
  try { finderFolderUrl(hostId, folder, 'check'); } catch { return null; }
  return { hostId, path: folder };
}

/** Adds the Finder item to an Explorer menu that is opening; does nothing for other modes or events. */
export function addFinderItem(event: Event, mode: 'files' | 'finder' | 'native', open: (url: string) => boolean): void {
  const detail = (event as CustomEvent<{ items?: unknown }>).detail;
  const folder = mode === 'finder' ? explorerFolder(detail) : null;
  if (!folder || !Array.isArray(detail.items)) return;
  detail.items.push({
    label: 'Открыть в Finder',
    run: () => {
      if (!open(finderFolderUrl(folder.hostId, folder.path))) throw new Error('На этом устройстве недоступен обработчик Finder.');
    },
  });
}
