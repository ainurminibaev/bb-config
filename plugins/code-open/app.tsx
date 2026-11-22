import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { definePluginApp, useComposer, experimental_Icon as Icon, experimental_THREAD_ACTION_GROUPS as GROUPS } from '@get-bb/plugin-sdk/app';
import { FORGE_PREFIX, FORGE_SETTINGS_KEY, RESTORE_FLAG, chatOpenKey, forgePath, projectTarget, withoutOverrides,
  type Target } from './target';

/**
 * Opens KodaForge's own page at a workspace. No editor logic lives here: the
 * plugin only builds the deep link, asks for the chat panel, and gets BB's
 * thread list out of the way while the editor is on screen.
 */
let collapsedByUs = false;

function sidebarToggle(expanded: boolean): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(
    `button[aria-label^="Toggle sidebar"][aria-expanded="${expanded}"]`);
}

function openCode(target: Target) {
  try { localStorage.setItem(chatOpenKey(target), '1'); } catch { /* private mode: chat stays one click away */ }
  const path = forgePath(target);
  // BB exposes no cross-plugin navigation, so drive its router through history.
  history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
  setTimeout(() => {
    if (location.pathname !== path) { location.assign(path); return; }
    const toggle = sidebarToggle(true);
    if (toggle && window.matchMedia('(min-width:900px)').matches) { toggle.click(); collapsedByUs = true; }
  }, 350);
}

/** Give the thread list back once the user leaves the editor. */
function useRestoreSidebar() {
  useEffect(() => {
    const timer = setInterval(() => {
      if (!collapsedByUs || location.pathname.startsWith(FORGE_PREFIX)) return;
      collapsedByUs = false;
      sidebarToggle(false)?.click();
    }, 400);
    return () => clearInterval(timer);
  }, []);
}

type Anchor = { key: string; id: string; element: HTMLElement };

/**
 * Only one live copy may own the buttons. BB can load a new copy of the bundle
 * without unmounting the old one (reinstall, reload); the old copy must stand
 * down instead of fighting over the same rows.
 */
const OWNER = '__codeOpenOwner';
type OwnerWindow = Window & { [OWNER]?: object };

function useProjectAnchors() {
  const [anchors, setAnchors] = useState<Anchor[]>([]);
  useEffect(() => {
    const token = {};
    (window as OwnerWindow)[OWNER] = token;
    const mounts = new Map<HTMLElement, Anchor>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      observer.disconnect();
      if (timer) clearTimeout(timer);
      for (const anchor of mounts.values()) anchor.element.remove();
      mounts.clear();
      setAnchors([]);
    };
    const mount = (controls: HTMLElement, id: string) => {
      const existing = mounts.get(controls);
      if (existing?.id === id && existing.element.parentElement === controls) return;
      existing?.element.remove();
      // Leftovers of a copy that never cleaned up.
      for (const stale of controls.querySelectorAll(':scope > [data-code-open]')) stale.remove();
      const element = document.createElement('span');
      element.dataset.codeOpen = 'project';
      controls.prepend(element);
      mounts.set(controls, { key: id, id, element });
    };
    const scan = () => {
      timer = null;
      if ((window as OwnerWindow)[OWNER] !== token) { stop(); return; }
      const seen = new Set<HTMLElement>();
      for (const group of document.querySelectorAll<HTMLElement>('[data-sidebar-project-id]')) {
        const controls = group.querySelector<HTMLElement>('[data-sidebar="group-label"] [data-sidebar-row-controls]');
        const id = group.dataset.sidebarProjectId;
        if (!controls || !id || seen.has(controls)) continue;
        seen.add(controls); mount(controls, id);
      }
      for (const [controls, anchor] of mounts) {
        if (seen.has(controls) && anchor.element.parentElement === controls) continue;
        anchor.element.remove(); mounts.delete(controls);
      }
      setAnchors(previous => {
        const next = [...mounts.values()];
        return next.length === previous.length && next.every((a, i) => a === previous[i]) ? previous : next;
      });
    };
    // Trailing throttle: chat streaming and the editor mutate the page many
    // times a second, and none of that needs a rescan per frame.
    const schedule = () => { if (!timer && !stopped) timer = setTimeout(scan, 200); };
    const observer = new MutationObserver(records => {
      for (const record of records) {
        const node = record.target instanceof Element ? record.target : record.target.parentElement;
        if (node && !node.closest('.monaco-editor, [data-code-open], [data-kodaforge-terminal], .xterm')) { schedule(); return; }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true,
      attributeFilter: ['data-sidebar-project-id'] });
    scan();
    return stop;
  }, []);
  return anchors;
}

const CSS = `
[data-code-open] { display:inline-flex; align-items:center; flex:0 0 auto; }
.code-open-button { display:inline-flex; align-items:center; justify-content:center; width:24px; height:24px; border:0; border-radius:6px; background:transparent; color:var(--muted-foreground); cursor:pointer; }
.code-open-button:hover { background:var(--state-hover); color:var(--foreground); }
.code-open-button:focus-visible { outline:2px solid var(--ring); outline-offset:-2px; }
[data-code-open="header"] .code-open-button { width:28px; height:28px; }
`;

function ProjectCodeButton({ id }: { id: string }) {
  const label = 'Открыть код проекта';
  return <button type="button" className="code-open-button" title={label} aria-label={label}
    onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
    onClick={event => {
      event.stopPropagation(); event.preventDefault();
      openCode(projectTarget(id));
    }}><Icon name="Code" className="size-4" /></button>;
}

/** Project headers have no BB slot, so this is the one place still injected. */
function ProjectButtons() {
  const anchors = useProjectAnchors();
  useRestoreSidebar();
  return <><style>{CSS}</style>{anchors.map(anchor =>
    createPortal(<ProjectCodeButton id={anchor.id} />, anchor.element, anchor.key))}</>;
}

/**
 * The open thread's header keeps an always-visible icon. BB's own header
 * placement folds into the thread menu in narrow panes, which hides the one
 * button this plugin exists for. The observer is scoped to the thread's pane
 * and throttled, so chat streaming does not rescan per frame.
 */
function HeaderBridge() {
  const marker = useRef<HTMLSpanElement>(null);
  const [element, setElement] = useState<HTMLElement | null>(null);
  const scope = useComposer().scope;
  const threadId = scope.kind === 'thread' ? scope.threadId : null;
  useEffect(() => {
    if (!threadId) return;
    const root = marker.current?.closest<HTMLElement>('[data-split-pane-id]');
    if (!root) return;
    let mounted: HTMLElement | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const scan = () => {
      timer = null;
      if (mounted?.isConnected) return;
      const container = root.querySelector<HTMLElement>('[data-thread-header-pane-actions]');
      if (!container?.parentElement) return;
      for (const stale of container.parentElement.querySelectorAll(':scope > [data-code-open]')) stale.remove();
      mounted = document.createElement('span'); mounted.dataset.codeOpen = 'header';
      container.parentElement.prepend(mounted); setElement(mounted);
    };
    const observer = new MutationObserver(() => { if (!timer && !mounted?.isConnected) timer = setTimeout(scan, 200); });
    observer.observe(root, { childList: true, subtree: true }); scan();
    return () => { observer.disconnect(); if (timer) clearTimeout(timer); mounted?.remove(); setElement(null); };
  }, [threadId]);
  const label = 'Открыть код этого треда';
  return <><span ref={marker} hidden />{element && threadId ? createPortal(
    <button type="button" className="code-open-button" title={label} aria-label={label}
      onClick={() => openCode({ kind: 'thread', id: threadId })}><Icon name="Code" className="size-4" /></button>, element) : null}</>;
}

/** Once per browser: give KodaForge back the editor settings 0.3.x overrode. */
function restoreEditorSettings() {
  try {
    if (localStorage.getItem(RESTORE_FLAG)) return;
    const next = withoutOverrides(localStorage.getItem(FORGE_SETTINGS_KEY));
    if (next === null) localStorage.removeItem(FORGE_SETTINGS_KEY); else localStorage.setItem(FORGE_SETTINGS_KEY, next);
    localStorage.setItem(RESTORE_FLAG, '1');
  } catch { /* storage unavailable: nothing was overridden either */ }
}

export default definePluginApp(app => {
  restoreEditorSettings();
  app.slots.experimental_appOverlay({ id: 'code-open', component: ProjectButtons });
  app.composer.customize({ id: 'code-open-header', scopes: ['thread'],
    banners: [{ id: 'code-open-header', chrome: 'bare', component: HeaderBridge }] });
  // The row button is BB's own thread action: BB renders it in the row's quick
  // actions and in the thread menus. No DOM work, no observer.
  app.slots.experimental_threadAction({
    id: 'open-code-menu', title: 'Открыть код', icon: 'Code', group: GROUPS.open, order: 5,
    item: ({ thread }) => thread.environment
      ? { label: 'Открыть код', icon: 'Code', run: () => openCode({ kind: 'thread', id: thread.id }) } : null,
  });
});
