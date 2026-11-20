import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract, UpdatePlan, UpdateStatus } from "./server";

const REMIND_MS = 24 * 3_600_000;
const SEEN_KEY = "config-updates:toast";
const NOTICE_ID = "config-updates:available";
/** Opens the component chooser from the settings page or the notice. */
const OPEN_EVENT = "config-updates:choose";
const openChooser = () => window.dispatchEvent(new Event(OPEN_EVENT));

function useUpdates() {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [busy, setBusy] = useState<"check" | "start" | null>(null);
  const refresh = useCallback(() => { rpc.call("status").then(setStatus).catch(() => {}); }, [rpc]);
  useEffect(refresh, [refresh]);
  useRealtime("status", refresh);
  const check = useCallback(async () => {
    setBusy("check");
    try { setStatus(await rpc.call("check")); } catch (error) { toast.error(`Проверка не удалась: ${(error as Error).message}`); } finally { setBusy(null); }
  }, [rpc]);
  const start = useCallback(async () => {
    setBusy("start");
    try {
      const plan = await rpc.call("compose");
      if (plan.threadId) {
        toast.info(`Открываю тред, который уже ведёт обновление до ${plan.tag}.`);
        navigate.toThread(plan.threadId);
      } else if (plan.projectId && plan.prompt) {
        // bb's own new-thread screen: the user sees and picks provider, model and permissions, then sends.
        navigate.toCompose({ projectId: plan.projectId, hostId: plan.hostId ?? undefined, initialPrompt: plan.prompt, focusPrompt: true });
        toast.info("Задание подготовлено. Выберите модель и отправьте сообщение.", { duration: 10_000 });
      }
    } catch (error) {
      toast.error((error as Error).message, { duration: 15_000 });
    } finally { setBusy(null); }
  }, [rpc, navigate]);
  const update = useCallback(async (skip: string[]) => {
    try { setStatus(await rpc.call("update", { skip })); } catch (error) { toast.error((error as Error).message, { duration: 15_000 }); }
  }, [rpc]);
  return { status, busy, check, start, update };
}

const link = "text-xs underline underline-offset-2 hover:text-foreground";

/** The window before an update: new components with a description, a link to the code and a checkbox. */
function Chooser() {
  const rpc = useRpc<typeof rpcContract>();
  const { update } = useUpdates();
  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState<UpdatePlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  useEffect(() => {
    const show = () => {
      setOpen(true); setPlan(null); setError(null); setSkipped(new Set());
      rpc.call("plan").then(setPlan).catch((reason) => setError((reason as Error).message));
    };
    window.addEventListener(OPEN_EVENT, show);
    return () => window.removeEventListener(OPEN_EVENT, show);
  }, [rpc]);
  if (!open) return null;
  const fresh = plan?.components.filter((item) => item.new) ?? [];
  const chosen = fresh.length - skipped.size;
  const toggle = (id: string) => setSkipped((current) => { const next = new Set(current); if (!next.delete(id)) next.add(id); return next; });
  const go = () => { void update([...skipped]); setOpen(false); toast.info("Обновление запущено. Ход и итог — в настройках «Обновления доработок».", { duration: 10_000 }); };
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label="Обновление доработок" data-config-updates-chooser
    onClick={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
    <div className="flex max-h-[85vh] w-full max-w-lg flex-col gap-3 rounded-lg border border-border bg-background p-4 text-sm shadow-xl">
      <p className="text-base font-semibold">{plan ? `Обновление до ${plan.tag}` : "Обновление доработок"}</p>
      {error && <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-destructive">{error}</p>}
      {!plan && !error && <p className="text-muted-foreground">Готовлю релиз и проверяю, что он принесёт…</p>}
      {plan && <div className="min-h-0 space-y-3 overflow-auto">
        {fresh.length > 0 ? <>
          <p>Новые компоненты. Снимите галочку с ненужных — они не будут установлены и больше не будут предлагаться.</p>
          <ul className="space-y-2">{fresh.map((item) => <li key={item.id} className="flex gap-2 rounded-md border border-border p-2">
            <input type="checkbox" className="mt-1" id={`cu-${item.id}`} checked={!skipped.has(item.id)} onChange={() => toggle(item.id)} />
            <label htmlFor={`cu-${item.id}`} className="min-w-0 flex-1 space-y-0.5">
              <span className="flex flex-wrap items-baseline gap-x-2"><b>{item.name}</b>
                <a className={link} href={item.link} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>код ↗</a></span>
              <span className="block text-xs text-muted-foreground">{item.description}</span>
            </label>
          </li>)}</ul>
        </> : <p>Новых компонентов нет: обновятся установленные, ваши настройки сохранятся.</p>}
        {plan.untested.length > 0 && <Untested items={plan.untested} />}
        <p className="text-xs text-muted-foreground">Устаревшие компоненты обновятся, отключённые останутся отключёнными, настройки и секреты сохранятся. Личные входы и действия на других машинах будут перечислены в итоге.</p>
      </div>}
      <div className="flex justify-end gap-2">
        <button type="button" className={button} onClick={() => setOpen(false)}>Отмена</button>
        <button type="button" className={`${button} bg-primary text-primary-foreground hover:bg-primary/90`} disabled={!plan} onClick={go}>
          {fresh.length ? `Установить отмеченное (${chosen}) и обновить` : "Обновить"}</button>
      </div>
    </div>
  </div>;
}

function Untested({ items }: { items: UpdateStatus["untested"] }) {
  return <div role="status" className="space-y-1 rounded-md bg-amber-500/10 px-3 py-2 text-xs">
    <p className="font-medium">Версия не проверена с доработками</p>
    <ul className="list-disc space-y-1 pl-4">{items.map((item) => <li key={item.component}>
      {item.name} {item.installed} новее проверенной {item.tested}{item.needed.length > 0 && `: ${item.needed.join(", ")} может работать неправильно`}.
      Если что-то сломалось, верните {item.tested} или дождитесь релиза доработок.</li>)}</ul>
  </div>;
}

/** Progress and result of the update started with the button. */
function Job({ status, start }: { status: UpdateStatus; start: () => void }) {
  const job = status.job;
  if (!job) return null;
  if (job.state === "running") return <p role="status" className="rounded-md bg-muted px-3 py-2">Обновляю до {job.tag}… Это несколько минут; страницу можно закрыть.</p>;
  const done = job.state === "done";
  return <div role="status" className={`space-y-2 rounded-md px-3 py-2 ${done ? "bg-muted" : "bg-destructive/10"}`}>
    <p className="font-medium">{done ? `Обновлено до ${job.tag}` : `Обновление до ${job.tag} не завершено`}
      {job.finishedAt && <span className="font-normal text-muted-foreground"> · {new Date(job.finishedAt).toLocaleString()}</span>}</p>
    {(job.installed.length > 0 || job.updated.length > 0) && <p className="text-xs">
      {job.installed.length > 0 && `Установлено: ${job.installed.join(", ")}. `}{job.updated.length > 0 && `Обновлено: ${job.updated.join(", ")}.`}</p>}
    {!done && <p className="text-xs">{job.error ?? `Осталось шагов: ${job.remaining}.`}</p>}
    {job.attention.length > 0 && <div className="text-xs"><p className="font-medium">Сделайте сами</p>
      <ul className="list-disc space-y-1 pl-4">{job.attention.map((item, index) => <li key={index}><b>{item.component}</b>: {item.text}</li>)}</ul></div>}
    {!done && <button type="button" className={button} onClick={start}>Разобраться с ИИ</button>}
  </div>;
}

/** Announces an available release at most once a day per version and browser. */
function Notice() {
  const { status, start } = useUpdates();
  const tag = status?.error ? undefined : status?.pending.at(-1)?.tag;
  useEffect(() => {
    if (!tag) {
      toast.dismiss(NOTICE_ID);
      return;
    }
    let seen: { tag?: string; at?: number } = {};
    try { seen = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "{}"); } catch { /* shown again */ }
    if (seen.tag === tag && Date.now() - (seen.at ?? 0) < REMIND_MS) return;
    try { localStorage.setItem(SEEN_KEY, JSON.stringify({ tag, at: Date.now() })); } catch { /* private mode */ }
    toast.info(`Доступно обновление доработок BB ${tag}`, {
      id: NOTICE_ID,
      duration: 15_000,
      action: { label: "Обновить", onClick: openChooser },
    });
  }, [tag, start]);
  return <Chooser />;
}

const day = (value: string | number) => new Date(value).toLocaleDateString();

/** What is installed, what is published, when it was checked: the same three lines everywhere. */
function Summary({ status }: { status: UpdateStatus }) {
  const target = status.pending.at(-1);
  return <><dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs">
    <dt className="text-muted-foreground">Установлено</dt>
    <dd>{status.installed ? <><b>{status.installed}</b>{status.installedAt && ` с ${day(status.installedAt)}`}{status.installedAuto && " — принято автоматически, устанавливать было нечего"}</> : "версия не записана"}</dd>
    <dt className="text-muted-foreground">Доступно</dt>
    <dd>{target ? <><b>{target.tag}</b> от {day(target.publishedAt)}</> : status.okAt > 0 ? "новых релизов нет" : "не проверено"}</dd>
    <dt className="text-muted-foreground">Проверено</dt>
    <dd>{status.checkedAt ? new Date(status.checkedAt).toLocaleString() : "ещё нет"}{status.error && " — с ошибкой"}</dd>
    {status.runRelease && <><dt className="text-muted-foreground">Сейчас</dt><dd>идёт обновление до {status.runRelease}</dd></>}
  </dl>{status.dependencyIssues.length > 0 && <div role="status" className="space-y-1 text-xs text-destructive">
    <p>Изменились зависимости доработок</p>
    <ul className="list-disc space-y-1 pl-4">{status.dependencyIssues.map((issue) => <li key={issue}>{issue}</li>)}</ul>
  </div>}</>;
}

const button = "inline-flex h-8 items-center rounded-md border border-border px-3 text-sm font-medium hover:bg-muted disabled:opacity-50";

function Section() {
  const { status, busy, check, start } = useUpdates();
  if (!status) return <p className="text-sm text-muted-foreground">Загрузка…</p>;
  const target = status.pending.at(-1);
  return <div className="space-y-3 text-sm" data-config-updates>
    <Summary status={status} />
    {status.untested.length > 0 && <Untested items={status.untested} />}
    <Job status={status} start={() => { void start(); }} />
    {status.remaining > 0 && <p className="text-muted-foreground">Предыдущее обновление применено частично, осталось шагов: {status.remaining}.</p>}
    {status.repository && <p className="text-xs text-muted-foreground">Репозиторий: {status.repository}</p>}
    {status.error && <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-destructive">
      Проверка не удалась: {status.error} Это не означает, что обновлений нет.
      {status.okAt > 0 && ` Ниже — данные последней успешной проверки (${new Date(status.okAt).toLocaleString()}).`}</p>}
    {target ? <div className="space-y-2 rounded-lg border border-border p-3">
      <p className="font-semibold">Доступно обновление {target.tag}{target.title !== target.tag && ` — ${target.title}`}</p>
      <p className="text-xs text-muted-foreground">Опубликовано {day(target.publishedAt)} · коммит {status.commit?.slice(0, 12)}
        {status.pending.length > 1 && ` · будут применены по порядку: ${status.pending.map((r) => r.tag).join(", ")}`}</p>
      {status.pending.slice().reverse().filter((release) => release.notes || release === target).map((release) => <div key={release.tag}>
        {status.pending.length > 1 && <p className="text-xs font-medium">{release.tag}</p>}
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-sans text-xs">{release.notes || "Описание не заполнено."}</pre>
        {release.url && <a className="text-xs underline" href={release.url} target="_blank" rel="noreferrer">Релиз на GitHub</a>}
      </div>)}
      <div className="flex flex-wrap gap-2">
        {status.runOwner ? <button type="button" className={button} disabled={busy !== null} onClick={() => { void start(); }}>Открыть идущее обновление</button>
          : <button type="button" className={`${button} bg-primary text-primary-foreground hover:bg-primary/90`} disabled={busy !== null || status.job?.state === "running"} onClick={openChooser}>
            {status.job?.state === "running" ? "Обновляю…" : `Обновить до ${target.tag}`}</button>}
        {!status.runOwner && (status.remaining > 0 || status.job?.state === "failed") &&
          <button type="button" className={button} disabled={busy !== null} onClick={() => { void start(); }}>{busy === "start" ? "Готовлю…" : "Разобраться с ИИ"}</button>}
      </div>
      <p className="text-xs text-muted-foreground">«Обновить» показывает новые компоненты на выбор и применяет релиз сам, без агента: ставит недостающее, обновляет устаревшее, сохраняет ваши настройки. Агент нужен, только если что-то не получилось. Проверка сама ничего не устанавливает.</p>
    </div> : status.okAt > 0 && !status.error && <p>Новых стабильных релизов нет.</p>}
    <button type="button" className={button} disabled={busy !== null} onClick={() => { void check(); }}>{busy === "check" ? "Проверяю…" : "Проверить сейчас"}</button>
  </div>;
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "update-notice", component: Notice });
  app.slots.settingsSection({ id: "updates", title: "Обновления доработок", description: "Стабильные релизы репозитория доработок BB", component: Section });
});
