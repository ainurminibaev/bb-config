// bb-plugin-machine-tabs — backend.
//
// Keeps the machine list and the selected machine tab (synced across
// windows), and forwards bb's thread-list preference calls (see rpcContract).
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { clearMark, MARK_GLYPHS, MARK_PLACES, MARK_SIZES, MARK_TONES, parseStore, replaceMarks, setMark, visibleMarks, type MarkStore } from "./lib/thread-marks";

/** Realtime channel app.tsx listens on after a tab changes. */
export const TABS_CHANGED = "machine-tabs-changed";

/** Realtime channel: another plugin changed its marks on thread icons. */
export const MARKS_CHANGED = "machine-tabs-thread-marks";
const MARKS_KEY = "thread-marks";
const markInput = z.object({
  threadId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  glyph: z.enum(MARK_GLYPHS),
  tone: z.enum(MARK_TONES).default("neutral"),
  place: z.enum(MARK_PLACES).default("corner"),
  size: z.enum(MARK_SIZES).default("normal"),
  label: z.string().max(160).default(""),
});
const markOutput = z.object({ glyph: z.enum(MARK_GLYPHS), tone: z.enum(MARK_TONES), place: z.enum(MARK_PLACES), size: z.enum(MARK_SIZES), label: z.string(), pluginId: z.string() });

/** Realtime channel: project images were re-read. */
export const ICONS_CHANGED = "machine-tabs-icons-changed";

const machineSchema = z.object({
  id: z.string(),
  name: z.string(),
  online: z.boolean(),
});
export type Machine = z.infer<typeof machineSchema>;

const outerSchema = z.enum(["none", "project", "machine", "day"]);

const stateSchema = z.object({
  machines: z.array(machineSchema),
  /** The machine whose tab is active, or null for All. */
  selectedId: z.string().nullable(),
  /** Split the flat list into day sections (Today, Yesterday, …). */
  byDay: z.boolean(),
  /** A grouping this plugin draws above bb's own, for two-level lists. */
  outer: outerSchema,
});
export type TabsState = z.infer<typeof stateSchema>;

const preferenceResultSchema = z.object({ key: z.string(), value: z.unknown() });

const ROW_MARK_CHANGED = "row-mark-changed";
const rowMarkSchema = z.enum(["ask", "project", "topic"]);

export const rpcContract = defineRpcContract({
  // Marks on a thread's icon, set by other plugins (the caller is the owner).
  thread_mark_set: { input: markInput, output: z.object({ ok: z.literal(true) }) },
  thread_mark_clear: { input: z.object({ threadId: z.string().max(64), place: z.enum(MARK_PLACES).optional() }), output: z.object({ ok: z.literal(true) }) },
  thread_marks_replace: { input: z.object({ marks: z.array(markInput).max(1000) }), output: z.object({ count: z.number() }) },
  thread_marks: { input: z.null(), output: z.object({ marks: z.record(z.string(), z.array(markOutput)) }) },
  row_mark: { input: z.null(), output: z.object({ rowMark: rowMarkSchema }) },
  set_row_mark: {
    input: z.object({ rowMark: z.enum(["project", "topic"]) }),
    output: z.object({ rowMark: rowMarkSchema }),
  },
  // bb's own thread list renders inside this plugin's list (see app.tsx), so
  // its preference calls arrive here; they are forwarded to the thread-list
  // plugin, which stays the single owner of those preferences.
  listPreferences: {
    input: z.null(),
    output: z.object({ preferences: z.record(z.string(), z.unknown()) }),
  },
  setPreference: {
    input: z.object({
      key: z.string(),
      value: z.unknown(),
      origin: z.string().min(1).optional(),
    }),
    output: preferenceResultSchema,
  },
  resetPreference: {
    input: z.object({ key: z.string() }),
    output: preferenceResultSchema,
  },
  /** Project images by project id, as data URLs (see {@link ICON_FILES}). */
  project_icons: {
    input: z.object({ refresh: z.boolean().optional() }),
    output: z.object({ icons: z.record(z.string(), z.string()) }),
  },
  /** When each given thread's latest turn started (ms), for the running-time labels. */
  turn_started: {
    input: z.object({ threadIds: z.array(z.string().regex(/^thr_[A-Za-z0-9]+$/)).max(50) }),
    output: z.object({ starts: z.record(z.string(), z.number()) }),
  },
  tabs_state: { input: z.null(), output: stateSchema },
  tabs_set_view: {
    input: z.object({ byDay: z.boolean(), outer: outerSchema }),
    output: stateSchema,
  },
  tabs_select: {
    input: z.object({ machineId: z.string().min(1).nullable() }),
    output: stateSchema,
  },
});

const SELECTED_KEY = "selected-machine";
const BY_DAY_KEY = "group-by-day";
const OUTER_KEY = "outer-grouping";
const THREAD_LIST_PLUGIN = "thread-list";
/** The channel bb's thread list listens on for preference changes. */
const PREFERENCES_CHANGED = "preferences";

/**
 * A project's own image, relative to its root: the first that exists is
 * drawn instead of the two-letter mark.
 */
const ICON_FILES = [
  ".bb/icon.png",
  ".bb/icon.svg",
  "favicon.png",
  "favicon.svg",
  "favicon.ico",
] as const;
const ICON_MIME: Record<string, string> = {
  png: "image/png",
  svg: "image/svg+xml",
  ico: "image/x-icon",
};
const ICON_MAX_BYTES = 256 * 1024;
const ICON_TTL_MS = 5 * 60 * 1000;
const ICONS_KEY = "project-icons";

export default async function plugin(bb: BbPluginApi) {
  // Switch the actual host provider, so Classic always uses the installed BB.
  const providerKey = "sidebar.threadListProvider" as const;
  bb.http.route("GET", "/sidebar-view", async (context) => {
    const { preferences } = await bb.sdk.system.uiPreferences.list();
    return context.json({ provider: preferences[providerKey].value });
  });
  bb.http.route("POST", "/sidebar-view", async (context) => {
    const input = z.object({ view: z.enum(["classic", "custom"]) }).safeParse(
      await context.req.json().catch(() => null),
    );
    if (!input.success) return context.json({ error: "Invalid sidebar view" }, 400);
    const { preferences } = await bb.sdk.system.uiPreferences.list();
    const provider = input.data.view === "classic"
      ? "thread-list/thread-list" : "machine-tabs/machine-tabs";
    await bb.sdk.system.uiPreferences.set({
      key: providerKey, value: provider,
      expectedRevision: preferences[providerKey].revision,
    });
    return context.json({ provider });
  });
  let iconCache: { at: number; icons: Record<string, string> } | null = null;
  let iconLoad: Promise<Record<string, string>> | null = null;

  async function readIcon(hostId: string, root: string): Promise<string | null> {
    const found = await Promise.all(
      ICON_FILES.map(async (name) => {
        try {
          const file = await bb.sdk.files.read({
            hostId,
            rootPath: root,
            path: `${root.replace(/\/+$/, "")}/${name}`,
          });
          if (!("content" in file) || typeof file.content !== "string") return null;
          if (file.sizeBytes === 0 || file.sizeBytes > ICON_MAX_BYTES) return null;
          const mime = ICON_MIME[name.slice(name.lastIndexOf(".") + 1)]!;
          const base64 =
            file.contentEncoding === "base64"
              ? file.content
              : Buffer.from(file.content, "utf8").toString("base64");
          return `data:${mime};base64,${base64}`;
        } catch {
          // Missing file, or the machine is offline.
          return null;
        }
      }),
    );
    return found.find((icon) => icon !== null) ?? null;
  }

  async function loadIcons(): Promise<Record<string, string>> {
    const projects = await bb.sdk.projects.list();
    const icons: Record<string, string> = {};
    await Promise.all(
      projects.map(async (project) => {
        const sources = [...(project.sources ?? [])].sort(
          (a, b) => Number(b.isDefault) - Number(a.isDefault),
        );
        for (const source of sources) {
          if (source.type !== "local_path" || !source.hostId || !source.path) continue;
          const icon = await readIcon(source.hostId, source.path);
          if (icon !== null) {
            icons[project.id] = icon;
            return;
          }
        }
      }),
    );
    return icons;
  }

  function refreshIcons(): Promise<Record<string, string>> {
    iconLoad ??= loadIcons()
      .then(async (icons) => {
        const changed =
          JSON.stringify(icons) !== JSON.stringify(iconCache?.icons ?? null);
        iconCache = { at: Date.now(), icons };
        if (changed) {
          await bb.storage.kv.set(ICONS_KEY, icons);
          bb.realtime.publish(ICONS_CHANGED, null);
        }
        return icons;
      })
      .finally(() => {
        iconLoad = null;
      });
    return iconLoad;
  }

  /** The last known images at once; stale ones are re-read in the background. */
  async function projectIcons(refresh: boolean): Promise<Record<string, string>> {
    if (refresh) return refreshIcons();
    if (iconCache === null) {
      const stored = z
        .record(z.string(), z.string())
        .safeParse(await bb.storage.kv.get<unknown>(ICONS_KEY));
      iconCache ??= { at: 0, icons: stored.success ? stored.data : {} };
    }
    if (Date.now() - iconCache.at >= ICON_TTL_MS) {
      void refreshIcons().catch(() => undefined);
    }
    return iconCache.icons;
  }

  async function listMachines(): Promise<Machine[]> {
    const hosts = await bb.sdk.hosts.list();
    return hosts
      .filter((host) => host.type === "persistent")
      .filter(
        (host) =>
          host.lifecycle.phase !== "destroyed" &&
          host.lifecycle.phase !== "removing",
      )
      .map((host) => ({
        id: host.id,
        name: host.name,
        online: host.status === "connected",
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async function state(): Promise<TabsState> {
    const [machines, stored, byDay, storedOuter] = await Promise.all([
      listMachines(),
      bb.storage.kv.get<string | null>(SELECTED_KEY),
      bb.storage.kv.get<boolean>(BY_DAY_KEY),
      bb.storage.kv.get<string>(OUTER_KEY),
    ]);
    const outer = outerSchema.safeParse(storedOuter);
    const selectedId =
      stored && machines.some((m) => m.id === stored) ? stored : null;
    return {
      machines,
      selectedId,
      byDay: byDay === true,
      outer: outer.success ? outer.data : "none",
    };
  }

  async function setView(view: {
    byDay: boolean;
    outer: z.infer<typeof outerSchema>;
  }): Promise<TabsState> {
    await bb.storage.kv.set(BY_DAY_KEY, view.byDay);
    await bb.storage.kv.set(OUTER_KEY, view.outer);
    const next = await state();
    bb.realtime.publish(TABS_CHANGED, next);
    return next;
  }

  async function select(machineId: string | null): Promise<TabsState> {
    const machines = await listMachines();
    if (machineId !== null && !machines.some((m) => m.id === machineId)) {
      throw new Error(`Unknown machine: ${machineId}`);
    }
    await bb.storage.kv.set(SELECTED_KEY, machineId);
    const next = await state();
    bb.realtime.publish(TABS_CHANGED, next);
    return next;
  }

  function forward<T>(method: string, input: unknown, outputSchema: z.ZodType<T>) {
    return bb.sdk.plugins.callRpc({
      pluginId: THREAD_LIST_PLUGIN,
      method,
      input: input as never,
      outputSchema,
    });
  }

  const settings = bb.settings.define({
    rowMark: {
      type: "select",
      label: "Значок перед названием треда",
      description:
        "«Спросить» оставляет значки проектов и предлагает выбор с примерами при загрузке списка.",
      options: ["ask", "project", "topic"],
      experimental_optionLabels: {
        ask: "Спросить при загрузке списка",
        project: "Значок проекта",
        topic: "Значок темы по названию",
      },
      default: "ask",
    },
  });
  const rowMark = async () => ({ rowMark: rowMarkSchema.catch("ask").parse((await settings.get()).rowMark) });
  settings.onChange(() => bb.realtime.publish(ROW_MARK_CHANGED, null));

  // A turn's start changes only when a new turn begins; half a minute of reuse keeps the
  // event log out of every menu refresh.
  const turnCache = new Map<string, { at: number | null; fetched: number }>();
  async function turnStarted(threadId: string): Promise<number | null> {
    const hit = turnCache.get(threadId);
    if (hit && Date.now() - hit.fetched < 30_000) return hit.at;
    let at: number | null = null;
    try {
      const rows = (await (bb.sdk.threads as any).events.list({ threadId, types: ["turn/started"], order: "desc", limit: "1" })) as unknown;
      const first = Array.isArray(rows) ? (rows[0] as { createdAt?: unknown } | undefined) : undefined;
      at = typeof first?.createdAt === "number" ? first.createdAt : null;
    } catch {
      at = null;
    }
    turnCache.set(threadId, { at, fetched: Date.now() });
    if (turnCache.size > 2000) turnCache.delete(turnCache.keys().next().value!);
    return at;
  }

  // ---------- marks other plugins put on thread icons ----------
  let markWrite: Promise<unknown> = Promise.resolve();
  function changeMarks(change: (store: MarkStore) => MarkStore): Promise<MarkStore> {
    const run = markWrite.then(async () => {
      const next = change(parseStore(await bb.storage.kv.get<unknown>(MARKS_KEY)));
      await bb.storage.kv.set(MARKS_KEY, next);
      bb.realtime.publish(MARKS_CHANGED, null);
      return next;
    });
    markWrite = run.catch(() => undefined);
    return run;
  }
  function markOwner(caller: unknown): string {
    const c = caller as { kind?: string; pluginId?: string } | undefined;
    if (c?.kind !== "plugin" || !c.pluginId) throw new Error("thread marks are set by plugins through bb.sdk.plugins.callRpc");
    return c.pluginId;
  }
  let enabledCache: { at: number; ids: Set<string> } | null = null;
  async function enabledPlugins(): Promise<Set<string>> {
    if (enabledCache && Date.now() - enabledCache.at < 15_000) return enabledCache.ids;
    try {
      const list = (await bb.sdk.plugins.list()) as unknown as { id?: string; enabled?: boolean }[] | { plugins?: { id?: string; enabled?: boolean }[] };
      const items = Array.isArray(list) ? list : list.plugins ?? [];
      enabledCache = { at: Date.now(), ids: new Set(items.filter((p) => p.enabled !== false && typeof p.id === "string").map((p) => p.id!)) };
    } catch {
      enabledCache = { at: Date.now(), ids: enabledCache?.ids ?? new Set() };
    }
    return enabledCache.ids;
  }
  for (const event of ["experimental_plugin.enabled", "experimental_plugin.disabled", "experimental_plugin.removed"] as const) {
    try { bb.events.on(event as never, (() => { enabledCache = null; bb.realtime.publish(MARKS_CHANGED, null); }) as never); } catch { /* older bb: the 15 s cache covers it */ }
  }

  bb.rpc.register(rpcContract, {
    async thread_mark_set(input, ctx) {
      const owner = markOwner((ctx as { experimental_caller?: unknown } | undefined)?.experimental_caller);
      await changeMarks((store) => setMark(store, owner, input.threadId, { glyph: input.glyph, tone: input.tone, place: input.place, size: input.size, label: input.label }));
      return { ok: true as const };
    },
    async thread_mark_clear({ threadId, place }, ctx) {
      const owner = markOwner((ctx as { experimental_caller?: unknown } | undefined)?.experimental_caller);
      await changeMarks((store) => clearMark(store, owner, threadId, place));
      return { ok: true as const };
    },
    async thread_marks_replace({ marks }, ctx) {
      const owner = markOwner((ctx as { experimental_caller?: unknown } | undefined)?.experimental_caller);
      const next = await changeMarks((store) => replaceMarks(store, owner, marks));
      return { count: Object.keys(next[owner] ?? {}).length };
    },
    async thread_marks() {
      const store = parseStore(await bb.storage.kv.get<unknown>(MARKS_KEY));
      return { marks: visibleMarks(store, await enabledPlugins()) };
    },
    async turn_started({ threadIds }) {
      const starts: Record<string, number> = {};
      await Promise.all([...new Set(threadIds)].map(async (id) => {
        const at = await turnStarted(id);
        if (at !== null) starts[id] = at;
      }));
      return { starts };
    },
    row_mark: rowMark,
    async set_row_mark(input) {
      await settings.experimental_set({ rowMark: input.rowMark });
      return rowMark();
    },
    async listPreferences() {
      return forward(
        "listPreferences",
        null,
        z.object({ preferences: z.record(z.string(), z.unknown()) }),
      );
    },
    async setPreference(input) {
      const result = await forward("setPreference", input, preferenceResultSchema);
      bb.realtime.publish(PREFERENCES_CHANGED, {
        key: result.key,
        value: result.value,
        origin: input.origin ?? null,
      } as never);
      return result;
    },
    async resetPreference(input) {
      const result = await forward("resetPreference", input, preferenceResultSchema);
      bb.realtime.publish(PREFERENCES_CHANGED, {
        key: result.key,
        value: result.value,
        origin: null,
      } as never);
      return result;
    },
    async project_icons({ refresh }) {
      return { icons: await projectIcons(refresh === true) };
    },
    async tabs_state() {
      return state();
    },
    async tabs_set_view(view) {
      return setView(view);
    },
    async tabs_select({ machineId }) {
      return select(machineId);
    },
  });

  bb.cli.register({
    name: bb.pluginId,
    summary: "Switch the sidebar's machine tab",
    commands: [
      { name: "list", summary: "List machines; * marks the active tab", usage: "list" },
      { name: "select", summary: "Switch the tab", usage: "select <machine-id|all>" },
      { name: "icons", summary: "Re-read project images; lists projects that have one", usage: "icons" },
    ],
    async run(argv) {
      const [command, arg] = argv;
      if (command === "list" || command === undefined) {
        const current = await state();
        const lines = current.machines.map(
          (m) =>
            `${m.id === current.selectedId ? "*" : " "} ${m.id}  ${m.name}${m.online ? "" : " (offline)"}`,
        );
        lines.unshift(`${current.selectedId === null ? "*" : " "} all`);
        return { exitCode: 0, stdout: lines.join("\n") + "\n" };
      }
      if (command === "select" && arg !== undefined) {
        const next = await select(arg === "all" ? null : arg);
        const name =
          next.machines.find((m) => m.id === next.selectedId)?.name ?? "All";
        return { exitCode: 0, stdout: `Selected: ${name}\n` };
      }
      if (command === "icons") {
        const icons = await projectIcons(true);
        const projects = await bb.sdk.projects.list();
        const lines = projects.map(
          (project) => `${icons[project.id] ? "*" : " "} ${project.name}`,
        );
        return {
          exitCode: 0,
          stdout: `${lines.join("\n")}\n\nLooked for: ${ICON_FILES.join(", ")}\n`,
        };
      }
      return {
        exitCode: 2,
        stderr: `Usage: bb ${bb.pluginId} list | select <machine-id|all> | icons\n`,
      };
    },
  });
}
