import { useCallback, useEffect, useState, type FormEvent, type SVGProps } from 'react';
import { definePluginApp, useRealtime, useRpc, useComposer, useBbNavigate } from '@get-bb/plugin-sdk/app';
import { createPortal } from 'react-dom';
import { installComposerFooter, registerFooterRoute } from './composer-footer';
import type { rpcContract, Check, RouteContext, RouteState } from './contract';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import './proxy-ui.css';
import { ModelRoutePanel } from './model-route-ui';
function Icon({ name, ...props }: SVGProps<SVGSVGElement> & { name: string }) {
  const paths: Record<string, string> = {
    ChevronRight: 'm9 5 7 7-7 7',
    ArrowLeft: 'M19 12H5m7-7-7 7 7 7',
    Plus: 'M12 5v14M5 12h14',
    Laptop: 'M5 4h14v12H5zM3 16h18l1 4H2z',
    Server: 'M4 3h16v7H4zM4 14h16v7H4zM7 6.5h.01M7 17.5h.01M11 6.5h6M11 17.5h6',
    RefreshCw: 'M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 14 6M18 18A8 8 0 0 1 4 12',
    Network: 'M9 2h6v6H9zM2 16h6v6H2zM16 16h6v6h-6zM12 8v4M5 16v-4h14v4',
    Trash2: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
    Settings2: 'M9.5 3h5l.5 2 2 1 2-.5 2.5 4-1.5 1.5v2l1.5 1.5-2.5 4-2-.5-2 1-.5 2h-5l-.5-2-2-1-2 .5-2.5-4L4.5 13v-2L3 9.5l2.5-4 2 .5 2-1 .5-2zM15 12a3 3 0 1 0-6 0 3 3 0 0 0 6 0',
  };
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}><path d={paths[name] ?? paths.Network}/></svg>;
}
type ProxyView = { id: string; name: string; protocol: 'http' | 'https'; host: string; port: number; authenticated: boolean };
type Machine = { id: string; name: string; connected: boolean };
type Provider = { id: string; name: string; installed: boolean; available: boolean; message: string };
type Binding = { hostId: string; providerId: string; proxyId: string | null };
const selectClass = 'h-9 min-w-0 rounded-md border border-input bg-background px-3 text-sm';
function Dot({ check, offline, checking, live = false }: { check?: Check; offline?: boolean; checking?: boolean; live?: boolean }) {
  const stale = check && Date.now() - Date.parse(check.checkedAt) > (live ? 90_000 : 5 * 60_000);
  const label = offline ? 'Машина офлайн' : checking ? 'Проверяется' : !check ? 'Не проверено' : stale ? 'Проверка устарела' : check.ok ? 'Доступен' : 'Недоступен';
  const color = offline ? 'bg-red-500' : checking ? 'bg-amber-500' : !check || stale ? 'bg-slate-400' : check.ok ? 'bg-emerald-500' : 'bg-red-500';
  return <span role="img" aria-label={label} title={check ? `${label}. ${check.message}. ${new Date(check.checkedAt).toLocaleString()}` : label} className={`inline-block size-2.5 shrink-0 rounded-full ${color} ${live && check?.ok && !stale && !offline ? 'proxy-dot-live' : ''}`} />;
}
// Keep the originating surface while the plugin panel is open in this app tab.
let connectionOrigin: { path: string; hostId: string | null } | null = null;
let machineCache: Machine[] = [];
let providerCache: Record<string, Provider[]> = {};
let connectionData: { proxies: ProxyView[]; bindings: Binding[]; routes: Record<string, RouteState>; checks: Record<string, Check> } | null = null;
function ProxiesPage() {
  const navigate = useBbNavigate();
  const goBack = () => {
    const returnTo = connectionOrigin?.path ?? new URLSearchParams(window.location.search).get('returnTo');
    connectionOrigin = null;
    const thread = returnTo?.match(/^\/projects\/[^/]+\/threads\/([^/?#]+)(?:[/?#]|$)/);
    const project = returnTo?.match(/^\/projects\/([^/?#]+)\/?(?:[?#].*)?$/);
    if (thread) navigate.toThread(decodeURIComponent(thread[1]!));
    else if (project) navigate.toProject(decodeURIComponent(project[1]!));
    else if (returnTo && /^\/(?:[?#].*)?$/.test(returnTo)) navigate.toCompose();
    else if (window.history.length > 1) window.history.back();
    else navigate.toCompose();
  };

  const rpc = useRpc<typeof rpcContract>();
  const [proxies, setProxies] = useState<ProxyView[]>(() => connectionData?.proxies ?? []);
  const [machines, setMachines] = useState<Machine[]>(() => machineCache);
  const [providers, setProviders] = useState<Record<string, Provider[]>>(() => providerCache);
  const [providerErrors, setProviderErrors] = useState<Record<string, string>>({});
  const [bindings, setBindings] = useState<Binding[]>(() => connectionData?.bindings ?? []);
  const [routes, setRoutes] = useState<Record<string, RouteState>>(() => connectionData?.routes ?? {});
  const [checks, setChecks] = useState<Record<string, Check>>(() => connectionData?.checks ?? {});
  const [hostId, setHostId] = useState(() => connectionOrigin?.hostId ?? new URLSearchParams(window.location.search).get('host') ?? '');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(() => !machineCache.length);
  const [adding, setAdding] = useState(false);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const emptyForm = { name: '', protocol: 'http' as 'http' | 'https', host: '', port: '3128', username: '', password: '' };
  const [form, setForm] = useState(emptyForm);
  const [, tick] = useState(0);
  const report = useCallback((e: unknown) => setError(e instanceof Error ? e.message : 'Операция не выполнена'), []);
  const refresh = useCallback(async () => {
    try { const data = await rpc.call('list'); connectionData = data; setProxies(data.proxies); setBindings(data.bindings); setChecks(data.checks); setRoutes(data.routes); }
    catch (e) { report(e); }
  }, [rpc, report]);
  const discover = useCallback(async (force = false) => {
    try {
      const hosts = await rpc.call('machines'); machineCache = hosts; setMachines(hosts); setLoading(false); setHostId(old => old || hosts.find(h => h.connected)?.id || '');
      await Promise.all(hosts.filter(h => h.connected).map(async h => {
        try { const entries = await rpc.call('providers', { hostId: h.id, force }); providerCache = { ...providerCache, [h.id]: entries }; setProviders(old => ({ ...old, [h.id]: entries })); setProviderErrors(old => ({ ...old, [h.id]: '' })); }
        catch { setProviderErrors(old => ({ ...old, [h.id]: 'Не удалось получить список CLI' })); }
      }));
    } catch (e) { report(e); }
    finally { setLoading(false); }
  }, [rpc, report]);
  useEffect(() => { void refresh(); void discover(); const timer = setInterval(() => { tick(x => x + 1); void refresh(); }, 5000); return () => clearInterval(timer); }, [refresh, discover]);
  useRealtime('changed', refresh);
  const action = async (key: string, fn: () => Promise<unknown>) => {
    if (pending[key]) return; setPending(old => ({ ...old, [key]: true })); setError('');
    try { await fn(); await refresh(); } catch (e) { report(e); } finally { setPending(old => ({ ...old, [key]: false })); }
  };
  const bind = (machine: string, proxyId: string | null) => action(`bind:${machine}`, async () => {
    await rpc.call('bind', { hostId: machine, providerId: 'codex', proxyId });
    await rpc.call('check', { hostId: machine, proxyId });
  });
  const add = (event: FormEvent) => { event.preventDefault(); void action('add', async () => {
    await rpc.call('add', { ...form, port: Number(form.port) }); setForm(emptyForm); setAdding(false);
  }); };
  const machine = machines.find(m => m.id === hostId);
  return <div className="h-full overflow-y-auto"><div className="proxy-page mx-auto max-w-3xl space-y-5 px-4 py-4 sm:px-6">
    <header className="sticky top-0 z-10 -mt-1 flex items-center gap-3 border-b border-border/60 bg-background py-2">
      <Button variant="ghost" size="sm" className="shrink-0 gap-1.5" onClick={goBack}><Icon name="ArrowLeft" className="size-4"/>Назад</Button>
      <div className="min-w-0"><h1 className="text-base font-semibold tracking-tight">Подключения</h1><p className="text-xs text-muted-foreground">Агенты и маршруты подключения</p></div>
    </header>
    {error && !adding && <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
    <ModelRoutePanel machines={machines}/>
    <section className="space-y-2">
      <div className="flex items-center justify-between"><h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Сетевые прокси CLI</h2><Button size="icon" variant="ghost" className="size-7" aria-label="Обновить машины" onClick={() => void discover(true)}><Icon name="RefreshCw" className="size-3.5"/></Button></div>
      {loading && <p className="text-sm text-muted-foreground">Загрузка…</p>}
      <div className="space-y-2.5">{machines.map(m => {
        const installed = (providers[m.id] ?? []).filter(p => p.installed);
        const status = !m.connected ? 'Офлайн' : providerErrors[m.id] ? 'Ошибка проверки' : !providers[m.id] ? 'Проверяю…' : `Агенты: ${installed.length}`;
        return <details key={m.id} open className="proxy-machine-group overflow-hidden rounded-lg border border-border bg-muted/20">
          <summary className="proxy-machine-summary flex min-h-10 cursor-pointer list-none items-center gap-2 bg-muted/50 px-3 py-2 text-sm hover:bg-muted/70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
            <Icon name="ChevronRight" className="proxy-machine-chevron size-3 shrink-0 text-muted-foreground"/>
            <Icon name={m.name.toLowerCase().includes('mac') ? 'Laptop' : 'Server'} className="size-4 shrink-0 text-muted-foreground"/>
            <span className="min-w-0 flex-1 truncate font-semibold" title={m.name}>{m.name}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{status}</span>
            <span role="img" aria-label={m.connected ? 'Машина на связи' : 'Машина офлайн'} className={`size-1.5 shrink-0 rounded-full ${m.connected ? 'bg-emerald-500' : 'bg-slate-400'}`}/>
          </summary>
          <div className="proxy-agent-branch my-2 ml-7 mr-2 space-y-1.5 border-l-2 border-border pl-3">
            {providerErrors[m.id] ? <p role="alert" className="py-2 text-xs text-destructive">{providerErrors[m.id]}</p> : !m.connected && !installed.length ? <p className="py-2 text-xs text-muted-foreground">Агенты будут доступны после подключения</p> : !providers[m.id] ? <p className="py-2 text-xs text-muted-foreground">Проверяю установленные CLI…</p> : !installed.length ? <p className="py-2 text-xs text-muted-foreground">Нет установленных агентов</p> : installed.map(p => {
              const binding = bindings.find(b => b.hostId === m.id && b.providerId === p.id);
              const route = routes[m.id];
              const enabled = m.connected && p.available && p.id === 'codex';
              const busy = pending[`bind:${m.id}`] || route?.phase === 'switching';
              const check = checks[`${m.id}:${binding?.proxyId ?? 'direct'}`];
              const needsApply = enabled && route?.phase !== 'ready';
              return <div key={p.id} className="proxy-agent-row relative flex min-h-10 items-center gap-2 rounded-md border border-border/60 bg-background px-2.5 py-1">
                <span className="min-w-0 flex-1 truncate text-sm" title={p.name}>{p.name}</span>
                {!enabled ? <span className="max-w-[60%] text-right text-xs text-muted-foreground" title={p.id !== 'codex' ? 'Маршрутом управляет сам CLI; плагин его не меняет' : p.message}>{!m.connected ? 'Офлайн' : !p.available ? p.message : 'Прокси не управляется'}</span> : <div className="proxy-machine-controls flex shrink-0 flex-wrap items-center justify-end gap-2">
                  <Dot live check={route?.phase === 'ready' ? check : undefined} checking={!!busy}/>
                  <select aria-label={`Прокси ${p.name} · ${m.name}`} title="Смена прокси остановит текущие ответы Codex" className="h-8 w-32 min-w-0 truncate rounded-md border-0 bg-muted/50 px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" value={binding?.proxyId ?? 'direct'} disabled={!!busy} onChange={e => void bind(m.id, e.target.value === 'direct' ? null : e.target.value)}>
                    <option value="direct">Напрямую</option>{proxies.map(proxy => <option key={proxy.id} value={proxy.id}>{proxy.name}</option>)}
                  </select>
                  {busy ? <span className="text-xs text-muted-foreground">Переключение…</span> : needsApply ? <Button size="sm" variant="ghost" className="h-8" onClick={() => void bind(m.id, binding?.proxyId ?? null)}>{route?.phase === 'error' ? 'Повторить' : 'Включить'}</Button> : check && !check.ok ? <span role="img" aria-label={check.message} title={check.message} className="text-amber-600">⚠</span> : null}
                </div>}
              </div>;
            })}
          </div>
        </details>;
      })}</div>
      <p className="text-xs text-muted-foreground">Этот блок меняет общие сетевые настройки Codex, включая внешние CLI. Для обхода OpenCodex только в BB используйте переключатели выше.</p>
    </section>
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Прокси <span className="ml-1 opacity-60">{proxies.length}</span></h2><div className="flex flex-wrap items-center gap-3"><select aria-label="Проверять прокси с машины" title="Машина для проверки" className="max-w-56 truncate rounded bg-transparent py-1 text-xs text-muted-foreground" value={hostId} onChange={e => setHostId(e.target.value)}>{machines.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select><Button size="sm" onClick={() => { setError(''); setAdding(true); }}><Icon name="Plus" className="mr-1.5 size-4"/>Добавить прокси</Button></div></div>
      {!proxies.length ? <button onClick={() => setAdding(true)} className="w-full rounded-xl border border-dashed border-border p-7 text-sm text-muted-foreground hover:bg-muted/30">＋ Добавить первый прокси</button> : <div className="divide-y divide-border/60">{proxies.map(p => {
        const key = `${hostId}:${p.id}`, result = checks[key];
        return <div key={p.id} className="flex items-center gap-3 py-2">
          <span className="flex size-9 items-center justify-center rounded-lg bg-muted/50 text-muted-foreground"><Icon name="Network" className="size-4"/></span>
          <div className="min-w-0 flex-1"><p className="flex items-center gap-2 text-sm font-medium">{p.name}<Dot check={result} offline={!!machine && !machine.connected} checking={pending[key]}/></p><p className="mt-0.5 truncate text-xs text-muted-foreground">{p.host}:{p.port}{result?.country ? ` · ${result.country}` : ''}</p></div>
          <Button size="icon" variant="ghost" className="size-8" aria-label={`Проверить ${p.name}`} disabled={!machine?.connected || pending[key]} onClick={() => void action(key, () => rpc.call('check', { hostId, proxyId: p.id }))}><Icon name="RefreshCw" className={`size-3.5 ${pending[key] ? 'animate-spin' : ''}`}/></Button>
          <Button size="icon" variant="ghost" className="size-8 text-muted-foreground" aria-label={`Удалить ${p.name}`} disabled={bindings.some(b => b.proxyId === p.id) || pending[`remove:${p.id}`]} onClick={() => void action(`remove:${p.id}`, () => rpc.call('remove', { id: p.id }))}><Icon name="Trash2" className="size-3.5"/></Button>
        </div>;
      })}</div>}
    </section>
    <details className="text-xs text-muted-foreground"><summary className="w-fit cursor-pointer">Как работает подключение</summary><p className="mt-2 max-w-xl leading-relaxed">Прокси применяется на выбранной машине ко всем сессиям Codex с общими настройками, включая новые запуски вне BB. Цвет показывает доступность маршрута, а не вход в аккаунт. Claude не изменяется.</p></details>
    <Dialog open={adding} onOpenChange={setAdding}><DialogContent className="sm:max-w-md"><DialogHeader><DialogTitle>Новый прокси</DialogTitle><DialogDescription>HTTP или HTTPS с поддержкой CONNECT.</DialogDescription></DialogHeader>
      <form onSubmit={add} className="space-y-4" autoComplete="off">
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <label className="block space-y-1.5 text-sm"><span>Название</span><Input autoFocus required maxLength={80} placeholder="Например, DE" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}/></label>
        <div className="grid grid-cols-[1fr_85px] gap-3"><label className="space-y-1.5 text-sm"><span>Адрес</span><Input required placeholder="IP или хост" value={form.host} onChange={e => setForm({ ...form, host: e.target.value })}/></label><label className="space-y-1.5 text-sm"><span>Порт</span><Input required type="number" min={1} max={65535} value={form.port} onChange={e => setForm({ ...form, port: e.target.value })}/></label></div>
        <label className="flex items-center justify-between text-sm"><span>Протокол</span><select className={selectClass} value={form.protocol} onChange={e => setForm({ ...form, protocol: e.target.value as 'http' | 'https' })}><option value="http">HTTP</option><option value="https">HTTPS</option></select></label>
        <details className="rounded-lg border border-border p-3"><summary className="cursor-pointer text-sm">Логин и пароль <span className="text-xs text-muted-foreground">· если нужны</span></summary><div className="mt-3 grid gap-3 sm:grid-cols-2"><Input aria-label="Логин прокси" placeholder="Логин" value={form.username} onChange={e => setForm({ ...form, username: e.target.value })}/><Input aria-label="Пароль прокси" type="password" autoComplete="new-password" placeholder="Пароль" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })}/></div></details>
        <DialogFooter><Button type="button" variant="ghost" onClick={() => setAdding(false)}>Отмена</Button><Button type="submit" disabled={pending.add}>{pending.add ? 'Добавляю…' : 'Добавить'}</Button></DialogFooter>
      </form>
    </DialogContent></Dialog>
  </div></div>;
}

function RouteBadge() {
  const navigate = useBbNavigate();
  const [anchor, setAnchor] = useState<HTMLSpanElement | null>(null);
  const [footerTarget, setFooterTarget] = useState<HTMLElement | null>(null);
  useEffect(() => anchor ? registerFooterRoute(anchor, setFooterTarget) : undefined, [anchor]);
  const composer = useComposer();
  const rpc = useRpc<typeof rpcContract>();
  const selection = composer.selection;
  const threadId = composer.scope.kind === 'new-thread' ? null : composer.scope.threadId;
  const environment = selection?.environment;
  const hostId = environment?.type === 'host' ? environment.hostId ?? null : environment?.type === 'provider' && environment.machine?.type === 'existing' ? environment.machine.hostId : null;
  const environmentId = environment?.type === 'reuse' ? environment.environmentId : null;
  const providerId = selection?.providerId ?? null;
  const contextKey = JSON.stringify([threadId, hostId, environmentId, providerId]);
  const [resolved, setResolved] = useState<{ key: string; route: RouteContext | null; error: boolean } | null>(null);
  const route = resolved?.key === contextKey ? resolved.route : null;
  const error = resolved?.key === contextKey && resolved.error;
  const refresh = useCallback(async () => {
    try { const next = await rpc.call('route_context', { threadId, hostId, environmentId, providerId }); setResolved({ key: contextKey, route: next, error: false }); }
    catch { setResolved({ key: contextKey, route: null, error: true }); }
  }, [rpc, threadId, hostId, environmentId, providerId, contextKey]);
  useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(), 5000); return () => clearInterval(timer); }, [refresh]);
  useRealtime('changed', refresh);
  const codex = (route?.providerId ?? providerId) === 'codex';
  const claude = (route?.providerId ?? providerId) === 'claude-code';
  const claudeCheck = route?.claudeRoute;
  const claudeFresh = !!claudeCheck && Date.now() - Date.parse(claudeCheck.checkedAt) < 15_000;
  const claudeConfirmed = claudeFresh && ['direct', 'proxy'].includes(claudeCheck!.state);
  const providerName = (route?.providerId ?? providerId) === 'claude-code' ? 'Claude Code' : codex ? 'Codex' : route?.providerId ?? providerId ?? 'Агент';
  const warning = error ? 'Не удалось проверить подключение' : route && !route.connected ? 'Машина офлайн' : codex && route ? route.warning || (route.check && !route.check.ok ? route.check.message : null) : null;
  const detail = route ? `${route.hostName} · ${providerName} · ${codex ? route.applied ? 'Проверка каждые 30 секунд' : 'Маршрут не применён плагином' : claude ? claudeCheck?.message ?? 'Проверяю процесс Claude без изменения маршрута' : 'Маршрут этого CLI не проверяется'}` : 'Выбор машины и агента — в настройках подключения';
  const label = route?.modelMode ? route.modelMode === 'direct' ? 'Модели: напрямую' : 'Модели: OpenCodex' : claude ? !claudeFresh ? 'Проверяю маршрут' : claudeCheck?.state === 'direct' ? 'Без прокси' : claudeCheck?.state === 'proxy' ? 'Прокси Claude' : claudeCheck?.state === 'inactive' ? 'Claude не запущен' : 'Маршрут не проверен' : !codex ? 'Маршрут CLI' : route?.proxyName ?? 'Без прокси';
  const settingsHost = route?.hostId ?? hostId;
  const settingsParams = new URLSearchParams({ returnTo: window.location.pathname + window.location.search + window.location.hash });
  if (settingsHost) settingsParams.set('host', settingsHost);
  const settingsUrl = `/plugins/proxy-manager/proxies?${settingsParams}`;
  const chip = <a href={settingsUrl} onPointerDown={event => {
    if (event.pointerType === 'mouse' && event.button === 0) event.preventDefault();
    event.stopPropagation();
  }} onClick={event => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    connectionOrigin = { path: window.location.pathname + window.location.search + window.location.hash, hostId: settingsHost };
    navigate.toPluginPanel('proxies');
  }} className="proxy-route inline-flex h-6 min-w-0 max-w-full items-center gap-1.5 rounded-md px-1 text-xs leading-tight text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring" aria-label={`Настройки прокси · ${label}`} title={warning ? `${detail} · ${warning}` : detail}>
    <Icon name="Network" className="size-3.5 shrink-0"/>
    {claude ? <span role="img" aria-label={route && !route.connected ? 'Машина офлайн' : claudeConfirmed ? 'Маршрут определён по TCP-соединению процесса' : 'Маршрут не подтверждён'} title={claudeCheck?.message} className={`inline-block size-2.5 shrink-0 rounded-full ${route && !route.connected ? 'bg-red-500' : claudeConfirmed ? 'bg-emerald-500' : 'bg-slate-400'}`} /> : <Dot live={codex} check={codex && route?.applied ? route.check ?? undefined : undefined} offline={route ? !route.connected : undefined}/> }
    <span className="proxy-route-label min-w-0 truncate">{label}</span>
    {warning && <span role="img" aria-label={warning} className="shrink-0 text-amber-600">⚠</span>}
  </a>;
  return <><span ref={setAnchor} hidden data-proxy-route-anchor=""/>{footerTarget ? createPortal(chip, footerTarget) : chip}</>;

}
export default definePluginApp(app => {
  app.contentScripts.register({ id: 'composer-route-footer', mount: ({ signal }) => installComposerFooter(signal) });
  // A bare banner, not a composer action: the chip is portaled into the footer,
  // and bb shows only three plugin action groups inline before a "…" overflow,
  // so an invisible anchor there pushed a real action (voice mode) into "…".
  app.composer.customize({ id: 'proxy-route', scopes: ['thread', 'new-thread'], banners: [{ id: 'route', chrome: 'bare', component: RouteBadge }] });
  app.slots.navPanel({ id: 'proxies', title: 'Прокси', icon: 'Network', path: 'proxies', component: ProxiesPage });
  app.slots.settingsSection({ id: 'connections', title: 'Прокси и подключения', component: ProxiesPage });
});
