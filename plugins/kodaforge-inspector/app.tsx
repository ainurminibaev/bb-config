import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import {
  definePluginApp,
  ThreadChat,
  useRealtime,
  useRpc,
  useSdk,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import {
  attachLayout,
  autoOpenWorkspace,
  belongsTo,
  CSS,
  inspect,
  headerSlot,
  threadInWorkspace,
  type Layout,
} from "./inspector";
type Attachment = ReturnType<typeof attachLayout>;
type Choice = Exclude<Layout, "ask">;
function Inspector() {
  const rpc = useRpc<typeof rpcContract>();
  const threadId = useSyncExternalStore(
    subscribeToRoute,
    currentThread,
    () => null,
  );
  const { values } = useSettings();
  const sdk = useSdk();
  const route = useSyncExternalStore(subscribeToRoute, currentRoute, () => "");
  const target = autoOpenWorkspace(route, values?.autoOpen, values?.autoOpenThread);
  useEffect(() => {
    if (!target) return;
    let active = true;
    sdk.plugins
      .list()
      .then(({ plugins }) => {
        const forge = plugins.find((plugin) => plugin.id === "kodaforge");
        if (!active || currentRoute() !== route || !forge?.enabled || !forge.app.bundle?.compatible)
          return;
        // The SDK exposes navigation to the calling plugin's own panels only.
        window.history.replaceState(null, "", target);
        window.dispatchEvent(new PopStateEvent("popstate"));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [route, sdk, target]);
  // null: not read yet. Nothing is changed or asked before the stored choice is known.
  const [layout, setLayout] = useState<Layout | null>(null);
  const [reopened, setReopened] = useState(false);
  const [postponed, setPostponed] = useState(false);
  const load = useCallback(() => {
    if (!threadId) return;
    let current = true;
    rpc.call("config", { threadId }).then(
      (config) => {
        if (current) setLayout(config.layout);
      },
      () => {},
    );
    return () => {
      current = false;
    };
  }, [rpc, threadId]);
  // Another project may have another choice: nothing carries over between threads.
  useEffect(() => {
    setLayout(null);
    setReopened(false);
    setPostponed(false);
    return load();
  }, [load]);
  useRealtime("layout", () => void load());
  if (!threadId || layout === null) return null;
  const asking = reopened || (layout === "ask" && !postponed);
  return (
    <>
      {layout === "center" && (
        <Workspace
          key={threadId}
          threadId={threadId}
          onChangeView={() => setReopened(true)}
        />
      )}
      {layout !== "center" && !asking && (
        <HeaderButton key={threadId} onClick={() => setReopened(true)} />
      )}
      {asking && (
        <Chooser
          current={layout === "center" ? "center" : "native"}
          first={layout === "ask"}
          onClose={() => {
            setReopened(false);
            setPostponed(true);
          }}
          onChoose={async (next, scope) => {
            const saved = await rpc.call("choose", {
              threadId,
              layout: next,
              scope,
            });
            setLayout(saved.layout);
            setReopened(false);
          }}
        />
      )}
    </>
  );
}

/**
 * The way back from the classic view: one small button in KodaForge's own title bar slot
 * (`data-kodaforge-header`). Without that slot nothing is drawn; the plugin settings remain.
 */
function HeaderButton({ onClick }: { onClick: () => void }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const find = () => setSlot(headerSlot(document, isVisible));
    find();
    let frame = 0;
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(find);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);
  if (!slot) return null;
  return createPortal(
    <button
      data-kfi-owned="view"
      type="button"
      title="Вид редактора: чат по центру или классический"
      onClick={onClick}
      className="text-muted-foreground hover:text-foreground"
      style={{ order: 99, flex: "none", padding: "2px 8px", borderRadius: 4, fontSize: 12, cursor: "pointer" }}
    >
      Вид…
    </button>,
    slot,
  );
}

/** The slot holds the button itself, so an empty but shown title bar counts as visible. */
const isVisible = (element: HTMLElement) => element.closest("header")?.getClientRects().length !== 0;

/** Schematic previews: files on the left in both; what fills the middle differs. */
function Preview({ kind }: { kind: Choice }) {
  const line = (x: number, y: number, w: number, o = 0.35) => (
    <rect key={y} x={x} y={y} width={w} height="4" rx="2" fill="currentColor" opacity={o} />
  );
  const bubble = (x: number, y: number, w: number, mine: boolean) => (
    <rect x={x} y={y} width={w} height="12" rx="6" fill="currentColor" opacity={mine ? 0.55 : 0.22} />
  );
  return (
    <svg viewBox="0 0 240 140" role="img" aria-hidden="true">
      <rect width="240" height="140" fill="currentColor" opacity="0.04" />
      <rect x="0" y="0" width="52" height="140" fill="currentColor" opacity="0.07" />
      {[14, 26, 38, 50, 62, 74].map((y, i) => line(i % 3 ? 14 : 8, y, i % 2 ? 26 : 34, 0.3))}
      {kind === "native" ? (
        <>
          {[14, 26, 38, 50, 62, 74, 86, 98, 110].map((y, i) =>
            line(62 + (i % 3) * 8, y, [70, 48, 84, 36, 62, 78, 44, 66, 30][i]!, 0.4),
          )}
          <rect x="166" y="0" width="74" height="140" fill="currentColor" opacity="0.07" />
          {bubble(174, 14, 44, false)}
          {bubble(190, 32, 42, true)}
          {bubble(174, 50, 52, false)}
          <rect x="174" y="116" width="58" height="14" rx="7" fill="none" stroke="currentColor" opacity="0.5" />
        </>
      ) : (
        <>
          <rect x="52" y="0" width="188" height="18" fill="currentColor" opacity="0.07" />
          <rect x="60" y="5" width="34" height="9" rx="4" fill="currentColor" opacity="0.55" />
          <rect x="100" y="5" width="34" height="9" rx="4" fill="currentColor" opacity="0.2" />
          {bubble(70, 30, 96, false)}
          {bubble(124, 50, 100, true)}
          {bubble(70, 70, 118, false)}
          {bubble(150, 90, 74, true)}
          <rect x="70" y="114" width="154" height="16" rx="8" fill="none" stroke="currentColor" opacity="0.5" />
        </>
      )}
    </svg>
  );
}

const OPTIONS: { id: Choice; title: string; text: string }[] = [
  {
    id: "native",
    title: "Штатный вид",
    text: "Код по центру, чат справа. Так KodaForge выглядит без инспектора.",
  },
  {
    id: "center",
    title: "Чат по центру",
    text: "Переписка и поле ввода занимают середину. Код открывается вкладкой «Файлы и код» или кликом по файлу.",
  },
];

export function Chooser({
  current,
  first,
  onClose,
  onChoose,
}: {
  current: Choice;
  first: boolean;
  onClose: () => void;
  onChoose: (next: Choice, scope: "project" | "all") => Promise<void>;
}) {
  const [selected, setSelected] = useState<Choice>(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const apply = useRef<HTMLButtonElement>(null);
  const save = (scope: "project" | "all") => {
    setBusy(true);
    setError("");
    onChoose(selected, scope).catch(() => {
      setError("Не удалось сохранить выбор. Повторите.");
      setBusy(false);
    });
  };
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    apply.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      close.current();
    };
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, []);
  return (
    <div
      className="kfi-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <style>{CSS}</style>
      <div
        className="kfi-chooser"
        role="dialog"
        aria-modal="true"
        aria-labelledby="kfi-chooser-title"
      >
        <h2 id="kfi-chooser-title">Как показывать диалог в редакторе?</h2>
        <p>
          «Применить» сохраняет выбор для этого проекта, «Сохранить для всех» —
          для всех проектов сразу. Изменить его можно кнопкой «Вид…» или в
          настройках KodaForge Inspector.
        </p>
        <div className="kfi-options" role="radiogroup" aria-label="Вид редактора">
          {OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={selected === option.id}
              className="kfi-option"
              onClick={() => setSelected(option.id)}
              onDoubleClick={() => apply.current?.click()}
            >
              <Preview kind={option.id} />
              <b>{option.title}</b>
              <span>{option.text}</span>
            </button>
          ))}
        </div>
        {error && <p role="alert">{error}</p>}
        <div className="kfi-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            {first ? "Позже" : "Отмена"}
          </button>
          <button type="button" disabled={busy} onClick={() => save("all")}>
            Сохранить для всех
          </button>
          <button
            ref={apply}
            type="button"
            className="kfi-primary"
            disabled={busy}
            onClick={() => save("project")}
          >
            Применить
          </button>
        </div>
      </div>
    </div>
  );
}

function currentRoute() {
  return location.pathname + location.search + location.hash;
}

function currentThread() {
  return threadInWorkspace(location.pathname);
}

function subscribeToRoute(check: () => void) {
  const navigation = (window as Window & { navigation?: EventTarget })
    .navigation;
  navigation?.addEventListener("currententrychange", check);
  window.addEventListener("popstate", check);
  window.addEventListener("hashchange", check);
  const timer = navigation ? undefined : window.setInterval(check, 250);
  return () => {
    navigation?.removeEventListener("currententrychange", check);
    window.removeEventListener("popstate", check);
    window.removeEventListener("hashchange", check);
    window.clearInterval(timer);
  };
}

function Workspace({
  threadId,
  onChangeView,
}: {
  threadId: string;
  onChangeView: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [paused, setPaused] = useState(false);
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [mode, setMode] = useState<"chat" | "code">("chat");
  const [warning, setWarning] = useState("");
  useLayoutEffect(() => {
    if (paused) return;
    let mounted: Attachment | null = null;
    let root: HTMLElement | null = null;
    let editors: HTMLElement | null = null;
    let frame = 0,
      lastReport = "",
      started = Date.now();
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.append(style);
    const select = (next: "chat" | "code") => {
      mounted?.mode(next);
      setMode(next);
    };
    const dispose = () => {
      mounted?.dispose();
      mounted = null;
      root = null;
      editors = null;
      setAttachment(null);
    };
    const report = (
      state: "compatible" | "incompatible" | "waiting",
      reason: string,
    ) => {
      const signature = state + reason;
      if (signature === lastReport) return;
      lastReport = signature;
      rpc.call("report", { state, reason }).catch(() => {});
    };
    const scan = () => {
      frame = 0;
      if (currentThread() !== threadId) {
        if (mounted) dispose();
        setWarning("");
        started = Date.now();
        return;
      }
      const result = inspect(document, (e) => e.getClientRects().length > 0);
      if (result.state !== "compatible") {
        if (mounted) dispose();
        const reason =
          result.state === "waiting" && Date.now() - started > 15000
            ? "KodaForge не загрузился. Проверьте, включён ли основной плагин."
            : result.reason;
        setWarning(
          result.state === "incompatible" || Date.now() - started > 15000
            ? reason
            : "",
        );
        report(result.state, reason);
        return;
      }
      setWarning("");
      if (
        mounted &&
        (editors !== result.editors ||
          mounted.original !== result.original ||
          !mounted.toolbar.isConnected ||
          !mounted.chat.isConnected)
      )
        dispose();
      if (!mounted) {
        root = result.root!;
        editors = result.editors!;
        mounted = attachLayout(editors, result.original!);
        setAttachment(mounted);
        setMode("chat");
      }
      report("compatible", result.reason);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(scan);
    };
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class", "style", "id"],
    });
    const click = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (
        currentThread() !== threadId ||
        !root ||
        !target ||
        !belongsTo(root, target)
      )
        return;
      const button = target.closest("button");
      const label = button?.getAttribute("aria-label") ?? "";
      if (
        label === "Chat" ||
        label.startsWith("Toggle Chat") ||
        button?.textContent?.includes("Chat with an agent")
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        select("chat");
        return;
      }
      if (target.closest('[data-panel][id="sidebar"]')) select("code");
    };
    const key = (event: KeyboardEvent) => {
      if (currentThread() !== threadId) return;
      if (
        root &&
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "p"
      )
        select("code");
      if (
        root &&
        event.target instanceof Element &&
        belongsTo(root, event.target) &&
        (event.metaKey || event.ctrlKey) &&
        event.altKey &&
        event.key.toLowerCase() === "b"
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        select("chat");
      }
    };
    // A slow heartbeat detects route changes even when BB retains DOM panes.
    const timer = window.setInterval(schedule, 1500);
    document.addEventListener("click", click, true);
    document.addEventListener("keydown", key, true);
    window.addEventListener("popstate", schedule);
    scan();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      clearInterval(timer);
      document.removeEventListener("click", click, true);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("popstate", schedule);
      mounted?.dispose();
      style.remove();
    };
  }, [paused, rpc, threadId]);
  const choose = (next: "chat" | "code") => {
    attachment?.mode(next);
    setMode(next);
  };
  return (
    <>
      {attachment &&
        createPortal(
          <div className="kfi-toolbar">
            <button
              aria-pressed={mode === "chat"}
              onClick={() => choose("chat")}
            >
              Чат с ИИ
            </button>
            <button
              aria-pressed={mode === "code"}
              onClick={() => choose("code")}
            >
              Файлы и код
            </button>
            <button className="kfi-view" onClick={onChangeView}>
              Вид…
            </button>
            <small title="Отдельный плагин. Исходные файлы KodaForge не изменяются.">
              Инспектор ✓
            </small>
          </div>,
          attachment.toolbar,
        )}
      {attachment &&
        createPortal(
          <ThreadChat
            threadId={threadId}
            variant="full"
            layout="contained"
            permissionPolicy="editable"
            className="h-full min-h-0 flex-1"
          />,
          attachment.chat,
        )}
      {warning && (
        <div className="kfi-warning" role="status">
          {warning}{" "}
          <button
            onClick={() => {
              setPaused(true);
              setAttachment(null);
              setWarning("");
            }}
          >
            Отключить до выхода из редактора
          </button>
        </div>
      )}
    </>
  );
}
export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "inspector", component: Inspector });
});
