import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import {
  definePluginApp, useComposer, useRealtime, useRealtimeConnectionState, useRpc,
  type ExperimentalThreadHeaderRowProps,
} from '@get-bb/plugin-sdk/app';
import type { DescriptionView, rpcContract } from './contract';
import { findComposerSpot, findTitleSpot } from './title-anchor';
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

const EditIcon = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="M13.5 6.5l4 4" /></svg>;
const RefreshIcon = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4v7h-7" /></svg>;

/** "claude-code/claude-haiku-5-5" → "Haiku 5.5"; other ids stay as they are. */
function modelName(id: string) {
  const model = id.split('/').pop() ?? id;
  const claude = /^claude-([a-z]+)-(\d+)-(\d+)/u.exec(model);
  return claude ? `${claude[1]![0]!.toUpperCase()}${claude[1]!.slice(1)} ${claude[2]}.${claude[3]}` : model;
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
      setPlace(kind === 'recap' ? { top: rect.top - 8, left, transform: 'translateY(-100%)' } : { top: rect.bottom + 6, left });
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
  const loading = busy && !(kind === 'recap' ? view?.recap : view?.description);
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
      <div className="tdesc-head">
        <span className="tdesc-title">{kind === 'recap' ? 'Сейчас' : 'О чём тред'}</span>
        {draft === null && <span className="tdesc-tools">
          {kind === 'description' && <button type="button" className="tdesc-tool" aria-label="Изменить описание" title="Изменить"
            onClick={() => { setPinned(true); setDraft(view?.description ?? ''); }}><EditIcon /></button>}
          <button type="button" className="tdesc-tool" aria-label="Обновить" title="Обновить" disabled={busy} data-busy={busy}
            onClick={() => { setPinned(true); void refresh(); }}><RefreshIcon /></button>
        </span>}
      </div>
      {draft !== null ? <>
        <textarea autoFocus maxLength={2000} aria-label="Текст описания" value={draft} onChange={(event) => setDraft(event.target.value)} />
        <div className="tdesc-edit">
          <button type="button" className="tdesc-primary" onClick={() => void save(draft).then((ok) => { if (ok) setDraft(null); })}>Сохранить</button>
          <button type="button" className="tdesc-plain" onClick={() => setDraft(null)}>Отмена</button>
        </div>
      </> : loading ? <div className="tdesc-skeleton" aria-label="Готовится"><i /><i /><i /></div>
        : <p className="tdesc-main" data-empty={!(kind === 'recap' ? view?.recap : view?.description)}>{main}</p>}
      {draft === null && kind === 'description' && view?.recap && <div className="tdesc-now">
        <span className="tdesc-title">Сейчас</span>
        <p>{view.recap}</p>
      </div>}
      {problem && <p className="tdesc-error">{problem}</p>}
      {draft === null && (view?.generatedAt || view?.manual) && <div className="tdesc-foot" title={view?.tokens ? `Последнее обновление: ${tokens(view.tokens)}` : undefined}>
        {view?.generatedAt ? <span>{busy ? 'обновляется…' : ago(view.generatedAt)}</span> : null}
        {view?.model ? <span>{modelName(view.model)}</span> : null}
        {view?.manual && kind === 'description' ? <span>описание ваше · <button type="button" className="tdesc-plain" onClick={() => void save('')}>вернуть авто</button></span> : null}
      </div>}
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

/** Mounted as an empty composer banner; puts the recap icon under the composer's collapse arrow. */
function ComposerMount() {
  const { scope } = useComposer();
  const marker = useRef<HTMLSpanElement | null>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const threadId = scope.kind === 'thread' ? scope.threadId : null;
  useEffect(() => {
    if (!threadId) return;
    const node = document.createElement('span');
    node.className = 'tdesc-composer-anchor';
    node.dataset.threadRecap = '';
    let timer = 0;
    let sized: ResizeObserver | null = null;
    const attach = () => {
      timer = 0;
      const spot = marker.current && findComposerSpot(marker.current);
      sized?.disconnect();
      if (!spot) { node.remove(); setAnchor(null); return; }
      const place = () => {
        const box = spot.composer.getBoundingClientRect();
        const arrow = spot.arrow.getBoundingClientRect();
        // Not laid out yet (first paint, hidden pane): try again shortly.
        if (!arrow.width || !box.width) { window.setTimeout(place, 250); return; }
        node.style.top = `${Math.round(arrow.bottom - box.top + 4)}px`;
        node.style.right = `${Math.round(box.right - arrow.right)}px`;
      };
      if (node.parentElement !== spot.composer) spot.composer.append(node);
      place();
      sized = new ResizeObserver(place);
      sized.observe(spot.composer);
      sized.observe(spot.arrow);
      setAnchor(node);
    };
    attach();
    const observer = new MutationObserver(() => { if (!node.isConnected && !timer) timer = window.setTimeout(attach, 200); });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => { observer.disconnect(); sized?.disconnect(); window.clearTimeout(timer); node.remove(); };
  }, [threadId]);
  return <><span ref={marker} hidden />{threadId && anchor && createPortal(<InfoButton key={threadId} threadId={threadId} kind="recap" />, anchor)}</>;
}

export default definePluginApp((app) => {
  app.slots.experimental_threadHeaderRow({ id: 'thread-description', order: 100, component: HeaderMount });
  app.composer.customize({
    id: 'thread-description', scopes: ['thread'],
    banners: [{ id: 'recap', chrome: 'bare', component: ComposerMount }],
  });
});
