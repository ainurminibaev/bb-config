import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { definePluginApp, useBbNavigate, useRealtime, useRpc } from '@get-bb/plugin-sdk/app';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { Board, FeedEventDto, ItemViewDto, SourcesDto, rpcContract } from './contract';
import { Icon, NavIcon } from './icons';

type Tab = 'action' | 'waiting' | 'done' | 'feed' | 'sources';
type KindFilter = 'all' | 'pr' | 'issue';
type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;

function ago(at: number | null | undefined): string {
  if (!at) return '';
  const min = Math.round((Date.now() - at) / 60000);
  if (min < 1) return 'только что';
  if (min < 60) return `${min} мин назад`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} ч назад`;
  const d = Math.round(h / 24);
  if (d < 31) return `${d} дн назад`;
  return new Date(at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
}

function glyph(item: Pick<ItemViewDto, 'kind' | 'state' | 'stateReason'>) {
  if (item.kind === 'pr') return item.state === 'merged' ? 'Merged' : item.state === 'closed' ? 'Closed' : 'PullRequest';
  return item.state === 'open' ? 'Issue' : item.stateReason === 'NOT_PLANNED' ? 'Closed' : 'IssueDone';
}

const canWrite = (item: ItemViewDto) => ['WRITE', 'MAINTAIN', 'ADMIN'].includes(item.permission ?? '');

const PAGE = 50;
type Filters = { bucket: 'action' | 'waiting' | 'done'; kind: KindFilter; scope: string; mine: boolean; q: string };

/** Debounced reload on realtime "changed", skipped while the tab is hidden and caught up when it is shown again. */
function useChanged(reload: () => void, delay: number) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stale = useRef(false);
  const fire = useCallback(() => {
    if (document.visibilityState === 'hidden') { stale.current = true; return; }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(reload, delay);
  }, [reload, delay]);
  useRealtime('changed', fire);
  useEffect(() => {
    const onShow = () => { if (document.visibilityState === 'visible' && stale.current) { stale.current = false; reload(); } };
    document.addEventListener('visibilitychange', onShow);
    return () => { document.removeEventListener('visibilitychange', onShow); if (timer.current) clearTimeout(timer.current); };
  }, [reload]);
}

/** One bucket, page by page: the server filters and counts, the client only holds what was scrolled into view. */
function useBoardPages(filters: Filters, enabled: boolean) {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<Board | null>(null);
  const [error, setError] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const shown = useRef(PAGE);
  const seq = useRef(0);
  const key = JSON.stringify(filters);
  const fetchFirst = useCallback(async (limit: number) => {
    const id = ++seq.current;
    try {
      const next = await rpc.call('board', { ...filters, offset: 0, limit: Math.min(200, Math.max(PAGE, limit)) });
      if (id === seq.current) { setData(next); setError(''); }
    } catch (reason) { if (id === seq.current) setError(String((reason as Error).message ?? reason)); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rpc, key]);
  useEffect(() => { if (!enabled) return; shown.current = PAGE; setData(prev => prev && { ...prev, items: [] }); void fetchFirst(PAGE); }, [fetchFirst, enabled]);
  const reload = useCallback(() => { if (enabled) void fetchFirst(shown.current); }, [fetchFirst, enabled]);
  useChanged(reload, 600);
  const loadMore = useCallback(async () => {
    if (!data || loadingMore || data.items.length >= data.total) return;
    setLoadingMore(true);
    const id = seq.current;
    try {
      const next = await rpc.call('board', { ...filters, offset: data.items.length, limit: PAGE });
      if (id === seq.current) { shown.current = data.items.length + next.items.length; setData({ ...next, items: [...data.items, ...next.items] }); }
    } catch (reason) { toast.error(String((reason as Error).message ?? reason)); }
    finally { setLoadingMore(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rpc, key, data, loadingMore]);
  return { rpc, data, error, loadMore, loadingMore };
}

/** The sidebar badge asks only for two numbers, never for the list. */
function useActionBadge() {
  const rpc = useRpc<typeof rpcContract>();
  const [sum, setSum] = useState<{ action: number; fresh: number } | null>(null);
  const load = useCallback(() => { void rpc.call('summary', null).then(setSum).catch(() => undefined); }, [rpc]);
  useEffect(load, [load]);
  useChanged(load, 1500);
  if (!sum?.action) return null;
  return { count: sum.action, tone: sum.fresh ? 'warning' as const : 'neutral' as const, label: `${sum.action} ждут вашего действия${sum.fresh ? `, ${sum.fresh} новых` : ''}` };
}

function Details({ item, rpc, onClose }: { item: ItemViewDto; rpc: Rpc; onClose: () => void }) {
  const navigate = useBbNavigate();
  const [busy, setBusy] = useState('');
  const [comment, setComment] = useState('');
  const [projectId, setProjectId] = useState(item.projects[0]?.id ?? '');
  const [projects, setProjects] = useState<{ id: string; name: string; repo: string | null }[]>([]);
  useEffect(() => { void rpc.call('projects', null).then(r => { setProjects(r.projects); if (!projectId && r.projects[0]) setProjectId(r.projects[0].id); }).catch(() => undefined); }, [rpc]);
  const write = canWrite(item);
  const run = async (name: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(name);
    try { await fn(); if (done) toast.success(done); }
    catch (reason) { toast.error(String((reason as Error).message ?? reason)); }
    finally { setBusy(''); }
  };
  const doAct = (action: 'comment' | 'close' | 'reopen' | 'merge' | 'approve', done: string, body?: string) =>
    run(action, () => rpc.call('act', { key: item.key, action, ...(body !== undefined ? { body } : {}) }), done);
  const confirmAct = (action: 'close' | 'reopen' | 'merge' | 'approve', question: string, done: string) => { if (window.confirm(question)) void doAct(action, done); };
  const label = item.kind === 'pr' ? 'PR' : 'issue';
  return <div className="space-y-3 border-t border-border bg-muted/20 px-3 py-3 text-sm">
    {item.lastOther && <div className="rounded-md border border-border bg-background p-2.5">
      <p className="text-xs text-muted-foreground">Последнее от других: <b>@{item.lastOther.login}</b> · {ago(item.lastOther.at)}
        {item.lastOther.url && <> · <a className="underline underline-offset-2" href={item.lastOther.url} target="_blank" rel="noreferrer">открыть</a></>}</p>
      {item.lastOther.text && <p className="mt-1 line-clamp-4 whitespace-pre-wrap">{item.lastOther.text}</p>}
    </div>}
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <dt>Автор</dt><dd>@{item.author}{item.mine ? ' (вы)' : ''}</dd>
      <dt>Создан</dt><dd>{ago(item.createdAt)}</dd>
      {item.closedAt && item.state !== 'open' && <><dt>{item.state === 'merged' ? 'Влит' : 'Закрыт'}</dt><dd>{ago(item.closedAt)}</dd></>}
      <dt>Комментариев</dt><dd>{item.comments}{item.unresolvedThreads ? ` · нерешённых замечаний в коде: ${item.unresolvedThreads}` : ''}</dd>
      {item.kind === 'pr' && item.checks && <><dt>Проверки</dt><dd>{item.checks === 'SUCCESS' ? 'прошли' : item.checks === 'PENDING' || item.checks === 'EXPECTED' ? 'идут' : 'упали'}</dd></>}
      {item.labels.length > 0 && <><dt>Метки</dt><dd>{item.labels.join(', ')}</dd></>}
      {item.projects.length > 0 && <><dt>Проект BB</dt><dd>{item.projects.map(p => p.name).join(', ')}</dd></>}
    </dl>
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" asChild><a href={item.url} target="_blank" rel="noreferrer"><Icon name="ExternalLink" className="mr-1 size-3.5"/>Открыть на GitHub</a></Button>
      {item.unread && <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void run('seen', () => rpc.call('mark_seen', { keys: [item.key] }))}>Прочитано</Button>}
      {item.state === 'open' && <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void run('mute', () => rpc.call('mute', { key: item.key, muted: !item.muted }), item.muted ? 'Возвращён в список' : 'Скрыт до нового ответа')}>{item.muted ? 'Вернуть в список' : 'Скрыть до нового ответа'}</Button>}
      {item.kind === 'pr' && item.state === 'open' && item.reviewRequestedFromMe && <Button size="sm" variant="outline" disabled={!!busy} onClick={() => confirmAct('approve', `Одобрить ${label} ${item.repo}#${item.number} от вашего имени?`, 'Одобрено')}>Одобрить</Button>}
      {item.kind === 'pr' && item.state === 'open' && write && !item.draft && <Button size="sm" variant="outline" disabled={!!busy} onClick={() => confirmAct('merge', `Влить PR ${item.repo}#${item.number} (squash) в основную ветку?`, 'PR влит')}>Влить (squash)</Button>}
      {item.state === 'open' && (item.mine || write) && <Button size="sm" variant="outline" disabled={!!busy} onClick={() => confirmAct('close', `Закрыть ${label} ${item.repo}#${item.number}${item.kind === 'pr' ? ' без слияния' : ''}?`, 'Закрыт')}>Закрыть</Button>}
      {item.state === 'closed' && (item.mine || write) && <Button size="sm" variant="outline" disabled={!!busy} onClick={() => confirmAct('reopen', `Открыть заново ${label} ${item.repo}#${item.number}?`, 'Открыт заново')}>Открыть заново</Button>}
    </div>
    {item.state === 'open' && <div className="space-y-2">
      <textarea value={comment} onChange={e => setComment(e.target.value)} rows={3} placeholder="Комментарий на GitHub от вашего имени…"
        className="w-full resize-y rounded-md border border-input bg-background px-2.5 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"/>
      <Button size="sm" disabled={!!busy || !comment.trim()} onClick={() => void doAct('comment', 'Комментарий отправлен', comment).then(() => setComment(''))}>Отправить комментарий</Button>
    </div>}
    <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
      <span className="text-xs text-muted-foreground">Разобрать с агентом в проекте</span>
      <select value={projectId} onChange={e => setProjectId(e.target.value)} className="h-8 max-w-[16rem] rounded-md border border-input bg-background px-2 text-sm">
        {projects.map(p => <option key={p.id} value={p.id}>{p.name}{p.repo && p.repo.toLowerCase() === item.repo.toLowerCase() ? ' ★' : ''}</option>)}
      </select>
      <Button size="sm" variant="outline" disabled={!!busy || !projectId} onClick={() => void run('delegate', async () => { const { threadId } = await rpc.call('delegate', { key: item.key, projectId }); navigate.toThread(threadId); }, 'Создан тред с агентом')}>Новый тред</Button>
      <button type="button" className="ml-auto text-xs text-muted-foreground underline underline-offset-2" onClick={onClose}>Свернуть</button>
    </div>
  </div>;
}

/** GitHub's own convention: the glyph's shape says PR or issue, its colour says the state. */
function stateColor(item: Pick<ItemViewDto, 'kind' | 'state' | 'stateReason' | 'draft'>): string {
  if (item.state === 'merged') return 'text-violet-600 dark:text-violet-400';
  if (item.state === 'closed') return item.kind === 'issue' && item.stateReason !== 'NOT_PLANNED' && item.stateReason !== 'DUPLICATE' ? 'text-violet-600 dark:text-violet-400' : 'text-red-600 dark:text-red-400';
  return item.draft ? 'text-muted-foreground' : 'text-emerald-600 dark:text-emerald-400';
}

function KindGlyph({ item, className = '' }: { item: Pick<ItemViewDto, 'kind' | 'state' | 'stateReason' | 'draft'>; className?: string }) {
  return <Icon name={glyph(item)} className={`size-4 shrink-0 ${stateColor(item)} ${className}`}/>;
}

function shortAgo(at: number | null | undefined): string {
  if (!at) return '';
  const min = Math.round((Date.now() - at) / 60000);
  if (min < 1) return 'сейчас';
  if (min < 60) return `${min} мин`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} ч`;
  const d = Math.round(h / 24);
  if (d < 31) return `${d} дн`;
  return new Date(at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

function Row({ item, open, onToggle, rpc }: { item: ItemViewDto; open: boolean; onToggle: () => void; rpc: Rpc }) {
  const dismissable = item.notice || (item.state === 'open' && !item.muted);
  const when = item.state !== 'open' ? item.closedAt ?? item.updatedAt : item.updatedAt;
  const dismiss = async () => {
    try {
      await rpc.call('mute', { key: item.key, muted: true });
      if (item.unread) await rpc.call('mark_seen', { keys: [item.key] });
      toast('Скинуто — вернётся, если на GitHub что-то обновится', { action: { label: 'Вернуть', onClick: () => void rpc.call('mute', { key: item.key, muted: false }) } });
    } catch (reason) { toast.error(String((reason as Error).message ?? reason)); }
  };
  return <li className={`group ${open ? 'bg-muted/40' : ''}`}>
    <div className={`flex items-center gap-1 pr-1 ${open ? '' : 'hover:bg-muted/50'}`}>
      <button type="button" onClick={onToggle} aria-expanded={open}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 py-2 pl-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        <span className="flex w-2 shrink-0 justify-center" aria-hidden>{item.unread && <span className="size-2 rounded-full bg-sky-500"/>}</span>
        <KindGlyph item={item}/>
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className={`truncate text-sm ${item.unread ? 'font-semibold text-foreground' : 'text-foreground/85'}`}>{item.title}</span>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">#{item.number}</span>
        </span>
        <span className={`hidden max-w-[42%] shrink-0 truncate text-xs sm:block ${item.bucket === 'action' ? 'text-foreground/75' : 'text-muted-foreground'}`} title={item.reason}>{item.reason}</span>
        <span className="w-14 shrink-0 whitespace-nowrap text-right text-xs tabular-nums text-muted-foreground" title={new Date(when).toLocaleString('ru-RU')}>{shortAgo(when)}</span>
      </button>
      {dismissable
        ? <button type="button" onClick={() => void dismiss()} title="Скинуть — вернётся при обновлении на GitHub" aria-label={`Скинуть: ${item.title}`}
          className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100">
          <Icon name="X" className="size-3.5"/></button>
        : <span className="size-7 shrink-0"/>}
    </div>
    {open && <Details item={item} rpc={rpc} onClose={onToggle}/>}
  </li>;
}

const ownerOf = (repo: string) => repo.split('/')[0]!;

/** Rows grouped under their repository, groups in the order of their most urgent row. */
function Groups({ items, openKey, onToggle, rpc }: { items: ItemViewDto[]; openKey: string; onToggle: (key: string) => void; rpc: Rpc }) {
  const groups = useMemo(() => {
    const map = new Map<string, ItemViewDto[]>();
    for (const item of items) map.set(item.repo, [...(map.get(item.repo) ?? []), item]);
    return [...map];
  }, [items]);
  return <div className="space-y-4">{groups.map(([repo, rows]) => {
    const fresh = rows.filter(r => r.unread).length;
    return <section key={repo} aria-label={repo}>
      <h3 className="flex items-baseline gap-2 px-3 pb-1 text-xs">
        <span className="truncate"><span className="text-muted-foreground">{ownerOf(repo)} / </span><span className="font-medium text-foreground">{repo.slice(ownerOf(repo).length + 1)}</span></span>
        <span className="tabular-nums text-muted-foreground">{rows.length}</span>
        {fresh > 0 && <span className="tabular-nums text-sky-600 dark:text-sky-400">{fresh} нов.</span>}
        {rows[0]!.projects.length > 0 && <span className="truncate text-muted-foreground">· проект {rows[0]!.projects.map(p => p.name).join(', ')}</span>}
      </h3>
      <ul className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border">
        {rows.map(item => <Row key={item.key} item={item} rpc={rpc} open={openKey === item.key} onToggle={() => onToggle(item.key)}/>)}
      </ul>
    </section>;
  })}</div>;
}

/** Calls `onHit` when the end of the list scrolls into view. */
function Sentinel({ onHit }: { onHit: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) onHit(); }, { rootMargin: '400px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [onHit]);
  return <div ref={ref} className="h-px"/>;
}

function FeedRow({ event, rpc }: { event: FeedEventDto; rpc: Rpc }) {
  const [item, setItem] = useState<ItemViewDto | null | undefined>(undefined);
  const open = item !== undefined;
  const toggle = () => {
    if (open) { setItem(undefined); return; }
    void rpc.call('item', { key: event.key }).then(r => { setItem(r.item); if (r.item?.unread) void rpc.call('mark_seen', { keys: [event.key] }); }).catch(() => setItem(null));
  };
  return <li className={open ? 'bg-muted/40' : ''}>
    <button type="button" onClick={toggle} aria-expanded={open} className="flex w-full cursor-pointer items-start gap-3 px-3 py-2 text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
      <span className={`mt-1.5 size-2 shrink-0 rounded-full ${TONE_DOT[event.tone] ?? 'bg-muted-foreground'}`} aria-hidden/>
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 text-sm">{event.text}</span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <Icon name={event.kind === 'pr' ? 'PullRequest' : 'Issue'} className="size-3 shrink-0"/>
          <span className="shrink-0">{event.repo}#{event.number}</span><span className="truncate">· {event.title}</span>
        </span>
      </span>
      <span className="w-14 shrink-0 whitespace-nowrap text-right text-xs tabular-nums text-muted-foreground">{shortAgo(event.at)}</span>
    </button>
    {item && <Details item={item} rpc={rpc} onClose={() => setItem(undefined)}/>}
    {item === null && <p className="px-3 pb-2 text-xs text-muted-foreground">Эта запись сейчас скрыта или больше не отслеживается.</p>}
  </li>;
}

const TONE_DOT: Record<string, string> = { good: 'bg-emerald-500', bad: 'bg-red-500', warn: 'bg-amber-500', info: 'bg-sky-500', neutral: 'bg-muted-foreground' };

function Feed({ rpc, kind, scope }: { rpc: Rpc; kind: KindFilter; scope: string }) {
  const [events, setEvents] = useState<FeedEventDto[] | null>(null);
  const load = useCallback(() => { void rpc.call('feed', { kind, scope }).then(r => setEvents(r.events)).catch(() => setEvents([])); }, [rpc, kind, scope]);
  useEffect(load, [load]);
  useChanged(load, 1000);
  if (!events) return <Skeleton/>;
  if (!events.length) return <Empty>Изменений пока нет. Здесь появятся новые ответы, смены статусов и новые PR и issue.</Empty>;
  return <ul className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border">{events.map((event, i) => <FeedRow key={`${event.key}:${event.at}:${i}`} event={event} rpc={rpc}/>)}</ul>;
}

function Skeleton() {
  return <div className="overflow-hidden rounded-lg border border-border">{Array.from({ length: 8 }, (_, i) =>
    <div key={i} className="flex items-center gap-3 border-b border-border/60 px-3 py-2.5 last:border-0">
      <span className="size-4 animate-pulse rounded-full bg-muted"/><span className="h-3.5 flex-1 animate-pulse rounded bg-muted" style={{ maxWidth: `${40 + ((i * 37) % 45)}%` }}/>
    </div>)}</div>;
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="rounded-lg border border-dashed border-border px-6 py-14 text-center text-sm text-muted-foreground">{children}</div>;
}

/** Filter by organization or repository: a menu with search, repositories grouped under their organization. */
function ScopeFilter({ scopes, scope, onChange }: { scopes: { repo: string; count: number }[]; scope: string; onChange: (scope: string) => void }) {
  const [open, setOpen] = useState(false);
  const [needle, setNeedle] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => { if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown); document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);
  const groups = useMemo(() => {
    const map = new Map<string, [string, number][]>();
    for (const { repo, count } of scopes) map.set(ownerOf(repo), [...(map.get(ownerOf(repo)) ?? []), [repo, count]]);
    const q = needle.trim().toLowerCase();
    return [...map].map(([org, repos]) => {
      const orgHit = !q || org.toLowerCase().includes(q);
      const list = orgHit ? repos : repos.filter(([repo]) => repo.toLowerCase().includes(q));
      return { org, total: repos.reduce((sum, [, n]) => sum + n, 0), repos: list, show: orgHit || list.length > 0 };
    }).filter(group => group.show).sort((a, b) => b.total - a.total || a.org.localeCompare(b.org));
  }, [scopes, needle]);
  const label = !scope ? 'Все репозитории' : scope.startsWith('org:') ? `${scope.slice(4)} / *` : scope.slice(5);
  const pick = (next: string) => { onChange(next); setOpen(false); setNeedle(''); };
  const option = (active: boolean) => `flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${active ? 'bg-muted font-medium' : 'hover:bg-muted/60'}`;
  return <div ref={ref} className="relative">
    <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="listbox"
      className={`flex h-8 max-w-[16rem] cursor-pointer items-center gap-1.5 rounded-md border px-2.5 text-xs ${scope ? 'border-foreground/30 bg-muted font-medium text-foreground' : 'border-input text-muted-foreground hover:text-foreground'}`}>
      <Icon name="Building" className="size-3.5 shrink-0"/><span className="truncate">{label}</span>
      {scope ? <span role="button" tabIndex={0} aria-label="Сбросить фильтр репозитория" onClick={e => { e.stopPropagation(); pick(''); }} className="-mr-1 rounded p-0.5 hover:bg-background"><Icon name="X" className="size-3"/></span>
        : <Icon name="ChevronDown" className="size-3.5 shrink-0"/>}
    </button>
    {open && <div className="absolute right-0 top-9 z-50 w-80 overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg">
      <div className="border-b border-border p-2">
        <Input autoFocus value={needle} onChange={e => setNeedle(e.target.value)} placeholder="Организация или репозиторий" className="h-8 text-sm"/>
      </div>
      <div className="max-h-[22rem] overflow-y-auto p-1.5">
        {!needle && <button type="button" className={option(!scope)} onClick={() => pick('')}><span className="flex-1">Все репозитории</span></button>}
        {groups.map(group => <div key={group.org} className="mt-1">
          <button type="button" className={option(scope === `org:${group.org.toLowerCase()}`)} onClick={() => pick(`org:${group.org.toLowerCase()}`)}>
            <Icon name="Building" className="size-3.5 text-muted-foreground"/><span className="flex-1 truncate font-medium">{group.org}</span>
            <span className="text-[11px] text-muted-foreground">вся орг.</span><span className="w-6 text-right text-xs text-muted-foreground tabular-nums">{group.total}</span></button>
          {group.repos.map(([repo, n]) => <button key={repo} type="button" className={`${option(scope === `repo:${repo.toLowerCase()}`)} pl-7`} onClick={() => pick(`repo:${repo.toLowerCase()}`)}>
            <span className="flex-1 truncate text-xs">{repo.slice(group.org.length + 1)}</span><span className="w-6 text-right text-xs text-muted-foreground tabular-nums">{n}</span></button>)}
        </div>)}
        {!groups.length && <p className="px-2 py-6 text-center text-xs text-muted-foreground">Ничего не нашлось</p>}
      </div>
    </div>}
  </div>;
}

type Mode = 'all' | 'mine' | 'hidden';
const MODES: [Mode, string, string][] = [
  ['all', 'Всё', 'Все PR и issue, кто бы их ни создал'],
  ['mine', 'Моё', 'Только ваши и те, где вы участвуете'],
  ['hidden', 'Скрыть', 'Ничего отсюда не показывать'],
];

function ModeSwitch({ mode, onChange, dim }: { mode: Mode; onChange: (mode: Mode) => void; dim?: boolean }) {
  return <div className={`flex shrink-0 rounded-md border border-border p-0.5 text-xs ${dim ? 'opacity-70' : ''}`} role="radiogroup">
    {MODES.map(([value, text, hint]) => <button key={value} type="button" role="radio" aria-checked={mode === value} title={hint} onClick={() => onChange(value)}
      className={`cursor-pointer rounded px-2.5 py-1 ${mode === value ? value === 'all' ? 'bg-emerald-500/15 font-medium text-emerald-700 dark:text-emerald-300' : value === 'hidden' ? 'bg-muted font-medium text-muted-foreground line-through' : 'bg-sky-500/15 font-medium text-sky-700 dark:text-sky-300' : 'text-muted-foreground hover:text-foreground'}`}>{text}</button>)}
  </div>;
}

/** Turn whole organizations and single repositories on and off. */
function SourcesView({ rpc }: { rpc: Rpc }) {
  const [data, setData] = useState<SourcesDto | null>(null);
  const [error, setError] = useState('');
  const [openOrgs, setOpenOrgs] = useState<Record<string, boolean>>({});
  const [needle, setNeedle] = useState('');
  const load = useCallback(async () => {
    try { setData(await rpc.call('sources', null)); setError(''); } catch (reason) { setError(String((reason as Error).message ?? reason)); }
  }, [rpc]);
  useEffect(() => { void load(); }, [load]);
  useRealtime('changed', () => { void load(); });
  const set = async (key: string, mode: Mode | null) => {
    try { await rpc.call('set_source', { key, mode }); await load(); if (mode === 'all') toast.success('Включено — подгружаю записи с GitHub'); }
    catch (reason) { toast.error(String((reason as Error).message ?? reason)); }
  };
  const q = needle.trim().toLowerCase();
  const orgs = (data?.orgs ?? []).map(org => ({ ...org, repos: org.repos.filter(r => !q || org.login.includes(q) || r.repo.toLowerCase().includes(q)) }))
    .filter(org => !q || org.login.includes(q) || org.repos.length > 0);
  return <div className="space-y-3">
    <p className="text-sm text-muted-foreground">Что отслеживать. <b className="text-foreground">Всё</b> — любые PR и issue организации или репозитория, кто бы их ни создал.
      {' '}<b className="text-foreground">Моё</b> — только ваши и те, где вы участвуете (ревью, упоминания, ответы). <b className="text-foreground">Скрыть</b> — не показывать совсем.
      {' '}Настройка репозитория важнее настройки организации.</p>
    <div className="relative max-w-sm">
      <Icon name="Search" className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"/>
      <Input value={needle} onChange={e => setNeedle(e.target.value)} placeholder="Найти организацию или репозиторий" className="pl-8"/>
    </div>
    {error && <p className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
    {!data && !error && <ul className="space-y-2">{Array.from({ length: 5 }, (_, i) => <li key={i} className="h-12 animate-pulse rounded-lg bg-muted/40"/>)}</ul>}
    <ul className="space-y-2">{orgs.map(org => {
      const expanded = Boolean(q) || openOrgs[org.login];
      return <li key={org.login} className="overflow-hidden rounded-lg border border-border">
        <div className="flex items-center gap-2 px-3 py-2">
          <button type="button" onClick={() => setOpenOrgs({ ...openOrgs, [org.login]: !openOrgs[org.login] })} className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left" aria-expanded={expanded}>
            <Icon name="ChevronDown" className={`size-4 shrink-0 text-muted-foreground transition-transform ${expanded ? '' : '-rotate-90'}`}/>
            <Icon name="Building" className="size-4 shrink-0 text-muted-foreground"/>
            <span className="truncate font-medium">{org.login}</span>
            {org.me && <span className="rounded bg-muted px-1.5 text-[10px] text-muted-foreground">ваш аккаунт</span>}
            {org.member && <span className="rounded bg-muted px-1.5 text-[10px] text-muted-foreground">вы участник</span>}
            <span className="text-xs text-muted-foreground">{org.repos.length} репоз. · {org.count} зап.</span>
          </button>
          {org.explicit && <button type="button" className="cursor-pointer text-[11px] text-muted-foreground underline underline-offset-2" onClick={() => void set(`org:${org.login}`, null)}>по умолчанию</button>}
          <ModeSwitch mode={org.mode} onChange={mode => void set(`org:${org.login}`, mode)}/>
        </div>
        {expanded && org.repos.length > 0 && <ul className="border-t border-border bg-muted/20 py-1">{org.repos.map(r =>
          <li key={r.repo} className="flex items-center gap-2 py-1.5 pl-11 pr-3">
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{r.repo.slice(org.login.length + 1)}
              {r.projects.length > 0 && <span className="ml-2 font-sans text-[10px] text-muted-foreground">проект BB: {r.projects.join(', ')}</span>}</span>
            <span className="text-xs text-muted-foreground tabular-nums">{r.count || ''}</span>
            {r.explicit ? <button type="button" className="cursor-pointer text-[11px] text-muted-foreground underline underline-offset-2" onClick={() => void set(`repo:${r.repo.toLowerCase()}`, null)}>как у организации</button>
              : <span className="text-[11px] text-muted-foreground">как у орг.</span>}
            <ModeSwitch mode={r.mode} dim={!r.explicit} onChange={mode => void set(`repo:${r.repo.toLowerCase()}`, mode)}/>
          </li>)}</ul>}
      </li>;
    })}</ul>
  </div>;
}

const HELP: [string, string][] = [
  ['Ждёт ревью', 'PR отправлен, мейнтейнеры ещё не посмотрели. Ваш ход не нужен.'],
  ['Просят изменения', 'Ревьюер оставил замечания и не принял PR, пока их не исправят. Ваш ход.'],
  ['Одобрен', 'Ревьюер принял изменения; осталось влить (merge). В своём репозитории это делаете вы.'],
  ['Конфликт с основной веткой', 'Пока PR ждал, основная ветка изменилась; нужно обновить ветку PR.'],
  ['Проверки упали', 'Автоматические тесты (CI) не прошли — обычно это ваша задача.'],
  ['Черновик', 'PR помечен как незаконченный; ревьюеры его не ждут.'],
  ['Принят (влит)', 'Изменения вошли в проект. Готово.'],
  ['Отклонён (закрыт без слияния)', 'PR закрыли, не приняв. Иногда потому, что сделали иначе.'],
  ['Открыт / Решён / Не будут делать', 'Состояния issue: обсуждается, сделано, закрыт без исправления.'],
];

function Page() {
  const [tab, setTab] = useState<Tab>('action');
  const [kind, setKind] = useState<KindFilter>('all');
  const [mine, setMine] = useState(false);
  const [query, setQuery] = useState('');
  const [q, setQ] = useState('');
  const [scope, setScope] = useState('');
  const [openKey, setOpenKey] = useState('');
  const [help, setHelp] = useState(false);
  useEffect(() => { const t = setTimeout(() => setQ(query), 250); return () => clearTimeout(t); }, [query]);
  const listTab = tab === 'action' || tab === 'waiting' || tab === 'done';
  const bucket = listTab ? tab : 'action';
  const filters = useMemo<Filters>(() => ({ bucket, kind, scope, mine, q }), [bucket, kind, scope, mine, q]);
  const { rpc, data, error, loadMore, loadingMore } = useBoardPages(filters, tab !== 'sources');
  const items = data?.items ?? [];
  const toggle = (key: string) => {
    const next = openKey === key ? '' : key;
    setOpenKey(next);
    if (next && items.find(i => i.key === key)?.unread) void rpc.call('mark_seen', { keys: [key] }).catch(() => undefined);
  };
  const filtered = Boolean(q || scope || kind !== 'all' || mine);
  const tabs: [Tab, string][] = [['action', 'Нужно ваше действие'], ['waiting', 'Ждут других'], ['done', 'Завершённые'], ['feed', 'Лента']];
  const unread = listTab ? data?.unread ?? [] : [];
  const more = data ? data.total - items.length : 0;
  return <div className="h-full overflow-y-auto">
    <div className="mx-auto w-full max-w-4xl px-4 pb-10 pt-5 md:px-6">
      <header className="flex items-center gap-3">
        <h1 className="text-lg font-semibold tracking-tight">PR и Issues</h1>
        {data?.fetchedAt && <span className="truncate text-xs text-muted-foreground" title={`@${data.me} · обновляется каждые 10 минут`}>
          {data.fetching ? 'обновляю…' : `обновлено ${ago(data.fetchedAt)}`}</span>}
        <div className="ml-auto flex items-center gap-1">
          <Button size="sm" variant="ghost" aria-label="Что значат статусы" aria-pressed={help} onClick={() => setHelp(!help)}><Icon name="CircleHelp" className="size-4"/></Button>
          <Button size="sm" variant="ghost" aria-label="Обновить с GitHub" disabled={data?.fetching} onClick={() => void rpc.call('refresh', null)}>
            <Icon name="RefreshCw" className={`size-4 ${data?.fetching ? 'animate-spin' : ''}`}/></Button>
          <Button size="sm" variant={tab === 'sources' ? 'secondary' : 'ghost'} onClick={() => setTab(tab === 'sources' ? 'action' : 'sources')}>
            <Icon name={tab === 'sources' ? 'ArrowLeft' : 'Settings'} className="mr-1.5 size-4"/>{tab === 'sources' ? 'К списку' : 'Источники'}</Button>
        </div>
      </header>

      {help && <dl className="mt-4 grid gap-x-4 gap-y-1.5 rounded-lg border border-border bg-muted/20 p-3 text-xs sm:grid-cols-[auto_1fr]">
        {HELP.map(([term, text]) => <div key={term} className="contents"><dt className="font-medium">{term}</dt><dd className="text-muted-foreground">{text}</dd></div>)}
        <div className="contents"><dt className="font-medium">Цвет значка</dt><dd className="text-muted-foreground">Зелёный — открыт, фиолетовый — принят или решён, красный — закрыт без результата, серый — черновик.</dd></div>
        <div className="contents"><dt className="font-medium">● Новое</dt><dd className="text-muted-foreground">С прошлого просмотра кто-то ответил или сменился статус. Откройте запись — отметка снимется.</dd></div>
        <div className="contents"><dt className="font-medium">× Скинуть</dt><dd className="text-muted-foreground">Убирает запись, пока на GitHub по ней ничего не изменится; при любом обновлении она вернётся.</dd></div>
      </dl>}

      {tab === 'sources' ? <div className="mt-5"><SourcesView rpc={rpc}/></div> : <>
        <nav className="sticky top-0 z-10 -mx-4 mt-3 flex gap-1 overflow-x-auto overflow-y-hidden border-b border-border bg-background [scrollbar-width:none] px-4 md:-mx-6 md:px-6" aria-label="Разделы">
          {tabs.map(([value, text]) => {
            const n = value !== 'feed' ? data?.counts[value as Filters['bucket']] : undefined;
            const fresh = value !== 'feed' ? data?.fresh[value as Filters['bucket']] ?? 0 : 0;
            return <button key={value} type="button" onClick={() => { setTab(value); setOpenKey(''); }} aria-current={tab === value ? 'page' : undefined}
              className={`-mb-px flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap border-b-2 px-2.5 py-2.5 text-sm ${tab === value ? 'border-foreground font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
              {text}
              {n !== undefined && <span className="tabular-nums text-xs text-muted-foreground">{n}</span>}
              {fresh > 0 && <span className="flex items-center gap-1 text-xs tabular-nums text-sky-600 dark:text-sky-400"><span className="size-1.5 rounded-full bg-sky-500"/>{fresh}</span>}
            </button>;
          })}
        </nav>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {listTab ? <div className="relative min-w-[12rem] flex-1">
            <Icon name="Search" className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"/>
            <Input value={query} onChange={e => setQuery(e.target.value)} placeholder="Поиск: название, #номер, @автор, метка" aria-label="Поиск" className="h-8 pl-8 text-sm"/>
          </div> : <span className="flex-1 text-xs text-muted-foreground">Новые ответы, смены статусов и новые записи — по времени</span>}
          <div className="flex h-8 items-center rounded-md border border-input p-0.5 text-xs" role="radiogroup" aria-label="Тип">
            {([['all', 'Все'], ['pr', 'PR'], ['issue', 'Issues']] as [KindFilter, string][]).map(([value, text]) =>
              <button key={value} type="button" role="radio" aria-checked={kind === value} onClick={() => setKind(value)}
                className={`flex h-full cursor-pointer items-center gap-1 rounded px-2 ${kind === value ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
                {value !== 'all' && <Icon name={value === 'pr' ? 'PullRequest' : 'Issue'} className="size-3"/>}{text}
                {listTab && data && <span className="tabular-nums opacity-60">{data.kinds[value]}</span>}</button>)}
          </div>
          <ScopeFilter scopes={data?.scopes ?? []} scope={scope} onChange={setScope}/>
          {listTab && <button type="button" aria-pressed={mine} onClick={() => setMine(!mine)}
            className={`h-8 cursor-pointer rounded-md border px-2.5 text-xs ${mine ? 'border-foreground/30 bg-muted font-medium text-foreground' : 'border-input text-muted-foreground hover:text-foreground'}`}>Только мои</button>}
        </div>

        {(error || data?.error) && <p className="mt-3 rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">Не удалось обновить: {error || data?.error}</p>}

        <div className="mt-4">
          {tab === 'feed' ? <Feed rpc={rpc} kind={kind} scope={scope}/>
            : !data ? <Skeleton/>
            : data.fetchedAt === null ? <Empty>Первая загрузка с GitHub, это займёт до минуты…</Empty>
            : !items.length && !data.total ? <Empty>{filtered ? 'По фильтру ничего не нашлось' : tab === 'action' ? 'Сейчас от вас ничего не ждут' : 'Пусто'}</Empty>
            : !items.length ? <Skeleton/>
            : <>
              {unread.length > 1 && <div className="mb-2 flex justify-end">
                <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground" onClick={() => void rpc.call('mark_seen', { keys: unread.slice(0, 1000) })}>
                  <Icon name="CheckAll" className="mr-1.5 size-3.5"/>Отметить прочитанными · {unread.length}</Button>
              </div>}
              <Groups items={items} openKey={openKey} onToggle={toggle} rpc={rpc}/>
              {more > 0 && <>
                <Sentinel onHit={() => void loadMore()}/>
                <div className="mt-3 flex justify-center">
                  <Button size="sm" variant="outline" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? 'Загружаю…' : `Показать ещё · ${more}`}</Button>
                </div>
              </>}
            </>}
        </div>

        {data?.fetchedAt && <p className="mt-6 text-xs leading-5 text-muted-foreground">
          Показано {items.length} из {data.total}. Ищутся ваши PR и issue на всём GitHub, запросы ревью, упоминания за 30 дней и всё в источниках с режимом «Всё»
          {data.since ? `, изменённое с ${new Date(data.since).toLocaleDateString('ru-RU')}` : ''}.
          {data.warnings.length > 0 && <span className="block">Часть поиска не удалась: {data.warnings[0]}</span>}
        </p>}
      </>}
    </div>
  </div>;
}

export default definePluginApp(app => {
  app.experimental_icons.register({ name: 'pr-issues/nav', component: NavIcon });
  app.slots.navPanel({ id: 'board', title: 'PR и Issues', icon: 'pr-issues/nav', path: 'pr-issues', component: Page, experimental_useBadge: useActionBadge });
});
