import assert from "node:assert/strict";
import { test } from "node:test";
import { buckets, collectTurns, sanitizeMetric, summarize } from "../metrics.ts";
import { context, finish, now, start, usage } from "./fixtures.ts";

test("Claude takes a single whole-turn last snapshot and never adds its cache or reasoning to total", () => {
  const old = usage(2, "a", 260, 60);
  const latest = usage(3, "a", 300, 100);
  latest.data.tokenUsage.last.inputTokens = 30;
  latest.data.tokenUsage.last.reasoningOutputTokens = 0;
  const [turn] = collectTurns([finish(6, "a"), context(5, "a", 150, null, true), context(4, "a", 140, 4096),
    latest, old, latest, start(1, "a")], "claude-code", 0);
  assert.deepEqual(turn.tokens, { total: 100, input: 80, output: 20, cachedInput: 50,
    cacheRead: 40, cacheWrite: 10, reasoning: null });
  assert.deepEqual(turn.context, { used: 150, capacity: 4096, estimated: true });
  assert.equal(turn.durationMs, 50_000);
  assert.equal(turn.tokenQuality, "reported");
});

test("Claude's capacity-only placeholder is missing token coverage", () => {
  const placeholder = usage(2, "a", 25, 0);
  delete placeholder.data.tokenUsage.last.cacheReadInputTokens;
  delete placeholder.data.tokenUsage.last.cacheWriteInputTokens;
  const [turn] = collectTurns([start(1, "a"), placeholder, finish(3, "a")], "claude-code", 0);
  assert.equal(turn.tokens, null);
  assert.equal(turn.tokenQuality, "missing");
  assert.deepEqual(turn.context, { used: null, capacity: 10000, estimated: false });
});

test("Codex uses cumulative deltas across proven consecutive samples, including multiple model requests", () => {
  const turns = collectTurns([
    start(1, "a"), usage(2, "a", 100, 100), finish(3, "a"),
    start(4, "b"), usage(5, "b", 120, 20), usage(6, "b", 120, 20),
    usage(7, "b", 170, 50), finish(8, "b"),
  ], "codex", 0);
  assert.equal(turns[1].tokens?.total, 70);
  assert.equal(turns[1].tokens?.input, 56);
  assert.equal(turns[1].tokenQuality, "reported");
});

test("Codex avoids attributing pruned or unobserved work to a later turn", () => {
  const turns = collectTurns([
    start(1, "a"), usage(2, "a", 100, 100), finish(3, "a"),
    start(4, "missing"), finish(5, "missing"),
    start(6, "b"), usage(7, "b", 410, 50), usage(8, "b", 420, 10), finish(9, "b"),
    start(10, "c"), usage(11, "c", 470, 20), finish(12, "c"),
  ], "codex", 0);
  assert.equal(turns[1].tokens, null);
  assert.equal(turns[2].tokens?.total, 60);
  assert.equal(turns[3].tokens?.total, 20);
  assert.equal(turns[3].tokenQuality, "lower_bound");
  assert.equal(summarize(turns, false).turnsWithTokens, 3);
});

test("Codex never subtracts across a change of session or an in-turn counter reset", () => {
  const turns = collectTurns([
    start(1, "a"), usage(2, "a", 600, 100), finish(3, "a"),
    start(4, "b"), usage(5, "b", 620, 20), usage(6, "b", 40, 40),
    usage(7, "b", 50, 10), finish(8, "b"),
    start(9, "c"), usage(10, "c", 60, 10, now - 20_000, "session-b"), finish(11, "c"),
  ], "codex", 0);
  assert.equal(turns[1].tokens?.total, 50);
  assert.equal(turns[2].tokens?.total, 10);
  assert.ok(turns.every(turn => turn.tokenQuality === "lower_bound"));
});

test("resume snapshots, fork ancestry and explicit nested turns do not count as independent usage", () => {
  const turns = collectTurns([
    start(1, "inherited", now - 500_000), finish(2, "inherited", now - 450_000),
    usage(3, null, 1000, 100), start(4, "root"), start(5, "nested", now - 59_000, "tool-id"),
    usage(6, "nested", 20, 20), finish(7, "nested"), usage(8, "root", 1020, 20), finish(9, "root"),
  ], "codex", now - 100_000);
  assert.deepEqual(turns.map(turn => turn.id), ["root"]);
  assert.equal(turns[0].tokens?.total, 20);
});

test("missing outcomes, optional cache values and zero remain distinct in output", () => {
  const metric = usage(2, "a", 0, 0);
  delete metric.data.tokenUsage.last.cacheWriteInputTokens;
  const turns = collectTurns([start(1, "a"), metric, start(3, "b")], "claude-code", 0);
  const metrics = summarize(turns, true);
  assert.equal(metrics.tokens?.total, 0);
  assert.equal(metrics.tokens?.cacheWrite, null);
  assert.equal(metrics.processingMs, null);
  assert.equal(metrics.turnsWithTokens, 1);
  assert.equal(metrics.turnsWithDuration, 0);
  assert.equal(metrics.readLimited, true);
  const values = buckets(turns, { from: now - 86_400_000, to: now });
  assert.deepEqual(values, [...Array(11).fill(null), 0]);
});

test("stored snapshots are allowlisted", () => {
  const metric = usage(1, "fixture", 30, 20);
  Object.assign(metric.data, { fixtureOnly: "drop" });
  Object.assign(metric.data.tokenUsage.last, { fixtureOnly: "drop" });
  assert.doesNotMatch(JSON.stringify(sanitizeMetric(metric)), /fixtureOnly/);
});
