import { useEffect, useRef, useState } from 'react';
import { definePluginApp, useComposer, useRpc, experimental_Icon as Icon, type PluginFileOpenerProps } from '@get-bb/plugin-sdk/app';
import { toast } from 'sonner';
import type { rpcContract } from './contract';

type DesktopApp = { id: string; name: string; path: string; isDefault: boolean; browser: boolean; icon: string };
type Bridge = {
  open: (path: string, action: 'open' | 'save' | 'clipboard', app?: string | null) => Promise<void>;
  apps: (extension: string) => Promise<DesktopApp[]>;
};
const bridges = new Map<string, Bridge>();
/** The last application chosen for a file type, so the main button opens there next time. */
const remembered = {
  key: (ext: string) => `file-local-open:app:${ext}`,
  get(ext: string): { path: string; name: string } | null {
    try { const v = JSON.parse(localStorage.getItem(this.key(ext)) ?? 'null'); return v && typeof v.path === 'string' && typeof v.name === 'string' ? v : null; } catch { return null; }
  },
  set(ext: string, app: { path: string; name: string } | null) {
    try { if (app) localStorage.setItem(this.key(ext), JSON.stringify(app)); else localStorage.removeItem(this.key(ext)); } catch { /* private mode */ }
  },
};
const appLists = new Map<string, Promise<DesktopApp[]>>();
function ThreadBridge() {
  const scope = useComposer().scope;
  const rpc = useRpc<typeof rpcContract>();
  const threadId = scope.kind === 'thread' ? scope.threadId : null;
  useEffect(() => {
    if (!threadId) return;
    const bridge: Bridge = {
      open: async (path, action, app) => {
        const result = await rpc.call('open', { path, action, app: app ?? null, source: { kind: 'host', threadId, environmentId: null, projectId: null } });
        toast.success(action === 'save' ? 'Сохранено в Загрузки' : action === 'clipboard' ? 'Файл скопирован — вставьте его в Telegram, почту или Finder' : `Открыто: ${result.application}`, { description: result.path });
      },
      apps: extension => {
        let list = appLists.get(extension);
        if (!list) {
          list = rpc.call('apps', { extension }).then(r => r.apps);
          list.catch(() => appLists.delete(extension));
          appLists.set(extension, list);
          setTimeout(() => appLists.delete(extension), 10 * 60 * 1000);
        }
        return list;
      },
    };
    bridges.set(threadId, bridge);
    return () => { if (bridges.get(threadId) === bridge) bridges.delete(threadId); };
  }, [rpc, threadId]);
  return <span hidden data-file-local-thread={threadId ?? undefined} />;
}
export function localPath(href: string): string | null {
  try {
    const url = new URL(href);
    if (url.protocol !== 'file:' || url.hostname) return null;
    // file:///C:/dir/file is the Windows path C:/dir/file, not /C:/dir/file.
    const path = decodeURIComponent(url.pathname).replace(/^\/(?=[a-z]:\/)/i, '');
    return /\.(pdf|html?|md|txt|csv|json|png|jpe?g|gif|webp|svg|docx?|xlsx?|pptx?|odt|ods|odp|rtf|mp3|mp4|wav|m4a|mov|zip)$/i.test(path) ? path : null;
  } catch { return null; }
}
function fileUrl(path: string, source: PluginFileOpenerProps['source']) {
  const encoded = path.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
  if (source.kind === 'workspace') {
    if (source.environmentId) return `/api/v1/environments/${encodeURIComponent(source.environmentId)}/files/${encoded}`;
    if (source.projectId) return `/api/v1/projects/${encodeURIComponent(source.projectId)}${source.experimental_hostId ? `/hosts/${encodeURIComponent(source.experimental_hostId)}` : ''}/files/${encoded}`;
  }
  if (source.threadId) return `/api/v1/threads/${encodeURIComponent(source.threadId)}/${source.kind === 'thread-storage' ? 'thread-storage/files' : 'host-files'}/${encoded}`;
  return null;
}
function PdfPreview({ path, source, Original }: PluginFileOpenerProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [zoom, setZoom] = useState('page-width');
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const url = fileUrl(path, source);
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController(); let objectUrl: string | null = null;
    setBlobUrl(null); setError('');
    void fetch(url, { credentials: 'same-origin', signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error(`Не удалось загрузить PDF (${response.status}).`);
      if (response.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/pdf') throw new Error('Сервер вернул файл другого типа.');
      const blob = await response.blob();
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob); setBlobUrl(objectUrl);
    }).catch(e => { if (!controller.signal.aborted) setError(String(e.message ?? e)); });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [url, attempt]);
  if (!url) return <Original />;
  return <div className="flex h-full min-h-0 flex-col">
    <div className="flex flex-wrap items-center gap-2 border-b p-2 text-sm">
      <button className="inline-flex items-center gap-1 rounded border px-3 py-1 hover:bg-state-hover disabled:opacity-50" disabled={busy} onClick={() => {
        setBusy(true);
        void rpc.call('open', { path, source, action: 'open' }).then(result => { if (active.current) toast.success(`Открыто: ${result.application}`, { description: result.path }); })
          .catch(e => { if (active.current) toast.error(String(e.message ?? e)); }).finally(() => { if (active.current) setBusy(false); });
      }}><Icon name="ExternalLink" className="size-4" />{busy ? 'Открываю…' : 'Открыть на компьютере'}</button>
      <button className="rounded border px-3 py-1 hover:bg-state-hover disabled:opacity-50" disabled={busy} onClick={() => {
        setBusy(true);
        void rpc.call('open', { path, source, action: 'save' }).then(result => { if (active.current) toast.success('Сохранено в Загрузки', { description: result.path }); })
          .catch(e => { if (active.current) toast.error(String(e.message ?? e)); }).finally(() => { if (active.current) setBusy(false); });
      }}>↓ В Загрузки</button>
      <select aria-label="Масштаб PDF" className="rounded border bg-background px-2 py-1" value={zoom} onChange={event => setZoom(event.target.value)}>
        <option value="page-width">По ширине</option><option value="100">100%</option><option value="150">150%</option><option value="200">200%</option>
      </select>
    </div>
    {error ? <div role="alert" className="p-4">{error}<button className="ml-2 underline" onClick={() => setAttempt(n => n + 1)}>Повторить</button></div>
      : blobUrl ? <iframe title={path} className="min-h-0 w-full flex-1 border-0" src={`${blobUrl}#pagemode=none&navpanes=0&zoom=${zoom}`} /> : <p className="p-4">Загружаю PDF…</p>}
  </div>;
}
function glyph(d: string, size: number) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({ width: String(size), height: String(size), viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(key, value);
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d); svg.append(path);
  return svg;
}
const ICONS = {
  // Share-style box with an arrow out: "send this file somewhere".
  more: 'M12 3v12M8 7l4-4 4 4M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7',
  open: 'M4 4h16v12H4zM2 20h20',
  save: 'M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4',
  share: 'M8 12l8-5M8 12l8 5M6 12a2 2 0 1 0 0 .01M18 7a2 2 0 1 0 0 .01M18 17a2 2 0 1 0 0 .01',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  chevron: 'm9 6 6 6-6 6',
  bb: 'M4 6h16M4 12h16M4 18h10',
};
type MenuItem = { label: string; hint?: string; icon?: string | { png: string }; checked?: boolean; submenu?: () => Promise<MenuItem[]>; run?: () => void } | 'separator' | { note: string };
let closeAll: (() => void) | null = null;
/** A small native-looking menu with optional fly-out submenus, keyboard and outside-click handling. */
function openMenu(at: { x: number; y: number } | HTMLElement, items: MenuItem[], signal: AbortSignal, parent?: HTMLElement): HTMLElement {
  if (!parent) closeAll?.();
  const menu = document.createElement('div');
  menu.setAttribute('role', 'menu');
  menu.dataset.fileLocalMenu = '';
  menu.className = 'fixed z-50 min-w-56 max-w-80 max-h-[70vh] overflow-y-auto rounded-md border bg-popover p-1 text-sm text-popover-foreground shadow-md';
  const place = () => {
    const w = menu.offsetWidth, h = menu.offsetHeight;
    let x: number, y: number;
    if (at instanceof HTMLElement) {
      const r = at.getBoundingClientRect();
      if (parent) { x = r.right + 2; y = r.top - 4; if (x + w > innerWidth - 8) x = r.left - w - 2; }
      else { x = r.left; y = r.bottom + 4; if (y + h > innerHeight - 8) y = r.top - h - 4; }
    } else { x = at.x; y = at.y; if (y + h > innerHeight - 8) y = at.y - h; }
    menu.style.left = `${Math.max(8, Math.min(x, innerWidth - w - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, innerHeight - h - 8))}px`;
  };
  let sub: HTMLElement | null = null, subOwner: HTMLElement | null = null;
  const closeSub = () => { sub?.remove(); sub = null; subOwner?.setAttribute('aria-expanded', 'false'); subOwner = null; };
  const render = (list: MenuItem[]) => {
    menu.replaceChildren();
    for (const item of list) {
      if (item === 'separator') { const hr = document.createElement('div'); hr.className = '-mx-1 my-1 h-px bg-border'; hr.setAttribute('role', 'separator'); menu.append(hr); continue; }
      if ('note' in item) { const p = document.createElement('div'); p.className = 'px-2 py-1.5 text-xs text-muted-foreground select-none'; p.textContent = item.note; menu.append(p); continue; }
      const b = document.createElement('button');
      b.type = 'button'; b.setAttribute('role', 'menuitem');
      b.className = 'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left outline-none hover:bg-state-hover focus-visible:bg-state-hover aria-expanded:bg-state-hover';
      const box = document.createElement('span'); box.className = 'inline-flex size-[18px] shrink-0 items-center justify-center text-muted-foreground';
      if (typeof item.icon === 'object') { const img = document.createElement('img'); img.src = `data:image/png;base64,${item.icon.png}`; img.alt = ''; img.className = 'size-[18px]'; box.append(img); }
      else if (item.icon) box.append(glyph(item.icon, 15));
      b.append(box);
      const name = document.createElement('span'); name.className = 'min-w-0 flex-1 truncate'; name.textContent = item.label; b.append(name);
      if (item.hint) { const h = document.createElement('span'); h.className = 'shrink-0 text-xs text-muted-foreground'; h.textContent = item.hint; b.append(h); }
      if (item.checked) { const c = document.createElement('span'); c.className = 'shrink-0 text-xs'; c.textContent = '✓'; b.append(c); }
      if (item.submenu) {
        b.setAttribute('aria-haspopup', 'menu'); b.setAttribute('aria-expanded', 'false');
        const arrow = document.createElement('span'); arrow.className = 'shrink-0 text-muted-foreground'; arrow.append(glyph(ICONS.chevron, 13)); b.append(arrow);
        const show = (focus: boolean) => {
          if (subOwner === b) return;
          closeSub(); subOwner = b; b.setAttribute('aria-expanded', 'true');
          sub = openMenu(b, [{ note: 'Загружаю…' }], signal, menu);
          const mine = sub;
          void item.submenu!().then(list => { if (mine.isConnected) { (mine as any).render(list); if (focus) mine.querySelector<HTMLElement>('[role=menuitem]')?.focus(); } },
            error => { if (mine.isConnected) (mine as any).render([{ note: String(error?.message ?? error) }]); });
        };
        b.addEventListener('mouseenter', () => show(false));
        b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); show(true); });
        b.addEventListener('keydown', e => { if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); show(true); } });
      } else {
        b.addEventListener('mouseenter', closeSub);
        b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); closeAll?.(); item.run?.(); });
      }
      menu.append(b);
    }
    place();
  };
  (menu as any).render = render;
  document.body.append(menu);
  render(items);
  if (parent) {
    menu.addEventListener('keydown', e => { if (e.key === 'ArrowLeft' || e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); menu.remove(); (at as HTMLElement).setAttribute('aria-expanded', 'false'); (at as HTMLElement).focus(); } });
  }
  menu.addEventListener('keydown', e => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault(); e.stopPropagation();
    const items = [...menu.querySelectorAll<HTMLButtonElement>(':scope > [role=menuitem]')], i = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  });
  if (!parent) {
    const close = () => { document.querySelectorAll('[data-file-local-menu]').forEach(m => m.remove()); document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', key, true); removeEventListener('scroll', onScroll, true); if (closeAll === close) closeAll = null; };
    const outside = (e: Event) => { if (!(e.target as Element)?.closest?.('[data-file-local-menu]')) close(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close(); if (at instanceof HTMLElement) at.focus(); } };
    // Scrolling the chat closes the menu; scrolling inside a long app list does not.
    const onScroll = (e: Event) => { if (!(e.target as Element)?.closest?.('[data-file-local-menu]')) close(); };
    document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', key, true); addEventListener('scroll', onScroll, true);
    signal.addEventListener('abort', close, { once: true });
    closeAll = close;
    menu.querySelector<HTMLElement>('[role=menuitem]')?.focus();
  }
  return menu;
}
async function copyText(text: string, done: string) {
  try { await navigator.clipboard.writeText(text); toast.success(done); } catch { toast.error('Не удалось скопировать'); }
}
/** Lets the next contextmenu event through to BB's own file menu (VS Code, Terminal, previews). */
let nativeMenuPass = false;
export default definePluginApp(app => {
  app.composer.customize({ id: 'local-open-bridge', scopes: ['thread'], banners: [{ id: 'bridge', chrome: 'bare', component: ThreadBridge }] });
  app.slots.fileOpener({ id: 'pdf', title: 'PDF — по ширине / на компьютере', extensions: ['pdf'], component: PdfPreview });
  app.contentScripts.register({ id: 'file-buttons', mount({ signal }) {
    const nodes = new Map<HTMLAnchorElement, { button: HTMLElement; href: string }>();
    const bridgeFor = (anchor: Element) => {
      const threadId = anchor.closest('[data-split-pane-id]')?.querySelector<HTMLElement>('[data-file-local-thread]')?.dataset.fileLocalThread;
      return threadId ? bridges.get(threadId) ?? null : null;
    };
    const itemsFor = (anchor: HTMLAnchorElement, path: string, withNative: { x: number; y: number } | null): MenuItem[] => {
      const ext = path.split('.').pop()!.toLowerCase(), file = path.split('/').pop()!;
      const run = (action: 'open' | 'save' | 'clipboard', app?: string | null) => {
        const bridge = bridgeFor(anchor);
        if (!bridge) { toast.error('Тред ещё загружается. Повторите.'); return; }
        void bridge.open(path, action, app).catch(error => { if (!signal.aborted) toast.error(String(error.message ?? error)); });
      };
      const chosen = remembered.get(ext);
      const items: MenuItem[] = [
        { label: chosen ? `Открыть в ${chosen.name}` : 'Открыть на компьютере', icon: ICONS.open, run: () => run('open', chosen?.path ?? null) },
        { label: 'Открыть с помощью', icon: ICONS.open, submenu: async () => {
          const bridge = bridgeFor(anchor);
          if (!bridge) throw new Error('Тред ещё загружается. Повторите.');
          const apps = await bridge.apps(ext);
          if (!apps.length) return [{ label: 'Приложение по умолчанию', icon: ICONS.open, run: () => { remembered.set(ext, null); run('open', null); } }];
          const current = remembered.get(ext)?.path ?? null;
          return apps.map(app => ({ label: app.name, hint: app.isDefault ? 'по умолчанию' : undefined, icon: app.icon ? { png: app.icon } : ICONS.open,
            checked: current ? current === app.path : app.isDefault,
            run: () => { remembered.set(ext, app.isDefault ? null : { path: app.path, name: app.name }); run('open', app.isDefault ? null : app.path); } }));
        } },
        { label: 'Поделиться', icon: ICONS.share, submenu: async () => [
          { label: 'Скопировать файл', hint: 'вставить в Telegram, почту', icon: ICONS.copy, run: () => run('clipboard') },
          { label: 'Скопировать путь', icon: ICONS.copy, run: () => void copyText(path, 'Путь скопирован') },
          { label: 'Скопировать имя', icon: ICONS.copy, run: () => void copyText(file, 'Имя скопировано') },
        ] },
        { label: 'Сохранить в Загрузки', icon: ICONS.save, run: () => run('save') },
      ];
      if (withNative) items.push('separator', { label: 'Меню BB: VS Code, Terminal, просмотр…', icon: ICONS.bb, run: () => {
        nativeMenuPass = true;
        anchor.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: withNative.x, clientY: withNative.y, button: 2 }));
        nativeMenuPass = false;
      } });
      return items;
    };
    const fileAnchor = (target: EventTarget | null) => {
      const anchor = (target as Element | null)?.closest?.<HTMLAnchorElement>('a[href^="file:"]');
      if (!anchor) return null;
      const path = localPath(anchor.href);
      if (!path || !anchor.closest('[data-split-pane-id]')?.querySelector('[data-file-local-thread]')) return null;
      return { anchor, path };
    };
    // Right-click on a file link opens this menu; its last item hands over to BB's own menu.
    document.addEventListener('contextmenu', event => {
      if (nativeMenuPass || event.shiftKey) return;
      const hit = fileAnchor(event.target);
      if (!hit) return;
      event.preventDefault(); event.stopPropagation();
      openMenu({ x: event.clientX, y: event.clientY }, itemsFor(hit.anchor, hit.path, { x: event.clientX, y: event.clientY }), signal);
    }, { capture: true, signal });
    // Warm the application list while the pointer approaches, so the submenu opens at once.
    document.addEventListener('pointerover', event => {
      const hit = fileAnchor(event.target) ?? (() => { const b = (event.target as Element | null)?.closest?.('[data-file-local-open]')?.previousElementSibling; return b ? fileAnchor(b) : null; })();
      if (hit) void bridgeFor(hit.anchor)?.apps(hit.path.split('.').pop()!.toLowerCase()).catch(() => undefined);
    }, { capture: true, passive: true, signal });
    let frame = 0;
    const scan = () => {
      frame = 0;
      for (const [anchor, entry] of nodes) if (!anchor.isConnected || anchor.href !== entry.href || !entry.button.isConnected) { entry.button.remove(); nodes.delete(anchor); }
      for (const anchor of document.querySelectorAll<HTMLAnchorElement>('a[href^="file:"]')) {
        if (nodes.has(anchor)) continue;
        const hit = fileAnchor(anchor); if (!hit) continue;
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.fileLocalOpen = '';
        button.className = 'ml-0.5 inline-flex size-5 items-center justify-center rounded align-middle text-subtle-foreground opacity-60 hover:bg-state-hover hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100';
        button.append(glyph(ICONS.more, 13));
        button.title = `Открыть на компьютере, поделиться, сохранить: ${hit.path.split('/').pop()} (или правый клик по ссылке)`;
        button.setAttribute('aria-label', button.title); button.setAttribute('aria-haspopup', 'menu');
        button.addEventListener('click', event => {
          event.preventDefault(); event.stopPropagation();
          openMenu(button, itemsFor(anchor, hit.path, null), signal);
        }, { signal });
        anchor.after(button); nodes.set(anchor, { button, href: anchor.href });
        // Warm the desktop's worker and this type's app list in the background, so the menu opens at once.
        const ext = hit.path.split('.').pop()!.toLowerCase();
        setTimeout(() => { if (!signal.aborted) void bridgeFor(anchor)?.apps(ext).catch(() => undefined); }, 1500);
      }
    };
    const observer = new MutationObserver(() => { if (!frame) frame = requestAnimationFrame(scan); });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['href', 'data-file-local-thread'] }); scan();
    return () => { observer.disconnect(); cancelAnimationFrame(frame); closeAll?.(); for (const { button } of nodes.values()) button.remove(); nodes.clear(); };
  } });
});
