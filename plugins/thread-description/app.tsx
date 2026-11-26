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
    markSeen: useCallback(() => run(rpc.call('markSeen', { threadId })), [run, rpc, threadId]),
  };
}

const InfoIcon = () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 7.6v.1" /></svg>;
const RecapIcon = () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 6h16M4 12h10M4 18h7" /><path d="M16 17l2 2 3-4" /></svg>;

function ago(at: number) {
  const minutes = Math.floor((Date.now() - at) / 60_000);
  if (minutes < 1) return 'только что';
  if (minutes < 60) return `${minutes} мин назад`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)} ч назад`;
  return new Date(at).toLocaleDateString();
}

const tokens = (count: number) => (count >= 1000 ? `${Math.round(count / 1000)} тыс. токенов` : `${count} токенов`);

/**
 * An icon that shows a card on hover and keeps it open on click.
 * `kind` picks the content: the description (header) or the recap (composer).
 */
function InfoButton({ threadId, kind }: { threadId: string; kind: 'description' | 'recap' }) {
  const { view, failure, refresh, save, markSeen } = useDescription(threadId);
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
    hideTimer.current = window.setTimeout(() => setHovered(on), on ? 150 : 300);
  };
  useEffect(() => () => window.clearTimeout(hideTimer.current), []);
  const unseen = Boolean(view?.recapUnseen);
  useEffect(() => { if (open && unseen) void markSeen(); }, [open, unseen, markSeen]);
  useEffect(() => {
    if (!open) return;
    const measure = () => {
      const rect = button.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(360, window.innerWidth - 16);
      const left = Math.max(8, Math.min(kind === 'recap' ? rect.right - width : rect.left - 12, window.innerWidth - width - 8));
      // The header card opens downwards, the composer card upwards.
      setPlace(kind === 'recap' ? { bottom: window.innerHeight - rect.top + 8, left } : { top: rect.bottom + 6, left });
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
  }, [open, close, kind]);

  const busy = view?.busy ?? false;
  const problem = failure ?? view?.error ?? null;
  const label = kind === 'recap' ? 'Сводка треда' : 'Описание треда';
  const mouse = (event: { pointerType: string }) => event.pointerType === 'mouse';
  const main = kind === 'recap'
    ? view?.recap || (busy ? 'Сводка готовится…' : 'Сводки пока нет.')
    : view?.description || (busy ? 'Описание готовится…' : 'Описания пока нет.');
  return <>
    <button ref={button} type="button" className="tdesc-btn" aria-label={label} title={open ? undefined : label} aria-expanded={open}
      data-empty={kind === 'recap' ? !view?.recap : !view?.description} data-busy={busy} data-unseen={kind === 'recap' && unseen && !open}
      onClick={() => {
        if (pinned) { close(); return; }
        setPinned(true);
        if (kind === 'recap' && !view?.recap && !busy) void refresh();
      }}
      onPointerEnter={(event) => { if (mouse(event)) hover(true); }}
      onPointerLeave={(event) => { if (mouse(event)) hover(false); }}>{kind === 'recap' ? <RecapIcon /> : <InfoIcon />}</button>
    {open && place && createPortal(<div ref={popup} className="tdesc-pop" role="dialog" aria-label={label} style={place}
      onPointerEnter={(event) => { if (mouse(event)) hover(true); }} onPointerLeave={(event) => { if (mouse(event)) hover(false); }}>
      {draft === null
        ? <>
          {kind === 'recap' && <p className="tdesc-label">Сейчас</p>}
          <p>{main}</p>
          {kind === 'description' && view?.recap && <><p className="tdesc-label">Сейчас</p><p>{view.recap}</p></>}
        </>
        : <textarea autoFocus maxLength={2000} aria-label="Текст описания" value={draft} onChange={(event) => setDraft(event.target.value)} />}
      {problem && <p className="tdesc-error">{problem}</p>}
      {draft === null && view?.generatedAt && <div className="tdesc-meta">
        Обновлено {ago(view.generatedAt)}{view.manual && kind === 'description' ? ' · описание ваше' : ''}{view.model ? ` · ${view.model.split('/').pop()}` : ''}{view.tokens ? ` · ${tokens(view.tokens)}` : ''}
      </div>}
      <div className="tdesc-row">
        {draft === null ? <>
          <button type="button" disabled={busy} onClick={() => void refresh()}>{busy ? 'Обновляется…' : 'Обновить'}</button>
          {kind === 'description' && <button type="button" onClick={() => { setPinned(true); setDraft(view?.description ?? ''); }}>Изменить</button>}
          {kind === 'description' && view?.manual && <button type="button" onClick={() => void save('')}>Вернуть автообновление</button>}
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
  return <><span ref={marker} hidden />{anchor && createPortal(<InfoButton key={threadId} threadId={threadId} kind="description" />, anchor)}</>;
}

function RecapAction() {
  const { scope } = useComposer();
  return scope.kind === 'thread' ? <InfoButton key={scope.threadId} threadId={scope.threadId} kind="recap" /> : null;
}

export default definePluginApp((app) => {
  app.slots.experimental_threadHeaderRow({ id: 'thread-description', order: 100, component: HeaderMount });
  app.composer.customize({
    id: 'thread-description', scopes: ['thread'],
    actions: [{ id: 'recap', component: RecapAction }],
  });
});
