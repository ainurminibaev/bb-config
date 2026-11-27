// «Аккаунты и объёмы»: one page for every way of billing — subscription windows
// and prepaid packages on the same scale (used share with a pace tick), the
// size of each plan in tokens with its source, used-percent history, and a BB
// thread to discuss it. VClaude keeps its own analysis as a tab.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { experimental_useProviders, useBbNavigate, useRpc } from '@get-bb/plugin-sdk/app';
import { ProviderMark } from './provider-icons';
import type { Account, QuotaWindow, rpcContract } from './contract';
import { ahead, isPackageAccount, pace, planLabel, wasteRisk } from './logic';
import { VClaudePanel } from './vclaude-panel';

type Tab = 'overview' | 'volumes' | 'history' | 'vclaude';
type Kind = 'all' | 'window' | 'package';
type Sort = 'load' | 'reset' | 'provider';
// ACP accounts carry their BB provider name (displayName), e.g. «Прямой Gemini».
const tag: Record<string, true> = { 'acp-antigravity-acp': true, 'acp-gemini-antig': true };
const confidence: Record<string, string> = { official: 'официально', measured: 'замер', estimate: 'оценка', none: 'нет данных' };
const pct = (v: number) => `${Math.round(v)}%`;
const name = (a: Account) => a.providerId === 'vclaude' ? 'VClaude' : `${a.providerName} · ${a.email?.split('@')[0] ?? '—'}`;
const tokens = (v: number) => v >= 1e9 ? `${(v / 1e9).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} млрд`
  : v >= 1e6 ? `${(v / 1e6).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} млн` : `${Math.round(v / 1e3)} тыс.`;
const money = (v: number) => `$${v < 10 ? v.toLocaleString('en-US', { maximumFractionDigits: 2 }) : Math.round(v).toLocaleString('en-US')}`;
function when(w: QuotaWindow, now: number) {
  const at = Date.parse(w.endsAt ?? w.resetsAt ?? '');
  if (!Number.isFinite(at)) return '—';
  const date = new Date(at).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  if (w.endsAt) return `до ${date}`;
  const m = Math.max(0, Math.round((at - now) / 60_000));
  return `${m < 60 ? `${m} мин` : m < 1440 ? `${Math.floor(m / 60)} ч ${m % 60} мин` : `${Math.floor(m / 1440)} д ${Math.floor(m % 1440 / 60)} ч`} · ${date}`;
}
const worst = (a: Account) => Math.max(0, ...a.windows.map(w => w.usedPercent));
const soonest = (a: Account) => Math.min(Infinity, ...a.windows.map(w => Date.parse(w.endsAt ?? w.resetsAt ?? '') || Infinity));
const problem = (a: Account, now: number) => a.status !== 'ok' || a.windows.some(w => ahead(w, now) || wasteRisk(w, now) || w.usedPercent >= 90);

function Bar({ w, now }: { w: QuotaWindow; now: number }) {
  const gone = pace(w, now);
  const fast = ahead(w, now);
  return <span className="tau-page-bar" title={`${w.label}: ${pct(w.usedPercent)} израсходовано${gone !== null ? `, прошло ${pct(gone)} периода` : ''}${fast ? ' — расход опережает время' : ''}${wasteRisk(w, now) ? ' — пакет может сгореть неиспользованным' : ''}`}>
    <span className="tau-bar"><span style={{ width: `${Math.min(100, Math.max(0, w.usedPercent))}%` }} />{gone !== null && w.usedPercent < 100 && <i className="tau-pace" data-ahead={fast} style={{ left: `${gone}%` }} />}</span>
    <b data-bad={fast || w.usedPercent >= 90}>{pct(w.usedPercent)}</b>
  </span>;
}

function Overview({ accounts, now, onAccount, logos }: { accounts: Account[]; now: number; onAccount: (a: Account) => void; logos: Record<string, string | null> }) {
  const [provider, setProvider] = useState('all');
  const [machine, setMachine] = useState('all');
  const [kind, setKind] = useState<Kind>('all');
  const [problems, setProblems] = useState(false);
  const [sort, setSort] = useState<Sort>('load');
  const providers = [...new Map(accounts.map(a => [a.providerId, a.providerName])).entries()];
  const machines = [...new Set(accounts.flatMap(a => a.hostNames.map(h => h.replace(/\s*[—–].*$/, '').trim())))];
  const list = accounts
    .filter(a => provider === 'all' || a.providerId === provider)
    .filter(a => machine === 'all' || a.hostNames.some(h => h.startsWith(machine)))
    .filter(a => kind === 'all' || (kind === 'package') === isPackageAccount(a))
    .filter(a => !problems || problem(a, now))
    .sort((a, b) => sort === 'load' ? worst(b) - worst(a) : sort === 'reset' ? soonest(a) - soonest(b) : a.providerName.localeCompare(b.providerName));
  return <section className="tau-vcl-card">
    <div className="tau-page-filters">
      <select aria-label="Провайдер" value={provider} onChange={e => setProvider(e.target.value)}><option value="all">Все провайдеры</option>{providers.map(([id, n]) => <option key={id} value={id}>{n}</option>)}</select>
      <select aria-label="Машина" value={machine} onChange={e => setMachine(e.target.value)}><option value="all">Все машины</option>{machines.map(m => <option key={m}>{m}</option>)}</select>
      <select aria-label="Тип" value={kind} onChange={e => setKind(e.target.value as Kind)}><option value="all">Окна и пакеты</option><option value="window">Подписки (окна)</option><option value="package">Пакеты</option></select>
      <select aria-label="Сортировка" value={sort} onChange={e => setSort(e.target.value as Sort)}><option value="load">Сначала загруженные</option><option value="reset">Сначала ближайший сброс</option><option value="provider">По провайдеру</option></select>
      <label><input type="checkbox" checked={problems} onChange={e => setProblems(e.target.checked)} /> только проблемные</label>
    </div>
    <div className="tau-vcl-table-scroll"><table className="tau-page-table">
      <thead><tr><th>Аккаунт</th><th>Тариф</th><th>Тип</th><th>Израсходовано · темп</th><th>Сброс / окончание</th><th>Осталось ≈</th><th>$ за 1 млн</th></tr></thead>
      <tbody>{list.map(a => {
        const v = a.volume;
        const used = worst(a);
        const left = v?.tokens ? v.tokens * (1 - used / 100) : null;
        return <tr key={a.key} data-stale={a.status !== 'ok'} onClick={() => onAccount(a)} title={[a.note, a.message, v?.source].filter(Boolean).join('\n')}>
          <th scope="row"><ProviderMark providerId={a.providerId} src={logos[a.providerId]} className="tau-page-logo" />{name(a)}<small>{a.hostNames.map(h => h.replace(/\s*[—–].*$/, '').trim()).join(' · ')}{(a.resetCount ?? 0) > 0 ? ` · сбросов: ${a.resetCount}` : ''}</small></th>
          <td>{planLabel(a.providerId, a.plan) || '—'}</td>
          <td>{isPackageAccount(a) ? 'пакет' : 'окна'}</td>
          <td className="tau-page-bars">{a.windows.length ? a.windows.map((w, i) => <div key={i}><small>{w.label}</small><Bar w={w} now={now} /></div>) : <small>{a.message ?? 'нет данных'}</small>}</td>
          <td className="tau-page-when">{a.windows.map((w, i) => <div key={i}>{when(w, now)}</div>)}</td>
          <td>{left !== null ? `${tokens(left)}` : '—'}{a.note && isPackageAccount(a) ? <small>{a.note}</small> : null}</td>
          <td>{v?.pricePerMTokens != null ? money(v.pricePerMTokens) : '—'}</td>
        </tr>;
      })}</tbody>
    </table></div>
    <p><small>Полоса — сколько израсходовано, засечка — сколько прошло времени окна или срока пакета; красная засечка — расход опережает время. «Осталось» — в токенах по оценке объёма со вкладки «Объёмы». Нажмите строку — треды этого аккаунта.</small></p>
  </section>;
}

function Volumes({ accounts, answer, logos }: { accounts: Account[]; answer: string; logos: Record<string, string | null> }) {
  return <>
    <section className="tau-vcl-card"><h2>Google AI Pro против Claude и Codex</h2><p>{answer}</p></section>
    <section className="tau-vcl-card"><h2>Объём тарифов</h2><div className="tau-vcl-table-scroll"><table className="tau-page-table">
      <thead><tr><th>Аккаунт</th><th>Тариф</th><th>Окно</th><th>≈ объём</th><th>≈ API-эквивалент</th><th>$ за 1 млн</th><th>Источник</th></tr></thead>
      <tbody>{accounts.map(a => { const v = a.volume; return <tr key={a.key}>
        <th scope="row"><ProviderMark providerId={a.providerId} src={logos[a.providerId]} className="tau-page-logo" />{name(a)}</th><td>{planLabel(a.providerId, a.plan) || '—'}</td><td>{v?.window ?? '—'}</td>
        <td>{v?.tokens ? <>{tokens(v.tokens)}<small>{v.tokensLabel}</small></> : '—'}</td>
        <td>{v?.usd ? money(v.usd) : '—'}</td><td>{v?.pricePerMTokens != null ? money(v.pricePerMTokens) : '—'}</td>
        <td className="tau-page-source"><span className="tau-page-chip">{confidence[v?.confidence ?? 'none']}</span> {v?.source ?? 'нет данных'}</td>
      </tr>; })}</tbody>
    </table></div>
    <p><small>Замер — токены из журналов этой установки, делённые на рост % того же окна у провайдера. Оценка — замер, пересчитанный по опубликованному соотношению тарифов, или цена по прайсу API. Цифры не выдумываются: где источника нет — «нет данных».</small></p></section>
  </>;
}

function History() {
  const rpc = useRpc<typeof rpcContract>();
  const [days, setDays] = useState(7);
  const [series, setSeries] = useState<{ key: string; account: string; label: string; points: [number, number][] }[] | null>(null);
  useEffect(() => { void rpc.call('history', { days }).then(r => setSeries(r.series), () => setSeries([])); }, [rpc, days]);
  const end = Date.now(), start = end - days * 86_400_000;
  return <section className="tau-vcl-card"><div className="tau-vcl-toolbar"><div><h2>История израсходованного</h2></div>
    <select aria-label="Период" value={days} onChange={e => setDays(Number(e.target.value))}><option value={1}>Сутки</option><option value={7}>Неделя</option><option value={30}>30 дней</option></select></div>
    {series === null ? <p>Загружаем…</p> : !series.length ? <p>Снимки копятся раз в 15 минут с момента установки — график появится после первых записей.</p>
      : <div className="tau-page-history">{series.map(s => <div key={`${s.key}|${s.label}`} className="tau-page-spark">
        <span>{s.account}<small>{s.label}</small></span>
        <svg viewBox="0 0 300 40" preserveAspectRatio="none" role="img" aria-label={`${s.account} ${s.label}`}>
          <line x1="0" y1="36" x2="300" y2="36" className="tau-page-axis" />
          <polyline fill="none" points={s.points.map(([t, v]) => `${((t - start) / (end - start) * 300).toFixed(1)},${(36 - v / 100 * 32).toFixed(1)}`).join(' ')} />
        </svg>
        <b>{pct(s.points.at(-1)?.[1] ?? 0)}</b>
      </div>)}</div>}
  </section>;
}

function Discuss() {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [text, setText] = useState('');
  const [state, setState] = useState<string | null>(null);
  const go = async () => {
    setState('Готовим сводку…');
    try { const { threadId } = await rpc.call('discuss', { text }); setText(''); setState(null); navigate.toThread(threadId); }
    catch (error) { setState(error instanceof Error ? error.message : 'Не удалось открыть тред'); }
  };
  return <section className="tau-vcl-card"><h2>Обсудить объёмы</h2>
    <form className="tau-page-discuss" onSubmit={e => { e.preventDefault(); void go(); }}>
      <input value={text} onChange={e => setText(e.target.value)} placeholder="Например: куда направить большую задачу на этой неделе?" maxLength={4000} />
      <button type="submit" disabled={state === 'Готовим сводку…'}>Обсудить</button>
    </form>
    <p><small>{state ?? 'Открывает или продолжает тред BB с агентом; текущая сводка по аккаунтам уходит первым сообщением.'}</small></p>
  </section>;
}

// Deep link: /plugins/thread-account-usage/accounts/vclaude opens that tab (thread header of a VClaude thread).
const tabFromPath = (subPath: string | undefined): Tab => {
  const first = decodeURIComponent((subPath ?? '').split('/')[0] ?? '');
  return first === 'volumes' || first === 'history' || first === 'vclaude' ? first : 'overview';
};
export function AccountsPage({ subPath }: { subPath?: string } = {}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [tab, setTab] = useState<Tab>(() => tabFromPath(subPath));
  useEffect(() => { if (subPath !== undefined) setTab(tabFromPath(subPath)); }, [subPath]);
  const [data, setData] = useState<{ accounts: Account[]; googleAnswer: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const load = useCallback(async (refresh: boolean) => {
    setBusy(true);
    try { setData(await rpc.call('overview', { refresh })); setError(null); setNow(Date.now()); }
    catch { setError('Не удалось получить данные от BB.'); }
    finally { setBusy(false); }
  }, [rpc]);
  useEffect(() => { void load(false); const t = setInterval(() => void load(false), 120_000); return () => clearInterval(t); }, [load]);
  const accounts = useMemo(() => data?.accounts ?? [], [data]);
  const catalog = experimental_useProviders();
  const logos = useMemo(() => Object.fromEntries(catalog.providers.map(p => [p.id, p.logoUrl])) as Record<string, string | null>, [catalog]);
  const openAccount = async (a: Account) => {
    const details = await rpc.call('details', { key: a.key }).catch(() => null);
    const first = details?.threads[0];
    if (first) navigate.toThread(first.id);
  };
  const tabs: [Tab, string][] = [['overview', 'Обзор'], ['volumes', 'Объёмы'], ['history', 'История'], ['vclaude', 'VClaude']];
  return <div className="tau-vcl-page"><div className="tau-vcl-content tau-page">
    <div className="tau-vcl-toolbar"><div><h1 className="tau-page-title">Аккаунты и объёмы</h1>
      <small>{data ? `Обновлено ${new Date(now).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}` : 'Загружаем…'}{error ? ` · ${error}` : ''}</small></div>
      <button type="button" disabled={busy} onClick={() => void load(true)}>{busy ? 'Обновляем…' : 'Обновить'}</button></div>
    <div className="tau-page-tabs" role="tablist">{tabs.map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} onClick={() => { setTab(id); navigate.toPluginPanel('accounts', { subPath: id === 'overview' ? '' : id, replace: true }); }}>{label}</button>)}</div>
    {tab === 'overview' && <><Overview accounts={accounts} now={now} logos={logos} onAccount={a => void openAccount(a)} /><Discuss /></>}
    {tab === 'volumes' && <Volumes accounts={accounts} logos={logos} answer={data?.googleAnswer ?? ''} />}
    {tab === 'history' && <History />}
    {tab === 'vclaude' && <div className="tau-page-embed"><VClaudePanel /></div>}
  </div></div>;
}
