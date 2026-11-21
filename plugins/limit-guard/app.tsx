import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { definePluginApp, useComposer, useRealtime, useRpc } from '@get-bb/plugin-sdk/app';
import type { ExperimentalThreadHeaderRowProps, ExperimentalThreadRowMetadataDataInput, ExperimentalThreadRowMetadataProps, PluginRpcClient } from '@get-bb/plugin-sdk/app';
import type { PriorityView, rpcContract } from './contract';
import './app.css';

type Mode = PriorityView['mode'];
type Rule = { enabled: boolean; low: number; high: number; nearMinutes: number };
type Custom = Partial<Record<'short' | 'long' | 'model', Rule>>;
type Marks = Record<string, { mode: 'low' | 'background'; holding: boolean; title: string }> | undefined;
const OPEN = 'limit-guard:open-priority';
const CHANGED = 'limit-guard:priority-changed';
const MODES: { mode: Mode; label: string; hint: string }[] = [
  { mode: 'normal', label: 'Обычный', hint: 'Задания не откладываются' },
  { mode: 'low', label: 'Неприоритетный', hint: 'Ждёт, пока лимит выше порога; порог растёт к сбросу окна' },
  { mode: 'background', label: 'Фоновый', hint: 'Как неприоритетный, но пороги на 20 пунктов ниже' },
];

/** One mark everywhere: an arrow down for lowered priority, with pause bars while work is held. */
function Glyph({ paused, size = 12 }: { paused: boolean; size?: number }) {
  return <svg className="lg-glyph" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    {paused ? <><path d="M5 3v6M5 9l-2.5-2.5M5 9l2.5-2.5"/><path d="M11 4v8M14 4v8"/></> : <><path d="M8 3v9"/><path d="M8 12l-3.5-3.5M8 12l3.5-3.5"/></>}
  </svg>;
}

let client: PluginRpcClient<typeof rpcContract> | null = null;
function KeepClient() { client = useRpc<typeof rpcContract>(); return null; }

function usePriority(threadId: string | null) {
  const rpc = useRpc<typeof rpcContract>();
  const [view, setView] = useState<PriorityView | null>(null);
  const load = useCallback(() => {
    if (!threadId) return;
    rpc.call('priority', { threadId }).then(setView, () => setView(null));
  }, [rpc, threadId]);
  useEffect(() => {
    setView(null); load();
    const timer = window.setInterval(load, 60_000);
    window.addEventListener(CHANGED, load);
    return () => { window.clearInterval(timer); window.removeEventListener(CHANGED, load); };
  }, [load]);
  useRealtime('priority', (payload: unknown) => { if (!threadId || (payload as { threadId?: string } | null)?.threadId === threadId) load(); });
  const set = useCallback(async (mode: Mode, custom?: Custom | null) => {
    if (!threadId) return;
    setView(await rpc.call('setPriority', { threadId, mode, ...(custom !== undefined ? { custom } : {}) }));
    window.dispatchEvent(new Event(CHANGED));
  }, [rpc, threadId]);
  return { view, set };
}

/** The thread's own thresholds: rows keep what the panel shows; edited or already-own rows are saved as own. */
function OwnThresholds({ view, onSave }: { view: PriorityView; onSave: (custom: Custom | null) => void }) {
  const [rows, setRows] = useState(() => view.policies.map(p => ({ ...p, dirty: false })));
  useEffect(() => { setRows(view.policies.map(p => ({ ...p, dirty: false }))); }, [view.policies]);
  const edit = (i: number, patch: Partial<Rule>) => setRows(list => list.map((r, j) => (j === i ? { ...r, ...patch, dirty: true } : r)));
  const num = (v: string, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(Number(v) || 0)));
  const save = () => {
    const custom: Custom = {};
    for (const r of rows) if (r.dirty || r.custom) custom[r.key] = { enabled: r.enabled, low: Math.min(r.low, r.high), high: Math.max(r.low, r.high), nearMinutes: r.nearMinutes };
    onSave(Object.keys(custom).length ? custom : null);
  };
  const anyOwn = rows.some(r => r.custom);
  return <details className="lg-own" open={anyOwn}>
    <summary>Свои пороги треда{anyOwn ? ' · заданы' : ''}</summary>
    <div className="lg-own-head"><span/><span>после сброса</span><span>перед сбросом</span><span>за, мин</span></div>
    {rows.map((r, i) => <div key={r.key} className="lg-own-row" data-off={!r.enabled}>
      <label title={r.label}><input type="checkbox" checked={r.enabled} onChange={e => edit(i, { enabled: e.target.checked })}/>{r.label.replace(' окно', '')}{r.custom ? ' ·' : ''}</label>
      <input type="number" min={1} max={100} value={r.low} disabled={!r.enabled} onChange={e => edit(i, { low: num(e.target.value, 1, 100) })} aria-label={`${r.label}: порог после сброса, %`}/>
      <input type="number" min={1} max={100} value={r.high} disabled={!r.enabled} onChange={e => edit(i, { high: num(e.target.value, 1, 100) })} aria-label={`${r.label}: порог перед сбросом, %`}/>
      <input type="number" min={0} max={10080} value={r.nearMinutes} disabled={!r.enabled} onChange={e => edit(i, { nearMinutes: num(e.target.value, 0, 10080) })} aria-label={`${r.label}: за сколько минут до сброса`}/>
    </div>)}
    <div className="lg-own-actions">
      <button type="button" onClick={save} disabled={!rows.some(r => r.dirty)}>Сохранить</button>
      <button type="button" onClick={() => onSave(null)} disabled={!anyOwn}>Общие</button>
    </div>
  </details>;
}

function Panel({ view, onPick, onCustom, anchor, onClose }: { view: PriorityView; onPick: (mode: Mode) => void; onCustom: (custom: Custom | null) => void; anchor: DOMRect; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', away); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', key); };
  }, [onClose]);
  const left = Math.max(8, Math.min(anchor.right - 320, window.innerWidth - 328));
  const bottom = Math.max(8, window.innerHeight - anchor.top + 6);
  return createPortal(<div ref={ref} className="lg-panel" role="dialog" aria-label="Приоритет треда" style={{ left, bottom }}>
    <div className="lg-panel-title">Приоритет треда</div>
    <div className="lg-modes" role="radiogroup">
      {MODES.map(m => <button key={m.mode} type="button" role="radio" aria-checked={view.mode === m.mode} title={m.hint}
        className="lg-mode" data-active={view.mode === m.mode} onClick={() => onPick(m.mode)}>{m.label}</button>)}
    </div>
    <p className="lg-panel-text">{view.text}</p>
    {view.rules.length > 0 && <ul className="lg-rules">{view.rules.map(rule => <li key={rule}>{rule}</li>)}</ul>}
    {view.mode !== 'normal' && !view.from && <OwnThresholds view={view} onSave={onCustom}/>}
    <p className="lg-panel-note">Пороги по умолчанию — в настройках Limit Guard. Подтреды получают режим родителя.</p>
  </div>, document.body);
}

/** Small grey control in the composer row, next to queue, context and compact. */
function ComposerChip() {
  const scope = useComposer().scope;
  const threadId = scope.kind === 'thread' ? scope.threadId : null;
  const { view, set } = usePriority(threadId);
  const button = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const open = useCallback(() => { if (button.current) setAnchor(button.current.getBoundingClientRect()); }, []);
  useEffect(() => {
    const onOpen = (e: Event) => { if ((e as CustomEvent<string>).detail === threadId) open(); };
    window.addEventListener(OPEN, onOpen);
    return () => window.removeEventListener(OPEN, onOpen);
  }, [threadId, open]);
  if (!threadId || !view) return null;
  const label = view.holding ? 'пауза' : view.mode === 'low' ? 'неприоритетный' : view.mode === 'background' ? 'фоновый' : null;
  return <>
    <button ref={button} type="button" className="lg-chip" data-mode={view.mode} data-holding={view.holding}
      title={view.mode === 'normal' ? 'Приоритет треда: обычный. Нажмите, чтобы сделать неприоритетным' : view.text}
      onClick={() => (anchor ? setAnchor(null) : open())}>
      <Glyph paused={view.holding}/>{label && <span>{label}</span>}
    </button>
    {anchor && <Panel view={view} anchor={anchor} onClose={() => setAnchor(null)} onPick={mode => { void set(mode); }} onCustom={custom => { void set(view.mode, custom); }}/>}
  </>;
}

/** A thin line under the thread header while its new work waits. */
function HeaderPause({ threadId }: ExperimentalThreadHeaderRowProps) {
  const { view } = usePriority(threadId);
  if (!view?.holding) return null;
  return <div className="lg-header"><Glyph paused/><span>{view.text}</span></div>;
}

function useMarks({ threads }: ExperimentalThreadRowMetadataDataInput): Marks {
  const rpc = useRpc<typeof rpcContract>();
  const ids = threads.map(thread => thread.id).slice(0, 500).join(',');
  const [marks, setMarks] = useState<Marks>(undefined);
  const load = useCallback(() => { rpc.call('marks', { threadIds: ids ? ids.split(',') : [] }).then(setMarks, () => setMarks({})); }, [rpc, ids]);
  useEffect(() => {
    load();
    const timer = window.setInterval(load, 60_000);
    window.addEventListener(CHANGED, load);
    return () => { window.clearInterval(timer); window.removeEventListener(CHANGED, load); };
  }, [load]);
  useRealtime('priority', () => load());
  return marks;
}
function RowMark({ thread, data }: ExperimentalThreadRowMetadataProps<Marks>) {
  const mark = data?.[thread.id];
  return mark ? <span className="lg-row" title={mark.title}><Glyph paused={mark.holding} size={11}/></span> : null;
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: 'limit-guard-client', component: KeepClient });
  app.slots.experimental_threadRowMetadata<Marks>({ id: 'limit-guard-priority', order: 90, useData: useMarks, component: RowMark });
  app.slots.experimental_threadHeaderRow({ id: 'limit-guard-pause', order: 50, component: HeaderPause });
  app.composer.customize({
    id: 'limit-guard', scopes: ['thread'],
    actions: [{ id: 'priority', component: ComposerChip }],
    plusMenu: [{
      id: 'priority', label: 'Приоритет треда…', icon: 'ChevronsDown',
      description: 'Обычный, неприоритетный или фоновый: когда новые задания этого треда ждут лимита',
      run({ composer }) {
        if (composer.scope.kind !== 'thread') return;
        window.dispatchEvent(new CustomEvent(OPEN, { detail: composer.scope.threadId }));
      },
    }],
  });
  void client;
});
