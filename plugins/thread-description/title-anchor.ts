/**
 * Where the icon goes: right after the thread menu that follows the title in
 * the same pane's header. Relies on BB 0.50.1 markup: the header actions carry
 * `data-thread-header-workflow-actions` and the menu button is labelled
 * "Thread actions". Returns null when either is missing; nothing is drawn then.
 */
export function findTitleSpot(marker: Element): Element | null {
  for (let root = marker.parentElement; root && root !== document.body; root = root.parentElement) {
    const actions = root.querySelector('[data-thread-header-workflow-actions]');
    if (!actions) continue;
    for (let header = actions.parentElement; header && root.contains(header); header = header.parentElement) {
      const menu = header.querySelector('button[aria-label="Thread actions"]');
      if (!menu) continue;
      return menu.closest('span') ?? menu;
    }
    return null;
  }
  return null;
}
