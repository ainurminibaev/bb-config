import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract, UpdateStatus } from "./server";

const REMIND_MS = 24 * 3_600_000;
const SEEN_KEY = "config-updates:toast";

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
  return { status, busy, check, start };
}

let footer: { open(): void } | null = null;

/** Opens the sidebar-footer card for a published release at most once a day per version and browser. */
function Notice() {
  const { status } = useUpdates();
  const tag = status?.pending.at(-1)?.tag;
  useEffect(() => {
    if (!tag) return;
    let seen: { tag?: string; at?: number } = {};
    try { seen = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "{}"); } catch { /* shown again */ }
    if (seen.tag === tag && Date.now() - (seen.at ?? 0) < REMIND_MS) return;
    try { localStorage.setItem(SEEN_KEY, JSON.stringify({ tag, at: Date.now() })); } catch { /* private mode */ }
    footer?.open();
  }, [tag]);
  return null;
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

/** The card above the sidebar footer row, next to bb's own update notices. */
function FooterCard({ dismiss }: { dismiss(): void }) {
  const { status, busy, check, start } = useUpdates();
  const target = status?.pending.at(-1);
  return <div className="space-y-2 rounded-lg border border-border bg-background p-3 text-sm shadow-sm" data-config-updates-card>
    <p className="font-semibold">Обновления доработок BB</p>
    {!status ? <p className="text-muted-foreground">Загрузка…</p> : <>
      <Summary status={status} />
      {status.error && <p role="alert" className="text-xs text-destructive">Проверка не удалась: {status.error} Это не означает, что обновлений нет.</p>}
      {target && <div className="border-t border-border pt-2">
        {target.title !== target.tag && <p className="text-xs font-medium">{target.title}</p>}
        <p className="line-clamp-4 whitespace-pre-wrap break-words text-xs text-muted-foreground">{target.notes || "Описание не заполнено."}</p>
        {status.pending.length > 1 && <p className="text-xs text-muted-foreground">Вместе с пропущенными: {status.pending.map((r) => r.tag).slice(-4).join(", ")}{status.pending.length > 4 && " и более ранние"}.</p>}
      </div>}
      {status.remaining > 0 && <p className="text-xs text-muted-foreground">Прошлое обновление применено частично, осталось шагов: {status.remaining}.</p>}
      <div className="flex flex-wrap gap-2">
        {target && <button type="button" className={`${button} bg-primary text-primary-foreground hover:bg-primary/90`} disabled={busy !== null}
          onClick={() => { void start().then(dismiss); }}>{busy === "start" ? "Готовлю…" : status.runOwner ? "Открыть идущее обновление" : `Обновить до ${target.tag} с ИИ`}</button>}
        <button type="button" className={button} disabled={busy !== null} onClick={() => { void check(); }}>{busy === "check" ? "Проверяю…" : "Проверить"}</button>
        <button type="button" className={button} onClick={dismiss}>Скрыть</button>
      </div>
    </>}
  </div>;
}

const button = "inline-flex h-8 items-center rounded-md border border-border px-3 text-sm font-medium hover:bg-muted disabled:opacity-50";

function Section() {
  const { status, busy, check, start } = useUpdates();
  if (!status) return <p className="text-sm text-muted-foreground">Загрузка…</p>;
  const target = status.pending.at(-1);
  return <div className="space-y-3 text-sm" data-config-updates>
    <Summary status={status} />
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
      <button type="button" className={`${button} bg-primary text-primary-foreground hover:bg-primary/90`} disabled={busy !== null} onClick={() => { void start(); }}>
        {busy === "start" ? "Готовлю…" : status.runOwner ? "Открыть идущее обновление" : `Обновить до ${target.tag} с ИИ`}</button>
      <p className="text-xs text-muted-foreground">Кнопка открывает экран нового треда с готовым заданием, проектом и машиной сервера: выберите модель и отправьте. Агент проверит фактическое состояние, применит только нужные шаги закреплённого релиза и сообщит результат. Проверка сама ничего не устанавливает.</p>
    </div> : status.okAt > 0 && !status.error && <p>Новых стабильных релизов нет.</p>}
    <button type="button" className={button} disabled={busy !== null} onClick={() => { void check(); }}>{busy === "check" ? "Проверяю…" : "Проверить сейчас"}</button>
  </div>;
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "update-notice", component: Notice });
  footer = app.experimental_sidebarFooter.register({ kind: "disclosure", id: "updates", label: "Обновления доработок BB", icon: "Download", component: FooterCard });
  app.slots.settingsSection({ id: "updates", title: "Обновления доработок", description: "Стабильные релизы репозитория доработок BB", component: Section });
});
