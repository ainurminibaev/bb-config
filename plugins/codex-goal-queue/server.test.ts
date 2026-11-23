import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, hasHeldResume, parseGoalCommand, texts } from "./policy.ts";

const en = texts("en");

const text = (value: string) => ({ blocks: [{ type: "text" }], text: value });
const running = (value: string, providerId = "codex") =>
  decide({ providerId, attempt: "join-turn", fromUser: true, ...text(value) });

test("/goal resume sent into a running Codex turn waits for the turn to end", () => {
  assert.deepEqual(running("/goal resume"), { action: "wait", reason: en.resume });
  assert.deepEqual(running("  /goal   Resume \n"), { action: "wait", reason: en.resume });
});

test("the held command proceeds once it starts a turn, so Codex runs it", () => {
  assert.deepEqual(decide({ providerId: "codex", attempt: "start-turn", fromUser: true, ...text("/goal resume") }), { action: "proceed" });
});

test("/goal pause and /goal clear sent into a running turn are refused with what to do instead", () => {
  assert.deepEqual(running("/goal pause"), { action: "reject", message: en.pause });
  assert.deepEqual(running("/goal clear"), { action: "reject", message: en.clear });
});

test("ordinary messages, natural-language requests and other /goal text are never held", () => {
  for (const value of ["Возобнови цель", "/goal resume and fix the tests", "/goal ship the release", "/goal", "resume", "", "/goalresume", "/GOAL resume"]) {
    assert.deepEqual(running(value), { action: "proceed" }, value);
  }
});

test("other providers and messages with attachments are left alone", () => {
  assert.deepEqual(running("/goal resume", "claude-code"), { action: "proceed" });
  assert.equal(parseGoalCommand([{ type: "text" }, { type: "image" }], "/goal resume"), null);
  assert.deepEqual(
    decide({ providerId: "codex", attempt: "join-turn", fromUser: true, blocks: [{ type: "image" }], text: "/goal resume" }),
    { action: "proceed" },
  );
});

test("a message from another thread is never held: bb prefixes it, so Codex would not run it anyway", () => {
  assert.deepEqual(
    decide({ providerId: "codex", attempt: "join-turn", fromUser: false, ...text("/goal resume") }),
    { action: "proceed" },
  );
});

test("a repeat is recognised only by a resume this plugin is already holding", () => {
  const row = (waitingOn: unknown, value: string) => ({ waitingOn, content: [{ type: "text", text: value, mentions: [] }] });
  const held = { kind: "plugin", pluginId: "codex-goal-queue", reason: "x" };
  assert.equal(hasHeldResume([row(held, "/goal resume")], "codex-goal-queue"), true);
  assert.equal(hasHeldResume([row(held, "fix the tests")], "codex-goal-queue"), false);
  assert.equal(hasHeldResume([row({ kind: "thread-busy" }, "/goal resume")], "codex-goal-queue"), false);
  assert.equal(hasHeldResume([row({ kind: "plugin", pluginId: "other" }, "/goal resume")], "codex-goal-queue"), false);
  for (const rows of [undefined, null, {}, [null, 1, {}]]) assert.equal(hasHeldResume(rows, "codex-goal-queue"), false);
});

test("messages are English by default and Russian when chosen; unknown values fall back to English", () => {
  const ru = texts("ru");
  assert.deepEqual(decide({ providerId: "codex", attempt: "join-turn", fromUser: true, language: "ru", ...text("/goal pause") }), { action: "reject", message: ru.pause });
  assert.deepEqual(decide({ providerId: "codex", attempt: "join-turn", fromUser: true, language: "ru", ...text("/goal resume") }), { action: "wait", reason: ru.resume });
  assert.equal(texts(undefined), en);
  assert.equal(texts("de"), en);
  assert.match(en.pause, /^[\x20-\x7E]+$/u);
});
