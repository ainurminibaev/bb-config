import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readHistory } from "../history.ts";

test("the transition archive is optional and read independently of live metrics", async t => {
  const root = await mkdtemp(join(tmpdir(), "thread-spend-history-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "history.json");
  assert.equal(await readHistory(7, file), null);
  const row = { threadId: "sample", title: "Sample", providerId: "example",
    input: 1, cacheRead: 2, output: 3, total: 6, turns: 1,
    contextLatest: null, contextPeak: null, processingMs: 12 };
  await writeFile(file, JSON.stringify({ version: 1, capturedAt: 42,
    windows: { "1": [], "7": [row], "30": [row] } }));
  assert.deepEqual(await readHistory(7, file), { capturedAt: 42, rows: [row] });
  assert.deepEqual(await readHistory(1, file), { capturedAt: 42, rows: [] });
  await writeFile(file, '{"version":999}');
  await assert.rejects(readHistory(7, file), /Invalid Thread Spend snapshot/);
});
