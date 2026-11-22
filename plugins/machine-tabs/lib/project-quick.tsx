import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import {
  QUICK_FILTERS, QUICK_STATES, STATE_LABEL, ago, duration, filterCounts, insideStates, passesFilter, projectThreads,
  summarizeProjects, threadState, threadTree, type FilterCount, type ProjectSummary, type QuickFilter, type QuickProject,
  type QuickState, type QuickThread,
} from "./project-quick-model";
import { textMatches } from "./text-match";
import { usePortalScopeProps } from "./portal-scope";

export const PROJECT_QUICK_CSS = `
/* Lives inside the sidebar search field beside the funnel; out of sight until the field is hovered. */
.mt-pq-button {
  position: absolute; right: 3.6rem; top: 4px; display: flex; height: 20px; width: 20px; align-items: center; justify-content: center;
  border-radius: 4px; color: var(--muted-foreground); background: transparent; border: 0; cursor: pointer; outline: none;
  opacity: 0; transition: opacity 120ms ease;
}
.machine-tabs-search:hover .mt-pq-button, .machine-tabs-search:focus-within .mt-pq-button { opacity: .7; }
.mt-pq-button:hover, .mt-pq-button:focus-visible, .mt-pq-button[aria-expanded="true"] { opacity: 1; color: var(--sidebar-foreground); }
.mt-pq-button[aria-expanded="true"] { background: var(--state-active); }
.mt-pq-button:focus-visible { outline: 2px solid var(--sidebar-ring); }
@media (hover: none) { .mt-pq-button { opacity: .7; } }
.mt-pq-panel, .mt-pq-fly {
  position: fixed; z-index: 400; display: flex; flex-direction: column; overflow: hidden;
  color: var(--popover-foreground); background: var(--popover); font-size: 12px;
  border: 1px solid var(--border); border-radius: 8px; box-shadow: 0 10px 28px #0000003d;
}
.mt-pq-panel { width: 288px; }
.mt-pq-fly { width: 300px; z-index: 401; }
.mt-pq-find { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-bottom: 1px solid var(--border); color: var(--muted-foreground); }
.mt-pq-find input { min-width: 0; flex: 1; font-size: 12px; color: var(--popover-foreground); background: transparent; border: 0; outline: none; }
.mt-pq-chips { display: flex; flex-wrap: wrap; gap: 3px; padding: 5px 6px; border-bottom: 1px solid var(--border); }
.mt-pq-chip {
  display: inline-flex; align-items: center; gap: 4px; height: 20px; padding: 0 6px; font-size: 11px;
  color: var(--muted-foreground); background: transparent; border: 1px solid var(--border); border-radius: 999px; cursor: pointer;
}
.mt-pq-chip:hover { color: var(--popover-foreground); background: var(--state-hover); }
.mt-pq-chip[data-on] { color: var(--popover-foreground); background: var(--state-active); border-color: transparent; font-weight: 500; }
.mt-pq-chip:disabled { opacity: .45; cursor: default; }
.mt-pq-chip > b { font-weight: 400; font-variant-numeric: tabular-nums; opacity: .75; }
.mt-pq-list { overflow-y: auto; overflow-x: hidden; padding: 3px; overscroll-behavior: contain; }
.mt-pq-row { display: flex; align-items: center; border-radius: 5px; }
.mt-pq-row[data-current] { background: var(--state-hover); }
.mt-pq-row[data-empty] .mt-pq-name { color: var(--muted-foreground); }
.mt-pq-main {
  display: flex; min-width: 0; flex: 1; align-items: center; gap: 7px; min-height: 26px; padding: 2px 4px 2px 6px;
  font-size: 12.5px; text-align: left; color: inherit; background: transparent; border: 0; cursor: pointer; outline: none;
}
.mt-pq-mark { display: inline-flex; width: 18px; height: 18px; flex-shrink: 0; align-items: center; justify-content: center; overflow: hidden; }
.mt-pq-mark > span { width: 18px !important; height: 18px !important; margin: 0 !important; display: inline-flex; align-items: center; justify-content: center;
  overflow: hidden; border-radius: 5px; font-size: 9px; font-weight: 600; line-height: 1; }
.mt-pq-mark img { width: 100%; height: 100%; object-fit: contain; opacity: .8; filter: grayscale(1); }
.mt-pq-mark svg { width: 12px; height: 12px; }
.mt-pq-name { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mt-pq-counts { display: inline-flex; flex-shrink: 0; align-items: center; gap: 5px; font-size: 10.5px; font-variant-numeric: tabular-nums; color: var(--muted-foreground); }
.mt-pq-count { display: inline-flex; align-items: center; gap: 1px; }
.mt-pq-arrow {
  display: flex; height: 24px; width: 20px; flex-shrink: 0; align-items: center; justify-content: center;
  color: var(--muted-foreground); background: transparent; border: 0; border-radius: 4px; cursor: pointer;
}
.mt-pq-arrow:hover, .mt-pq-arrow[aria-expanded="true"] { color: var(--popover-foreground); background: var(--state-active); }
.mt-pq-none { padding: 10px 8px; color: var(--muted-foreground); }
.mt-pq-head { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-bottom: 1px solid var(--border); font-weight: 600; }
.mt-pq-head > span:not(.mt-pq-mark) { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mt-pq-head > em { font-style: normal; font-weight: 400; color: var(--muted-foreground); font-variant-numeric: tabular-nums; }
.mt-pq-thread {
  display: flex; width: 100%; align-items: center; gap: 7px; min-height: 26px; padding: 2px 6px; border-radius: 5px;
  font-size: 12.5px; text-align: left; color: inherit; background: transparent; border: 0; cursor: pointer; outline: none;
}
.mt-pq-thread:hover, .mt-pq-thread:focus-visible { background: var(--state-hover); }
/* The status column stays put; a child thread indents its title only. */
.mt-pq-trow { display: flex; min-width: 0; align-items: center; border-radius: 5px; }
.mt-pq-trow > .mt-pq-thread { width: auto; min-width: 0; flex: 1; padding-right: 2px; }
.mt-pq-trow:hover { background: var(--state-hover); }
.mt-pq-trow > .mt-pq-thread:hover, .mt-pq-trow > .mt-pq-thread:focus-visible { background: transparent; }
.mt-pq-fold {
  /* One width for every row (with or without subthreads, with or without a state), so times line up. */
  display: flex; height: 22px; width: 40px; flex-shrink: 0; align-items: center; justify-content: flex-end; padding-right: 2px;
  color: var(--muted-foreground); background: transparent; border: 0; border-radius: 4px; cursor: pointer;
}
button.mt-pq-fold:hover { color: var(--popover-foreground); background: var(--state-active); }
/* The fold button carries what its subthreads do: the top state and how many are in it. */
.mt-pq-fold[data-inside] { gap: 1px; font-size: 10.5px; font-variant-numeric: tabular-nums; }
.mt-pq-count[data-nested] { opacity: .75; }
.mt-pq-count[data-nested]::before { content: "↳"; margin-right: 1px; }
.mt-pq-thread > .mt-pq-meta[data-running] { color: var(--popover-foreground); }
.mt-pq-thread[data-unread] > .mt-pq-title { font-weight: 600; }
.mt-pq-thread > .mt-pq-title { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mt-pq-thread > .mt-pq-meta { flex-shrink: 0; min-width: 44px; text-align: right; font-size: 10.5px; color: var(--muted-foreground); font-variant-numeric: tabular-nums; white-space: nowrap; }
/* Status marks as bb's sidebar draws them: same icons, one 16px cell so titles line up. */
.mt-pq-st { display: inline-flex; width: 16px; height: 16px; flex-shrink: 0; align-items: center; justify-content: center; color: var(--muted-foreground); }
.mt-pq-st[data-small] { width: 13px; height: 13px; }
.mt-pq-st > svg { width: 100%; height: 100%; }
.mt-pq-st[data-k="error"] { color: var(--destructive); }
.mt-pq-st[data-k="input"], .mt-pq-st[data-k="clock"] { color: color-mix(in oklab, var(--muted-foreground) 75%, transparent); }
.mt-pq-st[data-k="working"] { color: color-mix(in oklab, var(--muted-foreground) 50%, transparent); }
.mt-pq-st[data-k="working"] > svg { animation: mt-pq-spin 1s linear infinite; }
.mt-pq-st[data-k="unread"]::before { content: ""; width: 7px; height: 7px; border-radius: 999px; background: var(--sidebar-ring, #3b82f6); }
.mt-pq-st[data-k="idle"] { color: color-mix(in oklab, var(--muted-foreground) 55%, transparent); }
@keyframes mt-pq-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .mt-pq-st[data-k="working"] > svg { animation: none; } }
@media (hover: none) { .mt-pq-panel { width: min(288px, calc(100vw - 16px)); } }
`;

const OPEN_DELAY = 140;
const FIELD_DELAY = 300;
const CLOSE_DELAY = 260;

/** bb's icon for a thread state (summary counts, filter chips). */
const STATE_ICON: Record<QuickState, string | null> = {
  input: "CircleQuestion", error: "CircleX", working: "Loading", unread: null, idle: "CircleCheck",
};

export function StateMark({ state, small = false }: { state: QuickState; small?: boolean }) {
  const icon = STATE_ICON[state];
  return (
    <span className="mt-pq-st" data-k={state} data-small={small ? "" : undefined} title={STATE_LABEL[state]} aria-hidden="true">
      {icon ? <Icon name={icon} /> : null}
    </span>
  );
}

/** One thread's mark, the way bb's list picks it from the row indicator. */
function ThreadMark({ thread }: { thread: QuickThread }) {
  const indicator = thread.indicator ?? "none";
  const byIndicator: Record<string, [string, string]> = {
    "unread-error": ["error", "CircleX"], "queued-failed": ["error", "CircleX"],
    "waiting-for-input": ["input", "CircleQuestion"], "queued-waiting": ["clock", "Clock"],
    workflow: ["other", "Workflow"], "background-agent": ["other", "UserRoundPlus"],
    "background-command": ["other", "Terminal"], "plan-mode": ["other", "ListTodo"],
    runtime: ["working", "Loading"], "working-draft": ["working", "Loading"],
  };
  const state = threadState(thread);
  const [kind, icon] = byIndicator[indicator]
    ?? (state === "input" ? ["input", "CircleQuestion"] : state === "error" ? ["error", "CircleX"]
      : state === "working" ? ["working", "Loading"] : state === "idle" ? ["idle", "CircleCheck"] : [state, ""]);
  return (
    <span className="mt-pq-st" data-k={kind} title={STATE_LABEL[state]} aria-hidden="true">
      {icon ? <Icon name={icon} /> : null}
    </span>
  );
}

/** The menu's own mark: stacked project folders with a list. */
function ProjectsIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.9"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7.5V5.8C3 5.36 3.36 5 3.8 5h4.4l1.6 1.8h6.4c.44 0 .8.36.8.8v.4" />
      <rect x="5.5" y="9" width="15.5" height="10.5" rx="1.6" />
      <path d="M9 12.6h8.5M9 15.9h5.5" />
    </svg>
  );
}

function chipTitle(filter: QuickFilter, count: FilterCount): string {
  const threads = count.roots + count.nested;
  const where = filter === "all" ? `${count.projects} проектов` : `в ${count.projects} проектах`;
  return `Тредов ${threads}: главных ${count.roots}, подтредов ${count.nested} · ${where}`;
}

/** Top-level counts as before; a state only inside subthreads shows its subthread count with ↳. */
function Counts({ summary, longest }: { summary: ProjectSummary; longest?: number }) {
  const shown = QUICK_STATES.filter((state) => state !== "idle" && summary.counts[state] > 0);
  const lines = QUICK_STATES.filter((state) => summary.counts[state] > 0).map((state) => {
    const roots = summary.rootCounts[state], nested = summary.nestedCounts[state];
    const parts = [roots ? `главных ${roots}` : "", nested ? `подтредов ${nested}` : ""].filter(Boolean).join(", ");
    const extra = state === "working" && longest ? ` — дольше всех ${duration(longest)}` : "";
    return `${STATE_LABEL[state]}: ${summary.counts[state]} (${parts})${extra}`;
  });
  const nestedTotal = summary.threads.length - summary.roots;
  if (summary.threads.length) lines.push(`Тредов: ${summary.roots}${nestedTotal ? ` + ${nestedTotal} подтредов` : ""}`);
  return (
    <span className="mt-pq-counts" title={lines.join("\n") || "Нет активных тредов"}>
      {shown.map((state) => {
        const roots = summary.rootCounts[state];
        return (
          <span key={state} className="mt-pq-count" data-nested={roots ? undefined : ""}>
            <StateMark state={state} small />{roots || summary.nestedCounts[state]}
          </span>
        );
      })}
      {summary.roots > 0 ? <span>{summary.roots}</span> : null}
    </span>
  );
}
type Place = { left: number; top: number; maxHeight: number };

/** Under the search field, from `left` (the button, or the pointer over the field), never over the field itself. */
function placeBelow(field: DOMRect, left: number, width: number, wanted: number): Place {
  const top = field.bottom + 4;
  const maxHeight = Math.max(160, Math.min(wanted, window.innerHeight - top - 8));
  return { left: Math.max(8, Math.min(left, window.innerWidth - width - 8)), top, maxHeight };
}

function placeBeside(anchor: DOMRect, width: number, gap: number, wanted: number): Place {
  const room = window.innerWidth;
  const height = window.innerHeight;
  let left = anchor.right + gap;
  if (left + width > room - 8) left = Math.max(8, anchor.left - gap - width);
  if (left < 8 || (room < 640 && left + width > room - 8)) left = Math.max(8, Math.min(anchor.left, room - width - 8));
  const maxHeight = Math.min(wanted, height - 16);
  const top = Math.max(8, Math.min(anchor.top - 4, height - maxHeight - 8));
  return { left, top, maxHeight };
}

export function ProjectQuickMenu<P extends QuickProject>({
  projects,
  threads,
  mark,
  onProject,
  onThread,
  field,
  searchQuery = "",
  turnStarts,
}: {
  /** When the given running threads' turns started; absent — no running times. */
  turnStarts?: (threadIds: string[]) => Promise<Record<string, number>>;
  /** The sidebar search row: the menu opens under it, and a long rest on it opens the menu too. */
  field?: { readonly current: HTMLElement | null };
  /** What is typed in "Поиск тредов": narrows projects to those whose name or threads match. */
  searchQuery?: string;
  projects: readonly P[];
  threads: readonly QuickThread[];
  /** The project's badge, as the sidebar draws it. */
  mark: (projectId: string) => ReactNode;
  onProject: (projectId: string) => void;
  onThread: (thread: QuickThread) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<QuickFilter>("all");
  const [cursor, setCursor] = useState(0);
  const [fly, setFly] = useState<{ projectId: string; anchor: DOMRect } | null>(null);
  const [place, setPlace] = useState<Place | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const flyPanel = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const openTimer = useRef<number | undefined>(undefined);
  const closeTimer = useRef<number | undefined>(undefined);
  const flyTimer = useRef<number | undefined>(undefined);
  const flyCloseTimer = useRef<number | undefined>(undefined);
  const fieldTimer = useRef<number | undefined>(undefined);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [now, setNow] = useState(() => Date.now());
  const scope = usePortalScopeProps();

  const summaries = useMemo(() => summarizeProjects(projects, threads), [projects, threads]);
  const counts = useMemo(() => filterCounts(summaries), [summaries]);
  const inside = useMemo(() => insideStates(threads), [threads]);
  const working = useMemo(() => threads.filter((thread) => threadState(thread) === "working" && !thread.isArchived && !thread.isHidden)
    .map((thread) => thread.id).sort().slice(0, 50), [threads]);
  const workingKey = working.join(",");
  const [starts, setStarts] = useState<Record<string, number>>({});
  // Running times only while the menu is open: one small request, then a clock tick every 30 s.
  useEffect(() => {
    if (!open || !turnStarts || working.length === 0) return;
    let alive = true;
    const load = () => { void turnStarts(working).then((next) => { if (alive) setStarts(next); }).catch(() => undefined); };
    load();
    const tick = window.setInterval(() => { setNow(Date.now()); load(); }, 30_000);
    return () => { alive = false; window.clearInterval(tick); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, turnStarts, workingKey]);
  const runningFor = (id: string) => (starts[id] ? Math.max(0, now - starts[id]!) : 0);
  /** The longest running turn among a project's threads, for its tooltip. */
  const longestIn = (summary: ProjectSummary) => Math.max(0, ...summary.threads.map((thread) => runningFor(thread.id)));
  const outer = useMemo(() => needlesFor(searchQuery), [searchQuery]);
  /** Threads that answer the sidebar search, per project; null without a search. */
  const searchHits = useMemo(() => {
    if (!outer) return null;
    const hits = new Map<string, Set<string>>();
    for (const summary of summaries) {
      const nameHit = textMatches(projectLabel(summary.project), outer);
      const ids = new Set(summary.threads.filter((thread) => nameHit || textMatches(thread.displayTitle, outer)).map((thread) => thread.id));
      if (nameHit || ids.size > 0) hits.set(summary.project.id, ids);
    }
    return hits;
  }, [summaries, outer]);
  const rows = useMemo(() => {
    const needles = needlesFor(query);
    return summaries.filter((summary) => passesFilter(summary, filter) &&
      (!needles || textMatches(projectLabel(summary.project), needles)) &&
      (!searchHits || searchHits.has(summary.project.id)));
  }, [summaries, query, filter, searchHits]);
  const flySummary = fly ? summaries.find((summary) => summary.project.id === fly.projectId) ?? null : null;

  const close = useCallback(() => {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
    window.clearTimeout(flyTimer.current);
    setOpen(false);
    setPinned(false);
    setFly(null);
    setQuery("");
    setCursor(0);
  }, []);

  const anchorLeft = useRef<number | null>(null);
  const placeNow = useCallback(() => {
    if (!button.current) return;
    // The input itself, not the whole sticky row: the row also holds the filter strip below it.
    const box = field?.current?.querySelector("input") ?? field?.current ?? button.current;
    const fieldRect = box.getBoundingClientRect();
    const left = anchorLeft.current ?? button.current.getBoundingClientRect().left;
    setPlace(placeBelow(fieldRect, left, 288, 460));
  }, [field]);
  /** Open under the button, or under the pointer when it rested on the search field. */
  const show = useCallback((pointerX?: number) => {
    anchorLeft.current = pointerX === undefined ? null : pointerX - 24;
    setNow(Date.now());
    placeNow();
    setOpen(true);
  }, [placeNow]);

  // Hover: open after a short rest, close a moment after the pointer leaves button, menu and side list.
  const enter = useCallback(() => {
    window.clearTimeout(closeTimer.current);
    window.clearTimeout(fieldTimer.current);
    if (!open) {
      window.clearTimeout(openTimer.current);
      openTimer.current = window.setTimeout(() => show(), OPEN_DELAY);
    }
  }, [open, show]);
  const leave = useCallback(() => {
    window.clearTimeout(openTimer.current);
    if (pinned) return;
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => {
      if (document.activeElement && panel.current?.contains(document.activeElement) && query !== "") return;
      // Enter/leave events can arrive out of order between the field and the portaled menu; trust :hover.
      if ([button.current, field?.current, panel.current, flyPanel.current].some((node) => node?.matches(":hover"))) return;
      close();
    }, CLOSE_DELAY);
  }, [pinned, close, query, field]);

  useLayoutEffect(() => {
    if (!open || !button.current) return;
    window.addEventListener("resize", placeNow);
    return () => window.removeEventListener("resize", placeNow);
  }, [open, placeNow]);

  // A long rest on the search field opens the menu under the pointer; leaving closes it like the button does.
  useEffect(() => {
    const node = field?.current;
    if (!node) return;
    let x = 0;
    const move = (event: PointerEvent) => { x = event.clientX; };
    const enterField = (event: PointerEvent) => {
      x = event.clientX;
      window.clearTimeout(closeTimer.current);
      if (open || event.pointerType !== "mouse") return;
      window.clearTimeout(fieldTimer.current);
      fieldTimer.current = window.setTimeout(() => show(x), FIELD_DELAY);
    };
    const leaveField = () => { window.clearTimeout(fieldTimer.current); if (open) leave(); };
    const typing = () => window.clearTimeout(fieldTimer.current);
    node.addEventListener("pointerenter", enterField);
    node.addEventListener("pointermove", move);
    node.addEventListener("pointerleave", leaveField);
    node.addEventListener("keydown", typing);
    return () => {
      window.clearTimeout(fieldTimer.current);
      node.removeEventListener("pointerenter", enterField);
      node.removeEventListener("pointermove", move);
      node.removeEventListener("pointerleave", leaveField);
      node.removeEventListener("keydown", typing);
    };
  }, [field, open, show, leave]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (button.current?.contains(target) || field?.current?.contains(target) ||
        panel.current?.contains(target) || flyPanel.current?.contains(target)) return;
      close();
    };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); close(); button.current?.focus(); } };
    document.addEventListener("mousedown", outside, true);
    document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("mousedown", outside, true); document.removeEventListener("keydown", key, true); };
  }, [open, close, field]);

  useEffect(() => { setCursor(0); }, [query, filter, searchQuery]);
  useEffect(() => { setExpanded(new Set()); }, [fly?.projectId]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-pq-index="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  /** The thread list closes a moment after the pointer leaves it and its project row. */
  const closeFlySoon = useCallback(() => {
    window.clearTimeout(flyCloseTimer.current);
    flyCloseTimer.current = window.setTimeout(() => {
      if (flyPanel.current?.matches(":hover")) return;
      setFly((now) => (now && list.current?.querySelector(".mt-pq-row:hover")?.getAttribute("data-pq-id") === now.projectId ? now : null));
    }, 260);
  }, []);
  const openFly = useCallback((projectId: string, anchor: HTMLElement, delay: number) => {
    window.clearTimeout(flyTimer.current);
    flyTimer.current = window.setTimeout(() => {
      window.clearTimeout(flyCloseTimer.current);
      const row = anchor.closest<HTMLElement>(".mt-pq-row") ?? anchor;
      setFly({ projectId, anchor: row.getBoundingClientRect() });
    }, delay);
  }, []);

  const chooseProject = (projectId: string) => { close(); onProject(projectId); };
  const chooseThread = (thread: QuickThread) => { close(); onThread(thread); };

  const panelNode = open && place ? (
    <div
      ref={panel}
      className="mt-pq-panel"
      role="dialog"
      aria-label="Проекты"
      {...scope}
      style={{ left: place.left, top: place.top, maxHeight: place.maxHeight }}
      onPointerEnter={enter}
      onPointerLeave={leave}
      onPointerDown={() => setPinned(true)}
    >
      <label className="mt-pq-find">
        <Icon name="Search" className="size-3.5 shrink-0" />
        <input
          ref={input}
          value={query}
          placeholder="Найти проект"
          aria-label="Найти проект"
          onFocus={() => setPinned(true)}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") { event.preventDefault(); setCursor((at) => Math.min(rows.length - 1, at + 1)); }
            else if (event.key === "ArrowUp") { event.preventDefault(); setCursor((at) => Math.max(0, at - 1)); }
            else if (event.key === "Enter" && rows[cursor]) { event.preventDefault(); chooseProject(rows[cursor]!.project.id); }
            else if (event.key === "ArrowRight" && rows[cursor] && query === "") {
              const row = list.current?.querySelector<HTMLElement>(`[data-pq-index="${cursor}"]`);
              if (row) { event.preventDefault(); openFly(rows[cursor]!.project.id, row, 0); }
            }
          }}
        />
        {query ? (
          <button type="button" aria-label="Очистить" className="flex size-4 items-center justify-center" onClick={() => setQuery("")}>
            <Icon name="X" className="size-3" />
          </button>
        ) : null}
      </label>
      <div className="mt-pq-chips" role="group" aria-label="Быстрые фильтры">
        {QUICK_FILTERS.map((item) => (
          <button
            key={item.id}
            type="button"
            className="mt-pq-chip"
            data-on={filter === item.id ? "" : undefined}
            aria-pressed={filter === item.id}
            disabled={item.id !== "all" && counts[item.id].projects === 0 && filter !== item.id}
            title={chipTitle(item.id, counts[item.id])}
            onClick={() => setFilter((now) => (now === item.id ? "all" : item.id))}
          >
            {item.id !== "all" ? <StateMark state={item.id} small /> : null}
            {item.label}
            <b>{counts[item.id].roots + counts[item.id].nested}</b>
          </button>
        ))}
      </div>
      <div ref={list} className="mt-pq-list" role="listbox" aria-label="Проекты по последней активности">
        {rows.length === 0 ? <p className="mt-pq-none">Ничего не найдено.</p> : rows.map((summary, index) => {
          const id = summary.project.id;
          return (
            <div
              key={id}
              className="mt-pq-row"
              data-pq-index={index}
              data-pq-id={id}
              data-current={index === cursor || fly?.projectId === id ? "" : undefined}
              data-empty={summary.threads.length === 0 ? "" : undefined}
              onPointerEnter={(event) => {
                setCursor(index);
                window.clearTimeout(flyCloseTimer.current);
                if (fly?.projectId === id) return;
                // A long rest opens the project's threads; with a list already open, it follows the pointer sooner.
                if (summary.threads.length > 0) openFly(id, event.currentTarget, fly ? 160 : 450);
                else { window.clearTimeout(flyTimer.current); closeFlySoon(); }
              }}
              onPointerLeave={() => { window.clearTimeout(flyTimer.current); closeFlySoon(); }}
            >
              <button
                type="button"
                role="option"
                aria-selected={index === cursor}
                className="mt-pq-main"
                title={`${summary.project.isPersonal ? "Без проекта" : summary.project.name} — показать в боковой панели`}
                onClick={() => chooseProject(id)}
              >
                <span className="mt-pq-mark">{mark(id)}</span>
                <span className="mt-pq-name">{summary.project.isPersonal ? "Без проекта" : summary.project.name}</span>
                <Counts summary={summary} longest={longestIn(summary)} />
              </button>
              {summary.threads.length > 0 ? (
                <button
                  type="button"
                  className="mt-pq-arrow"
                  aria-label={`Треды проекта ${summary.project.name}`}
                  aria-expanded={fly?.projectId === id}
                  onPointerEnter={(event) => openFly(id, event.currentTarget, 90)}
                  onClick={(event) => openFly(id, event.currentTarget, 0)}
                >
                  <Icon name="ChevronRight" className="size-3.5" />
                </button>
              ) : <span className="mt-pq-arrow" aria-hidden="true" />}
            </div>
          );
        })}
      </div>
    </div>
  ) : null;

  const threadRow = (thread: QuickThread, depth: number, kids: number) => {
    const state = threadState(thread);
    const open = expanded.has(thread.id);
    const below = inside.get(thread.id);
    const running = state === "working" ? runningFor(thread.id) : 0;
    const insideLine = below && below.total
      ? `\nВнутри: ${QUICK_STATES.filter((s) => below.counts[s] > 0).map((s) => `${STATE_LABEL[s].toLowerCase()} ${below.counts[s]}`).join(", ")}`
      : "";
    const top = below?.top ?? null;
    return (
      <div key={thread.id} className="mt-pq-trow">
        <button
          type="button"
          className="mt-pq-thread"
          data-unread={state === "unread" ? "" : undefined}
          title={`${thread.displayTitle}\n${STATE_LABEL[state]}${running ? ` · ход идёт ${duration(running)}` : ""}${thread.host ? ` · ${thread.host.name}` : ""}${insideLine}`}
          onClick={() => chooseThread(thread)}
        >
          <ThreadMark thread={thread} />
          <span className="mt-pq-title" style={depth ? { paddingLeft: depth * 12 } : undefined}>{thread.displayTitle}</span>
          {running
            ? <span className="mt-pq-meta" data-running="">{duration(running)}</span>
            : <span className="mt-pq-meta">{ago(thread.updatedAt ?? thread.createdAt ?? 0, now)}</span>}
        </button>
        {kids > 0 ? (
          <button
            type="button"
            className="mt-pq-fold"
            data-inside={top && !open ? "" : undefined}
            aria-expanded={open}
            aria-label={open ? "Скрыть подтреды" : `Показать подтреды: ${kids}`}
            title={(open ? "Скрыть подтреды" : `Подтреды: ${kids}`) + insideLine}
            onClick={() => setExpanded((now) => {
              const next = new Set(now);
              if (next.has(thread.id)) next.delete(thread.id); else next.add(thread.id);
              return next;
            })}
          >
            {top && !open ? <><StateMark state={top} small />{below!.counts[top]}</> : null}
            <Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-3.5" />
          </button>
        ) : <span className="mt-pq-fold" aria-hidden="true" />}
      </div>
    );
  };
  /** Folded like bb's list: roots, children behind their parent's arrow. A filter or search lists matches flat. */
  const renderThreads = (summary: ProjectSummary) => {
    const hits = searchHits?.get(summary.project.id);
    if (filter !== "all" || hits) {
      const list = projectThreads(summary, filter).filter((thread) => !hits || hits.has(thread.id));
      return list.length ? list.map((thread) => threadRow(thread, 0, 0)) : <p className="mt-pq-none">Нет подходящих тредов.</p>;
    }
    const { roots, children } = threadTree(summary.threads);
    const out: ReactNode[] = [];
    const walk = (thread: QuickThread, depth: number) => {
      const kids = children.get(thread.id) ?? [];
      out.push(threadRow(thread, depth, kids.length));
      if (expanded.has(thread.id)) for (const kid of kids) walk(kid, depth + 1);
    };
    for (const root of roots) walk(root, 0);
    return out;
  };

  const flyPlace = fly && flySummary && panel.current
    ? placeBeside(new DOMRect(panel.current.getBoundingClientRect().left, fly.anchor.top, panel.current.getBoundingClientRect().width, fly.anchor.height), 300, 4, 420)
    : null;
  const flyNode = flySummary && flyPlace ? (
    <div
      ref={flyPanel}
      className="mt-pq-fly"
      role="dialog"
      aria-label={`Треды: ${flySummary.project.name}`}
      {...scope}
      style={{ left: flyPlace.left, top: flyPlace.top, maxHeight: flyPlace.maxHeight }}
      onPointerEnter={() => { enter(); window.clearTimeout(flyCloseTimer.current); }}
      onPointerLeave={() => { leave(); closeFlySoon(); }}
    >
      <div className="mt-pq-head">
        <span className="mt-pq-mark">{mark(flySummary.project.id)}</span>
        <span>{flySummary.project.isPersonal ? "Без проекта" : flySummary.project.name}</span>
        <em>{flySummary.threads.length}</em>
      </div>
      <div className="mt-pq-list">
        {renderThreads(flySummary)}
      </div>
    </div>
  ) : null;

  return (
    <>
      <button
        ref={button}
        type="button"
        className="mt-pq-button"
        aria-label="Проекты: быстрый переход"
        aria-haspopup="dialog"
        aria-expanded={open}
        onPointerEnter={enter}
        onPointerLeave={leave}
        onClick={() => {
          window.clearTimeout(openTimer.current);
          if (open && pinned) { close(); return; }
          if (!open) show();
          else { anchorLeft.current = null; placeNow(); }
          setPinned(true);
          window.setTimeout(() => input.current?.focus(), 0);
        }}
      >
        <ProjectsIcon />
      </button>
      {panelNode ? createPortal(panelNode, document.body) : null}
      {flyNode ? createPortal(flyNode, document.body) : null}
    </>
  );
}

const EN = "`qwertyuiop[]asdfghjkl;'zxcvbnm,.";
const RU = "ёйцукенгшщзхъфывапролджэячсмитьбю";
/** The same keys in the other keyboard layout: "ифкщ" finds "bb-config". */
function swap(text: string, from: string, to: string): string {
  return [...text].map((ch) => { const at = from.indexOf(ch); return at < 0 ? ch : to[at]!; }).join("");
}

function needlesFor(text: string): string[] | null {
  const typed = text.trim().toLowerCase();
  return typed === "" ? null : [...new Set([typed, swap(typed, EN, RU), swap(typed, RU, EN)])];
}

function projectLabel(project: QuickProject): string {
  return project.isPersonal ? "Без проекта No project" : project.name;
}
