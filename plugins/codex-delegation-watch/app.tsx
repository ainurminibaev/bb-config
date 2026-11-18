import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract, WatchView } from "./contract";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
type Overview = { enabled: boolean; maxNudges: number; intervalMinutes: number; watches: WatchView[] };

const errText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const btn =
  "inline-flex cursor-pointer items-center rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-accent disabled:pointer-events-none disabled:opacity-50";

function ago(ts: number | null): string {
  if (ts === null) return "ещё не проверялся";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s} с назад`;
  if (s < 3600) return `${Math.round(s / 60)} мин назад`;
  return new Date(ts).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function Row({ w, rpc, reload, maxNudges }: { w: WatchView; rpc: Rpc; reload: () => void; maxNudges: number }) {
  const navigate = useBbNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const act = (name: string, fn: () => Promise<string | null>) => {
    setBusy(name);
    setNote(null);
    fn().then((text) => setNote(text), (error) => setNote(`Ошибка: ${errText(error)}`)).finally(() => {
      setBusy(null);
      reload();
    });
  };
  const state = w.done ? `снят: ${w.doneReason ?? ""}` : w.mode === "observe" ? "только наблюдение" : "надзор с подталкиванием";
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <button type="button" className="cursor-pointer text-left text-sm font-medium hover:underline" onClick={() => navigate.toThread(w.threadId)}>{w.title}</button>
        <span className="text-xs text-muted-foreground">{state}</span>
      </div>
      <div className="text-xs text-muted-foreground">
        {w.lastSummary ?? "—"} · проверка: {ago(w.lastCheckAt)} · подталкиваний {w.nudges}/{maxNudges}
        {!w.hasParent && " · без родителя"}
      </div>
      <div className="flex flex-wrap gap-2 pt-1">
        <button type="button" className={btn} disabled={busy !== null} onClick={() => act("check", async () => (await rpc.call("checkNow", { threadId: w.threadId })).summary)}>
          {busy === "check" ? "Проверяю…" : "Проверить сейчас"}
        </button>
        {!w.done && w.mode === "supervise" && (
          <button type="button" className={btn} disabled={busy !== null} onClick={() => act("observe", async () => { await rpc.call("setMode", { threadId: w.threadId, mode: "observe" }); return "Теперь только наблюдение."; })}>
            Только наблюдать
          </button>
        )}
        {!w.done && w.mode === "observe" && w.hasParent && (
          <button type="button" className={btn} disabled={busy !== null} onClick={() => act("supervise", async () => { await rpc.call("setMode", { threadId: w.threadId, mode: "supervise" }); return "Включён надзор с подталкиванием."; })}>
            Надзор с подталкиванием
          </button>
        )}
        {!w.done && (
          <button type="button" className={btn} disabled={busy !== null} onClick={() => act("remove", async () => { await rpc.call("remove", { threadId: w.threadId }); return null; })}>
            Снять с надзора
          </button>
        )}
      </div>
      {note && <div className="text-xs">{note}</div>}
    </div>
  );
}

function Screen() {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const reload = useCallback(() => {
    rpc.call("overview", { includeDone: showDone }).then((d) => { setData(d); setError(null); }, (e) => setError(errText(e)));
  }, [rpc, showDone]);
  useEffect(() => {
    reload();
    const timer = setInterval(reload, 30_000);
    return () => clearInterval(timer);
  }, [reload]);

  return (
    <div className="flex flex-col gap-3">
      {data && !data.enabled && (
        <div className="rounded-md border border-border bg-muted p-3 text-sm">
          Надзор выключен: треды не проверяются и не подталкиваются, сами треды работают как обычно. Включите «Надзор включён» выше.
        </div>
      )}
      {data && data.enabled && (
        <div className="text-xs text-muted-foreground">Проверка каждые {data.intervalMinutes} мин. Список обновляется сам.</div>
      )}
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} />
          Показать снятые с надзора
        </label>
        <button type="button" className={btn} onClick={reload}>Обновить</button>
      </div>
      {error && <div className="text-sm text-destructive">Ошибка: {error}</div>}
      {data && data.watches.length === 0 && <div className="text-sm text-muted-foreground">Под надзором нет тредов.</div>}
      {data?.watches.map((w) => <Row key={w.threadId} w={w} rpc={rpc} reload={reload} maxNudges={data.maxNudges} />)}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "watches",
    title: "Треды под надзором",
    description: "Делегированные треды Codex: статус, последняя проверка, подталкивания.",
    component: Screen,
  });
});
