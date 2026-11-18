import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const dayMs = 86_400_000;
export const sorts = ["tokens", "time", "context"] as const;
export const days = z.number().int().min(1).max(30);
export const limit = z.number().int().min(1).max(100);
const threadId = z.string().min(1).max(200);
const count = z.number().nonnegative().nullable();

const tokens = z.object({
  total: count,
  input: count,
  output: count,
  cachedInput: count,
  cacheRead: count,
  cacheWrite: count,
  reasoning: count,
});
const context = z.object({ used: count, capacity: count, estimated: z.boolean() });
const turn = z.object({
  id: z.string(),
  at: z.number(),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
  status: z.string().nullable(),
  durationMs: count,
  tokens: tokens.nullable(),
  tokenQuality: z.enum(["reported", "lower_bound", "missing"]),
  context: context.nullable(),
});
const metrics = z.object({
  tokens: tokens.nullable(),
  turns: z.number(),
  turnsWithTokens: z.number(),
  lowerBoundTurns: z.number(),
  processingMs: count,
  turnsWithDuration: z.number(),
  context: context.nullable(),
  readLimited: z.boolean(),
});
const row = metrics.extend({
  id: z.string(),
  title: z.string(),
  providerId: z.string(),
  status: z.string(),
  archived: z.boolean(),
});
const range = z.object({ from: z.number(), to: z.number() });
const summary = range.extend({
  row,
  buckets: z.array(count),
});
const limits = z.record(z.string(), z.object({
  status: z.enum(["ok", "not_installed", "unauthenticated", "expired", "error"]),
  windows: z.array(z.object({
    label: z.string(),
    resetsAt: z.string().nullable(),
    usedPercent: z.number(),
    usedTokens: z.null(),
    limitTokens: z.null(),
    cost: z.object({ limitUsdCents: z.number(), usedUsdCents: z.number() }).nullable(),
  })),
}));

export const listInput = z.object({
  days: days.default(7),
  limit: limit.default(25),
  sort: z.enum(sorts).default("tokens"),
  active: z.boolean().default(false),
  provider: z.string().min(1).max(200).optional(),
}).strict();

export const detailInput = z.object({
  threadId,
  days: days.default(1),
  limit: limit.default(25),
  sort: z.enum([...sorts, "recent"]).default("recent"),
}).strict();

const historyRow = z.object({
  threadId, title: z.string().max(400), providerId: z.string().min(1).max(200),
  input: z.number().nonnegative(), cacheRead: z.number().nonnegative(),
  output: z.number().nonnegative(), total: z.number().nonnegative(), turns: z.number().int().nonnegative(),
  contextLatest: count, contextPeak: count, processingMs: count,
});
const historyRows = z.array(historyRow).max(1000);
const capturedAt = z.number().int().min(0).max(8.64e15);
const historyPeriod = z.union([z.literal(1), z.literal(7), z.literal(30)]);
export type HistoryPeriod = z.infer<typeof historyPeriod>;
export const historySnapshot = z.object({
  version: z.literal(1),
  capturedAt,
  windows: z.object({ "1": historyRows, "7": historyRows, "30": historyRows }),
});

export const contract = defineRpcContract({
  health: { input: z.null(), output: z.object({ ok: z.literal(true) }) },
  archived: {
    input: z.object({ days: historyPeriod }).strict(),
    output: z.object({ capturedAt, rows: historyRows }).nullable(),
  },
  summary: { input: z.object({ threadId }).strict(), output: summary },
  thread: {
    input: detailInput,
    output: summary.extend({ turns: z.array(turn) }),
  },
  threads: {
    input: listInput,
    output: range.extend({
      rows: z.array(row),
      matched: z.number(),
      scanned: z.number(),
      failed: z.number(),
      listLimited: z.boolean(),
      providers: z.array(z.string()),
    }),
  },
  usage_limits: { input: z.null(), output: limits },
});

export type Tokens = z.infer<typeof tokens>;
export type Context = z.infer<typeof context>;
export type Turn = z.infer<typeof turn>;
export type Metrics = z.infer<typeof metrics>;
export type ListInput = z.output<typeof listInput>;
export type DetailInput = z.output<typeof detailInput>;
export type Range = z.infer<typeof range>;
