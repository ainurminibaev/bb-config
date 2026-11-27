import { useCallback, useEffect, useState } from 'react';
import { useRpc } from '@get-bb/plugin-sdk/app';
import type { Account, rpcContract } from './contract';
import { displayPlan } from './logic';
import type { VClaudeComparison, VClaudeUsage } from './vclaude-contract';

const format = new Intl.NumberFormat('ru-RU');
const rub = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 2 });
const percent = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
const label = (value: number | null | undefined) => value == null ? '—' : format.format(value);
const dateTime = (value: string) => new Date(value).toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' });
function formatRunway(days: number) {
  if (days >= 1) return percent.format(days) + ' дн.';
  const minutes = Math.round(days * 1440);
  if (minutes < 1) return 'меньше мин.';
  if (minutes < 60) return minutes + ' мин';
  const remaining = minutes % 60;
  return Math.floor(minutes / 60) + ' ч' + (remaining ? ' ' + remaining + ' мин' : '');
}
type View = { usage: VClaudeUsage | null; error: string | null };

export function VClaudePanel() {
  const rpc = useRpc<typeof rpcContract>();
  const [view, setView] = useState<View | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [comparison, setComparison] = useState<VClaudeComparison | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async (refresh: boolean) => {
    setBusy(true);
    void rpc.call('comparison', { refresh }).then(setComparison, () => setComparison(previous => previous ?? ({
      catalog: [], estimate: null, message: 'Расчёт на сервере не ответил. Можно повторить обновление.',
    })));
    try {
      const data = await rpc.call('vclaude', { refresh });
      setView(data);
    } catch {
      setView(previous => ({ usage: previous?.usage ?? null, error: 'Не удалось получить данные от BB.' }));
    } finally { setBusy(false); }
    try {
      const result = await rpc.call('accounts', { refresh: false });
      setAccounts(result.accounts.filter(a => a.providerId === 'claude-code' && a.windows.length > 0));
    } catch { setAccounts([]); }
  }, [rpc]);
  useEffect(() => {
    void load(false);
    const timer = setInterval(() => { if (!document.hidden) void load(false); }, 15 * 60_000);
    return () => clearInterval(timer);
  }, [load]);

  const usage = view?.usage;
  const usedPercent = usage?.limitUnits
    ? Math.max(0, Math.min(100, 100 * (1 - usage.remainingUnits / usage.limitUnits))) : 0;

  return <div className="tau-vcl-page"><div className="tau-vcl-content">
    <div className="tau-vcl-toolbar">
      <div>{usage ? <>Данные на <time dateTime={usage.fetchedAt}>{dateTime(usage.fetchedAt)}</time></> : 'Данные кабинета VClaude'}</div>
      <a href="https://vclaude.ru/cabinet/usage" target="_blank" rel="noreferrer">Кабинет VClaude ↗</a>
      <button type="button" onClick={() => void load(true)} disabled={busy}>{busy ? 'Обновляется…' : 'Обновить'}</button>
    </div>
    {view?.error && <p className="tau-vcl-notice" role="status">{view.error}{usage ? ' Показаны последние полученные данные.' : ''}</p>}
    {!view && busy && <p role="status">Загружается расход…</p>}
    {view && !usage && !view.error && <p>На сервере ещё нет сессии VClaude.</p>}
    {usage && <>
      <section className="tau-vcl-card" aria-labelledby="tau-vcl-plan">
        <h2 id="tau-vcl-plan">Тариф</h2>
        {usage.limitUnits > 0 ? <>
          <div className="tau-vcl-metrics">
            <div><small>Осталось</small><strong>{label(usage.remainingUnits)} юн.</strong><span>из {label(usage.limitUnits)} юн.</span></div>
            <div><small>Оплачено за пакеты, вкл. очередь</small><strong>{usage.paidRub == null ? '—' : rub.format(usage.paidRub)}</strong></div>
            <div title="Цена пакета × доля потраченных в нём юнитов"><small>Использовано по цене пакетов</small><strong>{usage.usedRub == null ? '—' : rub.format(usage.usedRub)}</strong></div>
          </div>
          <progress value={usedPercent} max={100} aria-label="Использованная доля тарифа" />
          <div className="tau-vcl-term"><span>Использовано {percent.format(usedPercent)}%</span>
            {usage.nearestExpiry && usage.nearestExpiry !== usage.endsAt && <span>Текущий пакет до <time dateTime={usage.nearestExpiry}>{dateTime(usage.nearestExpiry)}</time></span>}
            {usage.endsAt && <span>{usage.queue.length > 1 ? 'Вся очередь — не позже' : 'Действует до'} <time dateTime={usage.endsAt}>{dateTime(usage.endsAt)}</time></span>}</div>
          {usage.queue.length > 1 && <ol className="tau-vcl-queue" aria-label="Пакеты по очереди">{usage.queue.map((p, i) =>
            <li key={`${p.name}:${i}`}><strong>{p.name}</strong> — {p.state === 'active' ? `идёт, осталось ${label(Math.max(0, p.limitUnits - p.usedUnits))} из ${label(p.limitUnits)} юн.` : `ждёт, ${label(p.limitUnits)} юн.`}
              {p.endsAt && <> · {p.estimated ? 'не позже ' : 'до '}<time dateTime={p.endsAt}>{dateTime(p.endsAt)}</time></>}</li>)}</ol>}
          {usage.queue.length > 1 && <small>Следующий пакет начинается, когда у текущего кончится лимит или срок; его срок считается с этого момента.</small>}
        </> : <p>Действующий тариф отсутствует.</p>}
      </section>
      <section className="tau-vcl-card" aria-labelledby="tau-vcl-models">
        <h2 id="tau-vcl-models">Токены и кэш {usage.days ? <small>за {usage.days} дн.</small> : null}</h2>
        {usage.models.length ? <div className="tau-vcl-table-scroll"><table>
          <thead><tr><th scope="col">Модель</th><th scope="col">Запросы</th><th scope="col">Вход</th><th scope="col">Выход</th>
            <th scope="col">Чтение кэша</th><th scope="col">Запись кэша</th><th scope="col">Юниты</th></tr></thead>
          <tbody>{usage.models.map(model => <tr key={model.id}><th scope="row">{model.name.replace(/^Anthropic:\s*/i, '')}
            {model.tokens?.estimated && <small> · оценка</small>}</th><td>{label(model.requests)}</td><td>{label(model.tokens?.input)}</td>
            <td>{label(model.tokens?.output)}</td><td>{label(model.tokens?.cacheRead)}</td><td>{label(model.tokens?.cacheWrite)}</td><td>{label(model.units)}</td></tr>)}</tbody>
        </table></div> : <p>За этот период расхода по моделям нет.</p>}
        {usage.models.some(m => m.rates) && <details>
          <summary>Сколько юнитов стоит 1 млн токенов</summary>
          <div className="tau-vcl-table-scroll"><table>
            <thead><tr><th scope="col">Модель</th><th scope="col">Вход</th><th scope="col">Выход</th><th scope="col">Чтение кэша</th>
              <th scope="col">Запись на 5 мин</th><th scope="col">Запись на 1 ч</th></tr></thead>
            <tbody>{usage.models.flatMap(model => model.rates ? [<tr key={model.id}>
              <th scope="row">{model.name.replace(/^Anthropic:\s*/i, '')}</th>
              <td>{label(model.rates.input)}</td><td>{label(model.rates.output)}</td><td>{label(model.rates.cacheRead)}</td>
              <td>{label(model.rates.cacheWrite5m)}</td><td>{label(model.rates.cacheWrite1h)}</td>
            </tr>] : [])}</tbody>
          </table></div>
        </details>}
      </section>
    </>}
    <section className="tau-vcl-card" aria-labelledby="tau-vcl-compare">
      <h2 id="tau-vcl-compare">Сравнение с подпиской Claude</h2>
      <Comparison comparison={comparison} />
      {accounts.length > 0 && <h3>Живые лимиты аккаунтов Claude</h3>}
      {accounts.length > 0 && <div className="tau-vcl-table-scroll"><table>
        <thead><tr><th scope="col">Аккаунт</th><th scope="col">Тариф</th><th scope="col">5 часов</th><th scope="col">Неделя</th></tr></thead>
        <tbody>{accounts.map(account => {
          const usageAt = (kind: 'five-hour' | 'weekly') => {
            const w = account.windows.find(item => item.kind === kind);
            return w ? percent.format(w.usedPercent) + '%' : '—';
          };
          return <tr key={account.key}><th scope="row">{account.email?.split('@')[0] ?? account.hostNames.join(' · ')}</th>
            <td>{displayPlan(account.providerId, account.plan) || '—'}{account.status !== 'ok' && <small> · последние данные</small>}</td>
            <td>{usageAt('five-hour')}</td><td>{usageAt('weekly')}</td></tr>;
        })}</tbody>
      </table></div>}
      <a href="https://claude.com/pricing" target="_blank" rel="noreferrer">Тарифы подписок Claude ↗</a>
    </section>
  </div></div>;
}


function Comparison({ comparison }: { comparison: VClaudeComparison | null }) {
  const [subscription, setSubscription] = useState('');
  if (!comparison) return <p role="status">Сверяем историю токенов и лимитов на Tru…</p>;
  const { estimate, catalog } = comparison;
  const units = (value: number) => percent.format(value / 1_000_000) + ' млн';
  const usd = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
  const perPercent = estimate?.unitsPerPercent;
  const monthlyUnits = perPercent ? perPercent * 100 * 30 / 7 : null;
  const biggest = catalog.reduce<(typeof catalog)[number] | null>(
    (best, item) => !best || item.limitUnits > best.limitUnits ? item : best, null);
  const subscriptionRub = Number(subscription.replace(',', '.'));
  const replacementRub = monthlyUnits && biggest ? monthlyUnits * biggest.priceRub / biggest.limitUnits : null;
  const apiRatio = estimate?.dailyApiUsd ? estimate.dailyUnits * 5 / 1_000_000 / estimate.dailyApiUsd : null;
  return <>
    {comparison.message && <p className="tau-vcl-notice" role="status">{comparison.message}</p>}
    {estimate && <>
      <div className="tau-vcl-metrics">
        <div><small>1% недельного лимита Tru</small><strong>{perPercent ? units(perPercent) + ' юн.' : 'Собираем замеры'}</strong>
          {estimate.usdPerPercent && <span>≈ {usd.format(estimate.usdPerPercent)} по прайсу API</span>}</div>
        <div><small>Эквивалент расхода Tru за 24 ч</small><strong>{units(estimate.dailyUnits)} юн.</strong><span>{usd.format(estimate.dailyApiUsd)} по прайсу API</span></div>
        {monthlyUnits && biggest && replacementRub !== null && <div><small>30 дней при полном расходе каждой недели</small>
          <strong>≈ {rub.format(replacementRub)}</strong>
          <span>{percent.format(monthlyUnits / biggest.limitUnits)} пакета {biggest.name} по объёму</span></div>}
      </div>
      {replacementRub !== null && <div className="tau-vcl-price-input">
        <label>Фактическая цена подписки Claude за месяц, ₽
          <input inputMode="decimal" value={subscription} onChange={e => setSubscription(e.target.value)} placeholder="Введи сумму" />
        </label>
        {Number.isFinite(subscriptionRub) && subscriptionRub > 0 && <span>VClaude / Claude ×{percent.format(replacementRub / subscriptionRub)} если расходовать весь недельный лимит</span>}
      </div>}
      <p className="tau-vcl-evidence">Замер на <time dateTime={estimate.observedAt}>{dateTime(estimate.observedAt)}</time>
        {' · '}{percent.format(estimate.weekProgress)}% недельного окна · {estimate.segments} отрезков от 5 п. п.
        {estimate.unitsRange && <> · разброс на 1% {units(estimate.unitsRange[0])}–{units(estimate.unitsRange[1])} юн.</>}
        {estimate.unpricedRequests > 0 && <> · без тарифа у {format.format(estimate.unpricedRequests)} запросов</>}
        {estimate.estimatedWriteRequests > 0 && <> · у {format.format(estimate.estimatedWriteRequests)} записей кэша без срока использована ставка за 5 минут</>}</p>
    </>}
    {catalog.length > 0 && <div className="tau-vcl-table-scroll"><table>
      <thead><tr><th scope="col">VClaude</th><th scope="col">Объём</th><th scope="col">Цена пакета</th>
        <th scope="col">Номинал по API</th><th scope="col">Цена 1% недели Tru</th><th scope="col">Хватит при расходе за 24 ч</th></tr></thead>
      <tbody>{catalog.map(plan => <tr key={plan.name}>
        <th scope="row">{plan.name} <small>· {plan.periodDays} дн.</small></th>
        <td>{units(plan.limitUnits)} юн.</td><td>{rub.format(plan.priceRub)}</td>
        <td>{usd.format(plan.limitUnits * 5 / 1_000_000)}</td>
        <td>{perPercent ? rub.format(perPercent * plan.priceRub / plan.limitUnits) : '—'}</td>
        <td>{estimate?.dailyUnits ? formatRunway(Math.min(plan.periodDays, plan.limitUnits / estimate.dailyUnits)) : '—'}</td>
      </tr>)}</tbody>
    </table></div>}
    <p>Номинал рассчитан как $5 за млн юнитов. Чтение кэша у VClaude тарифицируется по 10% обычного входа.
      У Anthropic это 5% для Opus 5.5 и Sonnet 5.5, 2,5% для Fable 5.2.
      {apiRatio && <> При фактическом составе запросов за сутки номинал юнитов вышел в {percent.format(apiRatio)} раза выше прямой цены API.</>}
      {' '}<a href="https://platform.claude.com/docs/en/about-claude/pricing" target="_blank" rel="noreferrer">Прайс API Anthropic ↗</a></p>
  </>;
}
