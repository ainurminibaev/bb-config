import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { definePluginApp, useComposer, useRpc } from '@get-bb/plugin-sdk/app';
import type { rpcContract, HintResult } from './contract';
import { coldMessageFactor, formatIdle, formatTokens, savingPercent } from './logic';
import { openOriginalHandoff } from './open-original';
import './app.css';

const POLL_MS = 30_000;
const dismissKey = (threadId: string) => `fresh-thread-hint:dismissed:${threadId}`;

function readDismissed(threadId: string): number | null {
  try {
    const raw = window.localStorage.getItem(dismissKey(threadId));
    const value = raw === null ? NaN : Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch { return null; }
}

function Banner() {
  const { scope } = useComposer();
  return scope.kind === 'thread' ? <Hint key={scope.threadId} threadId={scope.threadId} /> : null;
}

function Hint({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [hint, setHint] = useState<HintResult>({ show: false });
  const [dismissed, setDismissed] = useState<number | null>(() => readDismissed(threadId));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      if (document.visibilityState !== 'visible') return;
      // A failed check must not leave a stale suggestion on screen.
      rpc.call('hint', { threadId }).then(
        (result) => { if (!cancelled) setHint(result); },
        () => { if (!cancelled) setHint({ show: false }); },
      );
    };
    load();
    const timer = window.setInterval(load, POLL_MS);
    document.addEventListener('visibilitychange', load);
    return () => { cancelled = true; window.clearInterval(timer); document.removeEventListener('visibilitychange', load); };
  }, [rpc, threadId]);
  useEffect(() => () => pending.current?.abort(), []);

  // Dismissal lasts for this idle period only: new activity changes lastActivityAt.
  if (!hint.show || dismissed === hint.lastActivityAt) return null;

  return <div className="fth-banner" role="note" data-fresh-thread-hint>
    <span className="fth-text">
      Тред давно простаивает. Та же задача — пишите здесь, новая — лучше в новом треде.
      {error && <span className="fth-error"> {error}</span>}
    </span>
    <button type="button" className="fth-link" disabled={busy} onClick={(event) => {
      const controller = new AbortController();
      pending.current?.abort(); pending.current = controller; setBusy(true); setError(null);
      void openOriginalHandoff(event.currentTarget, controller.signal)
        .catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); })
        .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    }}>Продолжить в новом</button>
    <Why usedTokens={hint.usedTokens} idleMinutes={hint.idleMinutes} />
    <button type="button" className="fth-icon" aria-label="Скрыть подсказку" title="Скрыть" onClick={() => {
      try { window.localStorage.setItem(dismissKey(threadId), String(hint.lastActivityAt)); } catch { /* still hide for this view */ }
      setDismissed(hint.lastActivityAt);
    }}>×</button>
  </div>;
}

function Why({ usedTokens, idleMinutes }: { usedTokens: number; idleMinutes: number }) {
  const button = useRef<HTMLButtonElement | null>(null);
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [place, setPlace] = useState<{ left: number; bottom: number } | null>(null);
  const open = pinned || hovered;
  const measure = useCallback(() => {
    const rect = button.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(300, window.innerWidth - 16);
    setPlace({ left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)), bottom: window.innerHeight - rect.top + 6 });
  }, []);
  useEffect(() => {
    if (!open) return;
    measure();
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') { setPinned(false); setHovered(false); } };
    window.addEventListener('resize', measure);
    window.addEventListener('keydown', close);
    return () => { window.removeEventListener('resize', measure); window.removeEventListener('keydown', close); };
  }, [open, measure]);

  return <>
    <button ref={button} type="button" className="fth-icon" aria-label="Почему это важно" aria-expanded={open}
      onClick={() => setPinned((value) => !value)} onBlur={() => setPinned(false)}
      onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>?</button>
    {open && place && createPortal(<div className="fth-tip" role="tooltip" style={{ left: place.left, bottom: place.bottom }}>
      <p>Тред простоял {formatIdle(idleMinutes)}. Сообщение сюда сейчас спишет с лимита примерно как <strong>{coldMessageFactor()} обычных</strong>: Claude заново прочитает весь тред, около {formatTokens(usedTokens)} токенов.</p>
      <p>В новом треде это сообщение и все следующие обойдутся примерно <strong>на {savingPercent(usedTokens)}% дешевле</strong>.</p>
      <p>Но новый тред знает только пересказ. Нужны детали этой задачи — оставайтесь здесь.</p>
      <p className="fth-note">Оценка: цены Claude API и новый тред около 30 тыс. токенов.</p>
    </div>, document.body)}
  </>;
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: 'fresh-thread-hint', scopes: ['thread'],
    banners: [{ id: 'hint', chrome: 'bare', component: Banner }],
  });
});
