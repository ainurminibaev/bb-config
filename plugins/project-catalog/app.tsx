import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { definePluginApp, useBbNavigate, useRealtime, useRpc } from '@get-bb/plugin-sdk/app';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { GridIcon, Icon } from './icons';
import { Input } from '@/components/ui/input';
import type { Catalog, ProjectView, rpcContract } from './contract';
import { eventSummary, formatBytes, normalize, search, translit, WORKTREE_STATE_TEXT, type AutoField, type Level, type Status, type SyncEvent, type WorktreeView } from './core';
import './catalog.css';

type Source = ProjectView['sources'][number];
const NO_CATEGORY = 'Без категории';

const LEVEL: Record<Level, { icon: string; text: string; dot: string }> = {
  ok: { icon: 'CircleCheck', text: 'text-emerald-600 dark:text-emerald-400', dot: 'bg-emerald-500' },
  info: { icon: 'CircleCheck', text: 'text-emerald-600 dark:text-emerald-400', dot: 'bg-emerald-500' },
  attention: { icon: 'TriangleAlert', text: 'text-amber-600 dark:text-amber-400', dot: 'bg-amber-500' },
  risk: { icon: 'OctagonAlert', text: 'text-red-600 dark:text-red-400', dot: 'bg-red-500' },
  unknown: { icon: 'CircleHelp', text: 'text-muted-foreground', dot: 'bg-slate-400' },
};
const fieldClass = 'w-full rounded-md border border-input bg-background px-3 py-2 text-sm leading-relaxed placeholder:text-muted-foreground/70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring';
const selectClass = 'h-9 min-w-0 cursor-pointer rounded-md border border-input bg-background px-2.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring';

function hue(text: string) {
  let value = 0;
  for (let i = 0; i < text.length; i++) value = (value * 31 + text.charCodeAt(i)) % 360;
  return value;
}
function ago(time: number | null) {
  if (!time) return 'ещё не проверялось';
  const minutes = Math.round((Date.now() - time) / 60_000);
  if (minutes < 1) return 'только что';
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} ч назад` : `${Math.round(hours / 24)} дн назад`;
}
const isMac = (name: string) => /mac|book|laptop/i.test(name);
const shortHost = (name: string) => /macbook/i.test(name) ? 'Mac' : name.split(/\s[—-]\s/)[0]!.replace(/\s*\(\d+\)$/, '');

function sourceState(source: Source): { level: Level; text: string } {
  const scan = source.scan;
  if (!scan) return { level: 'unknown', text: source.connected ? 'ещё не проверено' : 'не проверено, машина офлайн' };
  if (scan.kind === 'error') return { level: 'unknown', text: `не удалось проверить: ${scan.error ?? 'ошибка'}` };
  if (scan.kind === 'missing') return { level: 'attention', text: 'папка не найдена' };
  if (scan.kind === 'plain' && scan.plain) return { level: 'ok', text: `без git · ${scan.plain.files}${scan.plain.truncated ? '+' : ''} файлов` };
  const git = scan.git!;
  const parts = [git.branch ?? 'detached', git.head ? git.head.slice(0, 7) : 'нет коммитов'];
  const local = git.dirty + git.untracked;
  if (local) parts.push(`${local} не закоммичено`);
  if (git.ahead) parts.push(`${git.ahead} не отправлено`);
  if (git.behind) parts.push(`отстаёт на ${git.behind}`);
  if (!git.hasUpstream) parts.push('нет remote-ветки');
  return { level: local || git.ahead ? 'attention' : 'ok', text: parts.join(' · ') };
}

function Avatar({ project, size = 'size-9' }: { project: ProjectView; size?: string }) {
  if (project.icon) return <img src={project.icon} alt="" className={`${size} shrink-0 rounded-lg bg-muted/60 object-contain p-1.5`}/>;
  const h = hue(project.name);
  return <span aria-hidden="true" className={`${size} flex shrink-0 items-center justify-center rounded-lg text-sm font-semibold`}
    style={{ background: `hsl(${h} 60% 50% / 0.16)`, color: `hsl(${h} 55% 52%)` }}>{project.name.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 1).toUpperCase() || '·'}</span>;
}
function VerdictBadge({ project }: { project: ProjectView }) {
  const style = LEVEL[project.verdict.level];
  return <span className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-xs font-medium ${style.text}`} title={project.verdict.details.join('\n') || project.verdict.label}>
    <Icon name={style.icon} fallback="Circle" className="size-3.5 shrink-0" aria-hidden="true"/><span className="sr-only sm:not-sr-only">{project.verdict.label}</span>
  </span>;
}
type ThreadList = { total: number; threads: { id: string; title: string; status: string; updatedAt: number; hostName: string | null; pinned: boolean }[] };
const threadCache = new Map<string, { at: number; data: ThreadList }>();
function useThreads(projectId: string, enabled: boolean) {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<ThreadList | null>(() => threadCache.get(projectId)?.data ?? null);
  useEffect(() => {
    if (!enabled) return;
    const hit = threadCache.get(projectId);
    if (hit) setData(hit.data);
    if (hit && Date.now() - hit.at < 30_000) return;
    let alive = true;
    void rpc.call('threads', { projectId }).then(next => { threadCache.set(projectId, { at: Date.now(), data: next }); if (alive) setData(next); }).catch(() => { if (alive) setData(old => old ?? { total: 0, threads: [] }); });
    return () => { alive = false; };
  }, [projectId, enabled, rpc]);
  return data;
}
/** Scroll the app sidebar to this project's thread group and flash it. Works in any thread-list view that marks project groups. */
function revealInSidebar(projectId: string) {
  const group = document.querySelector<HTMLElement>(`[data-sidebar-project-id="${CSS.escape(projectId)}"]`);
  if (!group) return false;
  const label = group.querySelector<HTMLElement>('[data-sidebar="group-label"] [aria-expanded="false"], [data-sidebar="group-label"][aria-expanded="false"]');
  label?.click();
  // Scroll the sidebar's own container so the group sits just below whatever is pinned at its top (sticky headers).
  let box: HTMLElement | null = group.parentElement;
  while (box && !(box.scrollHeight > box.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
  const behavior: ScrollBehavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
  if (box) {
    const top = box.getBoundingClientRect().top;
    let covered = 0;
    for (const el of Array.from(box.querySelectorAll<HTMLElement>('*'))) {
      if (el.contains(group) || group.contains(el)) continue;
      const style = getComputedStyle(el);
      if (style.position !== 'sticky' && style.position !== 'fixed') continue;
      const rect = el.getBoundingClientRect();
      if (rect.height && rect.top - top < 80) covered = Math.max(covered, rect.bottom - top);
    }
    box.scrollTo({ top: box.scrollTop + group.getBoundingClientRect().top - top - covered - 8, behavior });
  } else group.scrollIntoView({ block: 'start', behavior });
  group.classList.remove('catalog-flash');
  void group.offsetWidth;
  group.classList.add('catalog-flash');
  window.setTimeout(() => group.classList.remove('catalog-flash'), 2200);
  return true;
}
/** Who pulled or checked the project folder, where and with what result. Agents add rows through project_sync. */
function SyncHistory({ projectId }: { projectId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [events, setEvents] = useState<SyncEvent[] | null>(null);
  const load = useCallback(() => { void rpc.call('history', { projectId }).then(next => setEvents(next.events)).catch(() => setEvents(old => old ?? [])); }, [rpc, projectId]);
  useEffect(() => { setEvents(null); load(); }, [load]);
  useRealtime('history', (payload: unknown) => { if ((payload as { projectId?: string } | null)?.projectId === projectId) load(); });
  if (!events?.length) return null;
  const tone = (event: SyncEvent) => event.repos.some(repo => repo.reason === 'diverged' || repo.reason === 'merge-failed' || repo.reason === 'fetch-failed') ? 'bg-red-500'
    : event.repos.some(repo => repo.reason === 'dirty' || repo.reason === 'ahead' || repo.behind > 0) ? 'bg-amber-500'
    : event.repos.some(repo => repo.action === 'pulled') ? 'bg-sky-500' : 'bg-emerald-500';
  return <Section title="Синхронизация">
    <ul className="space-y-1.5">{events.slice(0, 8).map(event => <li key={`${event.at}:${event.hostId}`} className="flex items-start gap-2 text-xs">
      <span className={`mt-1.5 size-1.5 shrink-0 rounded-full ${tone(event)}`} aria-hidden="true"/>
      <div className="min-w-0 flex-1">
        <p className="text-foreground/90">{eventSummary(event)}</p>
        <p className="text-muted-foreground">{shortHost(event.hostName)}{event.apply ? '' : ' · проверка'} · {new Date(event.at).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
          {event.threadId && <> · <button type="button" className="cursor-pointer underline underline-offset-2 hover:text-foreground" onClick={() => navigate.toThread(event.threadId!)}>тред</button></>}</p>
      </div>
    </li>)}</ul>
    {events.length > 8 && <p className="text-xs text-muted-foreground">Ещё {events.length - 8} — <span className="font-mono">bb catalog history</span></p>}
  </Section>;
}
/** Extra copies BB made for this project's threads: forgotten ones first, with their size. */
function Worktrees({ projectId }: { projectId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [items, setItems] = useState<WorktreeView[] | null>(null);
  useEffect(() => {
    let alive = true;
    setItems(null);
    void rpc.call('worktrees', { projectId, sizes: false }).then(first => {
      if (!alive) return;
      setItems(first.worktrees);
      if (first.worktrees.length) void rpc.call('worktrees', { projectId, sizes: true }).then(next => { if (alive) setItems(next.worktrees); }).catch(() => undefined);
    }).catch(() => { if (alive) setItems([]); });
    return () => { alive = false; };
  }, [rpc, projectId]);
  if (!items?.length) return null;
  const copy = (value: string, what: string) => { void navigator.clipboard?.writeText(value).then(() => toast.success(`${what} скопирован`)); };
  const total = items.reduce((sum, item) => sum + (item.bytes ?? 0), 0);
  const dot: Record<WorktreeView['state'], string> = { missing: 'bg-red-500', orphan: 'bg-red-500', idle: 'bg-amber-500', active: 'bg-emerald-500', retiring: 'bg-muted-foreground' };
  return <Section title={`Worktree · ${items.length}${total ? ` · ${formatBytes(total)}` : ''}`}>
    <ul className="space-y-2">{items.map(item => <li key={item.environmentId} className="flex items-start gap-2 text-xs">
      <span className={`mt-1.5 size-1.5 shrink-0 rounded-full ${dot[item.state]}`} aria-hidden="true"/>
      <div className="min-w-0 flex-1">
        <p className="text-foreground/90">{item.branch ?? 'без ветки'} · {item.state === 'missing' ? 'папки нет' : formatBytes(item.bytes)} · {shortHost(item.hostName)}</p>
        <p className="text-muted-foreground">тредов {item.liveThreads}{item.archivedThreads ? ` (+${item.archivedThreads} в архиве)` : ''} · {WORKTREE_STATE_TEXT[item.state]}</p>
        <button type="button" className="block max-w-full cursor-pointer truncate text-left font-mono text-[11px] text-muted-foreground/80 hover:text-foreground" title="Скопировать путь" onClick={() => copy(item.path, 'Путь')}>{item.path}</button>
      </div>
    </li>)}</ul>
    <p className="text-xs text-muted-foreground">BB удаляет копию через 5 минут после архивации последнего её треда.</p>
  </Section>;
}
function ThreadList({ projectId, enabled, onNavigate }: { projectId: string; enabled: boolean; onNavigate?: () => void }) {
  const navigate = useBbNavigate();
  const data = useThreads(projectId, enabled);
  const reveal = () => { if (!revealInSidebar(projectId)) toast.message('В текущем виде боковой панели этого проекта нет'); onNavigate?.(); };
  return <div className="space-y-1.5">
    {!data && <p className="px-2 py-1 text-xs text-muted-foreground">Загрузка…</p>}
    {data && !data.threads.length && <p className="px-2 py-1 text-xs text-muted-foreground">Тредов пока нет</p>}
    {data && data.threads.length > 0 && <ul>{data.threads.map(thread => <li key={thread.id}>
      <button type="button" onClick={() => { onNavigate?.(); navigate.toThread(thread.id); }} className="catalog-row flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
        <span className={`size-1.5 shrink-0 rounded-full ${thread.status === 'active' ? 'bg-emerald-500' : thread.status === 'error' ? 'bg-red-500' : 'bg-transparent'}`} aria-label={thread.status === 'active' ? 'Работает' : thread.status === 'error' ? 'Ошибка' : undefined}/>
        <span className="min-w-0 flex-1 truncate text-[13px]" title={thread.title}>{thread.title}</span>
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{ago(thread.updatedAt).replace(' назад', '')}</span>
      </button></li>)}</ul>}
    <div className="flex flex-wrap gap-x-3.5 gap-y-1 px-2 pt-0.5 text-xs text-muted-foreground">
      <button type="button" className="inline-flex cursor-pointer items-center gap-1 hover:text-foreground" onClick={() => { onNavigate?.(); navigate.toProject(projectId); }}><Icon name="Plus" className="size-3.5" aria-hidden="true"/>Новый тред</button>
      <button type="button" className="inline-flex cursor-pointer items-center gap-1 hover:text-foreground" onClick={reveal}><Icon name="PanelLeft" className="size-3.5" aria-hidden="true"/>{data && data.total > data.threads.length ? `Все ${data.total} в боковой панели` : 'Показать в боковой панели'}</button>
    </div>
  </div>;
}
/** Threads of a project on hover or click of its icon in the list. */
function ThreadsButton({ project, onOpenChange }: { project: ProjectView; onOpenChange?: (open: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [up, setUp] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => { onOpenChange?.(open); }, [open, onOpenChange]);
  const show = () => { setUp((ref.current?.getBoundingClientRect().top ?? 0) > window.innerHeight * 0.55); setOpen(true); };
  const enter = () => { window.clearTimeout(timer.current); timer.current = window.setTimeout(show, 220); };
  const leave = () => { window.clearTimeout(timer.current); if (!pinned) timer.current = window.setTimeout(() => setOpen(false), 180); };
  const shut = () => { setOpen(false); setPinned(false); };
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) shut(); };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); shut(); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey, true); };
  }, [open]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return <div ref={ref} className="relative shrink-0" onMouseEnter={enter} onMouseLeave={leave}>
    <Button size="icon" variant="ghost" className="relative size-7 text-muted-foreground hover:text-foreground" aria-label={`Треды проекта «${project.name}»`} aria-expanded={open} data-tip={open ? undefined : 'Треды · клик — показать в боковой панели'}
      onClick={() => { if (open && pinned) shut(); else { show(); setPinned(true); revealInSidebar(project.id); } }}>
      <Icon name="MessageSquare" className="size-3.5" aria-hidden="true"/>
    </Button>
    {open && <div role="dialog" aria-label={`Треды проекта «${project.name}»`} className={`catalog-pop absolute right-0 z-30 w-80 rounded-xl border border-border bg-popover p-2 text-popover-foreground shadow-lg ${up ? 'bottom-full mb-1' : 'top-full mt-1'}`}>
      <p className="truncate px-2 pb-1.5 pt-1 text-xs text-muted-foreground">Недавние треды · {project.name}</p>
      <ThreadList projectId={project.id} enabled onNavigate={shut}/>
    </div>}
  </div>;
}

function Row({ project, active, onOpen, onEdit, onThread }: { project: ProjectView; active: boolean; onOpen: () => void; onEdit: () => void; onThread: () => void }) {
  const entry = project.entry;
  const quiet = project.verdict.level === 'ok' || project.verdict.level === 'info';
  const hosts = [...new Set(project.sources.map(source => shortHost(source.hostName)))];
  const [toolsOpen, setToolsOpen] = useState(false);
  return <li data-catalog-row={project.id} className={`catalog-row group relative flex items-start gap-3 rounded-lg px-2.5 py-2 sm:items-center ${active ? 'is-active' : ''} ${entry.status === 'archive' ? 'opacity-60' : ''}`}>
    <button type="button" onClick={onOpen} aria-current={active ? 'true' : undefined} className="absolute inset-0 cursor-pointer rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring" aria-label={`Открыть «${project.name}»`}/>
    <Avatar project={project} size="size-7"/>
    <div className="pointer-events-none relative min-w-0 flex-1">
      <p className="flex items-baseline gap-2">
        <span className="truncate text-sm font-medium" title={project.name}>{project.name}</span>
        {!quiet && <VerdictBadge project={project}/>}
      </p>
      <p className={`line-clamp-2 text-[13px] leading-5 sm:line-clamp-1 ${entry.summary ? 'text-muted-foreground' : 'italic text-muted-foreground/60'}`}>{entry.summary || 'Описания пока нет'}</p>
    </div>
    <span className="pointer-events-none relative hidden max-w-[7rem] shrink-0 truncate text-right text-xs text-muted-foreground sm:block" title={project.sources.map(source => `${source.hostName}: ${source.path}`).join('\n')}>{hosts.join(' · ') || '—'}</span>
    {/* Tools take no room of their own: they slide over the right edge of the row on hover, like the thread list in BB's sidebar. */}
    <div className={`catalog-row-bar absolute inset-y-0 right-0 flex items-center gap-0.5 rounded-r-lg pl-8 pr-1.5 ${toolsOpen ? 'is-open' : ''}`}>
      <ThreadsButton project={project} onOpenChange={setToolsOpen}/>
      <Button size="icon" variant="ghost" className="relative size-7 text-muted-foreground hover:text-foreground" aria-label={`Изменить описание, категории и теги «${project.name}»`} data-tip="Изменить" onClick={onEdit}>
        <Icon name="Pencil" className="size-3.5" aria-hidden="true"/>
      </Button>
      <Button size="icon" variant="ghost" className="relative size-7 text-muted-foreground hover:text-foreground" aria-label={`Новый тред в «${project.name}»`} data-tip="Новый тред" onClick={onThread}>
        <Icon name="Plus" className="size-4" aria-hidden="true"/>
      </Button>
    </div>
  </li>;
}

type Form = { summary: string; notes: string; category: string; tags: string; aliases: string; links: string; status: Status; independent: boolean; localPaths: string };
const toForm = (project: ProjectView): Form => ({
  summary: project.entry.summary, notes: project.entry.notes, category: project.entry.categories.join(', '),
  tags: project.entry.tags.join(', '), aliases: project.entry.aliases.join(', '),
  links: project.entry.links.map(link => `${link.label} = ${link.url}`).join('\n'), status: project.entry.status,
  independent: project.entry.independent, localPaths: project.entry.localPaths.join(', '),
});
const list = (text: string) => text.split(',').map(item => item.trim()).filter(Boolean);
const parseLinks = (text: string) => text.split('\n').map(row => row.trim()).filter(Boolean).map(row => {
  const at = row.indexOf('=');
  return at > 0 && !/^https?:/i.test(row.slice(0, at).trim()) ? { label: row.slice(0, at).trim(), url: row.slice(at + 1).trim() } : { label: '', url: row };
});

function Field({ label, hint, locked, onUnlock, children }: { label: string; hint?: ReactNode; locked?: boolean; onUnlock?: () => void; children: ReactNode }) {
  return <label className="block space-y-1.5">
    <span className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
      <span>{label}</span>
      {locked && onUnlock && <button type="button" className="inline-flex cursor-pointer items-center gap-1 hover:text-foreground" title="Поле закреплено за вами. Нажмите, чтобы ИИ снова мог его обновлять."
        onClick={event => { event.preventDefault(); onUnlock(); }}><Icon name="Lock" className="size-3" aria-hidden="true"/>ваш текст · открепить</button>}
    </span>
    {children}
    {hint && <span className="block text-xs text-muted-foreground/80">{hint}</span>}
  </label>;
}
const Section = ({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) => <section className="space-y-2">
  <div className="flex items-center justify-between gap-2"><h3 className="text-xs text-muted-foreground">{title}</h3>{action}</div>
  {children}
</section>;

/** All categories as toggles: chosen ones filled, the rest outlined; a new one is typed in place. Up to four, the first is primary. */
function CategoryPicker({ value, all, onChange }: { value: string[]; all: string[]; onChange: (next: string[]) => void }) {
  const [draft, setDraft] = useState('');
  const names = [...value, ...all.filter(name => !value.includes(name))];
  const full = value.length >= 4;
  const toggle = (name: string) => onChange(value.includes(name) ? value.filter(item => item !== name) : full ? value : [...value, name]);
  const add = () => { const name = draft.trim(); setDraft(''); if (name && !value.includes(name) && !full) onChange([...value, name]); };
  return <div className="flex flex-wrap gap-1.5">
    {names.map(name => { const on = value.includes(name); return <button key={name} type="button" aria-pressed={on} onClick={() => toggle(name)} disabled={!on && full}
      data-tip={on ? (value[0] === name && value.length > 1 ? 'Основная категория · нажмите, чтобы убрать' : 'Нажмите, чтобы убрать') : full ? 'Не больше четырёх категорий' : 'Добавить категорию'}
      className={`inline-flex h-7 cursor-pointer items-center gap-1 rounded-full border px-2.5 text-xs transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40 ${on ? 'border-foreground bg-foreground text-background' : 'border-border text-muted-foreground hover:border-foreground/40 hover:text-foreground'}`}>
      {on && <Icon name="Check" className="size-3" aria-hidden="true"/>}{name}</button>; })}
    {!full && <input value={draft} aria-label="Новая категория" placeholder="+ новая" onChange={event => setDraft(event.target.value)}
      onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); add(); } }} onBlur={add}
      className="h-7 w-24 rounded-full border border-dashed border-border bg-transparent px-2.5 text-xs placeholder:text-muted-foreground focus:w-36 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"/>}
  </div>;
}

const chip = 'inline-flex h-6 cursor-pointer items-center gap-1 rounded-full border px-2 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring';
/** Categories and tags change in one click, without opening the full form. */
function QuickMeta({ project, categories, onSaved }: { project: ProjectView; categories: string[]; onSaved: (next: ProjectView) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [picking, setPicking] = useState(false);
  const [draft, setDraft] = useState('');
  const [tag, setTag] = useState('');
  const entry = project.entry;
  const save = async (patch: { category?: string; tags?: string[] }) => {
    try { onSaved(await rpc.call('save', { projectId: project.id, patch })); } catch (error) { toast.error(String((error as Error).message ?? error)); }
  };
  const setCategories = (next: string[]) => save({ category: next.join(', ') });
  const toggle = (name: string) => setCategories(entry.categories.includes(name) ? entry.categories.filter(item => item !== name) : [...entry.categories, name]);
  const addCategory = () => { const name = draft.trim(); setDraft(''); if (name && !entry.categories.includes(name)) void setCategories([...entry.categories, name]); };
  const addTag = () => { const name = tag.trim(); setTag(''); if (name && !entry.tags.some(item => item.toLowerCase() === name.toLowerCase())) void save({ tags: [...entry.tags, name] }); };
  const others = categories.filter(name => !entry.categories.includes(name));
  const full = entry.categories.length >= 4;
  return <div className="space-y-3">
    <div className="space-y-1.5">
      <p className="text-xs text-muted-foreground">Категории</p>
      <div className="flex flex-wrap gap-1.5">
        {entry.categories.map((name, index) => <button key={name} type="button" onClick={() => void toggle(name)} title="Убрать категорию"
          className={`${chip} border-foreground/25 bg-muted text-foreground hover:border-destructive/60`}>{name}{index === 0 && entry.categories.length > 1 && <span className="text-[10px] text-muted-foreground">осн.</span>}<Icon name="X" className="size-3 text-muted-foreground" aria-hidden="true"/></button>)}
        {!full && <button type="button" aria-expanded={picking} onClick={() => setPicking(old => !old)} className={`${chip} border-dashed border-border text-muted-foreground hover:text-foreground`}><Icon name="Plus" className="size-3" aria-hidden="true"/>{entry.categories.length ? 'ещё' : 'категория'}</button>}
      </div>
      {picking && !full && <div className="flex flex-wrap items-center gap-1.5 rounded-lg bg-muted/40 p-2">
        {others.map(name => <button key={name} type="button" onClick={() => void toggle(name)} className={`${chip} border-border bg-background text-foreground/80 hover:border-foreground/40 hover:text-foreground`}>{name}</button>)}
        <input value={draft} aria-label="Новая категория" placeholder="новая…" onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addCategory(); } }} onBlur={addCategory}
          className="h-6 w-28 rounded-full border border-input bg-background px-2 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"/>
      </div>}
    </div>
    <div className="space-y-1.5">
      <p className="text-xs text-muted-foreground">Теги</p>
      <div className="flex flex-wrap items-center gap-1.5">
        {entry.tags.map(name => <button key={name} type="button" title="Убрать тег" onClick={() => void save({ tags: entry.tags.filter(item => item !== name) })}
          className={`${chip} border-border text-foreground/80 hover:border-destructive/60`}>{name}<Icon name="X" className="size-3 text-muted-foreground" aria-hidden="true"/></button>)}
        {entry.tags.length < 12 && <input value={tag} aria-label="Добавить тег" placeholder="+ тег" onChange={event => setTag(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addTag(); } }} onBlur={addTag}
          className="h-6 w-20 rounded-full border border-dashed border-border bg-transparent px-2 text-xs placeholder:text-muted-foreground focus:w-32 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"/>}
      </div>
    </div>
    {entry.aliases.length > 0 && <p className="text-xs text-muted-foreground">Называю: <span className="text-foreground/80">{entry.aliases.join(', ')}</span></p>}
  </div>;
}

function Detail({ project, categories, scanning, startEditing, onClose, onSaved }: { project: ProjectView; categories: string[]; scanning: boolean; startEditing: boolean; onClose: () => void; onSaved: (next: ProjectView) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [editing, setEditing] = useState(startEditing);
  const [form, setForm] = useState<Form>(() => toForm(project));
  const [busy, setBusy] = useState<string | null>(null);
  const entry = project.entry;
  const locked = (field: AutoField) => entry.locked.includes(field);
  const run = async (key: string, work: () => Promise<void>) => {
    setBusy(key);
    try { await work(); } catch (error) { toast.error(String((error as Error).message ?? error)); } finally { setBusy(null); }
  };
  const save = () => run('save', async () => {
    const next = await rpc.call('save', { projectId: project.id, patch: { summary: form.summary, notes: form.notes, category: form.category, tags: list(form.tags), aliases: list(form.aliases), links: parseLinks(form.links), status: form.status, independent: form.independent, localPaths: list(form.localPaths) } });
    onSaved(next); setForm(toForm(next)); setEditing(false); toast.success('Сохранено');
  });
  const release = (field: AutoField) => run(`unlock:${field}`, async () => { onSaved(await rpc.call('unlock', { projectId: project.id, fields: [field] })); });
  const copy = (text: string, what: string) => { void navigator.clipboard?.writeText(text).then(() => toast.success(`${what} скопирован`)); };
  const alarming = project.verdict.level === 'risk' || project.verdict.level === 'attention';
  const quick = 'inline-flex cursor-pointer items-center gap-1 rounded hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-60';
  const web = project.remote ? project.remote.replace(/^git@([^:]+):/, 'https://$1/').replace(/^ssh:\/\/git@/, 'https://').replace(/\.git$/, '') : null;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !editing) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [editing, onClose]);

  return <aside aria-label={`Проект ${project.name}`} className="catalog-detail absolute inset-0 z-20 flex flex-col bg-background lg:static lg:z-auto lg:w-[400px] lg:shrink-0 lg:border-l lg:border-border">
    <header className="flex items-center gap-3 px-5 pb-3 pt-5">
      <Avatar project={project} size="size-9"/>
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-base font-semibold">{project.name}</h2>
        <p className="truncate text-xs text-muted-foreground">{entry.categories.join(' · ') || NO_CATEGORY}{entry.status === 'paused' ? ' · на паузе' : entry.status === 'archive' ? ' · архив' : ''}</p>
      </div>
      <Button size="icon" variant="ghost" className="relative size-8 shrink-0 text-muted-foreground" aria-label="Закрыть" data-tip="Закрыть · Esc" onClick={onClose}><Icon name="X" className="size-4" aria-hidden="true"/></Button>
    </header>
    <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 pb-6">
      {!editing && <>
        <div className="space-y-2.5">
          <div className="flex gap-2">
            <Button size="sm" className="gap-1.5" onClick={() => navigate.toProject(project.id)}><Icon name="Plus" className="size-3.5" aria-hidden="true"/>Новый тред</Button>
            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => { setForm(toForm(project)); setEditing(true); }}><Icon name="Pencil" className="size-3.5" aria-hidden="true"/>Изменить</Button>
          </div>
          <div className="flex flex-wrap gap-x-3.5 gap-y-1.5 text-xs text-muted-foreground" role="group" aria-label="Быстрые действия">
            {project.sources[0] && <button type="button" className={quick} onClick={() => copy(project.sources[0]!.path, 'Путь')}><Icon name="Copy" className="size-3.5" aria-hidden="true"/>Путь</button>}
            {web && <a href={web} target="_blank" rel="noreferrer" className={quick}><Icon name="GitBranch" className="size-3.5" aria-hidden="true"/>Репозиторий</a>}
            <button type="button" disabled={scanning || busy !== null} className={quick} onClick={() => void run('refresh', async () => { await rpc.call('refresh', { projectId: project.id }); })}>
              <Icon name="RefreshCw" className={`size-3.5 ${scanning ? 'catalog-spin' : ''}`} aria-hidden="true"/>{scanning ? 'Проверяю…' : 'Проверить копии'}</button>
            <button type="button" disabled={busy !== null} className={quick} title="Отдельный тред: агент читает README и обновляет незакреплённые поля"
              onClick={() => void run('describe', async () => { const { threadId } = await rpc.call('describe_with_agent', { projectId: project.id }); toast.success('Агент описывает проект'); navigate.toThread(threadId); })}>
              <Icon name="Sparkles" className="size-3.5" aria-hidden="true"/>{busy === 'describe' ? 'Запускаю…' : 'Описать с ИИ'}</button>
            <button type="button" className={quick} onClick={() => copy(`bb catalog show ${project.id}`, 'Команда')}><Icon name="Copy" className="size-3.5" aria-hidden="true"/>Команда bb</button>
          </div>
        </div>
        <div className="space-y-3">
          <p className={`text-sm leading-relaxed ${entry.summary ? '' : 'italic text-muted-foreground'}`}>{entry.summary || 'Описания пока нет. Его напишет агент в первом треде проекта, или добавьте сами.'}</p>
          {entry.notes && <p className="whitespace-pre-wrap border-l-2 border-border pl-3 text-sm leading-relaxed text-muted-foreground">{entry.notes}</p>}
          {entry.links.length > 0 && <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm">{entry.links.map(link =>
            <a key={link.url} href={link.url} target="_blank" rel="noreferrer" className="inline-flex cursor-pointer items-center gap-1 underline underline-offset-2 hover:text-foreground"><Icon name="ExternalLink" className="size-3" aria-hidden="true"/>{link.label}</a>)}</p>}
        </div>
        <QuickMeta project={project} categories={categories} onSaved={onSaved}/>
        <Section title="Треды"><div className="-mx-2"><ThreadList projectId={project.id} enabled/></div></Section>
        <Section title="На машинах">
          {alarming && <p className={`flex items-start gap-1.5 text-sm ${LEVEL[project.verdict.level].text}`}><Icon name={LEVEL[project.verdict.level].icon} className="mt-0.5 size-4 shrink-0" aria-hidden="true"/>
            <span>{project.verdict.level === 'risk' ? 'Копии расходятся' : 'Есть несохранённая работа'}</span></p>}
          {!project.sources.length && <p className="text-sm text-muted-foreground">У проекта нет папки ни на одной машине.</p>}
          <ul className="space-y-3">{project.sources.map(source => {
            const state = sourceState(source);
            return <li key={source.id} className="group/src flex items-start gap-2.5">
              <Icon name={isMac(source.hostName) ? 'Laptop' : 'Server'} className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true"/>
              <div className="min-w-0 flex-1 space-y-0.5">
                <p className="flex items-center gap-1.5 text-sm"><span className="font-medium">{shortHost(source.hostName)}</span>
                  <span className={`size-1.5 shrink-0 rounded-full ${LEVEL[state.level].dot}`} aria-hidden="true"/>
                  <span className="min-w-0 truncate text-xs text-muted-foreground">{state.text}{!source.connected ? ' · офлайн' : ''}</span></p>
                <button type="button" className="block max-w-full cursor-pointer truncate text-left font-mono text-[11px] text-muted-foreground/80 hover:text-foreground" title="Скопировать путь" onClick={() => copy(source.path, 'Путь')}>{source.path}</button>
                {source.scan?.parts?.map(part => { const local = part.git.dirty + part.git.untracked; return <p key={part.path} className="truncate text-xs text-muted-foreground" title={part.path}>
                  <span className="text-foreground/80">{part.path.split('/').pop()}</span> — свой git{local ? ` · ${local} не закоммичено` : ''}{part.git.ahead ? ` · ${part.git.ahead} не отправлено` : ''}</p>; })}
              </div>
            </li>;
          })}</ul>
          {alarming && <ul className="space-y-1 text-xs text-muted-foreground">{project.verdict.details.map(detail => <li key={detail}>{detail}</li>)}</ul>}
          {project.diff && !entry.independent && project.diff.sample.length > 0 && <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Отличающиеся файлы: {project.diff.changed + project.diff.onlyA + project.diff.onlyB}</summary>
            <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto">{project.diff.sample.map(file => <li key={`${file.kind}:${file.path}`}>
              <span className="break-all font-mono">{file.path}</span>
              <span className="text-muted-foreground"> — {file.kind === 'changed' ? (file.newer ? `новее на ${shortHost(file.newer === 'a' ? project.diff!.a : project.diff!.b)}` : 'изменён') : `только на ${shortHost(file.kind === 'onlyA' ? project.diff!.a : project.diff!.b)}`}</span>
            </li>)}</ul>
          </details>}
          {entry.localPaths.length > 0 && <p className="text-xs text-muted-foreground">Не сравниваются (свои на каждой машине): {entry.localPaths.join(', ')}</p>}
          {entry.independent && <p className="text-xs text-muted-foreground">Копии помечены как разные и не сравниваются.</p>}
        </Section>
        <SyncHistory projectId={project.id}/>
        <Worktrees projectId={project.id}/>
      </>}
      {editing && <div className="space-y-4">
        <Field label="Описание" locked={locked('summary')} onUnlock={() => void release('summary')}>
          <textarea autoFocus className={fieldClass} rows={4} maxLength={600} value={form.summary} placeholder="Что это за проект и зачем он" onChange={event => setForm({ ...form, summary: event.target.value })}/>
        </Field>
        <Field label="Мои заметки" hint="ИИ этот текст не меняет.">
          <textarea className={fieldClass} rows={3} maxLength={4000} value={form.notes} placeholder="Что важно помнить" onChange={event => setForm({ ...form, notes: event.target.value })}/>
        </Field>
        <div className="space-y-1.5">
          <span className="flex items-center justify-between gap-2 text-xs text-muted-foreground"><span>Категории</span>
            {locked('category') && <button type="button" className="inline-flex cursor-pointer items-center gap-1 hover:text-foreground" data-tip="ИИ не меняет категории. Нажмите, чтобы разрешить" onClick={() => void release('category')}><Icon name="Lock" className="size-3" aria-hidden="true"/>ваш выбор · открепить</button>}</span>
          <CategoryPicker value={list(form.category)} all={categories} onChange={next => setForm({ ...form, category: next.join(', ') })}/>
        </div>
        <Field label="Статус">
          <select className={`${selectClass} w-full`} value={form.status} onChange={event => setForm({ ...form, status: event.target.value as Status })}>
            <option value="active">Активный</option><option value="paused">На паузе</option><option value="archive">Архив</option>
          </select>
        </Field>
        <Field label="Как ещё называю" locked={locked('aliases')} onUnlock={() => void release('aliases')} hint="Через запятую. По этим словам проект находят поиск и агенты.">
          <Input value={form.aliases} onChange={event => setForm({ ...form, aliases: event.target.value })}/>
        </Field>
        <Field label="Теги" locked={locked('tags')} onUnlock={() => void release('tags')}>
          <Input value={form.tags} onChange={event => setForm({ ...form, tags: event.target.value })}/>
        </Field>
        <Field label="Ссылки" locked={locked('links')} onUnlock={() => void release('links')} hint="По одной в строке: Название = https://…">
          <textarea className={`${fieldClass} font-mono text-xs`} rows={2} value={form.links} onChange={event => setForm({ ...form, links: event.target.value })}/>
        </Field>
        {project.sources.length > 1 && <div className="space-y-3 border-t border-border pt-4">
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input type="checkbox" className="size-4 cursor-pointer" checked={form.independent} onChange={event => setForm({ ...form, independent: event.target.checked })}/>
            Копии на машинах разные — не сравнивать
          </label>
          {!form.independent && <Field label="Папки, которые на каждой машине свои" hint="Через запятую, от корня проекта. В сравнении не участвуют.">
            <Input value={form.localPaths} onChange={event => setForm({ ...form, localPaths: event.target.value })}/>
          </Field>}
        </div>}
        <button type="button" className="block cursor-pointer font-mono text-[11px] text-muted-foreground/70 hover:text-foreground" title="Скопировать ID проекта" onClick={() => copy(project.id, 'ID')}>{project.id}</button>
      </div>}
    </div>
    {editing && <footer className="flex justify-end gap-2 border-t border-border px-5 py-3">
      <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Отмена</Button>
      <Button size="sm" disabled={busy !== null || JSON.stringify(form) === JSON.stringify(toForm(project))} onClick={() => void save()}>{busy === 'save' ? 'Сохраняю…' : 'Сохранить'}</Button>
    </footer>}
  </aside>;
}

let cached: Catalog | null = null;
type View = { kind: 'all' } | { kind: 'group'; name: string } | { kind: 'category'; name: string } | { kind: 'focus'; name: 'attention' | 'risk' | 'undescribed' | 'archive' } | { kind: 'machine'; id: string };
const viewKey = (view: View) => view.kind === 'all' ? 'all' : `${view.kind}:${'name' in view ? view.name : view.id}`;
const categoriesOf = (project: ProjectView) => project.entry.categories.length ? project.entry.categories : [NO_CATEGORY];
const typing = (target: EventTarget | null) => { const el = target as HTMLElement | null; return Boolean(el && (/input|textarea|select/i.test(el.tagName) || el.isContentEditable)); };

function NavItem({ label, count, active, tone, dim, onClick }: { label: string; count?: number; active: boolean; tone?: string; dim?: boolean; onClick: () => void }) {
  return <button type="button" aria-current={active ? 'true' : undefined} onClick={onClick} title={label}
    className={`catalog-nav ${dim && !active ? 'opacity-45' : ''} flex h-8 w-full cursor-pointer items-center justify-between gap-2 rounded-md px-2.5 text-left text-[13px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring ${active ? 'bg-muted font-medium text-foreground' : 'text-foreground/75 hover:bg-muted/60 hover:text-foreground'}`}>
    <span className="truncate">{label}</span>{count !== undefined && <span className={`shrink-0 text-xs tabular-nums ${tone ?? 'text-muted-foreground'}`}>{count}</span>}
  </button>;
}
/** Pencil that fades in only after the pointer rests on a row, so passing over rows to pick a filter stays calm. */
function EditTrigger({ label, open, onToggle }: { label: string; open: boolean; onToggle: () => void }) {
  return <button type="button" onClick={event => { event.stopPropagation(); onToggle(); }} aria-label={label} aria-expanded={open} title={label}
    className={`catalog-edit-trigger absolute right-8 top-1/2 flex size-6 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring ${open ? 'is-open' : ''}`}>
    <Icon name="Pencil" className="size-3" aria-hidden="true"/>
  </button>;
}
/** Small inline editor under a sidebar row: never clipped by the column, never covers the list. */
function InlineEditor({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return <div className="catalog-pop mx-1 mb-2 mt-1 space-y-2.5 rounded-lg border border-border bg-background p-2.5 shadow-sm" role="group" aria-label={title}>
    <p className="flex items-center justify-between text-[11px] text-muted-foreground">{title}
      <button type="button" onClick={onClose} aria-label="Закрыть" className="flex size-5 cursor-pointer items-center justify-center rounded hover:bg-muted hover:text-foreground"><Icon name="X" className="size-3" aria-hidden="true"/></button></p>
    {children}
  </div>;
}
const miniInput = 'h-7 w-full rounded-md border border-input bg-background px-2 text-[13px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring';
const miniChip = (on: boolean) => `inline-flex h-6 cursor-pointer items-center gap-1 rounded-full border px-2 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring ${on ? 'border-foreground bg-foreground text-background' : 'border-border text-muted-foreground hover:border-foreground/40 hover:text-foreground'}`;

function CategoryEditor({ name, group, groups, onSave, onClose }: { name: string; group: string; groups: string[]; onSave: (next: { name: string; group: string }) => Promise<void>; onClose: () => void }) {
  const [title, setTitle] = useState(name);
  const [target, setTarget] = useState(group);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const save = async () => { setBusy(true); try { await onSave({ name: title.trim() || name, group: target.trim() }); onClose(); } catch { /* reported by onSave */ } finally { setBusy(false); } };
  return <InlineEditor title="Категория" onClose={onClose}>
    <input autoFocus className={miniInput} value={title} aria-label="Название категории" onChange={event => setTitle(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void save(); }}/>
    <div className="space-y-1.5">
      <p className="text-[11px] text-muted-foreground">Группа</p>
      <div className="flex flex-wrap gap-1">
        {groups.map(item => <button key={item} type="button" aria-pressed={target === item} onClick={() => { setTarget(item); setAdding(false); }} className={miniChip(target === item)}>{item}</button>)}
        <button type="button" aria-pressed={target === '' && !adding} onClick={() => { setTarget(''); setAdding(false); }} className={miniChip(target === '' && !adding)}>Без группы</button>
        {adding
          ? <input autoFocus className="h-6 w-28 rounded-full border border-input bg-background px-2 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring" placeholder="Новая группа" aria-label="Новая группа"
              onChange={event => setTarget(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void save(); }}/>
          : <button type="button" onClick={() => { setAdding(true); setTarget(''); }} className={`${miniChip(false)} border-dashed`}><Icon name="Plus" className="size-3" aria-hidden="true"/>новая</button>}
      </div>
    </div>
    <div className="flex justify-end gap-1.5 pt-0.5">
      <Button size="sm" variant="ghost" className="h-7 px-2.5" onClick={onClose}>Отмена</Button>
      <Button size="sm" className="h-7 px-2.5" disabled={busy || (title.trim() === name && target.trim() === group)} onClick={() => void save()}>{busy ? 'Сохраняю…' : 'Сохранить'}</Button>
    </div>
  </InlineEditor>;
}

function GroupEditor({ name, size, onRename, onDelete, onClose }: { name: string; size: number; onRename: (next: string) => Promise<void>; onDelete: () => Promise<void>; onClose: () => void }) {
  const [title, setTitle] = useState(name);
  const [confirm, setConfirm] = useState(false);
  const save = async () => { if (title.trim() && title.trim() !== name) await onRename(title.trim()); onClose(); };
  return <InlineEditor title="Группа" onClose={onClose}>
    <input autoFocus className={miniInput} value={title} aria-label="Название группы" onChange={event => setTitle(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void save(); }}/>
    {confirm
      ? <div className="space-y-2 rounded-md bg-destructive/10 p-2 text-xs">
          <p>Удалить группу? {size === 1 ? 'Её категория останется' : `Её ${size} категории останутся`} в «Прочем».</p>
          <div className="flex justify-end gap-1.5">
            <Button size="sm" variant="ghost" className="h-7 px-2.5" onClick={() => setConfirm(false)}>Нет</Button>
            <Button size="sm" variant="destructive" className="h-7 px-2.5" onClick={() => void onDelete().then(onClose)}>Удалить</Button>
          </div>
        </div>
      : <>
          <div className="flex justify-end gap-1.5">
            <Button size="sm" variant="ghost" className="h-7 px-2.5" onClick={onClose}>Отмена</Button>
            <Button size="sm" className="h-7 px-2.5" disabled={!title.trim() || title.trim() === name} onClick={() => void save()}>Сохранить</Button>
          </div>
          <button type="button" onClick={() => setConfirm(true)} className="flex w-full cursor-pointer items-center gap-1.5 border-t border-border pt-2 text-xs text-muted-foreground hover:text-destructive">
            <Icon name="Trash" className="size-3" aria-hidden="true"/>Удалить группу</button>
        </>}
  </InlineEditor>;
}

/** A titled block of the sidebar; blocks are separated by a hairline so the structure reads at a glance. */
function NavSection({ title, count, active, onSelect, editor, children }: { title: string; count?: number; active?: boolean; onSelect?: () => void; editor?: { open: boolean; toggle: () => void; panel: ReactNode }; children: ReactNode }) {
  const head = 'text-[11px] font-semibold uppercase tracking-wider';
  return <section className="border-t border-border pt-3">
    <div className="catalog-navrow relative">
      {onSelect
        ? <button type="button" onClick={onSelect} aria-current={active ? 'true' : undefined} title="Все проекты группы"
            className={`catalog-nav flex h-7 w-full cursor-pointer items-center justify-between gap-2 rounded-md px-2.5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring ${head} ${active ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'}`}>
            <span className="truncate">{title}</span>{count !== undefined && <span className="shrink-0 font-normal normal-case tabular-nums tracking-normal">{count}</span>}
          </button>
        : <h2 className={`flex h-7 items-center px-2.5 text-muted-foreground ${head}`}>{title}</h2>}
      {editor && <EditTrigger label={`Изменить группу «${title}»`} open={editor.open} onToggle={editor.toggle}/>}
    </div>
    {editor?.open && editor.panel}
    <div className="mt-0.5 space-y-0.5">{children}</div>
  </section>;
}
function CategoryNavItem({ name, count, dim, active, onClick, editor }: { name: string; count: number; dim: boolean; active: boolean; onClick: () => void; editor?: { open: boolean; toggle: () => void; panel: ReactNode } }) {
  return <div>
    <div className="catalog-navrow relative">
      <NavItem label={name} count={count} dim={dim} active={active} onClick={onClick}/>
      {editor && <EditTrigger label={`Изменить категорию «${name}»`} open={editor.open} onToggle={editor.toggle}/>}
    </div>
    {editor?.open && editor.panel}
  </div>;
}

function CatalogPage({ subPath }: { subPath: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [data, setData] = useState<Catalog | null>(cached);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [view, setView] = useState<View>({ kind: 'all' });
  const [navQuery, setNavQuery] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [editId, setEditId] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const load = useCallback(async () => {
    try { const next = await rpc.call('catalog'); cached = next; setData(next); setError(''); }
    catch (reason) { setError(String((reason as Error).message ?? reason)); }
  }, [rpc]);
  useEffect(() => { void load(); }, [load]);
  useRealtime('changed', () => { void load(); });

  const projects = data?.projects ?? [];
  const groupOf = data?.groups ?? {};
  const openId = subPath ? decodeURIComponent(subPath.split('/')[0]!) : '';
  const opened = projects.find(project => project.id === openId) ?? null;
  const open = useCallback((id: string | null) => navigate.toPluginPanel('projects', id ? { subPath: id, replace: Boolean(openId) } : { replace: true }), [navigate, openId]);
  const close = useCallback(() => open(null), [open]);
  const live = useMemo(() => projects.filter(project => project.entry.status !== 'archive'), [projects]);
  const count = {
    attention: live.filter(project => project.verdict.level === 'attention').length,
    risk: live.filter(project => project.verdict.level === 'risk').length,
    undescribed: live.filter(project => !project.entry.summary).length,
    archive: projects.length - live.length,
  };
  const categories = useMemo(() => {
    const map = new Map<string, number>();
    for (const project of live) for (const name of categoriesOf(project)) map.set(name, (map.get(name) ?? 0) + 1);
    return [...map].sort((a, b) => Number(a[0] === NO_CATEGORY) - Number(b[0] === NO_CATEGORY) || a[0].localeCompare(b[0]));
  }, [live]);
  /** Categories arranged under their groups; ungrouped ones come last under a neutral heading. */
  const sections = useMemo(() => {
    const map = new Map<string, [string, number][]>();
    for (const item of categories) { const key = groupOf[item[0]] ?? ''; map.set(key, [...(map.get(key) ?? []), item]); }
    return [...map].sort((a, b) => Number(a[0] === '') - Number(b[0] === '') || a[0].localeCompare(b[0])).map(([name, items]) => ({ name, items }));
  }, [categories, groupOf]);
  const visible = useMemo(() => {
    let items = view.kind === 'focus' && view.name === 'archive' ? projects.filter(project => project.entry.status === 'archive') : live;
    if (view.kind === 'focus' && view.name === 'attention') items = items.filter(project => project.verdict.level === 'attention');
    if (view.kind === 'focus' && view.name === 'risk') items = items.filter(project => project.verdict.level === 'risk');
    if (view.kind === 'focus' && view.name === 'undescribed') items = items.filter(project => !project.entry.summary);
    if (view.kind === 'machine') items = items.filter(project => project.sources.some(source => source.hostId === view.id));
    if (view.kind === 'category') items = items.filter(project => categoriesOf(project).includes(view.name));
    if (view.kind === 'group') items = items.filter(project => categoriesOf(project).some(name => (groupOf[name] ?? '') === view.name));
    if (query.trim()) {
      const docs = items.map(project => ({ id: project.id, name: project.name, aliases: project.entry.aliases, category: project.entry.categories.join(' '), tags: project.entry.tags, summary: project.entry.summary, notes: project.entry.notes, paths: project.sources.map(source => source.path), project }));
      return search(docs, query).map(hit => hit.doc.project);
    }
    return [...items].sort((a, b) => a.name.localeCompare(b.name));
  }, [projects, live, view, query, groupOf]);
  /** With a project query, the sidebar becomes a facet: every section shows how many matches it holds. */
  const matched = useMemo(() => {
    if (!query.trim()) return null;
    const docs = live.map(project => ({ id: project.id, name: project.name, aliases: project.entry.aliases, category: project.entry.categories.join(' '), tags: project.entry.tags, summary: project.entry.summary, notes: project.entry.notes, paths: project.sources.map(source => source.path), project }));
    return search(docs, query).map(hit => hit.doc.project);
  }, [live, query]);
  const facet = (test: (project: ProjectView) => boolean, fallback: number) => matched ? matched.filter(test).length : fallback;
  const navMatch = (...names: string[]) => {
    const needle = normalize(navQuery);
    return !needle || names.some(name => normalize(name).includes(needle) || translit(name).includes(translit(navQuery)));
  };
  const grouped = !query.trim() && view.kind !== 'category';
  const groups = useMemo(() => {
    if (!grouped) return [{ name: '', items: visible }];
    const map = new Map<string, ProjectView[]>();
    for (const project of visible) { const key = categoriesOf(project)[0]!; map.set(key, [...(map.get(key) ?? []), project]); }
    const order = sections.flatMap(section => section.items.map(([name]) => name));
    return [...map].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])).map(([name, items]) => ({ name, items }));
  }, [visible, grouped, sections]);
  const flat = useMemo(() => groups.flatMap(group => group.items), [groups]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const inSearch = event.target === searchRef.current;
      if (event.key === '/' && !typing(event.target)) { event.preventDefault(); searchRef.current?.focus(); return; }
      if (typing(event.target) && !inSearch) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (!flat.length) return;
        event.preventDefault();
        const at = flat.findIndex(project => project.id === openId);
        const next = flat[Math.max(0, Math.min(flat.length - 1, at < 0 ? 0 : at + (event.key === 'ArrowDown' ? 1 : -1)))]!;
        open(next.id);
        document.querySelector(`[data-catalog-row="${next.id}"]`)?.scrollIntoView({ block: 'nearest' });
      } else if (event.key === 'Enter' && inSearch && flat[0]) { event.preventDefault(); open(flat[0].id); }
      else if ((event.key === 'n' || event.key === 'т') && !inSearch && opened) { event.preventDefault(); navigate.toProject(opened.id); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [flat, openId, open, opened, navigate]);

  const refresh = async () => { try { await rpc.call('refresh', { projectId: null }); } catch (reason) { toast.error(String((reason as Error).message ?? reason)); } };
  const patch = (next: ProjectView) => setData(old => { const merged = old ? { ...old, projects: old.projects.map(project => project.id === next.id ? next : project) } : old; cached = merged; return merged; });
  const setGroup = async (category: string, group: string) => {
    if ((groupOf[category] ?? '') === group.trim()) return;
    try { const result = await rpc.call('set_group', { category, group }); setData(old => { const merged = old ? { ...old, groups: result.groups } : old; cached = merged; return merged; }); }
    catch (reason) { toast.error(String((reason as Error).message ?? reason)); }
  };
  const applyGroups = (groups: Record<string, string>) => setData(old => { const merged = old ? { ...old, groups } : old; cached = merged; return merged; });
  const renameGroup = async (from: string, to: string) => {
    try { applyGroups((await rpc.call('rename_group', { from, to })).groups); } catch (reason) { toast.error(String((reason as Error).message ?? reason)); return; }
    if (view.kind === 'group' && view.name === from) setView(to ? { kind: 'group', name: to } : { kind: 'all' });
  };
  const saveCategory = async (from: string, next: { name: string; group: string }) => {
    try {
      let name = from;
      if (next.name !== from) { const result = await rpc.call('rename_category', { from, to: next.name }); applyGroups(result.groups); name = next.name; await load(); }
      if ((groupOf[from] ?? '') !== next.group || name !== from) await setGroup(name, next.group);
      if (view.kind === 'category' && view.name === from) setView({ kind: 'category', name });
    } catch (reason) { toast.error(String((reason as Error).message ?? reason)); throw reason; }
  };
  const groupNames = [...new Set(Object.values(groupOf))].sort((x, y) => x.localeCompare(y));
  const toggleEditor = (key: string) => setEditing(old => old === key ? null : key);
  const is = (other: View) => viewKey(view) === viewKey(other);
  const pick = (next: View) => setView(next);
  const resetAll = () => { setView({ kind: 'all' }); setQuery(''); setNavQuery(''); };
  const filters: { key: string; kind: string; label: string; clear: () => void }[] = [];
  if (view.kind === 'group') filters.push({ key: 'view', kind: 'Группа', label: view.name || 'Прочее', clear: () => setView({ kind: 'all' }) });
  if (view.kind === 'category') filters.push({ key: 'view', kind: groupOf[view.name] ? groupOf[view.name]! : 'Категория', label: view.name, clear: () => setView({ kind: 'all' }) });
  if (view.kind === 'machine') filters.push({ key: 'view', kind: 'Машина', label: shortHost(data?.hosts.find(host => host.id === view.id)?.name ?? ''), clear: () => setView({ kind: 'all' }) });
  if (view.kind === 'focus') filters.push({ key: 'view', kind: 'Состояние', label: { attention: 'Несохранённая работа', risk: 'Копии расходятся', undescribed: 'Без описания', archive: 'Архив' }[view.name], clear: () => setView({ kind: 'all' }) });
  if (query.trim()) filters.push({ key: 'query', kind: 'Поиск', label: query.trim(), clear: () => setQuery('') });
  if (navQuery.trim()) filters.push({ key: 'nav', kind: 'Разделы', label: navQuery.trim(), clear: () => setNavQuery('') });
  const title = view.kind === 'all' ? 'Все проекты' : view.kind === 'group' ? (view.name || 'Прочее') : view.kind === 'category' ? view.name : view.kind === 'machine' ? `На ${shortHost(data?.hosts.find(host => host.id === view.id)?.name ?? '')}`
    : view.name === 'attention' ? 'Несохранённая работа' : view.name === 'risk' ? 'Копии расходятся' : view.name === 'undescribed' ? 'Без описания' : 'Архив';
  const focusItems: { name: 'risk' | 'attention' | 'undescribed' | 'archive'; label: string; count: number; tone?: string }[] = [
    { name: 'risk' as const, label: 'Копии расходятся', count: count.risk, tone: 'font-medium text-red-600 dark:text-red-400' },
    { name: 'attention' as const, label: 'Несохранённая работа', count: count.attention, tone: 'font-medium text-amber-600 dark:text-amber-400' },
    { name: 'undescribed' as const, label: 'Без описания', count: count.undescribed },
    { name: 'archive' as const, label: 'Архив', count: count.archive },
  ].filter(item => item.count > 0);
  const options: { key: string; label: string; view: View }[] = [
    { key: 'all', label: `Все проекты · ${live.length}`, view: { kind: 'all' } },
    ...sections.flatMap(section => [
      ...(section.name ? [{ key: `group:${section.name}`, label: `${section.name} — вся группа`, view: { kind: 'group', name: section.name } as View }] : []),
      ...section.items.map(([name, total]) => ({ key: `category:${name}`, label: `${section.name ? '   ' : ''}${name} · ${total}`, view: { kind: 'category', name } as View })),
    ]),
    ...focusItems.map(item => ({ key: `focus:${item.name}`, label: `${item.label} · ${item.count}`, view: { kind: 'focus', name: item.name } as View })),
    ...(data?.hosts ?? []).map(host => ({ key: `machine:${host.id}`, label: `На ${shortHost(host.name)}`, view: { kind: 'machine', id: host.id } as View })),
  ];
  return <div className="relative flex h-full min-h-0">
    <nav aria-label="Разделы каталога" className="hidden w-60 shrink-0 flex-col border-r border-border md:flex">
      <div className="space-y-2 px-3 pb-3 pt-4">
        <div className="relative">
          <Icon name="Search" className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true"/>
          <input type="search" aria-label="Фильтр разделов" value={navQuery} placeholder="Категория, группа, машина" onChange={event => setNavQuery(event.target.value)}
            onKeyDown={event => { if (event.key === 'Escape') setNavQuery(''); }}
            className="h-8 w-full rounded-md border border-input bg-background pl-8 pr-2 text-[13px] placeholder:text-muted-foreground/70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"/>
        </div>
        {!navQuery.trim() && <NavItem label="Все проекты" count={matched ? matched.length : live.length} active={is({ kind: 'all' })} onClick={() => pick({ kind: 'all' })}/>}
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 pb-4">
        {sections.map(section => {
          const heading = section.name || (sections.length > 1 ? 'Прочее' : 'Категории');
          const items = section.items.filter(([name]) => navMatch(name, section.name || heading));
          if (!items.length) return null;
          const inGroup = (project: ProjectView) => categoriesOf(project).some(name => (groupOf[name] ?? '') === section.name);
          const total = facet(inGroup, live.filter(inGroup).length);
          const groupKey = `group:${section.name}`;
          return <NavSection key={section.name || 'rest'} title={heading} count={sections.length > 1 ? total : undefined}
            active={is({ kind: 'group', name: section.name })} onSelect={sections.length > 1 ? () => pick({ kind: 'group', name: section.name }) : undefined}
            editor={section.name ? { open: editing === groupKey, toggle: () => toggleEditor(groupKey), panel: <GroupEditor name={section.name} size={section.items.length}
              onRename={next => renameGroup(section.name, next)} onDelete={() => renameGroup(section.name, '')} onClose={() => setEditing(null)}/> } : undefined}>
            {items.map(([name, count]) => { const shown = facet(project => categoriesOf(project).includes(name), count); const key = `category:${name}`;
              return <CategoryNavItem key={name} name={name} count={shown} dim={shown === 0} active={is({ kind: 'category', name })} onClick={() => pick({ kind: 'category', name })}
                editor={name !== NO_CATEGORY ? { open: editing === key, toggle: () => toggleEditor(key), panel: <CategoryEditor name={name} group={groupOf[name] ?? ''} groups={groupNames}
                  onSave={next => saveCategory(name, next)} onClose={() => setEditing(null)}/> } : undefined}/>; })}
          </NavSection>;
        })}
        {focusItems.some(item => navMatch(item.label, 'Состояние')) && <NavSection title="Состояние">
          {focusItems.filter(item => navMatch(item.label, 'Состояние')).map(item => <NavItem key={item.name} label={item.label} count={item.count} tone={item.tone} active={is({ kind: 'focus', name: item.name })} onClick={() => pick({ kind: 'focus', name: item.name })}/>)}
        </NavSection>}
        {(data?.hosts.length ?? 0) > 1 && data!.hosts.some(host => navMatch(shortHost(host.name), host.name, 'Машины')) && <NavSection title="Машины">
          {data!.hosts.filter(host => navMatch(shortHost(host.name), host.name, 'Машины')).map(host => { const shown = facet(project => project.sources.some(source => source.hostId === host.id), live.filter(project => project.sources.some(source => source.hostId === host.id)).length);
            return <NavItem key={host.id} label={shortHost(host.name)} count={shown} dim={shown === 0} active={is({ kind: 'machine', id: host.id })} onClick={() => pick({ kind: 'machine', id: host.id })}/>; })}
        </NavSection>}
        {navQuery.trim() && <button type="button" className="w-full cursor-pointer px-2.5 pt-1 text-left text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground" onClick={() => setNavQuery('')}>Показать все разделы</button>}
      </div>
      <p className="flex items-center justify-between border-t border-border px-5 py-2.5 text-[11px] text-muted-foreground">
        <span><kbd className="catalog-kbd">/</kbd>поиск</span><span><kbd className="catalog-kbd">↑↓</kbd>выбор</span><span><kbd className="catalog-kbd">N</kbd>тред</span>
      </p>
    </nav>
    <div className="min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-4 py-5 sm:px-6">
        <header className="flex items-center justify-between gap-3">
          <h1 className="truncate text-lg font-semibold tracking-tight">{title}<span className="ml-2 text-sm font-normal tabular-nums text-muted-foreground">{data ? visible.length : ''}</span></h1>
          <button type="button" disabled={!data || data.scanning} onClick={() => void refresh()} data-tip="Проверить копии на машинах"
            className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground disabled:cursor-default disabled:opacity-60">
            <Icon name="RefreshCw" className={`size-3.5 ${data?.scanning ? 'catalog-spin' : ''}`} aria-hidden="true"/><span className="hidden sm:inline">{data?.scanning ? 'Проверяю машины…' : `Проверено ${ago(data?.scannedAt ?? null)}`}</span>
            <span className="sm:hidden">{data?.scanning ? 'Проверяю…' : ago(data?.scannedAt ?? null).replace(' назад', '')}</span>
          </button>
        </header>
        {error && <p role="alert" className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
        <div className="mt-4 flex gap-2">
          <div className="relative min-w-0 flex-1">
            <Icon name="Search" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true"/>
            <Input ref={searchRef} type="search" aria-label="Поиск по проектам" className="h-10 pl-9 md:h-9" value={query} placeholder={view.kind === 'all' ? 'Найти проект' : `Найти в разделе «${title}»`} onChange={event => setQuery(event.target.value)}/>
          </div>
          <select aria-label="Раздел" className={`${selectClass} h-10 w-[42%] shrink-0 md:hidden`} value={viewKey(view)} onChange={event => pick(options.find(option => option.key === event.target.value)?.view ?? { kind: 'all' })}>
            {options.map(option => <option key={option.key} value={option.key}>{option.label}</option>)}
          </select>
        </div>
        {filters.length > 0 && <div className="mt-2.5 flex flex-wrap items-center gap-1.5" aria-label="Применённые фильтры">
          {filters.map(filter => <span key={filter.key} className="inline-flex h-7 max-w-full items-center gap-1 rounded-full border border-border bg-muted/50 pl-2.5 pr-1 text-xs">
            <span className="text-muted-foreground">{filter.kind}:</span><span className="truncate font-medium">{filter.label}</span>
            <button type="button" onClick={filter.clear} aria-label={`Убрать фильтр «${filter.label}»`} className="flex size-5 cursor-pointer items-center justify-center rounded-full text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
              <Icon name="X" className="size-3" aria-hidden="true"/></button>
          </span>)}
          <button type="button" onClick={resetAll} className="ml-1 cursor-pointer text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">Сбросить фильтры</button>
        </div>}
        {query.trim() && view.kind !== 'all' && matched && matched.length > visible.length && <p className="mt-2 text-xs text-muted-foreground">
          В других разделах ещё {matched.length - visible.length}. <button type="button" className="cursor-pointer underline underline-offset-2 hover:text-foreground" onClick={() => pick({ kind: 'all' })}>Искать везде</button></p>}
        <div className="mt-4 space-y-6">
          {!data && !error && <ul className="space-y-1">{Array.from({ length: 10 }, (_, i) => <li key={i} className="catalog-skeleton h-[52px] rounded-lg bg-muted/40"/>)}</ul>}
          {data && !visible.length && <div className="px-2 py-16 text-center">
            <p className="text-sm">{query.trim() ? `По запросу «${query.trim()}» ничего не нашлось` : 'В этом разделе пусто'}</p>
            <Button size="sm" variant="outline" className="mt-4" onClick={() => { setQuery(''); pick({ kind: 'all' }); }}>Показать все проекты</Button>
          </div>}
          {groups.map(group => group.items.length > 0 && <section key={group.name || 'flat'}>
            {group.name && <h2 className="flex items-baseline gap-2 border-b border-border px-2.5 pb-1.5 text-xs font-medium text-muted-foreground">{group.name}<span className="tabular-nums opacity-70">{group.items.length}</span></h2>}
            <ul className={group.name ? 'mt-1' : ''}>{group.items.map(project => <Row key={project.id} project={project} active={project.id === openId} onOpen={() => { setEditId(''); open(project.id); }} onEdit={() => { setEditId(project.id); open(project.id); }} onThread={() => navigate.toProject(project.id)}/>)}</ul>
          </section>)}
        </div>
      </div>
    </div>
    {opened && <Detail key={`${opened.id}:${editId === opened.id}`} startEditing={editId === opened.id} project={opened} categories={categories.map(([name]) => name).filter(name => name !== NO_CATEGORY)} scanning={data?.scanning ?? false} onClose={close} onSaved={patch}/>}
  </div>;
}

export default definePluginApp(app => {
  app.experimental_icons.register({ name: 'project-catalog/grid', component: GridIcon });
  app.slots.navPanel({ id: 'projects', title: 'Проекты', icon: 'project-catalog/grid', path: 'projects', component: CatalogPage });
});
