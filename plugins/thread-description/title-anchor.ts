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

/**
 * The composer and its collapse arrow (BB 0.50.1: `data-follow-up-composer`
 * with a "Collapse prompt box" / "Expand prompt box" button). The icon goes
 * into the composer itself: inside the input region BB moves buttons away
 * while it measures them. Null when either is missing.
 */
export function findComposerSpot(marker: Element): { composer: HTMLElement; arrow: HTMLElement } | null {
  // The banner renders next to its own composer; the nearest one up the tree is it.
  const composer = (marker.closest('[data-follow-up-composer]') ?? findUp(marker, '[data-follow-up-composer]')) as HTMLElement | null;
  // BB keeps hidden copies of some controls; take the one that is on screen.
  const arrow = [...(composer?.querySelectorAll<HTMLElement>('button[aria-label="Collapse prompt box"],button[aria-label="Expand prompt box"]') ?? [])]
    .find((button) => button.getClientRects().length > 0);
  return composer && arrow ? { composer, arrow } : null;
}

function findUp(marker: Element, selector: string): Element | null {
  for (let root = marker.parentElement; root && root !== document.body; root = root.parentElement) {
    const found = root.querySelector(selector);
    if (found) return found;
  }
  return null;
}
