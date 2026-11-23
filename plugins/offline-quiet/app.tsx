import { useEffect } from 'react';
import { definePluginApp, useRpc } from '@get-bb/plugin-sdk/app';
import type { rpcContract } from './contract';
import { isSummaryLabel, offlineName, type QuietState } from './logic';

const POLL_MS = 60_000;
const MARK = 'data-offline-quiet-hidden';

/** Decide which elements to hide; returns them so stale marks can be cleared. */
export function findHidden(root: ParentNode, state: QuietState): Set<Element> {
  const quiet = new Set(state.quietNames.map(n => n.toLowerCase()));
  const isQuiet = (name: string | null | undefined) => !!name && quiet.has(name.trim().toLowerCase());
  const hidden = new Set<Element>();
  if (quiet.size === 0) return hidden;

  // Settings → Machines: the warning card above "How machines connect".
  for (const card of root.querySelectorAll('section[class*="border-warning-text"]')) {
    const title = card.querySelector('h2')?.textContent ?? '';
    if (isQuiet(offlineName(title))) { hidden.add(card); continue; }
    const items = [...card.querySelectorAll('ul > li')];
    if (items.length === 0) continue;
    const quietItems = items.filter(li => isQuiet(li.querySelector('p.font-medium')?.textContent));
    if (quietItems.length === items.length) hidden.add(card);
    else quietItems.forEach(li => hidden.add(li));
  }

  // Sidebar footer: the link "<machine> is offline" (or a summary for several).
  for (const link of root.querySelectorAll('a[aria-label]')) {
    const label = link.getAttribute('aria-label') ?? '';
    if (!isQuiet(offlineName(label)) && !(isSummaryLabel(label) && state.allWarningsQuiet)) continue;
    const parent = link.parentElement;
    hidden.add(parent && parent.childElementCount === 1 && parent.tagName !== 'BODY' ? parent : link);
  }
  return hidden;
}

let current: QuietState = { quietNames: [], allWarningsQuiet: false };

function apply() {
  const next = findHidden(document, current);
  for (const el of document.querySelectorAll(`[${MARK}]`)) if (!next.has(el)) el.removeAttribute(MARK);
  for (const el of next) if (!el.hasAttribute(MARK)) el.setAttribute(MARK, '');
}

function Quiet() {
  const rpc = useRpc<typeof rpcContract>();

  useEffect(() => {
    const style = document.createElement('style');
    style.textContent = `[${MARK}]{display:none!important}`;
    document.head.appendChild(style);
    let frame = 0;
    const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; apply(); }); };
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['aria-label'] });

    let cancelled = false;
    const load = () => {
      if (document.visibilityState !== 'visible') return;
      // On failure keep the last known list: BB's own warning is the fallback.
      rpc.call('state', {}).then(s => { if (!cancelled) { current = s; schedule(); } }, () => {});
    };
    load();
    const timer = window.setInterval(load, POLL_MS);
    document.addEventListener('visibilitychange', load);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', load);
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
      for (const el of document.querySelectorAll(`[${MARK}]`)) el.removeAttribute(MARK);
      style.remove();
      current = { quietNames: [], allWarningsQuiet: false };
    };
  }, [rpc]);

  return null;
}

export default definePluginApp(app => {
  app.slots.experimental_appOverlay({ id: 'offline-quiet', component: Quiet });
});
