import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { setImmediate as yieldControl } from "node:timers/promises";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { metricArchive } from "../archive.ts";
import { dayMs } from "../contract.ts";
import { metricTypes } from "../metrics.ts";
import { limiter } from "../reads.ts";
import { thread, usage } from "./fixtures.ts";

test("live capture allowlists payloads, skips thread scope, advances, deduplicates and removes deleted threads", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const db = new DatabaseSync(":memory:");
  const metric = usage(2, "a", 40, 40);
  metric.createdAt = Date.now() - 100;
  Object.assign(metric.data, { fixtureNoise: "never persisted" });
  const meta = thread(0, { id: metric.threadId });
  const handlers = new Map<string, (input: { thread: typeof meta }) => void>();
  let startService: ((signal: AbortSignal) => Promise<void>) | undefined;
  const calls: (string | undefined)[] = [];
  const bb = {
    storage: {
      database: () => ({
        prepare: (sql: string) => db.prepare(sql),
        transaction: (fn: unknown) => fn,
      }),
      migrate: (_db: unknown, statements: string[]) => { for (const sql of statements) db.exec(sql); },
    },
    events: { on: (name: string, handler: (input: { thread: typeof meta }) => void) => handlers.set(name, handler) },
    background: { service: (_name: string, spec: { start: typeof startService }) => { startService = spec.start; } },
    sdk: { threads: { events: { list: async (args: Parameters<BbPluginApi["sdk"]["threads"]["events"]["list"]>[0]) => {
      calls.push(args.afterSeq);
      assert.deepEqual(args.types, metricTypes);
      assert.ok(args.signal);
      return args.afterSeq ? [] : [{ ...metric, id: "replay", scope: { kind: "thread" } }, metric, metric];
    } } } },
  } as unknown as BbPluginApi;

  const read = metricArchive(bb, limiter(4));
  const controller = new AbortController();
  assert.ok(startService);
  const lifetime = startService(controller.signal);
  t.after(async () => { controller.abort(); await lifetime; db.close(); });

  for (let i = 0; i < 2; i++) {
    handlers.get("experimental_thread.events")?.({ thread: meta });
    t.mock.timers.tick(3_000);
    await yieldControl();
  }
  const saved = read(meta.id, Date.now() - dayMs, Date.now());
  assert.equal(saved.length, 1);
  assert.equal(saved[0].id, metric.id);
  assert.doesNotMatch(JSON.stringify(saved), /fixtureNoise|never persisted/);
  assert.deepEqual(calls, [undefined, "2"]);

  handlers.get("thread.deleted")?.({ thread: meta });
  assert.deepEqual(read(meta.id, Date.now() - dayMs, Date.now()), []);
});
