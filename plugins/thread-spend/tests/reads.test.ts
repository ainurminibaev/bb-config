import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as yieldControl } from "node:timers/promises";
import { contract, dayMs, detailInput, listInput } from "../contract.ts";
import { eventTypes, type EventRow } from "../metrics.ts";
import { readService } from "../reads.ts";
import { registerCommands } from "../server.ts";
import { finish, now, start, thread, usage } from "./fixtures.ts";

type Sdk = Parameters<typeof readService>[0];
type List = Sdk["threads"]["list"];
type Events = Sdk["threads"]["events"]["list"];
type Usage = Sdk["system"]["usageLimits"];

const createSdk = ({
  list = async () => [],
  events = async () => [],
  usageLimits = async () => ({}),
}: { list?: List; events?: Events; usageLimits?: Usage } = {}) => ({
  threads: { list, events: { list: events }, get: async ({ threadId }: { threadId: string }) => thread(0, { id: threadId }) },
  system: { usageLimits },
}) satisfies Sdk;
const signal = () => new AbortController().signal;

test("event reads use filters and exclusive sequence cursors and merge saved metrics with live events", async () => {
  const all: EventRow[] = [];
  for (let n = 0; n < 80; n++) {
    const seq = n * 3;
    all.push(start(seq + 1, `turn-${n}`), usage(seq + 2, `turn-${n}`, n * 100, 100), finish(seq + 3, `turn-${n}`));
  }
  const cursors: (string | undefined)[] = [];
  const sdk = createSdk({ events: async args => {
    cursors.push(args.beforeSeq);
    assert.deepEqual(args.types, eventTypes);
    assert.equal(args.order, "desc");
    assert.ok(args.signal);
    return all.filter(event => !args.beforeSeq || event.seq < Number(args.beforeSeq)).reverse().slice(0, Number(args.limit));
  } });
  const result = await readService(sdk, () => [usage(2, "turn-0", 0, 100)], undefined, () => now)
    .detail(detailInput.parse({ threadId: "thr_fixture", limit: 3 }), signal());
  assert.deepEqual(cursors, [undefined, "141", "41"]);
  assert.equal(result.row.tokens?.total, 8000);
  assert.equal(result.row.turns, 80);
  assert.equal(result.turns.length, 3);
  assert.equal(result.row.readLimited, false);
  assert.equal(result.buckets.at(-1), 8000);
  assert.equal(result.from, now - dayMs);
});

test("an older start and prior boundary are read for a turn that finishes during the window", async () => {
  const boundary = now - dayMs;
  const old = start(101, "crosses-cutoff", boundary - 10);
  const firstPage = [
    ...Array.from({ length: 98 }, (_, i) => finish(200 - i, `other-${i}`, now - 20)),
    usage(102, "crosses-cutoff", 100, 100, boundary - 5),
    finish(201, "crosses-cutoff", boundary + 50),
  ].sort((a, b) => b.seq - a.seq);
  const sdk = createSdk({ events: async args => args.beforeSeq ? [old] : firstPage });
  const response = await readService(sdk, undefined, undefined, () => now)
    .detail(detailInput.parse({ threadId: "thr_fixture", limit: 100 }), signal());
  const turn = response.turns.find(item => item.id === "crosses-cutoff");
  assert.equal(turn?.durationMs, 60);
  assert.equal(turn?.tokens?.total, 100);
});

test("thread pages include archives, filter by provider, tolerate failures and sort before limiting", async () => {
  const entries = Array.from({ length: 102 }, (_, i) => thread(i, { providerId: i % 2 ? "other" : "claude-code" }));
  const archived = thread(500, { archivedAt: now - 1_000 });
  const offsets: [boolean | undefined, number | undefined][] = [];
  let running = 0;
  let peak = 0;
  const sdk = createSdk({
    list: async args => {
      offsets.push([args?.archived, args?.offset]);
      return args?.archived ? [archived] : entries.slice(args?.offset, (args?.offset ?? 0) + (args?.limit ?? 0));
    },
    events: async args => {
      const index = Number(args.threadId.split("_").at(-1));
      running++;
      peak = Math.max(peak, running);
      await yieldControl();
      running--;
      if (index === 0) throw new Error("Synthetic event failure");
      return [finish(3, "a"), usage(2, "a", index, index), start(1, "a")];
    },
  });
  const result = await readService(sdk, undefined, undefined, () => now)
    .threads(listInput.parse({ limit: 2, provider: "claude-code" }), signal());
  assert.deepEqual(offsets, [[false, 0], [false, 100], [true, 0]]);
  assert.deepEqual(result.providers, ["claude-code", "other"]);
  assert.equal(result.scanned, 52);
  assert.equal(result.failed, 1);
  assert.equal(result.matched, 51);
  assert.equal(peak, 4);
  assert.deepEqual(result.rows.map(row => row.id), ["thr_fixture_500", "thr_fixture_100"]);
});

test("active filters by canonical runtime status and leaves an active thread with no events visible", async () => {
  const sdk = createSdk({ list: async args => {
    assert.equal(args?.archived, false);
    return [thread(1), thread(2, { status: "starting" }), thread(3, { status: "active" })];
  } });
  const result = await readService(sdk, undefined, undefined, () => now)
    .threads(listInput.parse({ active: true }), signal());
  assert.equal(result.scanned, 2);
  assert.deepEqual(result.rows.map(row => row.id), ["thr_fixture_2", "thr_fixture_3"]);
});

test("concurrent calls share the bound and cancellation prevents queued or subsequent event calls", async () => {
  const input = detailInput.parse({ threadId: "thr_fixture" });
  const waiting = new AbortController();
  const running = Array.from({ length: 4 }, () => new AbortController());
  const active = new Set<AbortSignal>();
  let eventCalls = 0;
  let peak = 0;
  const sdk = createSdk({ events: async ({ signal }) => {
    if (!signal) throw new Error("Missing request signal");
    eventCalls++;
    active.add(signal);
    peak = Math.max(peak, active.size);
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    return [];
  } });
  const reads = readService(sdk, undefined, undefined, () => now);
  const first = running.map(controller => assert.rejects(reads.detail(input, controller.signal), { name: "AbortError" }));
  const second = assert.rejects(reads.detail(input, waiting.signal), { name: "AbortError" });
  await yieldControl();
  waiting.abort();
  for (const controller of running) controller.abort();
  await Promise.all([...first, second]);
  assert.equal(eventCalls, 4);
  assert.equal(peak, 4);
});

test("usage_limits emits explicit null values, preserves official quota fields and drops account identity", async () => {
  const sdk = createSdk({ usageLimits: async args => {
    assert.equal(args?.refresh, false);
    assert.ok(args?.signal);
    return { codex: { status: "ok", accountEmail: "synthetic@example.invalid", planLabel: "Test", windows: [
      { label: "five hours", resetsAt: null, usedPercent: 25 },
      { label: "budget", resetsAt: "2099-01-01T00:00:00Z", usedPercent: 10, cost: { limitUsdCents: 200, usedUsdCents: 20 } },
    ] }, "claude-code": { status: "expired" } };
  } });
  const result = await readService(sdk).usageLimits(signal());
  assert.deepEqual(result.codex.windows[0], {
    label: "five hours", resetsAt: null, usedPercent: 25, usedTokens: null, limitTokens: null, cost: null,
  });
  assert.deepEqual(result.codex.windows[1].cost, { limitUsdCents: 200, usedUsdCents: 20 });
  assert.deepEqual(result["claude-code"], { status: "expired", windows: [] });
  assert.doesNotMatch(JSON.stringify(result), /example\.invalid/);
  assert.ok("value" in await contract.usage_limits.output["~standard"].validate(result));
});

test("CLI routes JSON, validates range, and reports command timing unavailable without reading it", async () => {
  type Registration = Parameters<Parameters<typeof registerCommands>[0]["cli"]["register"]>[0];
  let cli: Registration | undefined;
  registerCommands({ cli: { register(registration) { cli = registration; } } },
    readService(createSdk(), undefined, undefined, () => now));
  assert.ok(cli);
  const err = await cli.run(["threads", "--days", "31", "--json"], { signal: signal() });
  assert.notEqual(err.exitCode, 0);
  const list = await cli.run(["threads", "--days", "30", "--sort", "context", "--json"], { signal: signal() });
  assert.equal(list.exitCode, 0);
  assert.equal(JSON.parse(list.stdout ?? "").from, now - 30 * dayMs);
  const commands = await cli.run(["commands", "--json"], { signal: signal() });
  assert.equal(JSON.parse(commands.stdout ?? "").available, false);
});

test("time and context sort on measured values and leave missing values last", async () => {
  const sdk = createSdk({
    list: async args => args?.archived ? [] : [thread(1), thread(2), thread(3)],
    events: async args => {
      if (args.threadId.endsWith("_3")) return [start(1, "unfinished")];
      const slower = args.threadId.endsWith("_1");
      return [
        finish(3, "a"),
        { id: "event-2", threadId: args.threadId, seq: 2, type: "thread/contextWindowUsage/updated",
          createdAt: now - 15_000, scope: { kind: "turn", turnId: "a" }, data: {
            providerThreadId: "session-a", contextWindowUsage: {
              usedTokens: slower ? 200 : 500, modelContextWindow: 1000, estimated: false,
            },
          } },
        start(1, "a", now - (slower ? 100_000 : 30_000)),
      ];
    },
  });
  const reads = readService(sdk, undefined, undefined, () => now);
  const time = await reads.threads(listInput.parse({ sort: "time" }), signal());
  const context = await reads.threads(listInput.parse({ sort: "context" }), signal());
  assert.deepEqual(time.rows.map(row => row.id), ["thr_fixture_1", "thr_fixture_2", "thr_fixture_3"]);
  assert.deepEqual(context.rows.map(row => row.id), ["thr_fixture_2", "thr_fixture_1", "thr_fixture_3"]);
});
