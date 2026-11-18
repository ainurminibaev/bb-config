import {
  definePluginApp, experimental_Icon as Icon, experimental_useRpcQuery as useQuery, useBbNavigate,
} from "@get-bb/plugin-sdk/app";
import { useEffect, useRef, useState, type ComponentType } from "react";
import { contract, type Context, type HistoryPeriod, type Metrics, type Tokens } from "./contract.ts";
import "./style.css";

const navPath = "overview";
const count = new Intl.NumberFormat("ru-RU");
const compact = new Intl.NumberFormat("ru-RU", { notation: "compact", maximumFractionDigits: 1 });
const localTime = new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short" });
const format = (value: number | null | undefined) => value == null ? "—" : count.format(value);

function duration(ms: number | null) {
  if (ms === null) return "—";
  if (ms < 60_000) return `${Math.round(ms / 1000)} с`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} мин ${Math.floor(ms / 1000) % 60} с`;
  return `${Math.floor(ms / 3_600_000)} ч ${Math.floor(ms / 60_000) % 60} мин`;
}

function contextText(context: Context | null) {
  if (!context) return "—";
  if (context.used === null) return context.capacity === null ? "—" : `окно ${format(context.capacity)}`;
  const capacity = context.capacity === null ? "" : ` / ${format(context.capacity)}`;
  return `${context.estimated ? "≈" : ""}${format(context.used)}${capacity}`;
}

const incomplete = (row: Metrics) => row.readLimited || row.lowerBoundTurns > 0 || row.turnsWithTokens < row.turns;
const total = (row: Metrics) => row.tokens?.total == null ? "—" : `${incomplete(row) ? "≥" : ""}${format(row.tokens.total)}`;

function Activity({ values, miniature = false }: { values: (number | null)[]; miniature?: boolean }) {
  const peak = Math.max(1, ...values.map(value => value ?? 0));
  return (
    <div className={miniature ? "ts-pulse ts-pulse-mini" : "ts-pulse"}
      {...(miniature ? { "aria-hidden": true } : { role: "img", "aria-label": "Токены по двухчасовым интервалам за последние 24 часа" })}>
      {values.map((value, index) => (
        <span key={index} data-empty={value === null} style={{ height: `${Math.max(10, 100 * (value ?? 0) / peak)}%` }}
          title={miniature ? undefined : `${(values.length - index) * 2}–${(values.length - index - 1) * 2} ч назад · ${format(value)}`} />
      ))}
    </div>
  );
}

function Breakdown({ tokens }: { tokens: Tokens | null }) {
  if (!tokens) return <p className="ts-note">BB не сохранил измерение токенов.</p>;
  const entries = [
    ["Ввод", tokens.input], ["Вывод", tokens.output],
    ["Чтение кэша", tokens.cacheRead], ["Запись кэша", tokens.cacheWrite],
    ["Кэшированный ввод", tokens.cacheRead === null || tokens.cacheWrite === null ? tokens.cachedInput : null],
    ["Reasoning", tokens.reasoning],
  ] as const;
  return (
    <dl className="ts-breakdown">
      {entries.filter(([, value]) => value !== null).map(([label, value]) =>
        <div key={label}><dt>{label}</dt><dd>{format(value)}</dd></div>)}
    </dl>
  );
}

function ReadError({ onRetry, partial = false }: { onRetry: () => void; partial?: boolean }) {
  return (
    <p className="ts-error" role="alert">
      {partial ? "Не удалось обновить данные." : "Не удалось прочитать статистику BB."}{" "}
      <button className="ts-link" onClick={onRetry}>Повторить</button>
    </p>
  );
}

function ThreadDetails({ threadId }: { threadId: string }) {
  const query = useQuery({ contract, method: "thread", input: { threadId, limit: 100 } });
  const data = query.data;
  const retry = () => void query.refetch();
  if (!data) {
    return query.error ? <ReadError onRetry={retry} /> : <p role="status" className="ts-note">Читаем события BB…</p>;
  }
  const { row } = data;
  return (
    <>
      {query.error && <ReadError partial onRetry={retry} />}
      <div className="ts-metric">
        <div><span>Токены за 24 ч</span><strong>{total(row)}</strong></div>
        <div><span>Время по событиям BB</span><strong>{duration(row.processingMs)}</strong></div>
        <button className="ts-link" onClick={retry} disabled={query.isFetching}>Обновить</button>
      </div>
      <Activity values={data.buckets} />
      <Breakdown tokens={row.tokens} />
      {incomplete(row) && (
        <p className="ts-note" role="status">
          Замеры токенов доступны для {row.turnsWithTokens} из {row.turns} ходов.
          {row.lowerBoundTurns > 0 && " Часть значений — нижние оценки."}
          {row.readLimited && " Достигнут лимит чтения событий."}
        </p>
      )}
      <h3>Ходы</h3>
      {!data.turns.length ? <p className="ts-note">За последние 24 часа ходов не найдено.</p> : (
        <div className="ts-turns">
          {data.turns.map(turn => (
            <details key={turn.id}>
              <summary>
                <time dateTime={new Date(turn.at).toISOString()}>{localTime.format(turn.at)}</time>
                <span>{turn.tokens?.total == null ? "—" : `${turn.tokenQuality === "lower_bound" ? "≥" : ""}${format(turn.tokens.total)}`} ток.</span>
                <span>{duration(turn.durationMs)}</span>
              </summary>
              <div className="ts-turn-body">
                <dl className="ts-breakdown">
                  <div><dt>Контекст</dt><dd>{contextText(turn.context)}</dd></div>
                  <div><dt>Статус BB</dt><dd>{turn.status ?? "Без завершения"}</dd></div>
                </dl>
                <Breakdown tokens={turn.tokens} />
              </div>
            </details>
          ))}
        </div>
      )}
      {row.turns > data.turns.length && <p className="ts-note">Показаны последние {data.turns.length} ходов.</p>}
    </>
  );
}

function Header({ threadId }: { threadId: string }) {
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const navigate = useBbNavigate();
  const query = useQuery({ contract, method: "summary", input: { threadId } });
  const { refetch } = query;

  useEffect(() => {
    if (open && dialog.current && !dialog.current.open) dialog.current.showModal();
  }, [open]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refetch();
    }, 60_000);
    return () => clearInterval(timer);
  }, [refetch]);

  const row = query.data?.row;
  const value = row?.tokens?.total;
  const amount = value == null || !row ? "—" : `${incomplete(row) ? "≥" : ""}${compact.format(value)}`;
  return (
    <div className="ts-root">
      <button ref={button} type="button" data-thread-spend-indicator="" className="ts-indicator"
        aria-haspopup="dialog" aria-expanded={open} aria-label={`Тред за 24 часа · ${value == null ? "токены недоступны" : `${row && total(row)} токенов`}`}
        title={query.error ? "Не удалось обновить статистику" : "Расход токенов треда за 24 часа"}
        onClick={() => setOpen(true)}>
        <span>Тред / 24ч</span><strong>{query.isLoading ? "…" : amount}</strong>
        {query.data && <Activity values={query.data.buckets} miniature />}
      </button>
      <dialog ref={dialog} className="ts-dialog" aria-label="Статистика треда"
        onClose={() => { setOpen(false); button.current?.focus(); }}
        onClick={event => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
        {open && <div className="ts-dialog-content">
          <div className="ts-heading">
            <h2>Статистика треда</h2>
            <button type="button" className="ts-square" aria-label="Закрыть" onClick={() => dialog.current?.close()}>
              <Icon name="X" aria-hidden />
            </button>
          </div>
          <ThreadDetails threadId={threadId} />
          <footer className="ts-footer">
            <button className="ts-link" onClick={() => { dialog.current?.close(); navigate.toPluginPanel(navPath); }}>Все треды</button>
          </footer>
        </div>}
      </dialog>
    </div>
  );
}

const filters = [1, 7, 30];

function Overview({ subPath }: { subPath: string }) {
  const route = /^thread\/([^/]+)$/.exec(subPath);
  const navigate = useBbNavigate();
  if (route) {
    let threadId: string;
    try { threadId = decodeURIComponent(route[1]); } catch { threadId = route[1]; }
    return (
      <section className="ts-root ts-page">
        <button className="ts-link" onClick={() => navigate.toPluginPanel(navPath)}>К списку тредов</button>
        <h2>Статистика треда</h2>
        <ThreadDetails threadId={threadId} />
      </section>
    );
  }
  return subPath === "archive" ? <HistoryView /> : <OverviewList />;
}

function HistoryView() {
  const [days, setDays] = useState<HistoryPeriod>(7);
  const navigate = useBbNavigate();
  const query = useQuery({ contract, method: "archived", input: { days } });
  const history = query.data;
  return (
    <section className="ts-root ts-page">
      <button className="ts-link" onClick={() => navigate.toPluginPanel(navPath)}>К текущей статистике</button>
      <h2>До перехода</h2>
      <fieldset className="ts-range">
        <legend>Период снимка</legend>
        {([1, 7, 30] as const).map(value => <button key={value} aria-pressed={days === value}
          onClick={() => setDays(value)}>{value} д</button>)}
      </fieldset>
      {query.error ? <ReadError onRetry={() => void query.refetch()} /> :
        history === undefined ? <p role="status" className="ts-note">Читаем снимок…</p> :
        history === null ? <p className="ts-note">Снимок прежней статистики отсутствует.</p> : <>
          <p className="ts-note">Снимок на {localTime.format(history.capturedAt)}. Цифры показаны отдельно от текущей статистики.</p>
          <div className="ts-table-wrap">
            <table className="ts-table" data-thread-spend-history="">
              <thead><tr><th scope="col">Тред</th><th scope="col">Токены</th>
                <th scope="col" className="ts-optional">Время</th><th scope="col" className="ts-optional">Контекст</th>
              </tr></thead>
              <tbody>{history.rows.map(row => <tr key={row.threadId}>
                <th scope="row"><button className="ts-link ts-thread-link"
                  onClick={() => navigate.toThread(row.threadId)}>{row.title || "Тред"}</button><small>{row.providerId}</small></th>
                <td>{format(row.total)}<small>{row.turns} ходов</small></td>
                <td className="ts-optional">{duration(row.processingMs)}</td>
                <td className="ts-optional">{format(row.contextLatest)}</td>
              </tr>)}</tbody>
            </table>
          </div>
        </>}
    </section>
  );
}

function OverviewList() {
  const [days, setDays] = useState(7);
  const [sort, setSort] = useState<"tokens" | "time" | "context">("tokens");
  const [provider, setProvider] = useState("");
  const [limit, setLimit] = useState(25);
  const navigate = useBbNavigate();
  const query = useQuery({ contract, method: "threads", input: { days, sort, ...(provider ? { provider } : {}), limit } });
  const data = query.data;
  const retry = () => void query.refetch();
  const providers = Array.from(new Set([...(data?.providers ?? []), ...(provider ? [provider] : [])]));
  return (
    <section className="ts-root ts-page">
      <div className="ts-heading">
        <h2>Расход по тредам</h2>
        <button className="ts-link" onClick={() => navigate.toPluginPanel(navPath, { subPath: "archive" })}>До перехода</button>
        <button className="ts-square" aria-label="Обновить список" disabled={query.isFetching} onClick={retry}>
          <Icon name="RefreshCw" aria-hidden />
        </button>
      </div>
      <div className="ts-filters">
        <fieldset className="ts-range">
          <legend>Период</legend>
          {filters.map(value => <button key={value} aria-pressed={days === value} onClick={() => {
            setDays(value); setLimit(25);
          }}>{value} д</button>)}
        </fieldset>
        <label>Провайдер<select value={provider} onChange={event => { setProvider(event.target.value); setLimit(25); }}>
          <option value="">Все</option>
          {providers.map(value => <option key={value}>{value}</option>)}
        </select></label>
        <label>Сортировка<select value={sort} onChange={event => {
          const value = event.target.value;
          if (value === "tokens" || value === "time" || value === "context") setSort(value);
        }}>
          <option value="tokens">Токены</option>
          <option value="time">Время</option>
          <option value="context">Контекст</option>
        </select></label>
      </div>
      {query.error && <ReadError onRetry={retry} partial={!!data} />}
      {!data && !query.error && <p role="status" className="ts-note">Читаем события BB…</p>}
      {!!data && (
        <>
          {(data.failed > 0 || data.listLimited) && <p className="ts-note" role="status">
            {data.failed > 0 && `Не удалось прочитать тредов: ${data.failed}. `}
            {data.listLimited && "Достигнут лимит просмотра тредов."}
          </p>}
          {!data.rows.length ? <p className="ts-note">За этот период подходящих тредов не найдено.</p> : (
            <>
              <div className="ts-table-wrap">
                <table className="ts-table">
                  <thead><tr><th scope="col">Тред</th><th scope="col">Токены</th>
                    <th scope="col" className="ts-optional">Время</th><th scope="col" className="ts-optional">Контекст</th>
                  </tr></thead>
                  <tbody>{data.rows.map(row => (
                    <tr key={row.id}>
                      <th scope="row">
                        <button className="ts-link ts-thread-link" onClick={() => navigate.toThread(row.id)}>{row.title}</button>
                        <small>{row.providerId}{row.archived ? " · архив" : ""}</small>
                      </th>
                      <td>{total(row)}<small>{row.turnsWithTokens}/{row.turns} ходов</small></td>
                      <td className="ts-optional">{duration(row.processingMs)}</td>
                      <td className="ts-optional">{contextText(row.context)}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
              <p className="ts-note">Показано {data.rows.length} из {data.matched}.</p>
              {data.rows.length < data.matched && limit < 100 &&
                <button className="ts-link" onClick={() => setLimit(Math.min(limit + 25, 100))}>Показать ещё</button>}
            </>
          )}
        </>
      )}
    </section>
  );
}

export default definePluginApp(app => {
  // BB 0.49 keeps this component slot in its runtime compatibility collector.
  const slots = app.slots as typeof app.slots & {
    experimental_threadHeaderAction?: (registration: {
      id: string; title: string; component: ComponentType<{ threadId: string }>;
    }) => void;
  };
  if (slots.experimental_threadHeaderAction) {
    slots.experimental_threadHeaderAction({ id: "today", title: "Тред / 24ч", component: Header });
  } else {
    app.slots.experimental_threadAction({
      id: "today", group: "thread-spend", title: "Тред / 24ч", icon: "ChartNoAxesColumn", placement: "header",
      item: ({ thread, navigate }) => ({
        label: "Тред / 24ч", icon: "ChartNoAxesColumn",
        run: () => navigate.toPluginPanel(navPath, { subPath: `thread/${thread.id}` }),
      }),
    });
  }
  app.slots.navPanel({
    id: "overview", title: "Расход по тредам", icon: "ChartNoAxesColumn", path: navPath, component: Overview,
  });
});
