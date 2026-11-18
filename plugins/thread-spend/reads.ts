import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { dayMs, type DetailInput, type ListInput, type Metrics, type Range } from "./contract.ts";
import { buckets, collectTurns, eventTypes, summarize, type EventRow, type MetricEvent } from "./metrics.ts";

type SdkThreads = BbPluginApi["sdk"]["threads"];
type Thread = Awaited<ReturnType<SdkThreads["list"]>>[number];
type ThreadMeta = Pick<Thread, "id" | "title" | "providerId" | "status" | "archivedAt" | "createdAt">;
type Sdk = {
  threads: Pick<SdkThreads, "list"> & {
    get(args: Parameters<SdkThreads["get"]>[0]): Promise<ThreadMeta>;
    events: Pick<SdkThreads["events"], "list">;
  };
  system: Pick<BbPluginApi["sdk"]["system"], "usageLimits">;
};
type ArchiveRead = (threadId: string, from: number, to: number) => MetricEvent[];
const eventPageSize = 100;
const threadPageSize = 100;
const maxEventPages = 32;
const maxThreadPages = 50;
const readConcurrency = 4;

export function limiter(max: number) {
  let running = 0;
  const waiters: (() => void)[] = [];
  return async function run<T>(signal: AbortSignal, read: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    if (running < max) {
      running++;
    } else {
      await new Promise<void>((resolve, reject) => {
        const next = () => {
          signal.removeEventListener("abort", abort);
          resolve();
        };
        const abort = () => {
          const index = waiters.indexOf(next);
          if (index >= 0) waiters.splice(index, 1);
          reject(signal.reason);
        };
        waiters.push(next);
        signal.addEventListener("abort", abort, { once: true });
      });
    }
    try {
      signal.throwIfAborted();
      const result = await read();
      signal.throwIfAborted();
      return result;
    } finally {
      const next = waiters.shift();
      if (next) next();
      else running--;
    }
  };
}

const metadata = (thread: ThreadMeta) => ({
  id: thread.id,
  title: thread.title?.slice(0, 300) || "Без названия",
  providerId: thread.providerId,
  status: thread.status,
  archived: thread.archivedAt !== null,
});

function rank(value: { tokens: Metrics["tokens"]; context: Metrics["context"]; durationMs?: number | null; processingMs?: number | null }, sort: ListInput["sort"]) {
  switch (sort) {
    case "tokens": return value.tokens?.total ?? -1;
    case "context": return value.context?.used ?? -1;
    case "time": return value.durationMs ?? value.processingMs ?? -1;
  }
}

export function readService(
  sdk: Sdk,
  archive: ArchiveRead = () => [],
  sdkRead = limiter(readConcurrency),
  now = Date.now,
) {
  const range = (days: number): Range => {
    const to = now();
    return { from: to - days * dayMs, to };
  };

  async function readTurns(thread: ThreadMeta, period: Range, signal: AbortSignal) {
    const events: EventRow[] = [];
    let beforeSeq: number | undefined;
    let lowerTimestamp = period.from;
    let readLimited = true;
    const starts = new Set<string>();
    const finishes = new Set<string>();
    const periodTurns = new Set<string>();

    for (let page = 0; page < maxEventPages; page++) {
      const result = await sdkRead(signal, () => sdk.threads.events.list({
        threadId: thread.id, types: eventTypes, limit: String(eventPageSize), order: "desc",
        ...(beforeSeq === undefined ? {} : { beforeSeq: String(beforeSeq) }), signal,
      }));
      if (!result.length) {
        readLimited = false;
        break;
      }
      const nextSeq = Math.min(...result.map(event => event.seq));
      if (beforeSeq !== undefined && nextSeq >= beforeSeq) throw new Error("BB event cursor did not advance");
      beforeSeq = nextSeq;
      events.push(...result);
      lowerTimestamp = Math.min(lowerTimestamp, ...result.map(event => event.createdAt));
      for (const event of result) {
        if (event.scope.kind !== "turn") continue;
        const id = event.scope.turnId;
        if (event.createdAt >= period.from) periodTurns.add(id);
        if (event.type === "turn/started") starts.add(id);
        if (event.type === "turn/completed" && event.createdAt < period.from) finishes.add(id);
      }
      const includesEarlierBoundary = [...finishes].some(id => starts.has(id));
      const includesStarts = [...periodTurns].every(id => starts.has(id));
      if (result.length < eventPageSize ||
        (result.every(event => event.createdAt < period.from) && includesStarts && includesEarlierBoundary)) {
        readLimited = false;
        break;
      }
    }
    signal.throwIfAborted();
    const saved = archive(thread.id, lowerTimestamp, period.to);
    const source = [...saved, ...events].filter(event => event.createdAt <= period.to);
    const turns = collectTurns(source, thread.providerId, thread.createdAt).filter(turn => turn.at >= period.from);
    return { turns, metrics: summarize(turns, readLimited) };
  }

  async function detail(input: DetailInput, signal: AbortSignal) {
    const period = range(input.days);
    const thread = await sdkRead(signal, () => sdk.threads.get({ threadId: input.threadId, signal }));
    const { turns, metrics } = await readTurns(thread, period, signal);
    const sort = input.sort;
    const ordered = [...turns].sort((a, b) =>
      (sort === "recent" ? 0 : rank(b, sort) - rank(a, sort)) || b.at - a.at,
    );
    return { ...period, row: { ...metadata(thread), ...metrics },
      buckets: buckets(turns, period), turns: ordered.slice(0, input.limit) };
  }

  async function summary(threadId: string, signal: AbortSignal) {
    const { turns: _turns, ...header } = await detail({ threadId, days: 1, limit: 1, sort: "recent" }, signal);
    return header;
  }

  async function threads(input: ListInput, signal: AbortSignal) {
    const period = range(input.days);
    const candidates = new Map<string, Thread>();
    let listLimited = false;
    for (const archived of input.active ? [false] : [false, true]) {
      for (let page = 0; page < maxThreadPages; page++) {
        const items = await sdkRead(signal, () => sdk.threads.list({
          archived, limit: threadPageSize, offset: page * threadPageSize, signal,
        }));
        for (const item of items) {
          if (Math.max(item.updatedAt, item.latestAttentionAt, item.archivedAt ?? 0) < period.from &&
            item.status !== "active" && item.status !== "starting") continue;
          if (input.active && item.status !== "active" && item.status !== "starting") continue;
          candidates.set(item.id, item);
        }
        if (items.length < threadPageSize) break;
        if (page === maxThreadPages - 1) listLimited = true;
      }
    }
    const providers = [...new Set([...candidates.values()].map(thread => thread.providerId))].sort();
    const queue = [...candidates.values()].filter(thread => !input.provider || thread.providerId === input.provider);
    const rows: (ReturnType<typeof metadata> & Metrics)[] = [];
    let failed = 0;
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(queue.length, readConcurrency) }, async () => {
      while (next < queue.length) {
        signal.throwIfAborted();
        const thread = queue[next++];
        try {
          const { metrics } = await readTurns(thread, period, signal);
          if (metrics.turns > 0 || metrics.readLimited || input.active) rows.push({ ...metadata(thread), ...metrics });
        } catch {
          signal.throwIfAborted();
          failed++;
        }
      }
    }));
    rows.sort((a, b) => rank(b, input.sort) - rank(a, input.sort) || a.id.localeCompare(b.id));
    return { ...period, rows: rows.slice(0, input.limit), matched: rows.length,
      scanned: queue.length, failed, listLimited, providers };
  }

  async function usageLimits(signal: AbortSignal) {
    const result = await sdkRead(signal, () => sdk.system.usageLimits({ refresh: false, signal }));
    return Object.fromEntries(Object.entries(result).map(([key, usage]) => [
      key,
      { status: usage.status, windows: usage.status === "ok" ? usage.windows.map(window => ({
        label: window.label, resetsAt: window.resetsAt, usedPercent: window.usedPercent,
        usedTokens: null, limitTokens: null, cost: window.cost ?? null,
      })) : [] },
    ]));
  }

  return { summary, detail, threads, usageLimits };
}
