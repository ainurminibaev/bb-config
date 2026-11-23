// Keep the return control mounted even when Machine Tabs is not the provider.
const ENDPOINT = "/api/v1/plugins/machine-tabs/http/sidebar-view";

export function installSidebarView(signal: AbortSignal) {
  const control = document.createElement("span");
  control.dataset.machineTabsView = "";
  control.dataset.bbPlugin = "machine-tabs";
  control.dataset.bbPluginRoot = "machine-tabs";
  control.setAttribute("role", "group");
  control.setAttribute("aria-label", "Sidebar view");
  control.style.cssText = "display:inline-flex;align-items:center;gap:3px;flex-shrink:0;font-size:10px;white-space:nowrap;-webkit-app-region:no-drag";
  let provider: string | null = null;
  let busy = false;
  const buttons = (["classic", "custom"] as const).map((view, index) => {
    if (index) {
      const divider = document.createElement("span");
      divider.textContent = "|";
      divider.style.opacity = "0.35";
      divider.setAttribute("aria-hidden", "true");
      control.append(divider);
    }
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = view === "classic" ? "Classic" : "Custom";
    button.className = "rounded-sm text-muted-foreground hover:text-sidebar-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring";
    button.style.cssText = "padding:4px 1px;cursor:pointer;background:transparent;border:0;font:inherit";
    button.title = view === "classic" ? "Штатный список текущей версии BB" : "Вкладки машин, поиск и группы Machine Tabs";
    button.addEventListener("click", async () => {
      if (busy) return;
      busy = true;
      paint();
      try {
        const response = await fetch(ENDPOINT, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ view }), signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        provider = (await response.json()).provider;
        control.removeAttribute("title");
      } catch (error) {
        if (!signal.aborted) control.title = `Не удалось переключить вид: ${String(error)}. Нажмите ещё раз.`;
      } finally {
        busy = false;
        if (!signal.aborted) paint();
      }
    });
    control.append(button);
    return button;
  });
  function paint() {
    buttons.forEach((button, index) => {
      const selected = provider === (index === 0 ? "thread-list/thread-list" : "machine-tabs/machine-tabs");
      button.disabled = busy || provider === null;
      button.setAttribute("aria-pressed", String(selected));
      button.style.fontWeight = selected ? "600" : "400";
      button.style.textDecoration = selected ? "none" : "underline";
      button.style.textUnderlineOffset = "2px";
      button.style.opacity = selected ? "1" : "0.6";
    });
  }
  function attach() {
    if (signal.aborted) return;
    // Anchor to the built-in navigation contribution, never a thread action.
    const header = Array.from(document.querySelectorAll<HTMLElement>('[data-bb-plugin="navigation"]'))
      .find(node => node.querySelector('button[aria-keyshortcuts]') && node.classList.contains("contents"));
    if (header && header.nextSibling !== control) header.after(control);
  }
  async function refresh() {
    if (busy || signal.aborted) return;
    try {
      const response = await fetch(ENDPOINT, { signal, cache: "no-store" });
      if (!response.ok) return;
      const next = (await response.json()).provider;
      if (!busy && !signal.aborted) { provider = next; paint(); }
    } catch { /* A later refresh retries; never create an unhandled rejection. */ }
  }
  paint();
  // Look for the header again only when a change can move it; chat output and
  // other page updates elsewhere leave it alone (see mayMoveControl).
  const observer = new MutationObserver((records) => {
    if (mayMoveControl(records, control)) attach();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  attach();
  void refresh();
  // A hidden browser tab does not ask; it asks at once when it is shown again.
  const timer = window.setInterval(() => { if (document.visibilityState !== "hidden") void refresh(); }, 5000);
  const onVisible = () => { if (document.visibilityState !== "hidden") void refresh(); };
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    observer.disconnect();
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisible);
    control.remove();
  };
}

const NAVIGATION = '[data-bb-plugin="navigation"]';

function touchesNavigation(node: Node): boolean {
  if (node.nodeType !== 1) return false;
  const element = node as Element;
  return element.closest(NAVIGATION) !== null || element.querySelector(NAVIGATION) !== null;
}

/**
 * Whether these changes can make attach() choose another place: the control
 * left the page or its header changed, or a navigation header (or something
 * inside one) was added or removed. Everything else leaves the first matching
 * header where it was.
 */
export function mayMoveControl(records: readonly MutationRecord[], control: Element): boolean {
  if (!control.isConnected) return true;
  const header = control.previousSibling;
  if (!header || header.nodeType !== 1 || !(header as Element).matches(NAVIGATION)) return true;
  for (const record of records) {
    if (touchesNavigation(record.target)) return true;
    for (const node of record.addedNodes) if (touchesNavigation(node)) return true;
    for (const node of record.removedNodes) if (touchesNavigation(node)) return true;
  }
  return false;
}
