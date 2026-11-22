import { useCallback, useEffect, useMemo, useState } from 'react';
import { definePluginApp, useBbNavigate, useRealtime, useRpc } from '@get-bb/plugin-sdk/app';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { Board, FeedEventDto, ItemViewDto, rpcContract } from './contract';
import { Icon, NavIcon } from './icons';

type Tab = 'action' | 'waiting' | 'done' | 'feed';
type KindFilter = 'all' | 'pr' | 'issue';
type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;

let cached: Board | null = null;

const TONE: Record<string, string> = {
  good: 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10',
  bad: 'text-red-600 dark:text-red-400 bg-red-500/10',
  warn: 'text-amber-600 dark:text-amber-400 bg-amber-500/10',
  info: 'text-sky-600 dark:text-sky-400 bg-sky-500/10',
  neutral: 'text-muted-foreground bg-muted',
};
const TONE_TEXT: Record<string, string> = {
  good: 'text-emerald-600 dark:text-emerald-400', bad: 'text-red-600 dark:text-red-400', warn: 'text-amber-600 dark:text-amber-400', info: 'text-sky-600 dark:text-sky-400', neutral: 'text-muted-foreground',
};

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

function useBoard() {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<Board | null>(cached);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try { const next = await rpc.call('board', null); cached = next; setData(next); setError(''); }
    catch (reason) { setError(String((reason as Error).message ?? reason)); }
  }, [rpc]);
  useEffect(() => { void load(); }, [load]);
  useRealtime('changed', () => { void load(); });
  return { rpc, data, error, load };
}

function useActionBadge() {
  const { data } = useBoard();
  const items = data?.items.filter(item => item.bucket === 'action') ?? [];
  if (!items.length) return null;
  const fresh = items.filter(item => item.unread).length;
  return { count: items.length, tone: fresh ? 'warning' as const : 'neutral' as const, label: `${items.length} ждут вашего действия${fresh ? `, ${fresh} новых` : ''}` };
}

function Pill({ tone, children }: { tone: string; children: React.ReactNode }) {
  return <span className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${TONE[tone] ?? TONE.neutral}`}>{children}</span>;
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

/** PR and issue look different at a glance: colour strip, chip and glyph. */
const KIND_STYLE = {
  pr: { chip: 'bg-violet-500/15 text-violet-700 dark:text-violet-300', strip: 'bg-violet-500', text: 'PR' },
  issue: { chip: 'bg-amber-500/15 text-amber-700 dark:text-amber-300', strip: 'bg-amber-500', text: 'Issue' },
} as const;

function KindChip({ kind }: { kind: 'pr' | 'issue' }) {
  const style = KIND_STYLE[kind];
  return <span className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${style.chip}`}>
    <Icon name={kind === 'pr' ? 'PullRequest' : 'Issue'} className="size-3"/>{style.text}</span>;
}

function Row({ item, open, onToggle, rpc }: { item: ItemViewDto; open: boolean; onToggle: () => void; rpc: Rpc }) {
  const dismissable = item.notice || (item.state === 'open' && !item.muted);
  const dismiss = async () => {
    try {
      await rpc.call('mute', { key: item.key, muted: true });
      if (item.unread) await rpc.call('mark_seen', { keys: [item.key] });
      toast(item.notice ? 'Уведомление скинуто' : 'Скинуто до нового ответа', { action: { label: 'Вернуть', onClick: () => void rpc.call('mute', { key: item.key, muted: false }) } });
    } catch (reason) { toast.error(String((reason as Error).message ?? reason)); }
  };
  return <li className={`group relative overflow-hidden rounded-lg border ${open ? 'border-ring/40' : 'border-border/60 hover:border-border'}`}>
    <span className={`absolute inset-y-0 left-0 w-1 ${KIND_STYLE[item.kind].strip}`} aria-hidden/>
    <div className="flex items-start">
      <button type="button" onClick={onToggle} className="flex min-w-0 flex-1 cursor-pointer items-start gap-2.5 py-2.5 pl-4 pr-2 text-left hover:bg-muted/40">
        <Icon name={glyph(item)} className={`mt-0.5 size-4 shrink-0 ${TONE_TEXT[item.tone]}`}/>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <KindChip kind={item.kind}/>
            {item.unread && <span className="size-2 shrink-0 rounded-full bg-sky-500" title="Есть новое"/>}
            <span className={`truncate ${item.unread ? 'font-semibold' : 'font-medium'}`}>{item.title}</span>
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span className="font-mono">{item.repo}#{item.number}</span>
            <Pill tone={item.tone}>{item.status}</Pill>
            {item.reason !== item.status && <span className={item.bucket === 'action' ? 'font-medium text-foreground' : ''}>{item.reason}</span>}
          </span>
        </span>
        <span className="shrink-0 pt-0.5 text-xs text-muted-foreground" title={new Date(item.updatedAt).toLocaleString('ru-RU')}>{ago(item.state !== 'open' ? item.closedAt ?? item.updatedAt : item.updatedAt)}</span>
      </button>
      {dismissable && <button type="button" onClick={() => void dismiss()} title={item.notice ? 'Прочитано — скинуть' : 'Скинуть до нового ответа'} aria-label="Скинуть"
        className="m-1.5 flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground opacity-60 hover:bg-muted hover:text-foreground hover:opacity-100 group-hover:opacity-100">
        <Icon name="X" className="size-4"/></button>}
    </div>
    {open && <Details item={item} rpc={rpc} onClose={onToggle}/>}
  </li>;
}

function Feed({ events, onOpen }: { events: FeedEventDto[]; onOpen: (key: string) => void }) {
  if (!events.length) return <p className="px-2 py-12 text-center text-sm text-muted-foreground">Изменений пока нет. Здесь появятся новые ответы, смены статусов и новые PR и issue — начиная с первой загрузки.</p>;
  return <ul className="space-y-1">{events.map((event, i) => <li key={`${event.key}:${event.at}:${i}`}>
    <button type="button" onClick={() => onOpen(event.key)} className="flex w-full cursor-pointer items-start gap-2.5 rounded-md px-3 py-2 text-left hover:bg-muted/40">
      <span className={`mt-1.5 size-2 shrink-0 rounded-full ${TONE[event.tone]?.split(' ').find(c => c.startsWith('bg-')) ?? 'bg-muted'}`} style={{ opacity: 1 }}/>
      <span className="min-w-0 flex-1"><span className="block text-sm">{event.text}</span>
        <span className="flex items-center gap-1.5 truncate text-xs text-muted-foreground"><KindChip kind={event.kind}/><span className="font-mono">{event.repo}#{event.number}</span> · {event.title}</span></span>
      <span className="shrink-0 text-xs text-muted-foreground">{ago(event.at)}</span>
    </button></li>)}</ul>;
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
  const { rpc, data, error } = useBoard();
  const [tab, setTab] = useState<Tab>('action');
  const [kind, setKind] = useState<KindFilter>('all');
  const [mineOnly, setMineOnly] = useState(false);
  const [query, setQuery] = useState('');
  const [repo, setRepo] = useState('');
  const [openKey, setOpenKey] = useState('');
  const [help, setHelp] = useState(false);
  const items = data?.items ?? [];
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const words = needle.split(/\s+/).filter(Boolean);
    return items.filter(item => (kind === 'all' || item.kind === kind) && (!mineOnly || item.mine) && (!repo || item.repo === repo)
      && words.every(word => `${item.title} ${item.repo}#${item.number} #${item.number} ${item.author} @${item.author} ${item.status} ${item.reason} ${item.labels.join(' ')} ${item.kind === 'pr' ? 'pr pull request пулреквест' : 'issue задача'}`.toLowerCase().includes(word)));
  }, [items, kind, mineOnly, query, repo]);
  const repos = useMemo(() => [...new Set(items.map(item => item.repo))].sort((a, b) => a.localeCompare(b)), [items]);
  const kindCount = (k: KindFilter) => items.filter(item => (k === 'all' || item.kind === k) && (tab === 'feed' || item.bucket === tab)).length;
  const count = (b: Tab) => filtered.filter(item => item.bucket === b).length;
  const fresh = (b: Tab) => filtered.filter(item => item.bucket === b && item.unread).length;
  const visible = tab === 'feed' ? [] : filtered.filter(item => item.bucket === tab);
  const toggle = (key: string) => {
    const next = openKey === key ? '' : key;
    setOpenKey(next);
    const item = items.find(i => i.key === key);
    if (next && item?.unread) void rpc.call('mark_seen', { keys: [key] }).catch(() => undefined);
  };
  const openFromFeed = (key: string) => {
    const item = items.find(i => i.key === key);
    if (!item) return;
    setKind('all'); setMineOnly(false); setQuery(''); setTab(item.bucket); setOpenKey(key);
  };
  const tabs: [Tab, string][] = [['action', 'Нужно ваше действие'], ['waiting', 'Ждут других'], ['done', 'Завершённые'], ['feed', 'Лента изменений']];
  const unreadHere = visible.filter(item => item.unread).map(item => item.key);
  return <div className="h-full overflow-y-auto p-4 md:p-5">
    <div className="mx-auto w-full max-w-4xl space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[12rem] flex-1">
          <Icon name="Search" className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"/>
          <Input value={query} onChange={e => setQuery(e.target.value)} placeholder="Поиск: название, репозиторий, #номер, @автор, метка" className="pl-8"/>
        </div>
        <div className="flex rounded-md border border-border p-0.5 text-xs">
          {([['all', 'Все'], ['pr', 'PR'], ['issue', 'Issues']] as [KindFilter, string][]).map(([value, text]) =>
            <button key={value} type="button" onClick={() => setKind(value)} className={`flex cursor-pointer items-center gap-1 rounded px-2.5 py-1 ${kind === value ? (value === 'all' ? 'bg-muted' : KIND_STYLE[value].chip) + ' font-medium' : 'text-muted-foreground'}`}>
              {value !== 'all' && <Icon name={value === 'pr' ? 'PullRequest' : 'Issue'} className="size-3"/>}{text}<span className="tabular-nums opacity-60">{kindCount(value)}</span></button>)}
        </div>
        <select value={repo} onChange={e => setRepo(e.target.value)} className="h-8 max-w-[14rem] rounded-md border border-input bg-background px-2 text-xs" aria-label="Репозиторий">
          <option value="">Все репозитории</option>
          {repos.map(name => <option key={name} value={name}>{name}</option>)}
        </select>
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground"><input type="checkbox" checked={mineOnly} onChange={e => setMineOnly(e.target.checked)}/>Только мои</label>
        <Button size="sm" variant="outline" disabled={data?.fetching} onClick={() => void rpc.call('refresh', null)}>
          <Icon name="RefreshCw" className={`mr-1 size-3.5 ${data?.fetching ? 'animate-spin' : ''}`}/>{data?.fetching ? 'Обновляю…' : 'Обновить'}</Button>
      </div>
      <div className="flex flex-wrap items-end gap-1 border-b border-border">
        {tabs.map(([value, text]) => <button key={value} type="button" onClick={() => setTab(value)}
          className={`-mb-px flex cursor-pointer items-center gap-1.5 border-b-2 px-3 py-2 text-sm ${tab === value ? 'border-foreground font-medium' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
          {text}{value !== 'feed' && <span className="tabular-nums text-xs text-muted-foreground">{count(value)}</span>}
          {value !== 'feed' && fresh(value) > 0 && <span className="rounded-full bg-sky-500 px-1.5 text-[10px] font-semibold text-white">{fresh(value)} нов.</span>}
        </button>)}
        <button type="button" onClick={() => setHelp(!help)} className="mb-1.5 ml-auto flex cursor-pointer items-center gap-1 text-xs text-muted-foreground hover:text-foreground"><Icon name="CircleHelp" className="size-3.5"/>Что значат статусы</button>
      </div>
      {help && <dl className="grid gap-x-4 gap-y-1.5 rounded-lg border border-border p-3 text-xs sm:grid-cols-[auto_1fr]">
        {HELP.map(([term, text]) => <div key={term} className="contents"><dt className="font-medium">{term}</dt><dd className="text-muted-foreground">{text}</dd></div>)}
        <div className="contents"><dt className="font-medium">● Новое</dt><dd className="text-muted-foreground">С вашего прошлого просмотра кто-то ответил или сменился статус. Откройте запись — отметка снимется.</dd></div>
      </dl>}
      {(error || data?.error) && <p className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">Не удалось обновить: {error || data?.error}</p>}
      {!data && !error && <ul className="space-y-2">{Array.from({ length: 8 }, (_, i) => <li key={i} className="h-14 animate-pulse rounded-lg bg-muted/40"/>)}</ul>}
      {data && data.fetchedAt === null && !data.error && <p className="px-2 py-12 text-center text-sm text-muted-foreground">Первая загрузка с GitHub, это займёт до минуты…</p>}
      {data && data.fetchedAt !== null && tab !== 'feed' && <>
        {unreadHere.length > 1 && <div className="flex justify-end"><button type="button" className="cursor-pointer text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          onClick={() => void rpc.call('mark_seen', { keys: unreadHere })}>Отметить все прочитанными ({unreadHere.length})</button></div>}
        {visible.length ? <ul className="space-y-1">{visible.map(item => <Row key={item.key} item={item} rpc={rpc} open={openKey === item.key} onToggle={() => toggle(item.key)}/>)}</ul>
          : <p className="px-2 py-12 text-center text-sm text-muted-foreground">{query || repo || kind !== 'all' || mineOnly ? 'По фильтру ничего не нашлось' : tab === 'action' ? 'Сейчас от вас ничего не ждут 🎉' : 'Пусто'}</p>}
      </>}
      {data && tab === 'feed' && <Feed events={data.events.filter(e => kind === 'all' || e.kind === kind)} onOpen={openFromFeed}/>}
      {data?.fetchedAt && <p className="pt-2 text-xs text-muted-foreground">
        Обновлено {ago(data.fetchedAt)} · @{data.me} · обновляется каждые 10 минут{data.since ? ` · показано то, что менялось с ${new Date(data.since).toLocaleDateString('ru-RU')}` : ''}. Ищутся ваши PR и issue на всём GitHub, запросы ревью, упоминания за 30 дней и открытые записи в репозиториях проектов BB ({data.repos.length}).
        {data.warnings.length > 0 && <span className="block">Часть поиска не удалась: {data.warnings[0]}</span>}
      </p>}
    </div>
  </div>;
}

export default definePluginApp(app => {
  app.experimental_icons.register({ name: 'pr-issues/nav', component: NavIcon });
  app.slots.navPanel({ id: 'board', title: 'PR и Issues', icon: 'pr-issues/nav', path: 'pr-issues', component: Page, experimental_useBadge: useActionBadge });
});
