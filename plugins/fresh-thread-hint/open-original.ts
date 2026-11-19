/** Uses BB's native panel launcher. Never reaches into React state or plugin internals. */
function available<T extends HTMLElement>(element: T | null): T | null {
  return element && !element.closest('[hidden], [inert], [aria-hidden="true"]') ? element : null;
}

function waitFor<T>(root: HTMLElement, find: () => T | null, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  const found = find();
  if (found) return Promise.resolve(found);
  return new Promise((resolve, reject) => {
    const finish = (value?: T, error?: Error) => {
      observer.disconnect(); clearTimeout(timer); signal.removeEventListener("abort", abort);
      error ? reject(error) : resolve(value!);
    };
    const abort = () => finish(undefined, new Error("Opening cancelled"));
    const observer = new MutationObserver(() => {
      const value = find(); if (value) finish(value);
    });
    const timer = setTimeout(() => finish(undefined, new Error("BB panel launcher is unavailable. Open Hand off from the right panel's + menu.")), 3000);
    observer.observe(root, { childList: true, subtree: true, attributes: true });
    signal.addEventListener("abort", abort, { once: true });
  });
}

export async function openOriginalHandoff(source: HTMLElement, signal: AbortSignal): Promise<void> {
  const root = source.closest<HTMLElement>("[data-split-pane-id]") ?? source.ownerDocument.body;
  // The toggle and new-tab button are real BB controls; their handlers own panel state.
  available(root.querySelector<HTMLButtonElement>('button[aria-label^="Show right panel"]'))?.click();
  const newTab = await waitFor(source.ownerDocument.body, () => {
    const inline = available(root.querySelector<HTMLButtonElement>("button[data-panel-new-tab]"));
    if (inline) return inline;
    // BB can portal the active panel outside the thread pane, with different
    // wrappers across layouts. Accept only one available native launcher.
    const buttons = [...source.ownerDocument.querySelectorAll<HTMLButtonElement>("button[data-panel-new-tab]")]
      .filter((button) => available(button) && !button.disabled);
    return buttons.length === 1 ? buttons[0]! : null;
  }, signal);
  const panel = root.contains(newTab) ? newTab.closest("aside") ?? root : source.ownerDocument.body;
  newTab.click();
  const page = await waitFor(panel, () => {
    const pages = [...panel.querySelectorAll<HTMLElement>("[data-panel-new-tab-page]")].filter((page) => available(page));
    return pages.length === 1 ? pages[0]! : null;
  }, signal);
  // BB's native action id includes both the owner plugin and its action id.
  const selector = 'button[data-panel-new-tab-item][id="plugin-action:handoff:handoff"]';
  if (!page.querySelector(selector)) {
    page.querySelectorAll<HTMLButtonElement>('button[data-panel-new-tab-item][aria-expanded="false"]')
      .forEach((button) => button.click());
  }
  const action = await waitFor(page, () => available(page.querySelector<HTMLButtonElement>(selector)), signal);
  if (action.disabled) throw new Error("Enable the original Handoff plugin first.");
  action.click();
}
