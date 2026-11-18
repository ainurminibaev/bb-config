import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { type Context, type Metrics, type Range, type Tokens, type Turn } from "./contract.ts";

type EventsApi = BbPluginApi["sdk"]["threads"]["events"];
export type EventRow = Awaited<ReturnType<EventsApi["list"]>>[number];

const usageType = "thread/tokenUsage/updated";
const contextType = "thread/contextWindowUsage/updated";
export const metricTypes = [usageType, contextType] as const;
export const eventTypes = ["turn/started", "turn/completed", ...metricTypes] as const;
export type MetricEvent = Extract<EventRow, { type: typeof metricTypes[number] }>;
type Usage = Extract<MetricEvent, { type: typeof usageType }>["data"]["tokenUsage"];
type Breakdown = Usage["total"];

export function numberOrNull(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function sanitizeMetric(event: MetricEvent): MetricEvent {
  const { id, seq, createdAt, threadId, scope } = event;
  const { providerThreadId } = event.data;
  const base = { id, seq, createdAt, threadId, scope };
  if (event.type === usageType) {
    const { total, last, modelContextWindow } = event.data.tokenUsage;
    const counts = (value: Breakdown): Breakdown => ({
      totalTokens: value.totalTokens,
      inputTokens: value.inputTokens,
      outputTokens: value.outputTokens,
      cachedInputTokens: value.cachedInputTokens,
      reasoningOutputTokens: value.reasoningOutputTokens,
      ...(value.cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens: value.cacheReadInputTokens }),
      ...(value.cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens: value.cacheWriteInputTokens }),
    });
    return { ...base, type: usageType, data: {
      providerThreadId,
      tokenUsage: { total: counts(total), last: counts(last), modelContextWindow },
    } };
  }
  const { usedTokens, modelContextWindow, estimated } = event.data.contextWindowUsage;
  return { ...base, type: contextType, data: {
    providerThreadId,
    contextWindowUsage: { usedTokens, modelContextWindow, estimated },
  } };
}

function breakdown(value: Breakdown): Tokens {
  return {
    total: numberOrNull(value.totalTokens),
    input: numberOrNull(value.inputTokens),
    output: numberOrNull(value.outputTokens),
    cachedInput: numberOrNull(value.cachedInputTokens),
    cacheRead: numberOrNull(value.cacheReadInputTokens),
    cacheWrite: numberOrNull(value.cacheWriteInputTokens),
    reasoning: numberOrNull(value.reasoningOutputTokens),
  };
}

function combineTokens(left: Tokens, right: Tokens, combine: (a: number | null, b: number | null) => number | null): Tokens {
  return {
    total: combine(left.total, right.total),
    input: combine(left.input, right.input),
    output: combine(left.output, right.output),
    cachedInput: combine(left.cachedInput, right.cachedInput),
    cacheRead: combine(left.cacheRead, right.cacheRead),
    cacheWrite: combine(left.cacheWrite, right.cacheWrite),
    reasoning: combine(left.reasoning, right.reasoning),
  };
}

const add = (a: number | null, b: number | null) => a === null && b === null ? null : (a ?? 0) + (b ?? 0);
const subtract = (a: number | null, b: number | null) => a !== null && b !== null ? numberOrNull(a - b) : null;

type Sample = { session: string; value: Usage };
type Draft = {
  id: string;
  startedAt: number | null;
  finishedAt: number | null;
  status: string | null;
  order: number;
  seenAt: number;
  nested: boolean;
  samples: Sample[];
  context: Context | null;
};

function turnUsage(samples: Sample[], providerId: string, previous: Sample | undefined) {
  const latest = samples.at(-1);
  if (!latest) return { tokens: null, quality: "missing" } as const;
  const last = breakdown(latest.value.last);
  if (providerId === "claude-code") {
    // BB's Claude bridge reports uncached input and synthesizes an all-zero
    // placeholder when it knows only the window capacity.
    const windowOnly = latest.value.modelContextWindow !== null &&
      last.total === 0 && last.input === 0 && last.cachedInput === 0 && last.output === 0 &&
      last.reasoning === 0 && last.cacheRead === null && last.cacheWrite === null;
    if (windowOnly) return { tokens: null, quality: "missing" } as const;
    return {
      tokens: {
        ...last,
        input: last.input === null || last.cachedInput === null ? null : last.input + last.cachedInput,
        reasoning: last.reasoning === 0 ? null : last.reasoning,
      },
      quality: "reported",
    } as const;
  }
  if (providerId !== "codex") return { tokens: last, quality: "lower_bound" } as const;

  // Codex last can describe one model request. A gap between retained turns
  // makes a cumulative delta unsafe to attribute to any one of them.
  let segmentStart = 0;
  for (let i = 1; i < samples.length; i++) {
    const before = samples[i - 1];
    const after = samples[i];
    if (after.session !== before.session || after.value.total.totalTokens < before.value.total.totalTokens) {
      segmentStart = i;
    }
  }
  const first = samples[segmentStart];
  const finalTotal = breakdown(latest.value.total);
  if (segmentStart === 0 && previous?.session === latest.session) {
    const before = breakdown(previous.value.total);
    const delta = combineTokens(finalTotal, before, subtract);
    const firstDelta = subtract(first.value.total.totalTokens, before.total);
    if (delta.total !== null && firstDelta === first.value.last.totalTokens) {
      return { tokens: delta, quality: "reported" } as const;
    }
  }

  const observed = combineTokens(finalTotal, breakdown(first.value.total), subtract);
  return { tokens: combineTokens(breakdown(first.value.last), observed, add), quality: "lower_bound" } as const;
}

export function collectTurns(events: Iterable<EventRow>, providerId: string, createdAt: number): Turn[] {
  const drafts = new Map<string, Draft>();
  // Rewrites can reuse sequences. Event IDs deduplicate repeated pages and archive overlap.
  const ordered = [...new Map([...events].map(event => [event.id, event])).values()]
    .sort((a, b) => a.seq - b.seq);
  for (const event of ordered) {
    if (event.scope.kind !== "turn" || event.createdAt < createdAt) continue;
    const id = event.scope.turnId;
    let draft = drafts.get(id);
    if (!draft) {
      draft = { id, startedAt: null, finishedAt: null, status: null, order: event.seq, seenAt: event.createdAt,
        nested: false, samples: [], context: null };
      drafts.set(id, draft);
    }
    draft.seenAt = Math.max(draft.seenAt, event.createdAt);
    switch (event.type) {
      case "turn/started":
        draft.order = event.seq;
        draft.startedAt = event.createdAt;
        draft.nested = Boolean(event.data.parentToolCallId);
        break;
      case "turn/completed":
        draft.finishedAt = event.createdAt;
        draft.status = event.data.status;
        break;
      case usageType:
        draft.samples.push({ session: event.data.providerThreadId, value: event.data.tokenUsage });
        break;
      case contextType: {
        const { usedTokens, modelContextWindow, estimated } = event.data.contextWindowUsage;
        draft.context = { used: numberOrNull(usedTokens),
          capacity: numberOrNull(modelContextWindow) ?? draft.context?.capacity ?? null, estimated };
        break;
      }
    }
  }

  const turns: Turn[] = [];
  let previous: Sample | undefined;
  for (const draft of [...drafts.values()].sort((a, b) => a.order - b.order)) {
    if (draft.nested || (draft.startedAt === null && draft.finishedAt === null)) continue;
    const { startedAt, finishedAt } = draft;
    const { tokens, quality } = turnUsage(draft.samples, providerId, previous);
    const latest = draft.samples.at(-1);
    previous = finishedAt === null ? undefined : latest;
    const capacity = numberOrNull(latest?.value.modelContextWindow);
    const context = draft.context ?
      { ...draft.context, capacity: draft.context.capacity ?? capacity } :
      (capacity === null ? null : { used: null, capacity, estimated: false });
    turns.push({
      id: draft.id, startedAt, finishedAt, status: draft.status,
      at: finishedAt ?? draft.seenAt,
      durationMs: startedAt !== null && finishedAt !== null ? numberOrNull(finishedAt - startedAt) : null,
      tokens, tokenQuality: tokens?.total == null ? "missing" : quality, context,
    });
  }
  return turns;
}

export function summarize(turns: Turn[], readLimited: boolean): Metrics {
  const metrics: Metrics = {
    tokens: null, turns: turns.length, turnsWithTokens: 0, lowerBoundTurns: 0,
    processingMs: null, turnsWithDuration: 0, context: null, readLimited,
  };
  for (const turn of turns) {
    if (turn.tokens !== null) {
      if (turn.tokens.total !== null) metrics.turnsWithTokens++;
      metrics.tokens = metrics.tokens === null ? turn.tokens : combineTokens(metrics.tokens, turn.tokens, add);
    }
    if (turn.tokenQuality === "lower_bound") metrics.lowerBoundTurns++;
    if (turn.durationMs !== null) {
      metrics.processingMs = (metrics.processingMs ?? 0) + turn.durationMs;
      metrics.turnsWithDuration++;
    }
    if (turn.context?.used != null || metrics.context?.used == null) {
      metrics.context = turn.context ?? metrics.context;
    }
  }
  return metrics;
}

export function buckets(turns: Turn[], { from, to }: Range) {
  const bucketSize = (to - from) / 12;
  const values: (number | null)[] = Array.from({ length: 12 }, () => null);
  for (const turn of turns) {
    const index = Math.min(values.length - 1, Math.floor((turn.at - from) / bucketSize));
    values[index] = add(values[index], turn.tokens?.total ?? null);
  }
  return values;
}
