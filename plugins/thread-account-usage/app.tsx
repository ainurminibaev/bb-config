import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { definePluginApp, experimental_useProviders, useBbContext, useBbNavigate, useRpc, useSidebarSplitLayout } from '@get-bb/plugin-sdk/app';
import type { rpcContract, Account, Snapshot, QuotaWindow } from './contract';
import { accountExhausted, appliesToModel, planLabel } from './logic';
import './app.css';

type Filter = 'all' | 'five-hour' | 'weekly' | 'model';
function useCompactViewport() {
  const [compact,setCompact]=useState(()=>window.matchMedia('(max-width:767px)').matches);
  useEffect(()=>{const query=window.matchMedia('(max-width:767px)');const change=()=>setCompact(query.matches);query.addEventListener('change',change);return()=>query.removeEventListener('change',change)},[]);
  return compact;
}
const filters: { id: Filter; label: string }[] = [
  { id: 'all', label: 'Все окна' }, { id: 'five-hour', label: '5 часов' },
  { id: 'weekly', label: 'Неделя' }, { id: 'model', label: 'Fable / модели' },
];
const short = (w: QuotaWindow) => w.kind === 'five-hour' ? '5ч' : w.kind === 'weekly' ? 'Нед' : w.label;
const level = (percent: number) => percent >= 100 ? 'blocked' : percent >= 90 ? 'warning' : 'normal';
const pct = (v: number) => `${Math.round(v)}%`;
function compactReset(at: string | null, now: number) {
  if (!at || !Number.isFinite(Date.parse(at))) return '?';
  const m = Math.ceil((Date.parse(at)-now)/60_000);
  return m<=0 ? '↻' : m<60 ? `${m}м` : m<1440 ? `${Math.floor(m/60)}ч${m%60 ? '\u202f'+m%60+'м' : ''}` : `${Math.floor(m/1440)}д\u202f${Math.floor(m%1440/60)}ч`;
}
function resetText(at: string | null, now: number) {
  if (!at || !Number.isFinite(Date.parse(at))) return { relative: 'Время сброса не сообщено', exact: '' };
  const minutes = Math.ceil((Date.parse(at) - now) / 60_000);
  const relative = minutes <= 0 ? 'Срок сброса наступил — обновите данные' : minutes < 60
    ? `Сброс через ${minutes} мин` : minutes < 1440
      ? `Сброс через ${Math.floor(minutes / 60)} ч ${minutes % 60} мин`
      : `Сброс через ${Math.floor(minutes / 1440)} д ${Math.floor(minutes % 1440 / 60)} ч`;
  return { relative, exact: new Date(at).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) };
}
function QuotaGlyph({ windows, logo, agent, resets=0, blocked=0 }: { windows: QuotaWindow[]; logo?:string|null;agent?:string;resets?:number;blocked?:number }) {
  return <span className="tau-glyph-wrap"><svg className="tau-quota-glyph" viewBox="0 0 32 32" role="img" aria-label={windows.map(w=>`${short(w)}: ${pct(w.usedPercent)}`).join(', ')}>
    {windows.slice(0,2).map((w,i)=><g key={`${w.label}:${i}`} data-level={level(w.usedPercent)}><title>{w.label}: {pct(w.usedPercent)}</title>
      <circle className="tau-track" cx="16" cy="16" r={13-i*5} />
      <circle className="tau-fill" cx="16" cy="16" r={13-i*5} pathLength="100" strokeDasharray={`${Math.min(100,Math.max(0,w.usedPercent))} 100`} transform="rotate(-90 16 16)" />
    </g>)}
  </svg>{logo&&<img className="tau-glyph-agent" src={logo} alt={agent??''}/>}{resets>0&&<sup className="tau-glyph-credit" title={`Доступно сбросов: ${resets}`}>+{resets}</sup>}{blocked>0&&<span className="tau-account-status-dot" title={`Исчерпан общий лимит у аккаунтов: ${blocked}`} role="img" aria-label={`Исчерпан общий лимит у аккаунтов: ${blocked}`}/>}</span>;
}
function RefreshIcon({loading}:{loading:boolean}) {
  return <svg className="tau-refresh-icon" data-loading={loading} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 12a9 9 0 0 1 15.36-6.36L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.36 6.36L3 16M8 16H3v5"/>
  </svg>;
}
function WindowRows({ account, filter, model, now }: { account: Account; filter: Filter; model?: string | null; now: number }) {
  const windows = account.windows.filter(w => filter === 'all' || w.kind === filter);
  return <div className="tau-window-list">
    {windows.length === 0 && <p className="tau-empty">{filter === 'five-hour' ? 'Провайдер не сообщает пятичасовое окно.' : 'Провайдер не сообщил это окно.'}</p>}
    {windows.map((w, i) => {
      const reset = resetText(w.resetsAt, now);
      const inactive = model !== undefined && !appliesToModel(w, model);
      return <div className="tau-window" key={`${w.label}:${i}`} data-level={level(w.usedPercent)} data-inactive={inactive}>
        <div className="tau-window-heading"><span>{w.kind === 'five-hour' ? '5 часов' : w.kind === 'weekly' ? 'Неделя' : w.label}
          {inactive && <small> · другая модель</small>}</span><strong>{pct(w.usedPercent)} <small>исп.</small></strong></div>
        <div className="tau-bar"><span style={{ width: `${Math.min(100, Math.max(0, w.usedPercent))}%` }} /></div>
        <div className="tau-reset"><span>{reset.relative}</span><time dateTime={w.resetsAt ?? undefined}>{reset.exact}</time></div>
      </div>;
    })}
  </div>;
}

function AccountsGrid({ accounts, filter, now, logos, onDetails }: { accounts: Account[]; filter: Filter; now: number; logos: Record<string,string|null>; onDetails: (key:string)=>void }) {
  return <div className="tau-account-rows">{accounts.map(a=>{
    const windows = a.windows.filter(w=>filter==='all'||w.kind===filter);
    return <section className="tau-compact-row" key={a.key} data-stale={a.status!=='ok'}>
      <div className="tau-row-identity" title={`${a.email ?? a.providerName}\n${a.hostNames.join(', ')}`}>
        <strong>{logos[a.providerId]&&<img className="tau-grid-logo" src={logos[a.providerId]!} alt={a.providerName}/>}<span>{a.email?.split('@')[0]??'Аккаунт неизвестен'}</span></strong>
        <small>{a.hostNames.map(n=>n.replace(/\s*[—–].*$/,'').trim()).join(' · ')}</small>
        {a.plan&&<small className="tau-plan" title="Тариф и цена в месяц (справочно)">{planLabel(a.providerId,a.plan)}</small>}
        {(a.resetCount??0)>0&&<sup className="tau-row-reset" title="Доступные сбросы лимита">+{a.resetCount}</sup>}
      </div>
      <div className="tau-row-windows">{windows.length ? windows.map((w,i)=>{
        const reset=resetText(w.resetsAt,now);
        return <div className="tau-inline-window" key={`${w.label}:${i}`} data-level={level(w.usedPercent)} title={`${w.label}: ${pct(w.usedPercent)} использовано. ${reset.relative}. ${reset.exact}`}>
          <div className="tau-bar"><span style={{width:`${Math.min(100,Math.max(0,w.usedPercent))}%`}}/></div>
          <span className="tau-inline-type">{short(w)}</span><strong>{pct(w.usedPercent)}</strong><small>{compactReset(w.resetsAt,now)}</small>
        </div>;
      }):<small className="tau-row-empty">Окно не сообщено</small>}</div>
      <button className="tau-more" aria-label={`Подробнее: ${a.email??a.providerName}`} title="Подробнее" onClick={()=>onDetails(a.key)}>›</button>
    </section>;
  })}</div>;
}

function QuotaControl({ threadId, target }: { threadId: string | null; target?:HTMLElement }) {
  const mobile=useCompactViewport();
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const catalog = experimental_useProviders();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const pinnedRef=useRef(false);pinnedRef.current=pinned;
  const [view, setView] = useState<'thread' | 'accounts'>(threadId ? 'thread' : 'accounts');
  const [filter, setFilter] = useState<Filter>('all');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailsKey,setDetailsKey]=useState<string|null>(null);
  const [details,setDetails]=useState<{account:Account|null;threads:{id:string;title:string;hostName:string;updatedAt:number}[]}|null>(null);
  const [detailsError,setDetailsError]=useState(false);
  const detailsKeyRef=useRef(detailsKey);detailsKeyRef.current=detailsKey;
  const [now, setNow] = useState(Date.now());
  const [position, setPosition] = useState({ top: 64, left: 8, maxHeight: 500 });
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const active = useRef(true);
  const load = useCallback(async (refresh = false) => {
    if (inFlight.current) return;
    inFlight.current = true;
    const startedAt=Date.now();
    const current = generation.current;
    setLoading(true);
    try {
      const result = view === 'thread' && threadId
        ? await rpc.call('thread', { threadId, refresh })
        : await rpc.call('accounts', { refresh });
      if (!active.current || current !== generation.current) return;
      if ('accounts' in result) setAccounts(result.accounts); else setSnapshot(result);
      if('accounts' in result&&detailsKeyRef.current){
        const detailResult=await rpc.call('details',{key:detailsKeyRef.current});
        if(active.current&&current===generation.current){setDetails(detailResult);setDetailsError(false)}
      }
      setError(null);
    } catch { if (active.current && current === generation.current) setError('Не удалось обновить лимиты. Попробуйте ещё раз.'); }
    finally {
      const remaining=350-(Date.now()-startedAt);
      if(remaining>0)await new Promise(resolve=>setTimeout(resolve,remaining));
      if (current === generation.current) { inFlight.current = false; if (active.current) setLoading(false); }
    }
  }, [rpc, threadId, view]);
  useEffect(() => {
    active.current = true;
    generation.current++; inFlight.current = false;
    setSnapshot(null); setError(null); setOpen(false); setPinned(false);
    setView(threadId ? 'thread' : 'accounts');
    return () => { active.current = false; generation.current++; if (closeTimer.current) clearTimeout(closeTimer.current); };
  }, [threadId]);
  useEffect(() => {
    generation.current++; inFlight.current = false;
    void load();
    const timer = setInterval(() => void load(), 120_000);
    const focus = () => void load();
    window.addEventListener('focus', focus);
    return () => { clearInterval(timer); window.removeEventListener('focus', focus); generation.current++; inFlight.current = false; };
  }, [load]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer); }, []);
  useEffect(()=>{
    setDetails(null);setDetailsError(false);
    if(!detailsKey)return;
    let cancelled=false;
    rpc.call('details',{key:detailsKey}).then(r=>{if(!cancelled)setDetails(r)},()=>{if(!cancelled)setDetailsError(true)});
    return()=>{cancelled=true};
  },[rpc,detailsKey]);
  const positionPanel = useCallback(() => {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    if (mobile) {
      const viewport=window.visualViewport;
      const height=viewport?.height??window.innerHeight;
      const offset=viewport?.offsetTop??0;
      setPosition({left:8,top:offset+height-8,maxHeight:Math.max(100,height-24)});
      return;
    }
    const width = Math.min(view === 'accounts' ? 400 : 360, window.innerWidth - 16);
    const above = !threadId;
    setPosition({ left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
      top: above ? rect.top - 8 : rect.bottom + 8,
      maxHeight: above ? Math.min(580, rect.top - 16) : Math.max(100, window.innerHeight - rect.bottom - 20) });
  }, [threadId, view,mobile]);
  useEffect(() => {
    if (!open) return;
    positionPanel();
    const outside = (event: PointerEvent) => {
      if (!trigger.current?.contains(event.target as Node) && !panel.current?.contains(event.target as Node)) { setOpen(false); setPinned(false); }
    };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); setPinned(false); trigger.current?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', key);
    window.addEventListener('resize', positionPanel);
    window.visualViewport?.addEventListener('resize',positionPanel);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key); window.removeEventListener('resize', positionPanel);window.visualViewport?.removeEventListener('resize',positionPanel); };
  }, [open, positionPanel]);
  const enter = () => { if (closeTimer.current) clearTimeout(closeTimer.current); positionPanel(); setOpen(true); };
  const leave = () => { if (!pinnedRef.current) closeTimer.current = setTimeout(() => {if(!pinnedRef.current)setOpen(false)}, 180); };
  const account = snapshot?.account;
  const windows = account?.windows.filter(w => appliesToModel(w, snapshot?.model ?? null)) ?? [];
  const worst = [...windows].sort((a,b)=>b.usedPercent-a.usedPercent)[0];
  const windowOrder = { 'five-hour': 0, weekly: 1, model: 2, other: 3 };
  const importantWindows=[...windows].sort((a,b)=>windowOrder[a.kind]-windowOrder[b.kind]).slice(0,2);
  const list = accounts ?? [];
  const blockedAccounts=list.filter(accountExhausted);
  const accountName = account?.email?.split('@')[0] ?? 'не подтверждён';
  const logo = catalog.providers.find(p => p.id === snapshot?.providerId)?.logoUrl;
  const resetTotal=list.reduce((sum,a)=>sum+(a.resetCount??0),0);
  const averageWindows:QuotaWindow[]=['five-hour','weekly','model'].flatMap(kind=>{
    const values=list.flatMap(a=>a.windows.filter(w=>w.kind===kind).map(w=>w.usedPercent));
    return values.length?[{label:kind==='model'?'Fable':kind,kind:kind as QuotaWindow['kind'],usedPercent:values.reduce((a,b)=>a+b,0)/values.length,resetsAt:null}]:[];
  });
  const footerWindows=averageWindows.filter(w=>w.kind==='five-hour'||w.kind==='weekly');
  const label = threadId ? `Лимиты аккаунта ${account?.email ?? 'не подтверждён'} · ${snapshot?.hostName ?? 'машина треда'}` : 'Все аккаунты — лимиты и время сброса';
  const buttons=<>
    <button ref={trigger} type="button" className={`tau-trigger ${threadId ? 'tau-thread' : 'tau-global'}`}
      aria-label={label} aria-haspopup="dialog" aria-expanded={open}
      title={threadId ? label : `Средний расход по аккаунтам: ${footerWindows.map(w=>`${short(w)} ${pct(w.usedPercent)}`).join(', ')}. Исчерпан общий лимит у аккаунтов: ${blockedAccounts.length}. +N: подтверждённые доступные сбросы.`}
      onPointerEnter={event=>{if(event.pointerType==='mouse')enter()}} onPointerLeave={event=>{if(event.pointerType==='mouse')leave()}} onFocus={()=>{if(!mobile)enter()}}
      onClick={() => { if(closeTimer.current)clearTimeout(closeTimer.current);positionPanel(); const next=!(open&&pinned);pinnedRef.current=next;setOpen(next);setPinned(next); }}>
      {threadId && mobile ? <span className="tau-mobile-quota"><QuotaGlyph windows={importantWindows} logo={logo} agent={account?.providerName??snapshot?.providerId} resets={account?.resetCount??0}/><span data-level={worst?level(worst.usedPercent):undefined}>{worst?`${short(worst)} ${pct(worst.usedPercent)}`:loading?"…":"Лимиты"}</span></span> : threadId ? <><span className="tau-thread-composite"><QuotaGlyph windows={importantWindows} logo={logo} agent={account?.providerName??snapshot?.providerId} resets={account?.resetCount??0}/><span className="tau-thread-text">
        <span className="tau-thread-owner" title={`${account?.email??'Аккаунт не подтверждён'} · ${snapshot?.hostName??''}`}><span>{accountName}</span><small>{snapshot?.hostName?.replace(/\s*[—–].*$/,'').trim()??'машина треда'}</small></span>
        {worst?<span className="tau-inline-legend">{importantWindows.map(w=><span key={w.label} data-kind={w.kind} data-level={level(w.usedPercent)} title={`${w.label}: ${pct(w.usedPercent)} использовано. ${resetText(w.resetsAt,now).relative}. ${resetText(w.resetsAt,now).exact}`}><strong><span>{short(w)}</span> {pct(w.usedPercent)}</strong><small><span aria-hidden="true">↻ </span>{compactReset(w.resetsAt,now)}</small></span>)}</span>:<span className="tau-missing">{loading?'…':'Лимиты не подтверждены'}</span>}
      </span></span>
        {(error || account?.status === 'stale') && <span className="tau-caution">!</span>}</>
        : <><QuotaGlyph windows={footerWindows} resets={resetTotal} blocked={blockedAccounts.length}/><span className="tau-footer-values">{footerWindows.map(w=><span key={w.kind} data-kind={w.kind}><small>{short(w)}</small><strong>{pct(w.usedPercent)}</strong></span>)}{!footerWindows.length&&<span>—</span>}</span></>}
    </button>
    {!threadId && <button className="tau-footer-refresh" aria-label="Обновить все лимиты" aria-busy={loading} title="Автообновление раз в 2 минуты. Обновить сейчас" disabled={loading} onClick={() => void load(true)}><RefreshIcon loading={loading}/></button>}
  </>;
  return <>{target?createPortal(buttons,target):buttons}
    {open && createPortal(<div ref={panel} className="tau-panel" role="dialog" aria-busy={loading} aria-label={threadId ? 'Лимиты аккаунта треда' : 'Все аккаунты'}
      data-scope={view}
      onPointerDownCapture={()=>{pinnedRef.current=true;setPinned(true)}}
      style={{ top: position.top, left: position.left, maxHeight: position.maxHeight, transform: threadId&&!mobile ? undefined : 'translateY(-100%)' }} onPointerEnter={event=>{if(event.pointerType==='mouse')enter()}} onPointerLeave={event=>{if(event.pointerType==='mouse')leave()}}>
      <div className="tau-panel-header">{detailsKey&&view==='accounts'&&<button aria-label="Назад к аккаунтам" onClick={()=>setDetailsKey(null)}>‹</button>}<div><strong>{view === 'thread' ? 'Лимиты аккаунта треда' : detailsKey?'Подробнее об аккаунте':'Все аккаунты'}{view==='accounts'&&!detailsKey&&blockedAccounts.length>0&&<span className="tau-account-status-label">{blockedAccounts.length} {blockedAccounts.length===1?'исчерпан':'исчерпаны'}</span>}</strong>
        {view === 'thread' && <small>Расход подписки во всех беседах и CLI</small>}</div><button aria-label="Обновить лимиты" aria-busy={loading} disabled={loading} onClick={() => void load(true)}><RefreshIcon loading={loading}/></button>
        <button aria-label="Закрыть лимиты" onClick={() => { setOpen(false); setPinned(false); }}>×</button></div>
      {threadId && <div className="tau-view-tabs" role="tablist" aria-label="Область лимитов">
        <button role="tab" aria-selected={view === 'thread'} onClick={() => setView('thread')}>Этот аккаунт</button>
        <button role="tab" aria-selected={view === 'accounts'} onClick={() => setView('accounts')}>Все аккаунты</button>
      </div>}
      <div className="tau-filters" role="tablist" aria-label="Окно лимита">{filters.map(f => <button role="tab" key={f.id} aria-selected={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}</button>)}</div>
      <div className="tau-panel-body">
        {error && <p className="tau-error" role="alert">{error}</p>}
        {view === 'thread' ? <>
          {snapshot && <div className="tau-account-heading"><strong>{account?.email ?? 'Аккаунт не подтверждён'}</strong>
            <small>{account?.providerName ?? snapshot.providerId} · {snapshot.hostName ?? 'Нет машины'}{account?.plan ? ` · ${planLabel(account.providerId, account.plan)}` : ''}</small>
            {snapshot.model && <small>Модель запуска: {snapshot.model}</small>}</div>}
          {snapshot?.message && <p className="tau-empty">{snapshot.message}</p>}
          {account && <><WindowRows account={account} filter={filter} model={snapshot?.model} now={now} />
            <p className="tau-source">Доступные сбросы: {account.resetCount===null?'не сообщены':account.resetCount}</p>
            {account.status !== 'ok' && <p className="tau-error">Последние известные данные. {account.message}</p>}
            <p className="tau-source">Вход CLI на машине треда. Это лимиты аккаунта, а не токены одной беседы.</p></>}
          {!snapshot && <p className="tau-empty">{loading ? 'Проверяем аккаунт треда…' : 'Данные пока не получены'}</p>}
        </> : <>
          {detailsKey ? <>
            {details?.account&&<div className="tau-account-heading"><strong>{details.account.email}</strong><small>{details.account.providerName} · {planLabel(details.account.providerId, details.account.plan)}</small><small>{details.account.hostNames.join(' · ')}</small><small>Получено из BB: {details.account.fetchedAt?new Date(details.account.fetchedAt).toLocaleString():'неизвестно'}</small><small>Доступные сбросы: {details.account.resetCount===null?'не сообщены':details.account.resetCount}</small></div>}
            {details?.account&&<WindowRows account={details.account} filter={filter} now={now}/>}
            {detailsError&&<p className="tau-error">Не удалось загрузить подробности</p>}
            {!details&&!detailsError&&<p className="tau-empty">Загружаем…</p>}
            {details&&<div className="tau-recent"><strong>Последние треды агента на этих машинах</strong>{details.threads.map(t=><button key={t.id} onClick={()=>{setOpen(false);setPinned(false);navigate.toThread(t.id)}}><span>{t.title}</span><small>{t.hostName} · {new Date(t.updatedAt).toLocaleDateString()}</small></button>)}{!details.threads.length&&<small>Нет доступных тредов</small>}</div>}
          </>:<AccountsGrid accounts={list} filter={filter} now={now} logos={Object.fromEntries(catalog.providers.map(p=>[p.id,p.logoUrl]))} onDetails={key=>{setDetailsKey(key);setPinned(true)}}/>}
          {!list.length && <p className="tau-empty">{loading ? 'Собираем лимиты с машин…' : 'Подключённые CLI не сообщили аккаунты'}</p>}
        </>}
      </div>
      <div className="tau-panel-foot"><span className="tau-update-state" aria-live="polite">{loading?'Обновляем…':'Авто · 2 мин'}</span><span>{mobile?'Точные даты в ›':'Даты по наведению'}</span></div>
    </div>, document.body)}
  </>;
}

type Mount = { element: HTMLElement; threadId: string | null };
function Overlay() {
  const mobile=useCompactViewport();
  const context = useBbContext();
  const split = useSidebarSplitLayout();
  const [mounts, setMounts] = useState<Mount[]>([]);
  const paneKey = split?.panes.map(p => `${p.paneId}:${p.threadId ?? ''}`).join('|') ?? '';
  const paneMap = useMemo(() => new Map(split?.panes.map(p => [p.paneId, p.threadId]) ?? []), [paneKey]);
  useEffect(() => {
    const owned = new Set<HTMLElement>();
    // Footer controls must receive click before a mobile composer can collapse
    // on editor blur. Cancel only focus transfer, never propagation or gestures.
    const preserveEditorFocus = (event: MouseEvent | PointerEvent) => {
      if (!mobile || event.button !== 0 || !event.cancelable) return;
      const target = event.target instanceof Element ? event.target : null;
      const control = target?.closest('button,a[href],[role="button"]');
      const footer = control?.closest('[data-follow-up-composer-footer]');
      const composer = footer?.closest('[data-follow-up-composer]');
      const active = document.activeElement;
      if (composer && active instanceof HTMLElement && active.isContentEditable && composer.contains(active)) event.preventDefault();
    };
    if (mobile) {
      document.addEventListener('pointerdown', preserveEditorFocus, true);
      document.addEventListener('mousedown', preserveEditorFocus, true);
    }
    let frame = 0;
    const reconcile = () => {
      frame = 0;
      const next: Mount[] = [];
      for (const host of document.querySelectorAll<HTMLElement>('[data-thread-header-workflow-actions]')) {
        if(mobile)continue;
        const pane = host.closest('[data-split-pane-id]')?.getAttribute('data-split-pane-id');
        const threadId = paneMap.size ? paneMap.get(pane ?? '') ?? null : context.threadId;
        if (!threadId) continue;
        const spend = host.querySelector<HTMLElement>(':scope > [data-bb-plugin="thread-spend"]');
        let anchor = host.querySelector<HTMLElement>(':scope > [data-tau-root]');
        if (!anchor) {
          anchor = document.createElement('span');
          anchor.dataset.tauRoot = '';
          anchor.className = 'tau-mount';
          host.insertBefore(anchor, spend);
          owned.add(anchor);
        }
        if (spend && anchor.nextElementSibling !== spend) host.insertBefore(anchor, spend);
        next.push({ element: anchor, threadId });
      }
      if(mobile)for(const footer of document.querySelectorAll<HTMLElement>('[data-follow-up-composer-footer]')){
        const pane=footer.closest('[data-split-pane-id]')?.getAttribute('data-split-pane-id');
        const threadId=paneMap.size?paneMap.get(pane??'')??null:context.threadId;
        // Use the existing scrollable metadata row; never add a composer banner.
        const row=footer.firstElementChild;
        if(!threadId||!(row instanceof HTMLElement))continue;
        let anchor=row.querySelector<HTMLElement>(':scope > [data-tau-root]');
        if(!anchor){anchor=document.createElement('div');anchor.dataset.tauRoot='';anchor.className='tau-mobile-mount';row.append(anchor);owned.add(anchor);}
        next.push({element:anchor,threadId});
      }
      const footers = [...document.querySelectorAll<HTMLElement>('[data-sidebar="footer"] [data-sidebar="menu"]')];
      const footer = footers.find(f => f.getClientRects().length > 0);
      if (footer) {
        let anchor = footer.querySelector<HTMLElement>(':scope > [data-tau-root]');
        if (!anchor) { anchor = document.createElement('li'); anchor.dataset.tauRoot = ''; anchor.className = 'tau-footer-mount'; footer.append(anchor); owned.add(anchor); }
        next.push({ element: anchor, threadId: null });
      }
      for (const node of owned) if (!next.some(m => m.element === node)) { node.remove(); owned.delete(node); }
      setMounts(previous => previous.length === next.length && previous.every((m, i) => m.element === next[i]?.element && m.threadId === next[i]?.threadId) ? previous : next);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(reconcile); };
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', schedule); reconcile();
    return () => { observer.disconnect(); window.removeEventListener('resize', schedule); document.removeEventListener('pointerdown', preserveEditorFocus, true); document.removeEventListener('mousedown', preserveEditorFocus, true); cancelAnimationFrame(frame); for (const node of owned) node.remove(); };
  }, [context.threadId, paneMap,mobile]);
  return <>
    {mounts.map(m => <QuotaControl key={m.threadId ?? 'all'} threadId={m.threadId} target={m.element}/>)}
  </>;
}
export default definePluginApp(app => {
  app.slots.experimental_appOverlay({ id: 'thread-account-usage', component: Overlay });
});
