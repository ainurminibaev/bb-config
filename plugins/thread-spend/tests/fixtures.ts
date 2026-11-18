import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { EventRow, MetricEvent } from "../metrics.ts";

type Thread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["list"]>>[number];
export const now = 1_799_000_000_000;
export const start = (seq: number, turnId: string, at = now - 60_000, parentToolCallId?: string): EventRow => ({
  id: `event-${seq}`, seq, threadId: "thr_fixture", createdAt: at, type: "turn/started",
  scope: { kind: "turn", turnId }, data: { providerThreadId: "session-a", parentToolCallId },
});
export const finish = (seq: number, turnId: string, at = now - 10_000): EventRow => ({
  id: `event-${seq}`, seq, threadId: "thr_fixture", createdAt: at, type: "turn/completed",
  scope: { kind: "turn", turnId }, data: { providerThreadId: "session-a", status: "completed" },
});
const breakdown = (totalTokens: number) => ({
  totalTokens, inputTokens: totalTokens * .8, outputTokens: totalTokens * .2,
  cachedInputTokens: totalTokens * .5, cacheReadInputTokens: totalTokens * .4,
  cacheWriteInputTokens: totalTokens * .1, reasoningOutputTokens: totalTokens * .1,
});
export const usage = (seq: number, turnId: string | null, total: number, last: number, at = now - 30_000,
  providerThreadId = "session-a"): Extract<MetricEvent, { type: "thread/tokenUsage/updated" }> => ({
  id: `event-${seq}`, seq, threadId: "thr_fixture", createdAt: at, type: "thread/tokenUsage/updated",
  scope: turnId === null ? { kind: "thread" } : { kind: "turn", turnId },
  data: { providerThreadId, tokenUsage: { total: breakdown(total), last: breakdown(last), modelContextWindow: 10000 } },
});
export const context = (seq: number, turnId: string, usedTokens: number, modelContextWindow: number | null, estimated = false): MetricEvent => ({
  id: `event-${seq}`, seq, threadId: "thr_fixture", createdAt: now - 30_000, type: "thread/contextWindowUsage/updated",
  scope: { kind: "turn", turnId }, data: { providerThreadId: "session-a", contextWindowUsage: { usedTokens, modelContextWindow, estimated } },
});

export function thread(index: number, overrides: Partial<Thread> = {}): Thread {
  return {
    id: `thr_fixture_${index}`, title: `Synthetic ${index}`, providerId: "claude-code", status: "idle",
    archivedAt: null, updatedAt: now - 1_000, latestAttentionAt: now - 1_000, createdAt: now - 90 * 86_400_000,
    ...overrides,
  } as Thread;
}
