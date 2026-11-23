// Marks other plugins put on a thread's icon in this list. Machine Tabs knows
// nothing about what a mark means: a plugin sets a glyph from a short closed
// set, a tone and a tooltip; marks belong to the plugin that set them and are
// not drawn while that plugin is disabled or removed. Reads are tolerant.

/** A closed set of monochrome glyphs; extend by adding a name and its path. */
export const MARK_GLYPHS = ["crown", "bot", "link"] as const;
export type MarkGlyph = (typeof MARK_GLYPHS)[number];
/** `accent` is one calm gold for light and dark themes, `muted` a faded neutral; plugins cannot pass colours. */
export const MARK_TONES = ["neutral", "accent", "muted"] as const;
export type MarkTone = (typeof MARK_TONES)[number];
export const ACCENT_COLOR = "#c9a227";

export const MARK_PATHS: Record<MarkGlyph, string> = {
  crown: "M3 7l4.5 4L12 4l4.5 7L21 7l-2 12H5z",
  bot: "M5 8h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2zM12 4v4M9 14h.01M15 14h.01",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
};

export interface ThreadMark {
  glyph: MarkGlyph;
  tone: MarkTone;
  label: string;
}
/** pluginId → threadId → mark */
export type MarkStore = Record<string, Record<string, ThreadMark>>;

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const PLUGIN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const MAX_MARKS_PER_PLUGIN = 500;

export function parseMark(value: unknown): ThreadMark | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (!(MARK_GLYPHS as readonly string[]).includes(v.glyph as string)) return null;
  const tone = (MARK_TONES as readonly string[]).includes(v.tone as string) ? (v.tone as MarkTone) : "neutral";
  const label = typeof v.label === "string" ? v.label.slice(0, 160) : "";
  return { glyph: v.glyph as MarkGlyph, tone, label };
}

/** Never throws: unknown plugins, threads, glyphs and fields are dropped. */
export function parseStore(raw: unknown): MarkStore {
  const out: MarkStore = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [pluginId, marks] of Object.entries(raw as Record<string, unknown>)) {
    if (!PLUGIN.test(pluginId) || !marks || typeof marks !== "object") continue;
    const own: Record<string, ThreadMark> = {};
    let n = 0;
    for (const [threadId, mark] of Object.entries(marks as Record<string, unknown>)) {
      const parsed = ID.test(threadId) ? parseMark(mark) : null;
      if (!parsed) continue;
      own[threadId] = parsed;
      if (++n >= MAX_MARKS_PER_PLUGIN) break;
    }
    if (n > 0) out[pluginId] = own;
  }
  return out;
}

export function setMark(store: MarkStore, pluginId: string, threadId: string, mark: ThreadMark): MarkStore {
  if (!PLUGIN.test(pluginId) || !ID.test(threadId)) return store;
  return { ...store, [pluginId]: { ...(store[pluginId] ?? {}), [threadId]: mark } };
}

export function clearMark(store: MarkStore, pluginId: string, threadId: string): MarkStore {
  const own = { ...(store[pluginId] ?? {}) };
  delete own[threadId];
  const next = { ...store, [pluginId]: own };
  if (Object.keys(own).length === 0) delete next[pluginId];
  return next;
}

/** Replaces every mark of one plugin at once (moving a role between threads is one call). */
export function replaceMarks(store: MarkStore, pluginId: string, marks: readonly ({ threadId: string } & ThreadMark)[]): MarkStore {
  const next = { ...store };
  delete next[pluginId];
  let result = next;
  for (const m of marks.slice(0, MAX_MARKS_PER_PLUGIN)) result = setMark(result, pluginId, m.threadId, { glyph: m.glyph, tone: m.tone, label: m.label });
  return result;
}

/** What the list draws: marks of enabled plugins only; one per thread (plugin ids in order). */
export function visibleMarks(store: MarkStore, enabled: ReadonlySet<string>): Record<string, ThreadMark & { pluginId: string }> {
  const out: Record<string, ThreadMark & { pluginId: string }> = {};
  for (const pluginId of Object.keys(store).sort()) {
    if (!enabled.has(pluginId)) continue;
    for (const [threadId, mark] of Object.entries(store[pluginId] ?? {})) {
      out[threadId] ??= { ...mark, pluginId };
    }
  }
  return out;
}
