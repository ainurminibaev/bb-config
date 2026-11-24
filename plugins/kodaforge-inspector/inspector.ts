/** The KodaForge workspace to go to instead of this BB thread page, or null to stay. */
export function autoOpenWorkspace(
  route: string,
  autoOpen: unknown,
  selectedThread: unknown,
): string | null {
  if (autoOpen !== true || typeof selectedThread !== "string") return null;
  // Only the plain thread page: a link to a message or a file keeps opening as usual.
  const match = /^\/projects\/[^/?#]+\/threads\/(thr_[A-Za-z0-9_-]+)\/?$/.exec(route);
  if (!match || match[1] !== selectedThread.trim()) return null;
  return "/plugins/kodaforge/forge/thread/" + match[1];
}

/** The workspace route names the thread displayed by this editor. */
export function threadInWorkspace(pathname: string): string | null {
  return (
    /^\/plugins\/kodaforge\/forge\/thread\/(thr_[A-Za-z0-9_-]+)\/?$/.exec(
      pathname,
    )?.[1] ?? null
  );
}
/** ask: nothing chosen yet, the native layout stays until the user picks one. */
export const LAYOUTS = ["ask", "native", "center"] as const;
export type Layout = (typeof LAYOUTS)[number];
/** An unknown stored value never switches the layout on its own. */
export function layoutOf(value: unknown): Layout {
  return (LAYOUTS as readonly unknown[]).includes(value) ? (value as Layout) : "ask";
}
/** A project's own choice wins; otherwise the choice saved for all; otherwise ask. */
export function effectiveLayout(project: unknown, everywhere: unknown): Layout {
  const own = layoutOf(project);
  return own === "ask" ? layoutOf(everywhere) : own;
}
export const UPSTREAM =
  "git:https://github.com/Kodaks94/bb-plugin-kodaforge.git@semver:>=0.7.0 <1.0.0";
/** The owner's fork (plugins/kodaforge-compat/fork.json) gets the author's releases too. */
export const FORK =
  "git:https://github.com/ainurminibaev/bb-plugin-kodaforge.git@semver:own/:>=0.7.100 <1.0.0";
export function followsReleases(requested: unknown): boolean {
  return requested === UPSTREAM || requested === FORK;
}
/** Part of the editor: inside it, or its tabs and switches in BB's title bar (compactHeader). */
export function belongsTo(root: Element, target: Element): boolean {
  return root.contains(target) || target.closest("[data-kodaforge-header]") !== null;
}
/** KodaForge's slot in the title bar; null when there is none or it is not clear which one. */
export function headerSlot(doc: Document, visible: (element: HTMLElement) => boolean): HTMLElement | null {
  const slots = [...doc.querySelectorAll<HTMLElement>("[data-kodaforge-header]")].filter(visible);
  return slots.length === 1 ? slots[0]! : null;
}
export type Inspection = {
  state: "waiting" | "compatible" | "incompatible";
  reason: string;
  root?: HTMLElement;
  editors?: HTMLElement;
  original?: HTMLElement;
};
export function inspect(
  doc: Document,
  visible: (element: HTMLElement) => boolean,
): Inspection {
  const roots = [...doc.querySelectorAll<HTMLElement>(".kf-root")].filter(
    visible,
  );
  if (!roots.length)
    return { state: "waiting", reason: "Ожидаю загрузку KodaForge" };
  if (roots.length !== 1)
    return {
      state: "incompatible",
      reason: "Не удалось однозначно определить рабочую область",
    };
  const root = roots[0]!;
  const editors = root.querySelector<HTMLElement>('[data-panel][id="editors"]');
  const main = root.querySelector('[data-panel][id="main"]');
  const nativeChildren = editors?.querySelectorAll<HTMLElement>(
    ":scope > :not([data-kfi-owned])",
  );
  const original = nativeChildren?.length === 1 ? nativeChildren[0] : undefined;
  if (
    !editors ||
    !main?.contains(editors) ||
    !original ||
    !root.querySelector('nav[aria-label="Views"]') ||
    !root.querySelector('footer button[title="Switch branch"]') ||
    !root.querySelector('footer button[title="Toggle Terminal (⌃`)"]')
  ) {
    return {
      state: "incompatible",
      reason: "Структура KodaForge изменилась. Оставлен штатный интерфейс.",
    };
  }
  return {
    state: "compatible",
    reason: "Чат по центру; штатные файлы, Git и терминал",
    root,
    editors,
    original,
  };
}
export function attachLayout(editors: HTMLElement, original: HTMLElement) {
  const doc = editors.ownerDocument;
  const toolbar = doc.createElement("div");
  toolbar.setAttribute("data-kfi-owned", "toolbar");
  const chat = doc.createElement("div");
  chat.setAttribute("data-kfi-owned", "chat");
  const wasInert = original.inert;
  editors.setAttribute("data-kfi-layout", "chat");
  editors.prepend(toolbar);
  editors.append(chat);
  function mode(value: "chat" | "code") {
    editors.setAttribute("data-kfi-layout", value);
    original.inert = value === "chat" || wasInert;
  }
  mode("chat");
  return {
    original,
    toolbar,
    chat,
    mode,
    dispose() {
      toolbar.remove();
      chat.remove();
      editors.removeAttribute("data-kfi-layout");
      original.inert = wasInert;
    },
  };
}
export const CSS = `
[data-panel][id="main"]:has([data-kfi-layout="chat"]) ~ [data-panel][id="side"],
[data-panel][id="main"]:has([data-kfi-layout="chat"]) + [role="separator"]:has(+ [data-panel][id="side"]) { display:none !important; }
[data-kfi-layout] { position:relative !important; flex-direction:column !important; min-height:0; }
[data-kfi-layout] > :not([data-kfi-owned]) { flex:1; min-height:0; width:100%; }
[data-kfi-layout="chat"] > :not([data-kfi-owned]) { visibility:hidden; pointer-events:none; }
[data-kfi-owned="toolbar"] { flex:0 0 36px; height:36px; z-index:8; background:var(--background); border-bottom:1px solid var(--border); }
[data-kfi-owned="chat"] { position:absolute; inset:36px 0 0; z-index:7; background:var(--background); display:flex; min-height:0; }
[data-kfi-layout="code"] > [data-kfi-owned="chat"] { display:none; }
.kfi-toolbar { display:flex; align-items:center; height:36px; gap:6px; padding:0 10px; font-size:12px; color:var(--foreground); }
.kfi-toolbar button { padding:4px 9px; border-radius:4px; cursor:pointer; }
.kfi-toolbar button[aria-pressed="true"] { background:var(--muted); font-weight:600; }
.kfi-toolbar small { margin-left:auto; color:var(--muted-foreground); white-space:nowrap; }
.kfi-toolbar .kfi-view { margin-left:auto; color:var(--muted-foreground); }
.kfi-toolbar .kfi-view + small { margin-left:0; }
.kfi-backdrop { position:fixed; inset:0; z-index:1000; display:flex; align-items:center; justify-content:center; padding:16px; background:#0006; }
.kfi-chooser { width:min(680px,100%); max-height:100%; overflow:auto; background:var(--background); color:var(--foreground); border:1px solid var(--border); border-radius:12px; padding:20px; box-shadow:0 12px 40px #0004; font-size:13px; }
.kfi-chooser h2 { font-size:16px; font-weight:600; margin:0 0 4px; }
.kfi-chooser p { margin:0; color:var(--muted-foreground); }
.kfi-options { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:12px; margin:16px 0; }
.kfi-option { display:flex; flex-direction:column; gap:8px; padding:10px; text-align:left; border:1px solid var(--border); border-radius:10px; background:transparent; color:inherit; cursor:pointer; }
.kfi-option:hover { background:var(--muted); }
.kfi-option[aria-checked="true"] { border-color:var(--ring); box-shadow:0 0 0 1px var(--ring); }
.kfi-option:focus-visible { outline:2px solid var(--ring); outline-offset:2px; }
.kfi-option svg { width:100%; height:auto; border-radius:6px; border:1px solid var(--border); color:var(--foreground); }
.kfi-option b { font-weight:600; }
.kfi-option span { color:var(--muted-foreground); font-size:12px; line-height:1.4; }
.kfi-actions { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:8px; }
.kfi-actions button:first-child { margin-right:auto; }
.kfi-actions button { padding:6px 12px; border-radius:6px; border:1px solid var(--border); background:transparent; color:inherit; cursor:pointer; }
.kfi-actions button.kfi-primary { background:var(--foreground); color:var(--background); border-color:var(--foreground); }
.kfi-warning { position:fixed; bottom:40px; right:20px; max-width:420px; z-index:999; background:var(--background); color:var(--foreground); border:1px solid var(--border); border-radius:8px; padding:12px; box-shadow:0 4px 20px #0002; font-size:13px; }
`;
