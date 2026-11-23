// Marks other plugins put on a thread's icon in this list. Machine Tabs knows
// nothing about what a mark means: a plugin sets a glyph from a short closed
// set, a tone, a place, a size and a tooltip; marks belong to the plugin that
// set them and are not drawn while that plugin is disabled or removed. Reads
// are tolerant: data written by 0.2.10 (one mark per thread) still loads.

/** A closed set of monochrome glyphs; extend by adding a name and its path. */
export const MARK_GLYPHS = ["crown", "bot", "link", "telegram"] as const;
export type MarkGlyph = (typeof MARK_GLYPHS)[number];
/** `accent` is one calm gold for light and dark themes, `muted` a faded neutral; plugins cannot pass colours. */
export const MARK_TONES = ["neutral", "accent", "muted"] as const;
export type MarkTone = (typeof MARK_TONES)[number];
/** `top`: over the icon, centred, like a crown on a head; `corner`: the bottom-right corner (0.2.10 behaviour). */
export const MARK_PLACES = ["corner", "top"] as const;
export type MarkPlace = (typeof MARK_PLACES)[number];
export const MARK_SIZES = ["normal", "large"] as const;
export type MarkSize = (typeof MARK_SIZES)[number];
export const ACCENT_COLOR = "#c9a227";

/** Stroke paths on a 24×24 grid; `fill` marks glyphs drawn filled. */
export const MARK_PATHS: Record<MarkGlyph, string> = {
  crown: "M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z",
  bot: "M5 8h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2zM12 4v4M9 14h.01M15 14h.01",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  telegram: "M21.4 3.6 2.9 10.8c-1.2.5-1.2 1.2-.2 1.5l4.7 1.5 1.8 5.6c.2.6.4.8.9.8.4 0 .6-.2.9-.4l2.3-2.2 4.8 3.5c.9.5 1.5.2 1.7-.8L22.9 5c.3-1.3-.5-1.9-1.5-1.4Z",
};
export const FILLED_GLYPHS: ReadonlySet<MarkGlyph> = new Set(["crown", "telegram"]);

export interface ThreadMark {
  glyph: MarkGlyph;
  tone: MarkTone;
  place: MarkPlace;
  size: MarkSize;
  label: string;
}
/** pluginId → threadId → marks (at most one per place). */
export type MarkStore = Record<string, Record<string, ThreadMark[]>>;

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const PLUGIN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const MAX_MARKS_PER_PLUGIN = 500;

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly string[]).includes(value as string) ? (value as T) : fallback;
}

export function parseMark(value: unknown): ThreadMark | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (!(MARK_GLYPHS as readonly string[]).includes(v.glyph as string)) return null;
  return {
    glyph: v.glyph as MarkGlyph,
    tone: pick(v.tone, MARK_TONES, "neutral"),
    place: pick(v.place, MARK_PLACES, "corner"),
    size: pick(v.size, MARK_SIZES, "normal"),
    label: typeof v.label === "string" ? v.label.slice(0, 160) : "",
  };
}

/** Up to two marks, one per place; the first for a place wins. */
function marksOf(value: unknown): ThreadMark[] {
  const list = Array.isArray(value) ? value : [value];
  const out: ThreadMark[] = [];
  for (const item of list) {
    const mark = parseMark(item);
    if (mark && !out.some((m) => m.place === mark.place)) out.push(mark);
    if (out.length >= MARK_PLACES.length) break;
  }
  return out;
}

/** Never throws: unknown plugins, threads, glyphs and fields are dropped. */
export function parseStore(raw: unknown): MarkStore {
  const out: MarkStore = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [pluginId, marks] of Object.entries(raw as Record<string, unknown>)) {
    if (!PLUGIN.test(pluginId) || !marks || typeof marks !== "object") continue;
    const own: Record<string, ThreadMark[]> = {};
    let n = 0;
    for (const [threadId, value] of Object.entries(marks as Record<string, unknown>)) {
      const parsed = ID.test(threadId) ? marksOf(value) : [];
      if (parsed.length === 0) continue;
      own[threadId] = parsed;
      if (++n >= MAX_MARKS_PER_PLUGIN) break;
    }
    if (n > 0) out[pluginId] = own;
  }
  return out;
}

/** Sets one mark; it replaces the plugin's mark in the same place on that thread. */
export function setMark(store: MarkStore, pluginId: string, threadId: string, mark: ThreadMark): MarkStore {
  if (!PLUGIN.test(pluginId) || !ID.test(threadId)) return store;
  const own = store[pluginId] ?? {};
  const kept = (own[threadId] ?? []).filter((m) => m.place !== mark.place);
  return { ...store, [pluginId]: { ...own, [threadId]: [...kept, mark] } };
}

/** Clears the plugin's marks on a thread: every place, or only `place`. */
export function clearMark(store: MarkStore, pluginId: string, threadId: string, place?: MarkPlace): MarkStore {
  const own = { ...(store[pluginId] ?? {}) };
  const left = place ? (own[threadId] ?? []).filter((m) => m.place !== place) : [];
  if (left.length) own[threadId] = left; else delete own[threadId];
  const next = { ...store, [pluginId]: own };
  if (Object.keys(own).length === 0) delete next[pluginId];
  return next;
}

/** Replaces every mark of one plugin at once (moving a role between threads is one call). */
export function replaceMarks(store: MarkStore, pluginId: string, marks: readonly ({ threadId: string } & ThreadMark)[]): MarkStore {
  const next = { ...store };
  delete next[pluginId];
  let result = next;
  for (const m of marks.slice(0, MAX_MARKS_PER_PLUGIN * MARK_PLACES.length)) {
    result = setMark(result, pluginId, m.threadId, { glyph: m.glyph, tone: m.tone, place: m.place, size: m.size, label: m.label });
  }
  return result;
}

export type VisibleMark = ThreadMark & { pluginId: string };

/** What the list draws: marks of enabled plugins only; one per place per thread (plugin ids in order). */
export function visibleMarks(store: MarkStore, enabled: ReadonlySet<string>): Record<string, VisibleMark[]> {
  const out: Record<string, VisibleMark[]> = {};
  for (const pluginId of Object.keys(store).sort()) {
    if (!enabled.has(pluginId)) continue;
    for (const [threadId, marks] of Object.entries(store[pluginId] ?? {})) {
      const list = (out[threadId] ??= []);
      for (const mark of marks) if (!list.some((m) => m.place === mark.place)) list.push({ ...mark, pluginId });
    }
  }
  return out;
}

/**
 * The crown (0.2.14): two tones and balls on the points, on a 12×12 grid;
 * viewBox "-1 -0.5 14 11.5" keeps the balls and the contour inside.
 * `body` takes the light tone, `band` and ball outlines the dark one.
 */
export const CROWN = {
  viewBox: "-1 -0.5 14 11.5",
  outline: "M1 4.2 3.3 6.2 6 1.8 8.7 6.2 11 4.2 9.8 10H2.2Z",
  body: "M1 4.2 3.3 6.2 6 1.8 8.7 6.2 11 4.2 10.1 8.2H1.9Z",
  band: "M1.9 8.2H10.1L9.8 10H2.2Z",
  tips: [[1, 4], [6, 1.6], [11, 4]] as const,
  /** Visible width of a top crown in a row: ~60% of the 16px project mark. */
  rowWidth: 9.6,
} as const;
/** Gold for the accent tone: light face and dark base. */
export const ACCENT_HI = "#e8c24a";
export const ACCENT_LO = "#8f6c0e";
