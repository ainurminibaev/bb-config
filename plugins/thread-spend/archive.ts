import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { dayMs } from "./contract.ts";
import { metricTypes, sanitizeMetric, type MetricEvent } from "./metrics.ts";
import { limiter } from "./reads.ts";

const maxArchiveAge = 30 * dayMs;
const maxArchiveRows = 200_000;
const capturePageSize = 100;
const maxCapturePages = 4;

export function metricArchive(bb: BbPluginApi, sdkRead: ReturnType<typeof limiter>) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [`
    CREATE TABLE metric_sample (
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, seq INTEGER NOT NULL,
      at INTEGER NOT NULL, sample TEXT NOT NULL
    );
  `, "CREATE INDEX metric_sample_thread_at ON metric_sample(thread_id, at)",
  "CREATE INDEX metric_sample_at ON metric_sample(at)"]);
  const insert = db.prepare("INSERT OR REPLACE INTO metric_sample VALUES (?, ?, ?, ?, ?)");
  const read = db.prepare<[string, number, number], { sample: string }>(
    "SELECT sample FROM metric_sample WHERE thread_id = ? AND at BETWEEN ? AND ? ORDER BY at DESC LIMIT 3200",
  );
  const latest = db.prepare<[string], { seq: number | null }>("SELECT MAX(seq) AS seq FROM metric_sample WHERE thread_id = ?");
  const dropOld = db.prepare("DELETE FROM metric_sample WHERE at < ?");
  const trim = db.prepare(`DELETE FROM metric_sample WHERE id IN (
    SELECT id FROM metric_sample ORDER BY at DESC, id DESC LIMIT -1 OFFSET ?
  )`);
  const remove = db.prepare("DELETE FROM metric_sample WHERE thread_id = ?");
  const save = db.transaction((events: MetricEvent[]) => {
    for (const event of events) insert.run(event.id, event.threadId, event.seq, event.createdAt, JSON.stringify(event));
  });

  const dirty = new Set<string>();
  let lifetime: AbortSignal | undefined;
  let draining = false;
  let inFlight: { threadId: string; cancel: AbortController } | undefined;

  async function capture(threadId: string, signal: AbortSignal) {
    const afterSeq = latest.get(threadId)?.seq ?? undefined;
    let beforeSeq: number | undefined;
    const retained: MetricEvent[] = [];
    const cutoff = Date.now() - maxArchiveAge;
    for (let page = 0; page < maxCapturePages; page++) {
      const rows = await sdkRead(signal, () => bb.sdk.threads.events.list({
        threadId, types: metricTypes, order: "desc", limit: String(capturePageSize), signal,
        ...(afterSeq === undefined ? {} : { afterSeq: String(afterSeq) }),
        ...(beforeSeq === undefined ? {} : { beforeSeq: String(beforeSeq) }),
      }));
      for (const row of rows) {
        if (row.createdAt < cutoff || row.scope.kind !== "turn") continue;
        if (row.type === metricTypes[0] || row.type === metricTypes[1]) retained.push(sanitizeMetric(row));
      }
      if (rows.length < capturePageSize || rows.every(event => event.createdAt < cutoff)) break;
      const next = Math.min(...rows.map(event => event.seq));
      if (beforeSeq !== undefined && next >= beforeSeq) break;
      beforeSeq = next;
    }
    signal.throwIfAborted();
    if (retained.length) save(retained);
  }

  async function drain(signal: AbortSignal) {
    if (draining) return;
    draining = true;
    try {
      for (const threadId of [...dirty]) {
        if (signal.aborted) break;
        if (!dirty.delete(threadId)) continue;
        const cancel = new AbortController();
        inFlight = { threadId, cancel };
        try {
          await capture(threadId, AbortSignal.any([signal, cancel.signal, AbortSignal.timeout(12_000)]));
        } catch {
          // A live notification is only a hint. Later reads still consult BB.
        } finally {
          inFlight = undefined;
        }
      }
    } finally {
      draining = false;
    }
  }

  bb.events.on("experimental_thread.events", ({ thread }) => {
    if (!lifetime || lifetime.aborted || (dirty.size >= 256 && !dirty.has(thread.id))) return;
    dirty.add(thread.id);

  });
  bb.events.on("thread.deleted", ({ thread }) => {
    dirty.delete(thread.id);
    if (inFlight?.threadId === thread.id) inFlight.cancel.abort();
    remove.run(thread.id);
  });
  bb.background.service("metric-retention", {
    async start(signal) {
      lifetime = signal;
      const prune = () => {
        dropOld.run(Date.now() - maxArchiveAge);
        trim.run(maxArchiveRows);
      };
      try {
        prune();
        const timer = setInterval(prune, 60 * 60 * 1000);
        const captureTimer = setInterval(() => void drain(signal), 3_000);
        try {
          await new Promise<void>(resolve => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", () => resolve(), { once: true });
          });
        } finally {
          clearInterval(captureTimer);
          clearInterval(timer);
        }
      } finally {
        lifetime = undefined;
        dirty.clear();
      }
    },
  });

  return (threadId: string, from: number, to: number): MetricEvent[] =>
    read.all(threadId, Math.max(from, Date.now() - maxArchiveAge), to).map(row => JSON.parse(row.sample) as MetricEvent);
}
