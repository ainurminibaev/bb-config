import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import {
  QUICK_FILTERS, QUICK_STATES, STATE_LABEL, ago, filterCounts, passesFilter, projectThreads,
  summarizeProjects, threadState, type ProjectSummary, type QuickFilter, type QuickProject,
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
.mt-pq-list { overflow-y: auto; padding: 3px; overscroll-behavior: contain; }
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
.mt-pq-count { display: inline-flex; align-items: center; gap: 2px; }
.mt-pq-arrow {
  display: flex; height: 24px; width: 20px; flex-shrink: 0; align-items: center; justify-content: center;
  color: var(--muted-foreground); background: transparent; border: 0; border-radius: 4px; cursor: pointer;
}
.mt-pq-arrow:hover, .mt-pq-arrow[aria-expanded="true"] { color: var(--popover-foreground); background: var(--state-active); }
.mt-pq-none { padding: 10px 8px; color: var(--muted-foreground); }
.mt-pq-head { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-bottom: 1px solid var(--border); font-weight: 600; }
.mt-pq-head > span { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mt-pq-head > em { font-style: normal; font-weight: 400; color: var(--muted-foreground); font-variant-numeric: tabular-nums; }
.mt-pq-thread {
  display: flex; width: 100%; align-items: center; gap: 7px; min-height: 26px; padding: 2px 6px; border-radius: 5px;
  font-size: 12.5px; text-align: left; color: inherit; background: transparent; border: 0; cursor: pointer; outline: none;
}
.mt-pq-thread:hover, .mt-pq-thread:focus-visible { background: var(--state-hover); }
.mt-pq-thread[data-child] { padding-left: 16px; }
.mt-pq-thread > .mt-pq-title { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mt-pq-thread > .mt-pq-meta { flex-shrink: 0; font-size: 10.5px; color: var(--muted-foreground); font-variant-numeric: tabular-nums; }
.mt-pq-dot { display: inline-block; width: 7px; height: 7px; flex-shrink: 0; border-radius: 999px; }
.mt-pq-dot[data-s="input"] { background: #f59e0b; }
.mt-pq-dot[data-s="error"] { background: #ef4444; }
.mt-pq-dot[data-s="unread"] { background: #3b82f6; }
.mt-pq-dot[data-s="idle"] { background: transparent; box-shadow: inset 0 0 0 1.3px color-mix(in oklab, var(--muted-foreground) 70%, transparent); }
.mt-pq-dot[data-s="working"] {
  width: 9px; height: 9px; background: transparent;
  border: 1.6px solid color-mix(in oklab, var(--muted-foreground) 35%, transparent); border-top-color: var(--popover-foreground);
  animation: mt-pq-spin .9s linear infinite;
}
@keyframes mt-pq-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .mt-pq-dot[data-s="working"] { animation: none; } }
@media (hover: none) { .mt-pq-panel { width: min(288px, calc(100vw - 16px)); } }
`;

const OPEN_DELAY = 140;
const CLOSE_DELAY = 260;

function StateDot({ state }: { state: QuickState }) {
  return <span className="mt-pq-dot" data-s={state} title={STATE_LABEL[state]} aria-hidden="true" />;
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

function Counts({ summary }: { summary: ProjectSummary }) {
  const shown = QUICK_STATES.filter((state) => state !== "idle" && summary.counts[state] > 0);
  const title = QUICK_STATES.filter((state) => summary.counts[state] > 0)
    .map((state) => `${STATE_LABEL[state]}: ${summary.counts[state]}`).join("\n");
  return (
    <span className="mt-pq-counts" title={title || "Нет активных тредов"}>
      {shown.map((state) => (
        <span key={state} className="mt-pq-count"><StateDot state={state} />{summary.counts[state]}</span>
      ))}
      {summary.threads.length > 0 ? <span>{summary.threads.length}</span> : null}
    </span>
  );
}

type Place = { left: number; top: number; maxHeight: number };

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
}: {
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
  const [now, setNow] = useState(() => Date.now());
  const scope = usePortalScopeProps();

  const summaries = useMemo(() => summarizeProjects(projects, threads), [projects, threads]);
  const counts = useMemo(() => filterCounts(summaries), [summaries]);
  const rows = useMemo(() => {
    const typed = query.trim().toLowerCase();
    const needles = [...new Set([typed, swap(typed, EN, RU), swap(typed, RU, EN)])];
    return summaries.filter((summary) => passesFilter(summary, filter) &&
      (typed === "" || textMatches(summary.project.isPersonal ? "Без проекта No project" : summary.project.name, needles)));
  }, [summaries, query, filter]);
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

  const show = useCallback(() => {
    if (!button.current) return;
    setNow(Date.now());
    setPlace(placeBeside(button.current.getBoundingClientRect(), 288, 6, 460));
    setOpen(true);
  }, []);

  // Hover: open after a short rest, close a moment after the pointer leaves button, menu and side list.
  const enter = useCallback(() => {
    window.clearTimeout(closeTimer.current);
    if (!open) {
      window.clearTimeout(openTimer.current);
      openTimer.current = window.setTimeout(show, OPEN_DELAY);
    }
  }, [open, show]);
  const leave = useCallback(() => {
    window.clearTimeout(openTimer.current);
    if (pinned) return;
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => {
      if (document.activeElement && panel.current?.contains(document.activeElement) && query !== "") return;
      close();
    }, CLOSE_DELAY);
  }, [pinned, close, query]);

  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const update = () => button.current && setPlace(placeBeside(button.current.getBoundingClientRect(), 288, 6, 460));
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (button.current?.contains(target) || panel.current?.contains(target) || flyPanel.current?.contains(target)) return;
      close();
    };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); close(); button.current?.focus(); } };
    document.addEventListener("mousedown", outside, true);
    document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("mousedown", outside, true); document.removeEventListener("keydown", key, true); };
  }, [open, close]);

  useEffect(() => { setCursor(0); }, [query, filter]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-pq-index="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const openFly = useCallback((projectId: string, anchor: HTMLElement, delay: number) => {
    window.clearTimeout(flyTimer.current);
    flyTimer.current = window.setTimeout(() => {
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
            disabled={item.id !== "all" && counts[item.id] === 0 && filter !== item.id}
            onClick={() => setFilter((now) => (now === item.id ? "all" : item.id))}
          >
            {item.id !== "all" ? <StateDot state={item.id} /> : null}
            {item.label}
            <b>{counts[item.id]}</b>
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
              data-current={index === cursor || fly?.projectId === id ? "" : undefined}
              data-empty={summary.threads.length === 0 ? "" : undefined}
              onPointerEnter={() => {
                setCursor(index);
                if (fly && fly.projectId !== id) window.clearTimeout(flyTimer.current);
              }}
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
                <Counts summary={summary} />
              </button>
              {summary.threads.length > 0 ? (
                <button
                  type="button"
                  className="mt-pq-arrow"
                  aria-label={`Треды проекта ${summary.project.name}`}
                  aria-expanded={fly?.projectId === id}
                  onPointerEnter={(event) => openFly(id, event.currentTarget, 90)}
                  onPointerLeave={() => window.clearTimeout(flyTimer.current)}
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
      onPointerEnter={enter}
      onPointerLeave={leave}
    >
      <div className="mt-pq-head">
        <span className="mt-pq-mark">{mark(flySummary.project.id)}</span>
        <span>{flySummary.project.isPersonal ? "Без проекта" : flySummary.project.name}</span>
        <em>{flySummary.threads.length}</em>
      </div>
      <div className="mt-pq-list">
        {projectThreads(flySummary, filter).map((thread) => {
          const state = threadState(thread);
          return (
            <button
              key={thread.id}
              type="button"
              className="mt-pq-thread"
              data-child={thread.parentThreadId ? "" : undefined}
              title={`${thread.displayTitle}\n${STATE_LABEL[state]}${thread.host ? ` · ${thread.host.name}` : ""}`}
              onClick={() => chooseThread(thread)}
            >
              <StateDot state={state} />
              <span className="mt-pq-title">{thread.displayTitle}</span>
              <span className="mt-pq-meta">{ago(thread.updatedAt ?? thread.createdAt ?? 0, now)}</span>
            </button>
          );
        })}
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
