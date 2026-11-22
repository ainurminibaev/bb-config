// bb-plugin-machine-tabs — frontend.
//
// A sidebar thread list that is bb's own list plus a row of machine tabs.
// It loads a second instance of the bundled thread-list plugin's bundle with
// one hook wrapped: inside this plugin's list, `experimental_useSidebarThreads`
// returns only the selected machine's threads. Everything else — grouping
// menu, sections, sorting, drag and drop, row menus — is bb's code, unchanged.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ComponentType } from "react";
import * as zod from "zod";
import {
  definePluginApp,
  experimental_Icon as BbIcon,
  experimental_useSidebarThreads,
  experimental_ThreadRowMetadata as ThreadRowMetadata,
  useBbNavigate,
  useRealtime,
  useRpc,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import type { PluginSidebarThread, PluginThreadListProps } from "@get-bb/plugin-sdk/app";
import type { rpcContract, TabsState } from "./server";
import { cn } from "@/lib/utils";
import { automaticProjectSectionOrder, projectsByLatestThread } from "./lib/project-order";
import { GROUP_PAGING_CSS, withGroupPaging } from "./lib/group-paging";
import { withProjectAliases } from "./lib/project-alias-view";
import { TOPICS, matchesFilters, shownOfTotal, topicForTitle, withAncestors, type RowMark, type Topic } from "./lib/thread-topics";
import { ROW_MARK_CSS, RowMarkChooser } from "./lib/row-mark-chooser";
import { FILTER_PICKER_CSS, FilterPicker, type FilterOption } from "./lib/filter-picker";
import { textMatches } from "./lib/text-match";
import { installSidebarView } from "./lib/sidebar-view";
import { waitForThreadListBundle } from "./lib/thread-list-bundle";
import { SearchExtras, SearchSettings, type SearchOptions } from "./lib/thread-search";
import { PROJECT_QUICK_CSS, ProjectQuickMenu, StateMark } from "./lib/project-quick";
import { REVEAL_CSS, revealProject, revealThread } from "./lib/sidebar-reveal";
import { QUICK_STATES, STATE_LABEL, insideStates, type Inside, type QuickThread } from "./lib/project-quick-model";

const TABS_CHANGED = "machine-tabs-changed";
const ICONS_CHANGED = "machine-tabs-icons-changed";
const ICONS_REFRESH_MS = 5 * 60 * 1000;
// Marks are grey on purpose: they tell projects apart without pulling the eye.
const GREY_MARK_BG = "oklch(0.6 0 0 / 0.16)";
const GREY_MARK_FG = "oklch(0.5 0 0)";

/** The machine whose threads the wrapped list shows; null shows all. */
type Grouping = "none" | "project" | "machine" | "day";
type DayField = "updatedAt" | "createdAt";

/** What one instance of bb's list shows. */
interface ListView {
  /** Only this machine's threads; null shows every machine. */
  machineId: string | null;
  /** Only this project's threads. */
  projectId: string | null;
  /** Only threads of this day bucket (see {@link dayBucket}). */
  day: number | null;
  /** Split the flat list into day sections. */
  byDay: boolean;
  /** The timestamp a thread's day comes from. */
  dayField: DayField;
  /** Only these threads (the search filter, or the Last 5 block); null is no limit. */
  ids: ReadonlySet<string> | null;
  /** Draw the threads as one "Last 5" section, preserving native parent/child trees. */
  recent: boolean;
}

const DEFAULT_VIEW: ListView = {
  machineId: null,
  projectId: null,
  day: null,
  byDay: false,
  dayField: "updatedAt",
  ids: null,
  recent: false,
};

/** A project's mark, shown before a thread's title. */
interface ProjectBadge {
  /** Set when rows show topic icons instead of project marks. */
  topic?: Topic;
  letters: string;
  name: string;
  /** Threads outside any project: an icon instead of letters. */
  personal: boolean;
  /** The project's own image (a data URL), drawn instead of the letters. */
  image: string | null;
}

/** Badges by thread id; null draws none. */
const ProjectBadges = createContext<ReadonlyMap<string, ProjectBadge> | null>(
  null,
);
/** Sidebar threads by id, so a row can draw every plugin's row marks (limit, PR, …). */
const RowThreads = createContext<ReadonlyMap<string, PluginSidebarThread> | null>(null);
/** What each thread's subthreads are doing (see insideStates), for the quiet "↳" mark in its row. */
const RowInside = createContext<ReadonlyMap<string, Inside> | null>(null);

const MachineFilter = createContext<ListView>(DEFAULT_VIEW);

// ------------------------------------------------- loading bb's own list ---

type ThreadListComponent = ComponentType<PluginThreadListProps>;
type Sdk = ReturnType<typeof useSdk>;
type ThreadListBundle = NonNullable<Awaited<ReturnType<Sdk["plugins"]["list"]>>["plugins"][number]["app"]["bundle"]>;
type AnyRecord = Record<string, unknown>;

interface ThreadLike {
  id: string;
  projectId: string;
  parentThreadId?: string | null;
  pinnedAt?: number | null;
  host: { id: string } | null;
  sectionId?: string | null;
  isPinned?: boolean;
  updatedAt?: number;
  createdAt?: number;
}

interface SidebarData {
  threads: readonly ThreadLike[];
  projects?: readonly { id: string }[];
  sections?: readonly unknown[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_SECTION_PREFIX = "machine-tabs-day-";
/** Buckets 0–6 are single days back from today; 7 is everything earlier. */
const EARLIER = 7;

function startOfToday(): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return today.getTime();
}

function dayBucket(thread: ThreadLike, field: DayField, todayStart: number) {
  const at = thread[field] ?? thread.updatedAt ?? 0;
  return Math.min(Math.max(0, Math.ceil((todayStart - at) / DAY_MS)), EARLIER);
}

function dayLabel(bucket: number, todayStart: number): string {
  if (bucket === 0) return "Today";
  if (bucket === 1) return "Yesterday";
  if (bucket === EARLIER) return "Earlier";
  return new Date(todayStart - bucket * DAY_MS).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

/** The threads a view shows, and only the projects that have some of them. */
function applyFilters<T extends SidebarData>(data: T, view: ListView): T {
  if (
    view.machineId === null &&
    view.projectId === null &&
    view.day === null &&
    view.ids === null
  ) {
    return data;
  }
  const todayStart = startOfToday();
  const threads = data.threads.filter(
    (thread) =>
      (view.ids === null || view.ids.has(thread.id)) &&
      (view.machineId === null || thread.host?.id === view.machineId) &&
      (view.projectId === null || thread.projectId === view.projectId) &&
      (view.day === null ||
        dayBucket(thread, view.dayField, todayStart) === view.day),
  );
  const projectIds = new Set(threads.map((thread) => thread.projectId));
  return {
    ...data,
    threads,
    ...(data.projects
      ? { projects: data.projects.filter((p) => projectIds.has(p.id)) }
      : {}),
  };
}

/**
 * Files every unpinned thread under a section for its day. bb's flat
 * ("Custom") organization draws them as its own sections.
 */
function groupByDay<T extends SidebarData>(data: T, field: DayField): T {
  const todayStart = startOfToday();
  const used = new Set<number>();
  const threads = data.threads.map((thread) => {
    if (thread.isPinned) return thread;
    const bucket = dayBucket(thread, field, todayStart);
    used.add(bucket);
    return { ...thread, sectionId: `${DAY_SECTION_PREFIX}${bucket}` };
  });
  const sections = [...used]
    .sort((a, b) => a - b)
    .map((bucket) => ({
      id: `${DAY_SECTION_PREFIX}${bucket}`,
      name: dayLabel(bucket, todayStart),
      createdAt: todayStart - bucket * DAY_MS,
      updatedAt: todayStart - bucket * DAY_MS,
    }));
  return { ...data, threads, sections };
}

/** A grey line icon as a CSS image, for headers this plugin does not render. */
function iconUrl(paths: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#7b7b7b" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}
const PERSON_ICON = iconUrl(
  '<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>',
);
const PIN_ICON = iconUrl(
  '<path d="M12 17v5"/><path d="M8 3h8l-1 6 3 4H6l3-4z"/>',
);
const RECENT_ICON = iconUrl(
  '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
);
const DAY_ICON = iconUrl(
  '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>',
);

function ProjectBadgeMark({
  badge,
  header = false,
}: {
  badge: ProjectBadge;
  /** In a group header: no agent icon is attached to it. */
  header?: boolean;
}) {
  if (!header && badge.topic) {
    const topic = badge.topic;
    return (
      <span data-machine-tabs-badge="topic" title={`${topic.label} · ${badge.name}`} aria-label={topic.label}
        className="machine-tabs-topic-mark" style={{ color: topic.color }}>
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
          strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={topic.path} /></svg>
      </span>
    );
  }
  return (
    <span
      data-machine-tabs-badge={header ? "header" : ""}
      title={badge.name}
      aria-label={badge.personal ? badge.name : `Project ${badge.name}`}
      className={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-[5px] font-semibold leading-none tracking-tight",
        header ? "size-[18px] text-[9px]" : "mr-2 size-4 rounded-[4px] text-[8px]",
      )}
      style={
        badge.image !== null
          ? undefined
          : { backgroundColor: GREY_MARK_BG, color: GREY_MARK_FG }
      }
    >
      {badge.image !== null ? (
        <img
          src={badge.image}
          alt=""
          draggable={false}
          className="size-full object-contain opacity-80 grayscale"
        />
      ) : badge.personal ? (
<svg
          viewBox="0 0 24 24"
          className="size-3"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="8" r="4" />
          <path d="M4.5 20.5a7.5 7.5 0 0 1 15 0" />
        </svg>
      ) : (
        badge.letters
      )}
    </span>
  );
}

/** Project images by project id; re-read on a timer and on `bb machine-tabs icons`. */
function useProjectIcons(): Readonly<Record<string, string>> {
  const rpc = useRpc<typeof rpcContract>();
  const [icons, setIcons] = useState<Readonly<Record<string, string>>>({});
  const load = useCallback(() => {
    rpc.call("project_icons", {}).then(
      (result) => setIcons(result.icons),
      () => undefined,
    );
  }, [rpc]);
  useEffect(() => {
    load();
    const timer = setInterval(load, ICONS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);
  useRealtime(ICONS_CHANGED, load);
  return icons;
}

/** "my-project" → "MP", "SampleApp" → "SA", "root" → "RO". */
function projectLetters(name: string): string {
  const words = name
    .replace(/([a-zа-яё])([A-ZА-ЯЁ])/g, "$1 $2")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => /\p{L}/u.test(word));
  const letters =
    words.length >= 2
      ? words[0]![0]! + words[1]![0]!
      : (words[0] ?? name).slice(0, 2);
  return letters.toUpperCase();
}

/**
 * The same marks before the project headers of bb's list, which this plugin
 * does not render: one generated rule per project.
 */
function projectHeaderCss(badges: ReadonlyMap<string, ProjectBadge>): string {
  const rules: string[] = [];
  for (const [id, badge] of badges) {
    if (badge.personal) continue;
    const mark =
      badge.image !== null
        ? `content: ""; background: center / contain no-repeat url("${badge.image}"); filter: grayscale(1); opacity: 0.8;`
        : `content: ${JSON.stringify(badge.letters)}; background: ${GREY_MARK_BG}; color: ${GREY_MARK_FG};`;
    rules.push(
      `[data-machine-tabs-list] [data-sidebar-project-id=${JSON.stringify(id)}] [data-sidebar="group-label"] > span:first-child::before { ${mark} }`,
    );
  }
  return rules.join("\n");
}

/**
 * Projects with no thread, by id rather than by what is on screen: a
 * collapsed project has no rows either, and must not change places.
 */
function emptyProjectsCss(ids: readonly string[]): string {
  if (ids.length === 0) return "";
  const group = (suffix: string) =>
    ids
      .map(
        (id) =>
          `[data-machine-tabs-list] [data-sidebar-visibility-group=${JSON.stringify(`project:${id}`)}]${suffix}`,
      )
      .join(",\n");
  return `
${group("")} { order: 1; margin-top: -0.75rem; opacity: 0.55; }
${group(":hover")} { opacity: 1; }
${group(' [data-sidebar="group-label"] + div')},
${group(' [data-sidebar="group-label"] > span:first-child::after')},
${group(' [data-sidebar="group-label"] > span:first-child > button')} { display: none; }`;
}

const RECENT_SECTION_ID = "machine-tabs-recent";

/** One recent section, preserving parents so BB renders its own child controls. */
function asRecentSection<T extends SidebarData>(data: T, view: ListView): T {
  const threads = data.threads
    .filter((thread) => view.ids?.has(thread.id))
    .map((thread) => ({
      ...thread,
      isPinned: false,
      pinnedAt: null,
      sectionId: RECENT_SECTION_ID,
    }));
  return {
    ...data,
    threads,
    sections: [
      { id: RECENT_SECTION_ID, name: "Last 5", createdAt: 0, updatedAt: 0 },
    ],
  };
}

/**
 * Two instances of bb's list: "main" follows the user's preferences; "recent"
 * uses chronological organization, so the Last 5 block looks the same
 * whatever grouping the main list uses.
 */
type ListKind = "main" | "recent";

const RECENT_PREFERENCES: AnyRecord = {
  organizationMode: "chronological",
  chronologicalSort: "updated",
  sortDirection: "default",
  groupByReadStatus: false,
  environmentGrouping: false,
  hiddenGroups: [],
  collapsedThreadSections: [],
  manualSectionOrder: ["pinned", "sections", "threads"],
};

const nativeListPromises = new Map<ListKind, Promise<ThreadListComponent>>();
/** Loads run one at a time: each swaps the shared SDK while its bundle evaluates. */
let loadQueue: Promise<unknown> = Promise.resolve();

/** Accepts any registration call and ignores it. */
function swallow(): unknown {
  const fn = () => undefined;
  return new Proxy(fn, { get: () => swallow(), apply: () => undefined });
}

async function loadNativeList(
  bundle: ThreadListBundle,
  kind: ListKind,
): Promise<ThreadListComponent> {
  const runtime = (globalThis as AnyRecord).__bbPluginRuntime as
    | AnyRecord
    | undefined;
  const real = runtime?.pluginSdkApp as AnyRecord | undefined;
  if (!runtime || !real) throw new Error("bb's plugin runtime is missing.");
  // BB 0.49 loads Zod lazily. Our direct import of the native list bypasses
  // that loader, so provide our declared dependency when the shared slot
  // has not loaded yet. Preserve BB's own module when it is already present.
  runtime.zod ??= zod;
  const base = ("default" in real ? real.default : real) as AnyRecord;

  const setups = new Map<unknown, (app: unknown) => void>();
  const useThreads = base.experimental_useSidebarThreads as (
    options?: unknown,
  ) => SidebarData;
  const define = base.definePluginApp as (
    setup: (app: unknown) => void,
  ) => unknown;

  // Identical to the real SDK outside <MachineFilter.Provider>, so a bundle
  // that happens to load while it is installed behaves as usual.
  const wrapped: AnyRecord = {
    ...base,
    definePluginApp(setup: (app: unknown) => void) {
      const definition = define(setup);
      setups.set(definition, setup);
      return definition;
    },
    experimental_useSidebarThreads(options?: unknown) {
      const result = useThreads(options);
      const view = useContext(MachineFilter);
      return useMemo(() => {
        if (view.recent) return asRecentSection(result, view);
        const filtered = applyFilters(result, view);
        const ordered = filtered.projects
          ? { ...filtered, projects: projectsByLatestThread(filtered.projects, filtered.threads) }
          : filtered;
        return view.byDay ? groupByDay(ordered, view.dayField) : ordered;
      }, [result, view]);
    },
  };

  const separator = bundle.jsUrl.includes("?") ? "&" : "?";
  // A fresh URL every time: after a hot reload of this plugin the browser
  // would otherwise return the instance bound to the previous load.
  const RealTitle = base.ThreadTitle as ComponentType<{ threadId: string }>;
  wrapped.ThreadTitle = function TitleWithProjectBadge(props: {
    threadId: string;
  }) {
    const badge = useContext(ProjectBadges)?.get(props.threadId);
    const thread = useContext(RowThreads)?.get(props.threadId);
    const inside = useContext(RowInside)?.get(props.threadId);
    const top = inside?.top ?? null;
    return (
      <>
        {badge ? <ProjectBadgeMark badge={badge} /> : null}
        <RealTitle {...props} />
        {thread ? (
          <span data-machine-tabs-row-meta="">
            {top ? (
              <span data-machine-tabs-inside="" title={`Внутри подтредов: ${QUICK_STATES.filter((s) => inside!.counts[s] > 0).map((s) => `${STATE_LABEL[s].toLowerCase()} ${inside!.counts[s]}`).join(", ")}`}>
                ↳<StateMark state={top} small />{inside!.counts[top]}
              </span>
            ) : null}
            <ThreadRowMetadata thread={thread} />
          </span>
        ) : null}
      </>
    );
  };

  if (kind === "recent") {
    // Keep a chronological section, but native child expansion stays shared.
    const useRealRpc = base.useRpc as () => {
      call(method: string, input: unknown): Promise<AnyRecord>;
    };
    wrapped.useRpc = function useRecentRpc() {
      const rpc = useRealRpc();
      return useMemo(
        () => ({
          ...rpc,
          async call(method: string, input: unknown) {
            if (method === "listPreferences") {
              const result = await rpc.call(method, input);
              return {
                ...result,
                preferences: {
                  ...(result.preferences as AnyRecord),
                  ...RECENT_PREFERENCES,
                },
              };
            }
            const { key, value } = (input ?? {}) as AnyRecord;
            if (method === "setPreference" && key === "collapsedThreads") return rpc.call(method, input);
            return { key, value: value ?? RECENT_PREFERENCES[String(key)] };
          },
        }),
        [rpc],
      );
    };
    const useRealRealtime = base.useRealtime as (channel: string, handler: (payload: unknown) => void) => void;
    wrapped.useRealtime = (channel: string, handler: (payload: unknown) => void) => useRealRealtime(channel, payload => {
      if (channel === "preferences" && (payload as AnyRecord)?.key === "collapsedThreads") handler(payload);
    });
  }

  if (kind === "main") {
    // The native list's persisted project IDs otherwise override the sorted
    // sidebar data. Resolve those slots dynamically within each filtered list.
    const normalize = (value: unknown) => Array.isArray(value)
      ? automaticProjectSectionOrder(value as string[]) : value;
    const useRealRpc = base.useRpc as () => {
      call(method: string, input: unknown): Promise<AnyRecord>;
    };
    wrapped.useRpc = function useProjectOrderRpc() {
      const rpc = useRealRpc();
      return useMemo(() => ({
        ...rpc,
        async call(method: string, input: unknown) {
          const result = await rpc.call(method, input);
          if (method === "listPreferences") {
            const preferences = result.preferences as AnyRecord;
            return { ...result, preferences: { ...preferences,
              sectionOrder: normalize(preferences.sectionOrder) } };
          }
          if (method === "setPreference" && result.key === "sectionOrder") {
            return { ...result, value: normalize(result.value) };
          }
          return result;
        },
      }), [rpc]);
    };
    const useRealRealtime = base.useRealtime as (channel: string, handler: (payload: unknown) => void) => void;
    wrapped.useRealtime = (channel: string, handler: (payload: unknown) => void) => useRealRealtime(channel, payload => {
      const event = payload as AnyRecord;
      handler(channel === "preferences" && event?.key === "sectionOrder"
        ? { ...event, value: normalize(event.value) } : payload);
    });
  }

  const url = `${bundle.jsUrl}${separator}machine_tabs=${kind}-${Date.now().toString(36)}`;
  let module: { default?: unknown };
  // The bundle reads the SDK from the shared runtime once, while it
  // evaluates. Swap the SDK in for that moment; if the runtime object is
  // read-only, swap the whole runtime for a copy that inherits from it.
  const globals = globalThis as AnyRecord;
  const realJsx = runtime.jsxRuntime as AnyRecord;
  const aliasesJsx = kind === "main" ? withProjectAliases(realJsx, () => {
    const data = useThreads();
    const view = useContext(MachineFilter);
    return useMemo(() => applyFilters(data, view).threads, [data, view]);
  }) : realJsx;
  const pagedJsx = withGroupPaging(aliasesJsx);
  // The native list captures its JSX helpers during evaluation, just like SDK.
  // Use an inheriting copy so other plugins keep their original runtime.
  const pagingRuntime = Object.create(runtime) as AnyRecord;
  Object.defineProperty(pagingRuntime, "pluginSdkApp", { value: wrapped });
  Object.defineProperty(pagingRuntime, "jsxRuntime", { value: pagedJsx });
  try {
    globals.__bbPluginRuntime = pagingRuntime;
    module = (await import(/* @vite-ignore */ url)) as { default?: unknown };
  } finally {
    globals.__bbPluginRuntime = runtime;
  }

  const setup = setups.get(module.default);
  if (!setup) throw new Error("Could not read bb's thread list bundle.");

  let component: ThreadListComponent | null = null;
  setup(
    new Proxy(
      {},
      {
        get: (_target, key) =>
          key === "slots"
            ? new Proxy(
                {},
                {
                  get: (_slots, slot) =>
                    slot === "experimental_threadList"
                      ? (registration: { component: ThreadListComponent }) => {
                          component = registration.component;
                        }
                      : swallow(),
                },
              )
            : swallow(),
      },
    ),
  );
  if (component === null) {
    throw new Error("bb's thread list did not register a list.");
  }
  return component;
}

function useNativeListBundle() {
  const sdk = useSdk();
  const [bundle, setBundle] = useState<ThreadListBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    waitForThreadListBundle(() => sdk.plugins.list(), controller.signal).then(
      (loaded) => {
        if (!controller.signal.aborted) setBundle(loaded);
      },
      (cause: unknown) => {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      },
    );
    return () => controller.abort();
  }, [sdk]);
  return { bundle, error };
}

function useNativeList(kind: ListKind, bundle: ThreadListBundle | null) {
  const [component, setComponent] = useState<ThreadListComponent | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!bundle) return;
    let cancelled = false;
    let promise = nativeListPromises.get(kind);
    if (!promise) {
      promise = loadQueue.then(() => loadNativeList(bundle, kind));
      loadQueue = promise.catch(() => undefined);
      nativeListPromises.set(kind, promise);
    }
    promise.then(
      (loaded) => {
        if (!cancelled) setComponent(() => loaded);
      },
      (cause: unknown) => {
        nativeListPromises.delete(kind);
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [bundle, kind]);
  return { component, error };
}

// ------------------------------------------------------------------ tabs ---

/** Survives remounts of the list, so the filter applies from the first paint. */
let lastTabsState: TabsState | null = null;

function useTabs() {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setStateRaw] = useState<TabsState | null>(lastTabsState);
  const setState = useCallback((next: TabsState) => {
    lastTabsState = next;
    setStateRaw(next);
  }, []);

  const refetch = useCallback(() => {
    rpc.call("tabs_state", null).then(setState, () => undefined);
  }, [rpc, setState]);

  useEffect(() => {
    refetch();
    window.addEventListener("focus", refetch);
    return () => window.removeEventListener("focus", refetch);
  }, [refetch]);
  useRealtime(TABS_CHANGED, refetch);

  const select = useCallback(
    (machineId: string | null) => {
      // The list filters on the client, so switch at once.
      if (lastTabsState) setState({ ...lastTabsState, selectedId: machineId });
      rpc.call("tabs_select", { machineId }).then(setState, refetch);
    },
    [rpc, refetch, setState],
  );

  const setView = useCallback(
    (view: { byDay: boolean; outer: Grouping }) => {
      if (lastTabsState) setState({ ...lastTabsState, ...view });
      rpc.call("tabs_set_view", view).then(setState, refetch);
    },
    [rpc, refetch, setState],
  );

  return { state, select, setView };
}

const GROUPINGS: readonly { value: Grouping; label: string }[] = [
  { value: "project", label: "Project" },
  { value: "machine", label: "Machine" },
  // Not a bb mode: this plugin splits bb's flat list into day sections.
  { value: "day", label: "Day" },
  { value: "none", label: "None" },
];

const SORT_OPTIONS = [
  { value: "updated", label: "Last updated" },
  { value: "created", label: "Created" },
  { value: "alpha", label: "Name" },
] as const;

/** bb's organization mode that draws a grouping. Day and None use its flat list. */
function nativeMode(grouping: Grouping): string {
  return grouping === "project" || grouping === "machine"
    ? grouping
    : "chronological";
}

function MenuSection({
  title,
  options,
  current,
  onChoose,
}: {
  title: string;
  options: readonly { value: string; label: string }[];
  current: string | null;
  onChoose: (value: string) => void;
}) {
  return (
    <div role="group" aria-label={title}>
      <div className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
        {title}
      </div>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="menuitemradio"
          aria-checked={current === option.value}
          onClick={() => onChoose(option.value)}
          className="flex w-full items-center gap-2 rounded-sm py-1 pl-4 pr-2 text-left text-sm outline-none hover:bg-state-hover focus-visible:bg-state-hover"
        >
          <span className="flex-1">{option.label}</span>
          {current === option.value ? (
            <BbIcon name="Check" className="size-3.5" />
          ) : null}
        </button>
      ))}
    </div>
  );
}

/**
 * Grouping and sorting of the list. One level is bb's own grouping; with a
 * second level the first is drawn by this plugin and bb's list, grouped by
 * the second, repeats inside each group.
 */
function OrganizeMenu({
  ready,
  outer,
  byDay,
  onView,
  onSort,
  onMode,
  onChanged,
}: {
  ready: boolean;
  outer: Grouping;
  byDay: boolean;
  onView: (view: { byDay: boolean; outer: Grouping }) => void;
  onSort: (sort: string | null) => void;
  onMode: (mode: string | null) => void;
  onChanged: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [prefs, setPrefs] = useState<{
    mode: string | null;
    sort: string | null;
  }>({ mode: null, sort: null });
  const [open, setOpen] = useState(false);
  const onSortRef = useRef(onSort);
  onSortRef.current = onSort;
  const onModeRef = useRef(onMode);
  onModeRef.current = onMode;

  const refetch = useCallback(() => {
    if (!ready) return;
    rpc.call("listPreferences", null).then(
      ({ preferences }) => {
        const mode = preferences.organizationMode;
        const sort = preferences.chronologicalSort;
        setPrefs({
          mode: typeof mode === "string" ? mode : null,
          sort: typeof sort === "string" ? sort : null,
        });
        onSortRef.current(typeof sort === "string" ? sort : null);
        onModeRef.current(typeof mode === "string" ? mode : null);
      },
      () => undefined,
    );
  }, [ready, rpc]);
  useEffect(refetch, [refetch]);
  useRealtime("preferences", refetch);

  useEffect(() => {
    if (!open) return;
    refetch();
    const close = () => setOpen(false);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, refetch]);

  const save = (changes: Record<string, string>) => {
    Promise.all(
      Object.entries(changes).map(([key, value]) =>
        rpc.call("setPreference", { key, value }),
      ),
    )
      // bb's list reads its preferences when it mounts, so remount it.
      .then(onChanged, () => undefined)
      .then(refetch);
  };

  // The grouping bb's list draws, and the two levels the menu shows.
  const inner: Grouping =
    prefs.mode === "project" || prefs.mode === "machine"
      ? prefs.mode
      : byDay
        ? "day"
        : "none";
  const first = outer === "none" ? inner : outer;
  const second = outer === "none" ? "none" : inner;

  const apply = (nextFirst: Grouping, nextSecond: Grouping) => {
    const twoLevels =
      nextFirst !== "none" && nextSecond !== "none" && nextFirst !== nextSecond;
    const nextOuter = twoLevels ? nextFirst : "none";
    const nextInner = twoLevels ? nextSecond : nextFirst;
    setPrefs((prev) => ({ ...prev, mode: nativeMode(nextInner) }));
    onModeRef.current(nativeMode(nextInner));
    onView({ outer: nextOuter, byDay: nextInner === "day" });
    save({ organizationMode: nativeMode(nextInner) });
  };

  return (
    <div
      className="relative shrink-0"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        aria-label="Group and sort threads"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Group and sort threads"
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-state-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring",
          open && "bg-state-active text-sidebar-foreground",
        )}
      >
        <BbIcon name="Layers" className="size-4" />
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-8 z-[200] min-w-40 rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        >
          <MenuSection
            title="Group by"
            options={GROUPINGS}
            current={first}
            onChoose={(value) => apply(value as Grouping, second)}
          />
          <div className="my-1 border-t" />
          <MenuSection
            title="Then by"
            options={GROUPINGS.filter(
              (option) => option.value === "none" || option.value !== first,
            )}
            current={second}
            onChoose={(value) => apply(first, value as Grouping)}
          />
          <div className="my-1 border-t" />
          <MenuSection
            title="Sort"
            options={SORT_OPTIONS}
            current={prefs.sort}
            onChoose={(value) => {
              setPrefs((prev) => ({ ...prev, sort: value }));
              save({ chronologicalSort: value, sortDirection: "default" });
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

function Tab({
  label,
  count,
  online = true,
  active,
  onClick,
}: {
  label: string;
  count: number;
  online?: boolean;
  active: boolean;
  onClick: () => void;
}) {
  // Long names give way first; every tab keeps room for about six letters.
  const minWidth = `${Math.min(label.length, 6) * 0.45 + (count > 0 ? 2.1 : 1.2)}rem`;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      title={online ? label : `${label} (offline)`}
      onClick={onClick}
      style={{ flex: `0 ${Math.max(label.length, 1)} auto`, minWidth }}
      className={cn(
        "flex h-7 items-center gap-1.5 rounded-md px-2 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-sidebar-ring",
        active
          ? "bg-state-active font-medium text-sidebar-foreground"
          : "text-muted-foreground hover:bg-state-hover hover:text-sidebar-foreground",
        !online && "opacity-60",
      )}
    >
      <span className="truncate">{label}</span>
      {count === 0 ? null : (
        <span className="shrink-0 text-[0.6875rem] tabular-nums text-muted-foreground">
          {count}
        </span>
      )}
    </button>
  );
}

/** bb's list for one first-level group. The view is memoized: bb's list
 * recomputes everything when it changes. */
function FilteredList({
  List,
  base,
  group,
  listProps,
}: {
  List: ThreadListComponent;
  base: ListView;
  group: OuterGroup;
  listProps: PluginThreadListProps;
}) {
  const { machineId, projectId, day } = group.filter;
  const view = useMemo<ListView>(
    () => ({ ...base, machineId, projectId, day }),
    [base, machineId, projectId, day],
  );
  return (
    <MachineFilter.Provider value={view}>
      <List {...listProps} />
    </MachineFilter.Provider>
  );
}

// The same physical keys in the US and Russian layouts, so a query typed in
// the wrong layout ("ghbdtn" for "привет") still matches.
const EN_KEYS = "`qwertyuiop[]asdfghjkl;'zxcvbnm,.";
const RU_KEYS = "ёйцукенгшщзхъфывапролджэячсмитьбю";
const EN_TO_RU = new Map([...EN_KEYS].map((key, i) => [key, RU_KEYS[i]!]));
const RU_TO_EN = new Map([...RU_KEYS].map((key, i) => [key, EN_KEYS[i]!]));

function swapLayout(text: string, keys: ReadonlyMap<string, string>): string {
  return [...text].map((char) => keys.get(char) ?? char).join("");
}

const COLLAPSED_KEY = "bb-machine-tabs:collapsed-groups";

/** Collapsed first-level groups, kept per browser. */
function useCollapsedGroups() {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => {
    try {
      const parsed: unknown = JSON.parse(
        window.localStorage.getItem(COLLAPSED_KEY) ?? "[]",
      );
      return new Set(
        Array.isArray(parsed)
          ? parsed.filter((v): v is string => typeof v === "string")
          : [],
      );
    } catch {
      return new Set();
    }
  });
  const toggle = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      } catch {
        // Storage blocked: keep the in-memory state.
      }
      return next;
    });
  }, []);
  return { collapsed, toggle };
}

interface OuterGroup {
  id: string;
  label: string;
  count: number;
  filter: Pick<ListView, "machineId" | "projectId" | "day">;
}

// Groups of bb's list that hold no thread: empty projects, machines and the
// loose "Threads" bucket. Hidden whenever the list is filtered, where they
// only say "No threads". A collapsed group has no rows either, but its
// header carries the expand button, so it stays.
const HIDE_EMPTY_GROUPS = `
/* Only a group that says "No threads" is empty. One whose rows are simply
   not drawn yet (bb draws rows as they scroll into view) must stay, or it
   would never get the chance to draw them. */
[data-machine-tabs-hide-empty] [data-sidebar-visibility-group]:has([data-sidebar="group-label"] + div p):not(:has([data-sidebar-thread-id])) {
  display: none;
}
/* Groups with no thread (projects never used here) go below the rest as
   dim one-line headers: still there for New thread, out of the way. */
/* The groups' container is addressed by bb's own class, not by
   \`:has(> [data-sidebar-visibility-group])\`. A \`:has()\` on a bare universal
   subject makes the browser recheck the whole page after every DOM insertion
   anywhere: scrolling a code editor (which inserts a line per frame) spent
   seconds in style recalculation because of these two rules. Never write
   \`:has()\` here without a class or attribute on its subject. */
[data-machine-tabs-list] div.space-y-4 {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
[data-machine-tabs-list] div.space-y-4 > [data-sidebar-visibility-group] {
  margin-top: 0;
  margin-bottom: 0;
}
/* This plugin's sections (days, Last 5) are not bb sections: no New thread
   in section, no rename or delete menu. */
[data-sidebar-visibility-group^="section:machine-tabs-"] [data-sidebar-trailing-controls] {
  display: none;
}
/* The Last 5 block is a whole bb list: drop the space it leaves below itself. */
[data-machine-tabs-recent] [data-sidebar="group"] {
  padding-bottom: 0;
}
[data-machine-tabs-recent] [data-sidebar-visibility-group] {
  margin-bottom: 0;
}
/* Other plugins' row marks (limit-guard priority, PR status, …): quiet, at the
   right end of the title, next to bb's own status dot or clock. */
[data-machine-tabs-row-meta] {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  padding-left: 4px;
  flex: none;
  color: var(--muted-foreground);
  font-size: 11px;
  line-height: 1;
}
[data-machine-tabs-inside] {
  display: inline-flex; align-items: center; gap: 1px; opacity: .7;
  font-size: 10.5px; font-variant-numeric: tabular-nums;
}
[data-machine-tabs-row-meta]:empty {
  display: none;
}
.bb-thread-title:has(> [data-machine-tabs-badge]) {
  align-items: center;
}
/* Three levels read as three weights of one font: machine or other first
   level (semibold), project or section (medium), thread (regular). */
[data-machine-tabs-list] [data-sidebar="group-label"] {
  font-weight: 600;
  color: var(--sidebar-foreground, currentColor);
}
/* Rows sit a step inside the header they belong to. */
[data-machine-tabs-list] [data-sidebar="group-label"] + div {
  margin-left: 10px;
}
/* A header is a divider: a hairline runs from its name to the edge, which
   no thread row has. */
[data-machine-tabs-list] [data-sidebar="group-label"] > span:first-child::after {
  content: "";
  flex: 1 1 0;
  min-width: 8px;
  height: 1px;
  margin-left: 4px;
  background: var(--border, currentColor);
  opacity: 0.9;
}
[data-machine-tabs-list] [data-sidebar="group-label"] > span:first-child::before {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  margin-right: 3px;
  border-radius: 5px;
  font-size: 9px;
  font-weight: 600;
  line-height: 1;
}
[data-machine-tabs-list] [data-sidebar-visibility-group="threads"] [data-sidebar="group-label"] > span:first-child::before {
  content: "";
  background: ${PERSON_ICON} center / 14px no-repeat;
}
/* Pinned is the one header bb draws outside every visibility group. */
[data-machine-tabs-list] [data-sidebar="group-label"]:not([data-sidebar-visibility-group] *) > span:first-child::before {
  content: "";
  background: ${PIN_ICON} center / 14px no-repeat;
}
[data-machine-tabs-list] [data-sidebar-visibility-group="section:machine-tabs-recent"] [data-sidebar="group-label"] > span:first-child::before {
  content: "";
  background: ${RECENT_ICON} center / 14px no-repeat;
}
[data-machine-tabs-list] [data-sidebar-visibility-group^="section:machine-tabs-day"] [data-sidebar="group-label"] > span:first-child::before {
  content: "";
  background: ${DAY_ICON} center / 14px no-repeat;
}
/* Touch rows have no mouse-hover toolbar. Empty trailing cells must not
   shorten the title; real progress/attention indicators keep their space. */
@media (hover: none) {
  [data-machine-tabs-list] [data-sidebar-rename-row] .bb-sidebar-hover-actions-inset,
  [data-machine-tabs-list] [data-sidebar-rename-row] [style*="--bb-sidebar-hover-actions-inset"] {
    padding-right: 0 !important;
  }
  [data-machine-tabs-list] [data-sidebar-rename-row]:not(:has(
    [data-sidebar-thread-trailing-indicator],
    [data-sidebar-hover-actions-open="true"],
    [data-sidebar-hover-actions-mobile="always"],
    [data-thread-actions-trigger][data-state="open"]
  )) > [data-sidebar-thread-trailing] {
    display: none;
  }
}
/* With a mouse BB keeps an empty 28px cell at the end of every row for the
   hover toolbar, so titles were cut early and the expander stood short of the
   edge. The cell now takes space only while the row is hovered, focused or
   has something to show. */
@media (hover: hover) {
  [data-machine-tabs-list] [data-sidebar-rename-row]:has(> span > a[data-sidebar-thread-id]):not(:hover, :has(:focus-visible), :has(
    [data-sidebar-thread-trailing-indicator],
    [data-sidebar-hover-actions-open="true"],
    [data-thread-actions-trigger][data-state="open"]
  )) > [data-sidebar-thread-trailing] {
    display: none;
  }
}
/* The subagent expander sits at the right edge of the row, in one column for
   all rows, instead of right after the title in the middle of a wide sidebar. */
[data-machine-tabs-list] [data-sidebar-rename-row] > span:has(> a[data-sidebar-thread-id]) button[aria-expanded][data-sidebar-rename-anchor] {
  margin-left: auto;
}
/* The same column for bb's "thread of another project" folder mark: a short
   title no longer pulls it to the middle of the row. An expander before it keeps
   the auto margin, so the mark follows right after the arrow. */
[data-machine-tabs-list] [data-sidebar-rename-row] > span:has(> a[data-sidebar-thread-id]) [data-sidebar-thread-cross-project] {
  margin-left: auto;
}
[data-machine-tabs-list] [data-sidebar-rename-row] > span:has(> a[data-sidebar-thread-id]):has(button[aria-expanded][data-sidebar-rename-anchor]) [data-sidebar-thread-cross-project] {
  margin-left: 0;
}
/* One mark per row: the agent's icon sits small in the top right corner of
   the project mark instead of beside it. The icon itself is the subject of
   :has() (it comes right before the title); a bare \`span:has()\` here made
   every span on the page, including each line of a code editor, a candidate. */
[data-machine-tabs-list] [data-sidebar-thread-provider]:has(+ .bb-thread-title > [data-machine-tabs-badge]) {
  position: absolute;
  left: 9px;
  top: calc(50% - 13px);
  width: 12px;
  height: 12px;
  margin: 0;
  border-radius: 9999px;
  background: var(--sidebar, var(--background));
  box-shadow: 0 0 0 1px var(--sidebar, var(--background));
}
[data-machine-tabs-list] [data-sidebar-thread-provider]:has(+ .bb-thread-title > [data-machine-tabs-badge]) > span {
  width: 10px;
  height: 10px;
}`;

function MachineThreadList(props: PluginThreadListProps) {
  const { state, select, setView } = useTabs();
  const { bundle, error: bundleError } = useNativeListBundle();
  const { component: NativeList, error: listError } = useNativeList("main", bundle);
  const { component: RecentList } = useNativeList("recent", bundle);
  const error = bundleError ?? listError;
  const [query, setQuery] = useState("");
  const [searchOptions, setSearchOptions] = useState<SearchOptions>({ archive: false, messages: false });
  // Filters last for the sidebar session; "all" is no filter.
  const [topicFilter, setTopicFilter] = useState("all");
  const [projectFilter, setProjectFilter] = useState("all");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtering = topicFilter !== "all" || projectFilter !== "all";
  // A row opened just to look closes by itself: when the pointer has left the search
  // and the row for a moment, or on a click elsewhere. A row with a filter on stays.
  const filterArea = useRef(new Set<HTMLElement>());
  const leaveTimer = useRef<number | undefined>(undefined);
  const keepFilters = useCallback(() => window.clearTimeout(leaveTimer.current), []);
  const leaveFilters = useCallback(() => {
    window.clearTimeout(leaveTimer.current);
    leaveTimer.current = window.setTimeout(() => {
      // Focus left on the funnel after the click is not use; an open list is.
      const inUse = [...filterArea.current].some((node) => node.querySelector(".mt-pick-panel") !== null);
      if (!inUse) setFiltersOpen(false);
    }, 700);
  }, []);
  const filterAreaRef = useCallback((node: HTMLElement | null) => {
    if (node) filterArea.current.add(node);
    for (const known of filterArea.current) if (!known.isConnected) filterArea.current.delete(known);
  }, []);
  const searchRow = useRef<HTMLDivElement | null>(null);
  const searchRowRef = useCallback((node: HTMLDivElement | null) => {
    searchRow.current = node;
    filterAreaRef(node);
  }, [filterAreaRef]);
  useEffect(() => {
    if (!filtersOpen || filtering) { keepFilters(); return; }
    const outside = (event: MouseEvent) => {
      if (![...filterArea.current].some((node) => node.contains(event.target as Node))) setFiltersOpen(false);
    };
    document.addEventListener("mousedown", outside, true);
    return () => { document.removeEventListener("mousedown", outside, true); keepFilters(); };
  }, [filtersOpen, filtering, keepFilters]);
  // Project marks stay until the user picks topic icons. The question comes once the list first
  // draws a mark before a title, and again with the filters if it was put off.
  const markRpc = useRpc<typeof rpcContract>();
  const turnStarts = useCallback(
    (threadIds: string[]) => markRpc.call("turn_started", { threadIds }).then((result) => result.starts),
    [markRpc],
  );
  const [rowMark, setRowMark] = useState<RowMark | null>(null);
  const [askingMark, setAskingMark] = useState(false);
  const loadRowMark = useCallback(() => {
    markRpc.call("row_mark", null).then((result) => setRowMark(result.rowMark), () => {});
  }, [markRpc]);
  useEffect(loadRowMark, [loadRowMark]);
  useRealtime("row-mark-changed", loadRowMark);
  const askedMark = useRef(false);
  const { threads, projects } = experimental_useSidebarThreads();
  const { collapsed, toggle } = useCollapsedGroups();
  const [sort, setSort] = useState<string | null>(null);
  const [innerMode, setInnerMode] = useState<string | null>(null);
  const [listKey, setListKey] = useState(0);

  const machines = state?.machines ?? [];
  const selectedId = state?.selectedId ?? null;
  const byDay = state?.byDay ?? false;
  const outer: Grouping = state?.outer ?? "none";
  const dayField: DayField = sort === "created" ? "createdAt" : "updatedAt";

  const live = useMemo(
    () => threads.filter((thread) => !thread.isArchived && !thread.isHidden),
    [threads],
  );

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const thread of live) {
      if (thread.host) {
        map.set(thread.host.id, (map.get(thread.host.id) ?? 0) + 1);
      }
    }
    return map;
  }, [live]);

  const projectNames = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );
  const needles = useMemo(() => {
    const typed = query.trim().toLowerCase();
    return [...new Set([typed, swapLayout(typed, EN_TO_RU), swapLayout(typed, RU_TO_EN)])];
  }, [query]);

  // The search filter: thread ids whose title matches, or whose group header
  // would: project, machine, or day ("today", "yesterday", "12 nov").
  const matchIds = useMemo(() => {
    const typed = query.trim().toLowerCase();
    if (typed === "" && !filtering) return null;
    // Also what the same keys spell in the other keyboard layout.
    const todayStart = startOfToday();
    // A matching child keeps its parents, so bb can still draw the path to it.
    return withAncestors(threads, new Set(
      threads
        .filter((thread) =>
          matchesFilters(thread.displayTitle, thread.projectId, topicFilter, projectFilter) &&
          [
            thread.displayTitle,
            projectNames.get(thread.projectId)?.name ?? "",
            thread.host?.name ?? "",
            dayLabel(dayBucket(thread, dayField, todayStart), todayStart),
          ].some((text) => textMatches(text, needles)),
        )
        .map((thread) => thread.id),
    ));
  }, [threads, projectNames, query, dayField, needles, filtering, topicFilter, projectFilter]);

  /** Live threads of the selected tab before search and filters: the "of N" in the counter. */
  const tabTotal = useMemo(
    () => live.filter((thread) => selectedId === null || thread.host?.id === selectedId).length,
    [live, selectedId],
  );

  /** Live threads of the selected tab that pass the search filter. */
  const shown = useMemo(
    () =>
      live.filter(
        (thread) =>
          (selectedId === null || thread.host?.id === selectedId) &&
          (matchIds === null || matchIds.has(thread.id)),
      ),
    [live, selectedId, matchIds],
  );

  const baseView = useMemo<ListView>(
    () => ({
      ...DEFAULT_VIEW,
      machineId: selectedId,
      byDay,
      dayField,
      ids: matchIds,
    }),
    [selectedId, byDay, dayField, matchIds],
  );

  // Include descendants: BB owns the hierarchy, expander and child activity.
  const recentView = useMemo<ListView | null>(() => {
    const ids = [...shown]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((thread) => thread.id);
    if (ids.length === 0) return null;
    return { ...DEFAULT_VIEW, recent: true, ids: new Set(ids) };
  }, [shown]);

  const projectIcons = useProjectIcons();
  const projectBadges = useMemo(() => {
    const map = new Map<string, ProjectBadge>();
    for (const project of projects) {
      map.set(
        project.id,
        project.isPersonal
          ? { letters: "", name: "No project", personal: true, image: null }
          : {
              letters: projectLetters(project.name),
              name: project.name,
              personal: false,
              image: projectIcons[project.id] ?? null,
            },
      );
    }
    return map;
  }, [projects, projectIcons]);
  const badges = useMemo(() => {
    const map = new Map<string, ProjectBadge>();
    for (const thread of threads) {
      const badge = projectBadges.get(thread.projectId);
      if (!badge) continue;
      // The machine is one hover away on every row, whatever the grouping.
      const machine = thread.host?.name;
      map.set(
        thread.id,
        {
          ...badge,
          name: machine ? `${badge.name} · ${machine}` : badge.name,
          topic: rowMark === "topic" ? topicForTitle(thread.displayTitle) : undefined,
        },
      );
    }
    return map;
  }, [threads, projectBadges, rowMark]);
  const threadsById = useMemo(() => new Map(threads.map((thread) => [thread.id, thread as PluginSidebarThread])), [threads]);
  const insideById = useMemo(() => insideStates(threads as readonly QuickThread[]), [threads]);
  const headerCss = useMemo(() => projectHeaderCss(projectBadges), [projectBadges]);

  // Each filter's list counts what it would leave with the other filter as it is now.
  const facets = useMemo(() => {
    const onTab = live.filter((thread) => selectedId === null || thread.host?.id === selectedId);
    const topics = new Map<string, number>(), perProject = new Map<string, number>();
    let forTopics = 0, forProjects = 0;
    for (const thread of onTab) {
      const topic = topicForTitle(thread.displayTitle).id;
      if (projectFilter === "all" || projectFilter === thread.projectId) {
        forTopics += 1;
        topics.set(topic, (topics.get(topic) ?? 0) + 1);
      }
      if (topicFilter === "all" || topicFilter === topic) {
        forProjects += 1;
        perProject.set(thread.projectId, (perProject.get(thread.projectId) ?? 0) + 1);
      }
    }
    return { topics, perProject, forTopics, forProjects };
  }, [live, selectedId, topicFilter, projectFilter]);
  const topicOptions = useMemo<FilterOption[]>(() => TOPICS.map((topic) => ({
    value: topic.id, label: topic.label, count: facets.topics.get(topic.id) ?? 0,
    mark: <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color: topic.color, flexShrink: 0 }}><path d={topic.path} /></svg>,
  })), [facets]);
  const projectOptions = useMemo<FilterOption[]>(() => projects.map((project) => {
    const badge = projectBadges.get(project.id);
    return {
      value: project.id, label: project.isPersonal ? "Без проекта" : project.name,
      count: facets.perProject.get(project.id) ?? 0,
      mark: badge ? <ProjectBadgeMark badge={badge} header /> : undefined,
    };
  }), [projects, projectBadges, facets]);
  /** Typed text against a label, also as the same keys in the other keyboard layout. */
  const labelMatches = useCallback((label: string, typed: string) => {
    const query = typed.toLowerCase();
    return textMatches(label, [query, swapLayout(query, EN_TO_RU), swapLayout(query, RU_TO_EN)]);
  }, []);
  useEffect(() => {
    // Once per page load, and only when there is a row whose mark the choice is about.
    if (rowMark !== "ask" || askedMark.current || badges.size === 0) return;
    askedMark.current = true;
    setAskingMark(true);
  }, [rowMark, badges]);

  // First-level groups, each a filter for one instance of bb's list.
  const groups = useMemo<OuterGroup[]>(() => {
    if (outer === "none") return [];
    const count = new Map<string, number>();
    const bump = (key: string) => count.set(key, (count.get(key) ?? 0) + 1);
    const none = { machineId: selectedId, projectId: null, day: null };
    if (outer === "project") {
      for (const thread of shown) bump(thread.projectId);
      return projectsByLatestThread(projects, shown)
        .filter((project) => count.has(project.id))
        .map((project) => ({
          id: `project:${project.id}`,
          label: project.isPersonal ? "No project" : project.name,
          count: count.get(project.id) ?? 0,
          filter: { ...none, projectId: project.id },
        }));
    }
    if (outer === "machine") {
      for (const thread of shown) if (thread.host) bump(thread.host.id);
      return machines
        .filter((machine) => count.has(machine.id))
        .map((machine) => ({
          id: `machine:${machine.id}`,
          label: machine.name,
          count: count.get(machine.id) ?? 0,
          filter: { ...none, machineId: machine.id },
        }));
    }
    const todayStart = startOfToday();
    for (const thread of shown) {
      bump(String(dayBucket(thread, dayField, todayStart)));
    }
    return [...count.keys()]
      .map(Number)
      .sort((a, b) => a - b)
      .map((bucket) => ({
        id: `day:${bucket}`,
        label: dayLabel(bucket, todayStart),
        count: count.get(String(bucket)) ?? 0,
        filter: { ...none, day: bucket },
      }));
  }, [outer, shown, selectedId, projects, machines, dayField]);

  const navigate = useBbNavigate();
  /**
   * Make the project's group reachable in the list: its machine tab, no search
   * or filter that hides it, then scroll there and flash it. Without project
   * groups in the list, open the project instead.
   */
  const showProject = useCallback((projectId: string) => {
    if (revealProject(projectId)) return;
    const onTab = selectedId === null || live.some((thread) => thread.projectId === projectId && thread.host?.id === selectedId);
    if (!onTab) select(null);
    setQuery("");
    if (projectFilter !== "all" && projectFilter !== projectId) setProjectFilter("all");
    if (topicFilter !== "all") setTopicFilter("all");
    let tries = 6;
    const retry = () => {
      if (revealProject(projectId)) return;
      if (--tries > 0) window.setTimeout(retry, 120);
      else navigate.toProject(projectId);
    };
    window.setTimeout(retry, 60);
  }, [selectedId, live, select, projectFilter, topicFilter, navigate]);
  const openThread = useCallback((thread: QuickThread) => {
    navigate.toThread(thread.id);
    const onTab = selectedId === null || thread.host?.id === selectedId;
    if (!onTab) select(null);
    if (matchIds !== null && !matchIds.has(thread.id)) {
      setQuery("");
      setTopicFilter("all");
      setProjectFilter("all");
    }
    window.setTimeout(() => revealThread(thread.id, thread.projectId), 120);
  }, [navigate, selectedId, select, matchIds]);

  const hideEmpty =
    selectedId !== null || byDay || outer !== "none" || matchIds !== null;

  const emptyCss = useMemo(() => {
    if (hideEmpty) return "";
    // Pinned threads count: they are listed under their project as well.
    const used = new Set(shown.map((thread) => thread.projectId));
    return emptyProjectsCss(
      projects
        .filter((project) => !project.isPersonal && !used.has(project.id))
        .map((project) => project.id),
    );
  }, [hideEmpty, shown, projects]);

  return (
    <>
      {machines.length < 2 ? null : (
        <div className="relative z-[100] flex items-center gap-1 px-2 pb-1.5 pt-0.5">
          <div
            role="tablist"
            aria-label="Machines"
            className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]"
          >
            <Tab
              label="All"
              count={live.length}
              active={selectedId === null}
              onClick={() => select(null)}
            />
            {machines.map((machine) => (
              <Tab
                key={machine.id}
                label={machine.name}
                count={counts.get(machine.id) ?? 0}
                online={machine.online}
                active={selectedId === machine.id}
                onClick={() => select(machine.id)}
              />
            ))}
          </div>
          <OrganizeMenu
            ready={NativeList !== null}
            outer={outer}
            byDay={byDay}
            onView={setView}
            onSort={setSort}
            onMode={setInnerMode}
            onChanged={() => setListKey((key) => key + 1)}
          />
        </div>
      )}
      <div ref={searchRowRef} onPointerEnter={keepFilters} onPointerLeave={filtering ? undefined : leaveFilters}
        className="machine-tabs-search sticky top-0 z-[100] bg-sidebar px-2 pb-1.5 pt-0.5">
        <BbIcon
          name="Search"
          className="pointer-events-none absolute left-4 top-1.5 size-3.5 text-muted-foreground"
        />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setQuery("");
          }}
          placeholder="Поиск тредов"
          aria-label="Поиск тредов"
          className="h-7 w-full rounded-md border border-transparent bg-state-hover pl-7 pr-[5.5rem] text-xs text-sidebar-foreground outline-none placeholder:text-muted-foreground focus:border-sidebar-ring [&::-webkit-search-cancel-button]:hidden"
        />
        {query === "" ? null : (
          <button
            type="button"
            aria-label="Clear filter"
            onClick={() => setQuery("")}
            className="absolute right-[5rem] top-1 flex size-5 items-center justify-center rounded text-muted-foreground hover:text-sidebar-foreground"
          >
            <BbIcon name="X" className="size-3.5" />
          </button>
        )}
        <button
          type="button"
          aria-label="Фильтры по теме и проекту"
          title="Фильтры по теме и проекту"
          aria-expanded={filtersOpen || filtering}
          aria-controls="machine-tabs-filters"
          data-active={filtering ? "" : undefined}
          onClick={() => {
            if (!filtersOpen && rowMark === "ask") setAskingMark(true);
            setFiltersOpen((open) => !open);
          }}
          className="machine-tabs-filter-toggle absolute right-9 top-1 flex size-5 items-center justify-center rounded text-muted-foreground hover:text-sidebar-foreground focus-visible:outline focus-visible:outline-2"
        >
          {/* A funnel drawn here: bb's icon set has none and shows a lightning bolt for an unknown name. */}
          <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2"
            strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 5h18l-7 8.5V19l-4 2v-7.5L3 5Z" />
          </svg>
        </button>
        {/* Projects menu: hidden like the funnel until the field is hovered. */}
        <ProjectQuickMenu
          projects={projects}
          threads={threads as readonly QuickThread[]}
          mark={(projectId) => {
            const badge = projectBadges.get(projectId);
            return badge ? <ProjectBadgeMark badge={badge} header /> : null;
          }}
          onProject={showProject}
          onThread={openThread}
          field={searchRow}
          searchQuery={query}
          turnStarts={turnStarts}
        />
        <SearchSettings options={searchOptions} onChange={setSearchOptions} />
      </div>
      <style>{PROJECT_QUICK_CSS}</style>
      <style>{REVEAL_CSS}</style>
      {filtersOpen || filtering ? (
        <div id="machine-tabs-filters" ref={filterAreaRef} onPointerEnter={keepFilters}
          onPointerLeave={filtering ? undefined : leaveFilters}
          className="machine-tabs-filters relative z-[90] flex items-center gap-1 px-2 pb-1.5">
          <FilterPicker label="Тема" allLabel="Все темы" value={topicFilter} onChange={setTopicFilter}
            options={topicOptions} total={facets.forTopics} matches={labelMatches} />
          <FilterPicker label="Проект" allLabel="Все проекты" value={projectFilter} onChange={setProjectFilter}
            options={projectOptions} total={facets.forProjects} matches={labelMatches} />
          {matchIds !== null ? (
            <span aria-live="polite" className="ml-auto shrink-0 whitespace-nowrap pl-1 text-[11px] tabular-nums text-muted-foreground">
              {shownOfTotal(shown.length, tabTotal)}
            </span>
          ) : null}
          {filtering ? (
            <button
              type="button"
              aria-label="Сбросить фильтры"
              title="Сбросить фильтры"
              onClick={() => { setTopicFilter("all"); setProjectFilter("all"); setFiltersOpen(false); }}
              className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-sidebar-foreground focus-visible:outline focus-visible:outline-2"
            >
              <BbIcon name="X" className="size-3.5" />
            </button>
          ) : null}
        </div>
      ) : null}
      <style>{HIDE_EMPTY_GROUPS}</style>
      <style>{GROUP_PAGING_CSS}</style>
      <style>{ROW_MARK_CSS}</style>
      <style>{FILTER_PICKER_CSS}</style>
      {askingMark ? (
        <RowMarkChooser
          current={rowMark === "topic" ? "topic" : "project"}
          first={rowMark === "ask"}
          onClose={() => setAskingMark(false)}
          onChoose={async (next) => {
            const saved = await markRpc.call("set_row_mark", { rowMark: next });
            setRowMark(saved.rowMark);
            setAskingMark(false);
          }}
        />
      ) : null}
      <style>{`
        .machine-tabs-search-settings { opacity: 0; transition: opacity 120ms ease; }
        .machine-tabs-search:hover .machine-tabs-search-settings,
        .machine-tabs-search:focus-within .machine-tabs-search-settings,
        .machine-tabs-search-settings[data-open] { opacity: .7; }
        @media (hover: none) { .machine-tabs-search-settings { opacity: .7; } }
        /* Like the search settings: out of the way until the field is used. An open filter row
           does not keep it on screen; only a filter that is actually on does. */
        .machine-tabs-filter-toggle { opacity: 0; transition: opacity 120ms ease; }
        .machine-tabs-search:hover .machine-tabs-filter-toggle,
        .machine-tabs-search:focus-within .machine-tabs-filter-toggle { opacity: .7; }
        .machine-tabs-filter-toggle:hover, .machine-tabs-filter-toggle:focus-visible { opacity: 1; }
        .machine-tabs-filter-toggle[data-active] { opacity: 1; color: var(--sidebar-foreground); background: var(--state-active); }
        @media (hover: none) { .machine-tabs-filter-toggle { opacity: .7; } }
      `}</style>
      <style>{headerCss}</style>
      <style>{emptyCss}</style>
      {query.trim() !== "" ? <SearchExtras query={query} needles={needles}
        options={searchOptions} machineId={selectedId} topicFilter={topicFilter} projectFilter={projectFilter} localIds={new Set(shown.map((thread) => thread.id))} /> : null}
      <RowThreads.Provider value={threadsById}><RowInside.Provider value={insideById}><ProjectBadges.Provider value={badges}>
        {RecentList && recentView && state !== null ? (
          <>
            <div
              data-machine-tabs-list=""
              data-machine-tabs-hide-empty=""
              data-machine-tabs-recent=""
            >
              <MachineFilter.Provider value={recentView}>
                <RecentList {...props} />
              </MachineFilter.Provider>
            </div>
            <div className="mx-3 mb-1.5 mt-1 border-b border-border" />
          </>
        ) : null}
      </ProjectBadges.Provider></RowInside.Provider></RowThreads.Provider>
      {matchIds !== null && shown.length === 0 ? (
        <p className="px-4 py-2 text-xs text-muted-foreground">
          {!query.trim() ? "По выбранным фильтрам тредов нет." : searchOptions.archive || searchOptions.messages
            ? "В названиях активных тредов совпадений нет."
            : `Ничего не найдено по запросу «${query.trim()}».`}
        </p>
      ) : null}
      {NativeList && state !== null ? (
        <RowThreads.Provider value={threadsById}><RowInside.Provider value={insideById}><ProjectBadges.Provider value={badges}>
        <div data-machine-tabs-list="" data-machine-tabs-host-id={baseView.machineId ?? undefined} data-machine-tabs-hide-empty={hideEmpty ? "" : undefined}>
          {outer === "none" ? (
            <MachineFilter.Provider value={baseView}>
              <NativeList key={listKey} {...props} />
            </MachineFilter.Provider>
          ) : groups.length === 0 ? (
            <p className="px-4 py-2 text-xs text-muted-foreground">
              No threads
            </p>
          ) : (
            groups.map((group) => {
              const isCollapsed = collapsed.has(group.id);
              return (
                <section
                  key={group.id}
                  data-machine-tabs-host-id={group.filter.machineId ?? undefined}
                  className="mt-1 border-t border-border pb-1 pt-1 first:mt-0 first:border-t-0 first:pt-0"
                >
                  <button
                    type="button"
                    aria-expanded={!isCollapsed}
                    onClick={() => toggle(group.id)}
                    className="group/outer mx-2 flex h-7 w-[calc(100%-1rem)] items-center gap-1.5 rounded-md px-2 text-left text-[13px] font-semibold text-sidebar-foreground outline-none hover:bg-state-hover focus-visible:ring-2 focus-visible:ring-sidebar-ring"
                  >
                    <BbIcon
                      name={isCollapsed ? "ChevronRight" : "ChevronDown"}
                      className="size-3.5 shrink-0 text-muted-foreground"
                    />
                    {outer === "project" &&
                    group.filter.projectId !== null &&
                    projectBadges.has(group.filter.projectId) ? (
                      <ProjectBadgeMark
                        badge={projectBadges.get(group.filter.projectId)!}
                        header
                      />
                    ) : null}
                    <span className="min-w-0 truncate">{group.label}</span>
                    <span className="shrink-0 font-normal tabular-nums text-muted-foreground">
                      {group.count}
                    </span>
                  </button>
                  {isCollapsed ? null : (
                    <div className="ml-3 border-l border-border-hairline">
                      <FilteredList
                        key={listKey}
                        List={NativeList}
                        base={baseView}
                        group={group}
                        listProps={props}
                      />
                    </div>
                  )}
                </section>
              );
            })
          )}
        </div>
        </ProjectBadges.Provider></RowInside.Provider></RowThreads.Provider>
      ) : error ? (
        <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
          Machine Tabs could not load bb’s thread list. {error}
        </p>
      ) : (
        <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
          Waiting for bb’s thread list…
        </p>
      )}
    </>
  );
}

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "sidebar-view",
    mount: ({ signal }) => installSidebarView(signal),
  });
  app.slots.experimental_threadList({
    id: "machine-tabs",
    title: "Thread list + machine tabs",
    description:
      "bb's thread list with a row of machine tabs that filter it by machine.",
    component: MachineThreadList,
  });
});
