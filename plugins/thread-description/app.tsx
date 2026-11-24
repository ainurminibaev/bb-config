import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import {
  definePluginApp, useComposer, useRealtime, useRealtimeConnectionState, useRpc,
  type ExperimentalThreadHeaderRowProps,
} from '@get-bb/plugin-sdk/app';
import type { DescriptionView, rpcContract } from './contract';
import { findTitleSpot } from './title-anchor';
import './app.css';

// One cache for the header icon, the composer button and the recap line of a thread.
const cache = new Map<string, DescriptionView>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
function put(threadId: string, view: DescriptionView) { cache.set(threadId, view); for (const listener of [...listeners]) listener(); }

function useDescription(threadId: string) {
  const rpc = useRpc<typeof rpcContract>();
  const connection = useRealtimeConnectionState();
  const view = useSyncExternalStore(subscribe, () => cache.get(threadId));
  const [failure, setFailure] = useState<string | null>(null);
  const run = useCallback(async (request: Promise<DescriptionView>) => {
    try { put(threadId, await request); setFailure(null); return true; } catch (error) { setFailure(error instanceof Error ? error.message : String(error)); return false; }
  }, [threadId]);
  const reload = useCallback(() => { void rpc.call('get', { threadId }).then((next) => put(threadId, next), () => undefined); }, [rpc, threadId]);
  useEffect(() => { if (connection === 'connected') reload(); }, [connection, reload]);
  useRealtime('changed', (payload) => {
    if ((payload as { threadId?: unknown } | null)?.threadId === threadId) reload();
  });
  return {
    view, failure,
    refresh: () => run(rpc.call('refresh', { threadId })),
    save: (text: string) => run(rpc.call('setDescription', { threadId, text })),
    setRecapOpen: (open: boolean) => run(rpc.call('setRecapOpen', { threadId, open })),
  };
}

const PageIcon = () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M6 3h8l4 4v14H6z" /><path d="M9 11h6M9 15h6" /></svg>;
const RecapIcon = () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 6h16M4 12h10M4 18h7" /><path d="M16 17l2 2 3-4" /></svg>;

function ago(at: number) {
  const minutes = Math.floor((Date.now() - at) / 60_000);
  if (minutes < 1) return 'только что';
  if (minutes < 60) return `${minutes} мин назад`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)} ч назад`;
  return new Date(at).toLocaleDateString();
}

function HeaderIcon({ threadId }: { threadId: string }) {
  const { view, failure, refresh, save } = useDescription(threadId);
  const button = useRef<HTMLButtonElement | null>(null);
  const popup = useRef<HTMLDivElement | null>(null);
  const hideTimer = useRef(0);
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [place, setPlace] = useState<CSSProperties | null>(null);
  const open = pinned || hovered;
  const close = useCallback(() => { setPinned(false); setHovered(false); setDraft(null); }, []);
  const hover = (on: boolean) => {
    window.clearTimeout(hideTimer.current);
    // The gap lets the pointer travel from the icon to the card.
    hideTimer.current = window.setTimeout(() => setHovered(on), on ? 200 : 250);
  };
  useEffect(() => () => window.clearTimeout(hideTimer.current), []);
  useEffect(() => {
    if (!open) return;
    const measure = () => {
      const rect = button.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(360, window.innerWidth - 16);
      setPlace({ top: rect.bottom + 6, left: Math.max(8, Math.min(rect.left - 12, window.innerWidth - width - 8)) });
    };
    measure();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!popup.current?.contains(target) && !button.current?.contains(target)) close();
    };
    window.addEventListener('resize', measure);
    window.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown, true);
    return () => { window.removeEventListener('resize', measure); window.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onDown, true); };
  }, [open, close]);

  const busy = view?.busy ?? false;
  const problem = failure ?? view?.error ?? null;
  return <>
    <button ref={button} type="button" className="tdesc-btn" aria-label="Описание треда" aria-expanded={open}
      data-empty={!view?.description} data-busy={busy}
      onClick={() => { if (pinned) close(); else setPinned(true); }}
      onPointerEnter={(event) => { if (event.pointerType === 'mouse') hover(true); }}
      onPointerLeave={(event) => { if (event.pointerType === 'mouse') hover(false); }}><PageIcon /></button>
    {open && place && createPortal(<div ref={popup} className="tdesc-pop" role="dialog" aria-label="Описание треда" style={place}
      onPointerEnter={() => hover(true)} onPointerLeave={(event) => { if (event.pointerType === 'mouse') hover(false); }}>
      {draft === null
        ? <p>{view?.description || (busy ? 'Описание готовится…' : 'Описания пока нет.')}</p>
        : <textarea autoFocus maxLength={2000} aria-label="Текст описания" value={draft} onChange={(event) => setDraft(event.target.value)} />}
      {draft === null && view?.recap && <><p className="tdesc-label">Сейчас</p><p>{view.recap}</p></>}
      {problem && <p className="tdesc-error">{problem}</p>}
      {draft === null && view?.generatedAt && <div className="tdesc-meta">
        Обновлено {ago(view.generatedAt)}{view.manual ? ' · описание ваше' : ''}{view.model ? ` · ${view.model}` : ''}
      </div>}
      <div className="tdesc-row">
        {draft === null ? <>
          <button type="button" disabled={busy} onClick={() => void refresh()}>{busy ? 'Обновляется…' : 'Обновить'}</button>
          <button type="button" onClick={() => { setPinned(true); setDraft(view?.description ?? ''); }}>Изменить</button>
          {view?.manual && <button type="button" onClick={() => void save('')}>Вернуть автообновление</button>}
        </> : <>
          <button type="button" onClick={() => void save(draft).then((ok) => { if (ok) setDraft(null); })}>Сохранить</button>
          <button type="button" onClick={() => setDraft(null)}>Отмена</button>
        </>}
      </div>
    </div>, document.body)}
  </>;
}

/** The header row slot gives the thread of each pane; the icon itself sits next to the title. */
function HeaderMount({ threadId }: ExperimentalThreadHeaderRowProps) {
  const marker = useRef<HTMLSpanElement | null>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const node = document.createElement('span');
    node.className = 'tdesc-anchor';
    node.dataset.threadDescription = '';
    let frame = 0;
    const attach = () => {
      frame = 0;
      const spot = marker.current && findTitleSpot(marker.current);
      if (!spot) { node.remove(); setAnchor(null); return; }
      if (spot.nextElementSibling !== node) spot.after(node);
      setAnchor(node);
    };
    attach();
    // BB re-renders the header on rename and layout changes; put the icon back then.
    const observer = new MutationObserver(() => { if (!node.isConnected && !frame) frame = window.setTimeout(attach, 200); });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => { observer.disconnect(); window.clearTimeout(frame); node.remove(); };
  }, [threadId]);
  return <><span ref={marker} hidden />{anchor && createPortal(<HeaderIcon key={threadId} threadId={threadId} />, anchor)}</>;
}

function RecapAction() {
  const { scope } = useComposer();
  return scope.kind === 'thread' ? <RecapButton key={scope.threadId} threadId={scope.threadId} /> : null;
}

function RecapButton({ threadId }: { threadId: string }) {
  const { view, refresh, setRecapOpen } = useDescription(threadId);
  const open = view?.recapOpen ?? false;
  return <button type="button" className="tdesc-btn" title="Сводка треда" aria-label="Сводка треда" aria-expanded={open}
    data-empty={!view?.recap} data-busy={view?.busy ?? false} data-unseen={Boolean(view?.recapUnseen && !open)}
    onClick={() => {
      void setRecapOpen(!open);
      if (!open && !view?.recap && !view?.busy) void refresh();
    }}><RecapIcon /></button>;
}

function RecapBanner() {
  const { scope } = useComposer();
  return scope.kind === 'thread' ? <RecapLine key={scope.threadId} threadId={scope.threadId} /> : null;
}

function RecapLine({ threadId }: { threadId: string }) {
  const { view, failure, setRecapOpen } = useDescription(threadId);
  if (!view?.recapOpen) return null;
  const text = view.recap || (view.busy ? 'Сводка готовится…' : view.error ?? failure ?? 'Сводки пока нет: агент ещё не ответил.');
  return <div className="tdesc-recap" role="note" data-thread-recap>
    <span>{text}</span>
    <button type="button" aria-label="Свернуть сводку" title="Свернуть" onClick={() => void setRecapOpen(false)}>×</button>
  </div>;
}

export default definePluginApp((app) => {
  app.slots.experimental_threadHeaderRow({ id: 'thread-description', order: 100, component: HeaderMount });
  app.composer.customize({
    id: 'thread-description', scopes: ['thread'],
    actions: [{ id: 'recap', component: RecapAction }],
    banners: [{ id: 'recap', chrome: 'bare', component: RecapBanner }],
  });
});
