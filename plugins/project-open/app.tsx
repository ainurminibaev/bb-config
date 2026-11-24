import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { definePluginApp, useSdk, useBbNavigate, useSettings, useComposer, experimental_useSidebarThreads,
  experimental_Icon as Icon, experimental_THREAD_ACTION_GROUPS as GROUPS } from '@get-bb/plugin-sdk/app';
import { toast } from 'sonner';
import * as Tooltip from '@radix-ui/react-tooltip';
import { openNativeTerminal, openNativeWorkspace, openNativeFiles, waitFor } from './native';
import { finderFolderUrl, folderClientMode } from './folder-target';
import { addFinderItem, EXPLORER_MENU_EVENT } from './explorer-menu';

type Anchor = { threadId: string; element: HTMLElement };
function useThreadAnchors(enabled: boolean) {
  const [anchors, setAnchors] = useState<Anchor[]>([]);
  useEffect(() => {
    if (!enabled) { setAnchors([]); return; }
    const mounts = new Map<HTMLElement, Anchor>();
    let frame = 0;
    const scan = () => {
      frame = 0;
      const desktop = window.matchMedia('(hover:hover) and (pointer:fine)').matches;
      const rows = new Set(desktop ? document.querySelectorAll<HTMLElement>('a[data-sidebar-thread-id]') : []);
      for (const [row, anchor] of mounts) {
        if (!rows.has(row) || !anchor.element.isConnected || row.dataset.sidebarThreadId !== anchor.threadId) {
          row.closest<HTMLElement>('[data-sidebar-rename-row]')?.style.removeProperty('--project-open-toolbar-inset');
          resizeObserver.unobserve(anchor.element.closest('[data-sidebar-row-controls]') ?? anchor.element);
          resizeObserver.unobserve(anchor.element.closest('[data-sidebar-thread-trailing]') ?? anchor.element);
          anchor.element.remove(); mounts.delete(row);
        }
      }
      for (const row of rows) {
        if (mounts.has(row)) continue;
        const trailing = row.closest('[data-sidebar-rename-row]')?.querySelector<HTMLElement>('[data-sidebar-thread-trailing]');
        if (!trailing) continue;
        const element = document.createElement('span');
        element.dataset.projectOpenControls = '';
        const controls = trailing.querySelector<HTMLElement>('[data-sidebar-row-controls]');
        if (!controls) continue;
        controls.prepend(element);
        resizeObserver.observe(controls);
        resizeObserver.observe(trailing);
        mounts.set(row, { threadId: row.dataset.sidebarThreadId!, element });
      }
      // Reserve the toolbar's overflow in layout, so native project links and
      // child expanders stay after the title instead of translating over it.
      for (const [link, anchor] of mounts) {
        const row = link.closest<HTMLElement>('[data-sidebar-rename-row]');
        const toolbar = anchor.element.closest<HTMLElement>('[data-sidebar-row-controls]');
        const trailing = toolbar?.closest<HTMLElement>('[data-sidebar-thread-trailing]');
        if (!row || !toolbar || !trailing) continue;
        const inset = Math.max(0, toolbar.getBoundingClientRect().width - trailing.getBoundingClientRect().width + 2);
        row.style.setProperty('--project-open-toolbar-inset', `${inset}px`);
      }
      setAnchors(previous => {
        const next = [...mounts.values()];
        return next.length === previous.length && next.every((a, i) => a === previous[i]) ? previous : next;
      });
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(scan); };
    const resizeObserver = new ResizeObserver(schedule);
    const pointer = window.matchMedia('(hover:hover) and (pointer:fine)');
    pointer.addEventListener('change', schedule);
    window.addEventListener('resize', schedule);
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true,
      attributeFilter: ['data-sidebar-thread-id'] });
    scan();
    return () => {
      observer.disconnect(); resizeObserver.disconnect(); cancelAnimationFrame(frame);
      pointer.removeEventListener('change', schedule);
      window.removeEventListener('resize', schedule);
      for (const [link, a] of mounts) {
        link.closest<HTMLElement>('[data-sidebar-rename-row]')?.style.removeProperty('--project-open-toolbar-inset');
        a.element.remove();
      }
    };
  }, [enabled]);
  return anchors;
}
const CSS = `
[data-project-open-controls], [data-project-open-header] { position:relative; z-index:31; display:inline-flex; flex:0 0 56px; align-items:center; width:56px; overflow:visible; opacity:0; pointer-events:none; transition:opacity 100ms ease; }
@media (hover:hover) {
[data-sidebar-rename-row]:has(> [data-sidebar-thread-trailing] [data-project-open-controls]) { column-gap:0; }
[data-sidebar-rename-row]:has(> [data-sidebar-thread-trailing] [data-project-open-controls]) > span:has(> a[data-sidebar-thread-id]) { padding-right:0; }
[data-sidebar-thread-trailing]:has([data-project-open-controls]) > span > span { width:20px; }
[data-sidebar-row-controls]:has(> [data-project-open-controls]) { gap:0; background:var(--sidebar-accent); box-shadow:-6px 0 6px var(--sidebar-accent); }
[data-sidebar-row-controls]:has(> [data-project-open-controls]) > button { width:20px; height:24px; }
}
[data-project-open-controls] { position:relative; width:40px; flex-basis:40px; }
[data-project-open-controls] .project-open-button { width:20px; height:24px; flex-basis:20px; }
@media (hover:hover) and (pointer:fine) {
[data-sidebar-rename-row]:has(> [data-sidebar-thread-trailing] [data-project-open-controls]):is(:hover, :has(:focus-visible), :has([data-sidebar-hover-actions-open="true"])) > span:has(> a[data-sidebar-thread-id]) { padding-right:var(--project-open-toolbar-inset, 0px); }
}
[data-project-open-header] { opacity:1; pointer-events:auto; }
[data-sidebar-rename-row]:hover > [data-sidebar-thread-trailing] [data-sidebar-row-controls] > [data-project-open-controls],
[data-sidebar-rename-row]:has(:focus-visible) > [data-sidebar-thread-trailing] [data-sidebar-row-controls] > [data-project-open-controls],
[data-sidebar-rename-row]:has([data-sidebar-hover-actions-open="true"]) > [data-sidebar-thread-trailing] [data-sidebar-row-controls] > [data-project-open-controls],
[data-testid="app-page-header-content-row"]:hover [data-project-open-header],
[data-testid="app-page-header-content-row"]:focus-within [data-project-open-header] { opacity:1; pointer-events:auto; }
.project-open-button { display:inline-flex; flex:0 0 28px; align-items:center; justify-content:center; width:28px; height:28px; border-radius:6px; color:var(--muted-foreground); background:transparent; border:0; cursor:pointer; }
.project-open-button:hover { background:var(--state-hover); color:var(--foreground); }
.project-open-button:focus-visible { outline:2px solid var(--ring); outline-offset:-2px; }
.project-open-button:disabled { opacity:.4; cursor:wait; }
.project-open-tooltip { z-index:10000; max-width:min(460px, calc(100vw - 16px)); padding:10px 12px; border-radius:8px; background:var(--foreground); color:var(--background); box-shadow:0 4px 12px #0002; font-size:12px; line-height:1.4; pointer-events:none; }
.project-open-tooltip-action { font-weight:600; margin-bottom:7px; }
.project-open-tooltip-row { display:flex; align-items:flex-start; gap:7px; }
.project-open-tooltip-row + .project-open-tooltip-row { margin-top:5px; }
.project-open-tooltip-row > svg { width:14px; height:14px; flex-shrink:0; margin-top:1px; opacity:.8; }
.project-open-tooltip-host { font-weight:500; }
.project-open-tooltip-path { min-width:0; font-family:var(--font-mono, monospace); white-space:pre-wrap; overflow-wrap:anywhere; }
@media (hover:none) { [data-project-open-controls], [data-project-open-header] { flex-basis:64px; width:64px; opacity:1; pointer-events:auto; } .project-open-button { flex-basis:32px; width:32px; height:36px; } }
@media (hover:none), (pointer:coarse) { [data-project-open-controls], [data-project-open-controls] * { display:none !important; pointer-events:none !important; } }
@media (pointer:coarse) {
[data-sidebar-rename-row] button[aria-expanded][aria-label$=" threads"] { width:36px; height:36px; flex:0 0 36px; touch-action:manipulation; }
}
@media (prefers-reduced-motion:reduce) { [data-project-open-controls], [data-project-open-header] { transition:none; } }
`;

type HeaderAnchor = { element: HTMLElement; root: HTMLElement };
function HeaderBridge() {
  const marker = useRef<HTMLSpanElement>(null);
  const [anchor, setAnchor] = useState<HeaderAnchor | null>(null);
  const scope = useComposer().scope;
  const threadId = scope.kind === 'thread' ? scope.threadId : null;
  useEffect(() => {
    if (!threadId) return;
    const root = marker.current?.closest<HTMLElement>('[data-split-pane-id]');
    if (!root) return;
    let element: HTMLElement | null = null;
    let frame = 0;
    const scan = () => {
      frame = 0;
      if (element?.isConnected) return;
      const container = root.querySelector<HTMLElement>('[data-thread-header-pane-actions]');
      if (!container?.parentElement) return;
      element = document.createElement('span'); element.dataset.projectOpenHeader = '';
      element.dataset.projectOpenThreadId = threadId;
      container.parentElement.prepend(element); setAnchor({ element, root });
    };
    const observer = new MutationObserver(() => { if (!frame) frame = requestAnimationFrame(scan); });
    observer.observe(root, { childList: true, subtree: true }); scan();
    return () => { observer.disconnect(); cancelAnimationFrame(frame); element?.remove(); };
  }, [threadId]);
  return <><span ref={marker} data-project-open-bridge="" hidden />{anchor && threadId ? createPortal(<ThreadButtons root={anchor.root} threadId={threadId} />, anchor.element) : null}</>;
}

const clientMode = (finderHelper: boolean) => folderClientMode({ userAgent: navigator.userAgent, platform: navigator.platform, maxTouchPoints: navigator.maxTouchPoints,
  compactTouch: window.matchMedia('(max-width:640px) and (pointer:coarse)').matches }, finderHelper);

/** Puts «Открыть в Finder» into KodaForge's Explorer menu, when that plugin offers its menu. */
function ExplorerMenu() {
  const { values } = useSettings();
  const navigate = useBbNavigate();
  const finderHelper = values?.finderHelper === true;
  useEffect(() => {
    if (!finderHelper) return;
    const listen = (event: Event) => addFinderItem(event, clientMode(finderHelper), url => navigate.openUrl(url));
    window.addEventListener(EXPLORER_MENU_EVENT, listen);
    return () => window.removeEventListener(EXPLORER_MENU_EVENT, listen);
  }, [finderHelper, navigate]);
  return null;
}

async function openThreadTarget(
  kind: 'folder' | 'terminal', threadId: string, sdk: ReturnType<typeof useSdk>,
  navigate: ReturnType<typeof useBbNavigate>, values: ReturnType<typeof useSettings>['values'],
  signal: AbortSignal, root?: HTMLElement,
) {
  const getRoot = async () => {
    if (root) return root;
    navigate.toThread(threadId);
    return waitFor(document.body, () => {
      const marker = [...document.querySelectorAll<HTMLElement>('[data-project-open-thread-id]')]
        .find(element => element.dataset.projectOpenThreadId === threadId);
      return marker?.closest<HTMLElement>('[data-split-pane-id]') ?? null;
    }, signal);
  };
  if (kind === 'terminal') return openNativeTerminal(await getRoot(), signal);
  const thread = await sdk.threads.get({ threadId, signal });
  if (!thread.environmentId) throw new Error('У треда нет рабочей папки.');
  const environment = await sdk.environments.get({ environmentId: thread.environmentId, signal });
  if (!environment.path) throw new Error('У треда нет рабочей папки.');
  if (!values) throw new Error('Настройки открытия папки ещё загружаются.');
  const mode = clientMode(values.finderHelper === true);
  if (mode === 'files') return openNativeFiles(await getRoot(), signal);
  if (mode === 'finder') {
    const url = finderFolderUrl(environment.hostId, environment.path);
    if (!navigate.openUrl(url)) throw new Error('На этом устройстве недоступен обработчик Finder.');
    return;
  }
  return openNativeWorkspace(await getRoot(), signal);
}

function ThreadButtons({ root, threadId }: { root?: HTMLElement; threadId: string }) {
  const sdk = useSdk(), navigate = useBbNavigate();
  const { values } = useSettings();
  const { threads } = experimental_useSidebarThreads();
  const sidebarThread = threads.find(thread => thread.id === threadId);
  const [tooltipOpen, setTooltipOpen] = useState<string | null>(null);
  const tooltipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTooltip = () => {
    if (tooltipTimer.current) clearTimeout(tooltipTimer.current);
    tooltipTimer.current = null;
    setTooltipOpen(null);
  };
  useEffect(() => () => { if (tooltipTimer.current) clearTimeout(tooltipTimer.current); }, []);
  const [destination, setDestination] = useState<{ threadId: string; hostName: string; path: string; error?: string } | null>(null);
  useEffect(() => {
    if (!tooltipOpen) return;
    const controller = new AbortController();
    setDestination(null);
    void (async () => {
      const thread = await sdk.threads.get({ threadId, signal: controller.signal });
      if (!thread.environmentId) throw new Error('У треда нет рабочей папки.');
      const environment = await sdk.environments.get({ environmentId: thread.environmentId, signal: controller.signal });
      if (!environment.path) throw new Error('У треда нет рабочей папки.');
      const host = await sdk.hosts.get({ hostId: environment.hostId, signal: controller.signal });
      if (!controller.signal.aborted) setDestination({ threadId, hostName: host.name, path: environment.path });
    })().catch(error => {
      if (!controller.signal.aborted) setDestination({ threadId, hostName: '', path: '', error: error instanceof Error ? error.message : String(error) });
    });
    return () => controller.abort();
  }, [sdk, threadId, tooltipOpen]);
  const currentDestination = destination?.threadId === threadId ? destination : null;
  const hostName = currentDestination?.hostName || sidebarThread?.host?.name;
  const path = currentDestination?.path || sidebarThread?.environment?.path;
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  return <Tooltip.Provider delayDuration={100} skipDelayDuration={300}>{(['folder', 'terminal'] as const).map(kind => <Tooltip.Root key={kind}
    open={tooltipOpen === kind} onOpenChange={open => { if (!open) hideTooltip(); }}>
    <Tooltip.Trigger asChild><button type="button"
    className="project-open-button" disabled={busy || !values}
    aria-label={kind === 'folder' ? 'Открыть папку треда' : 'Открыть терминал треда в BB'}
    onPointerEnter={() => { hideTooltip(); tooltipTimer.current = setTimeout(() => setTooltipOpen(kind), 100); }}
    onPointerLeave={hideTooltip} onFocus={() => { hideTooltip(); setTooltipOpen(kind); }} onBlur={hideTooltip}
    onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
    onClick={event => {
      event.stopPropagation(); event.preventDefault();
      hideTooltip();
      if (pending.current) return;
      const controller = new AbortController(); pending.current = controller; setBusy(true);
      void openThreadTarget(kind, threadId, sdk, navigate, values, controller.signal, root)
        .catch(error => { if (!controller.signal.aborted) toast.error(error instanceof Error ? error.message : String(error)); })
        .finally(() => { if (!controller.signal.aborted) { pending.current = null; setBusy(false); } });
    }}><Icon name={kind === 'folder' ? 'FolderOpen' : 'Terminal'} className="size-4" /></button></Tooltip.Trigger>
    <Tooltip.Portal><Tooltip.Content className="project-open-tooltip" side="bottom" sideOffset={6} collisionPadding={8}>
      <div className="project-open-tooltip-action">{kind === 'folder' ? 'Открыть папку' : 'Открыть терминал в BB'}</div>
      {currentDestination?.error ? <div>{currentDestination.error}</div> : <>
        <div className="project-open-tooltip-row"><Icon name="Laptop" aria-hidden="true" /><span className="project-open-tooltip-host">{hostName || 'Уточняю машину…'}</span></div>
        <div className="project-open-tooltip-row"><Icon name="Folder" aria-hidden="true" /><code className="project-open-tooltip-path">{path || 'Уточняю путь…'}</code></div>
      </>}
    </Tooltip.Content></Tooltip.Portal>
  </Tooltip.Root>)}</Tooltip.Provider>;
}

/** Where the folder and terminal shortcuts live: on the row (default) or in the thread's native menu. */
const inMenu = (values: ReturnType<typeof useSettings>['values']) => values?.placement === 'menu';

function ProjectControls() {
  const { values } = useSettings();
  // Until settings load nothing is mounted, so a "menu" choice never flashes row buttons.
  const anchors = useThreadAnchors(values !== undefined && !inMenu(values));
  return <><style>{CSS}</style>{anchors.map(anchor => createPortal(<ThreadButtons threadId={anchor.threadId} />, anchor.element))}</>;
}

export default definePluginApp(app => {
  for (const [kind, title, icon, order] of [
    ['folder', 'Открыть папку треда', 'FolderOpen', 10],
    ['terminal', 'Открыть терминал треда в BB', 'Terminal', 20],
  ] as const) {
    app.slots.experimental_threadAction({
      id: 'open-' + kind, title, icon, group: GROUPS.open, order,
      useData: () => useSettings().values,
      item: ({ thread, sdk, navigate, data }) => thread.environment && inMenu(data) ? {
        label: title, icon,
        run: () => openThreadTarget(kind, thread.id, sdk, navigate, data, new AbortController().signal)
          .catch(error => { toast.error(error instanceof Error ? error.message : String(error)); }),
      } : null,
    });
  }
  app.slots.experimental_appOverlay({ id: 'project-controls', component: ProjectControls });
  app.slots.experimental_appOverlay({ id: 'explorer-menu', component: ExplorerMenu });
  app.composer.customize({ id: 'header-bridge', scopes: ['thread'], banners: [{ id: 'header-bridge', chrome: 'bare', component: HeaderBridge }] });
});
