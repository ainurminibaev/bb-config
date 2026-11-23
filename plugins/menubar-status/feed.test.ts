import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildFeed, chatFromEvents, descendantsFrom, describeActivity, keepRecent, machineNamesFrom, oneLine, sameContent, stateOf,
  statusFile, THREAD_PAGE, type FeedThread,
} from "./feed.ts";

const thread = (over: Partial<FeedThread>): FeedThread => ({
  id: "t", projectId: "p", title: "T", status: "idle", updatedAt: 1, ...over,
});

test("state: pending beats running, unread needs newer attention", () => {
  assert.equal(stateOf(thread({ status: "active", hasPendingInteraction: true })), "needs");
  assert.equal(stateOf(thread({ status: "active" })), "running");
  assert.equal(stateOf(thread({ latestAttentionAt: 5, lastReadAt: 3 })), "unread");
  assert.equal(stateOf(thread({ latestAttentionAt: 5, lastReadAt: 9 })), "idle");
});

test("feed: needs first, subagents folded into their parent, capped", () => {
  const feed = buildFeed({
    threads: [
      thread({ id: "old", updatedAt: 1 }),
      thread({ id: "run", status: "active", updatedAt: 2 }),
      thread({ id: "ask", hasPendingInteraction: true, updatedAt: 0 }),
      thread({ id: "child", parentThreadId: "run", status: "active", updatedAt: 9 }),
    ],
    projectNames: new Map([["p", "proj"]]), machineNames: new Map([["ask", "Mac"]]),
    snippets: { ask: "hi" }, webUrl: "https://x.example/", maxItems: 2, now: 7,
  });
  assert.deepEqual(feed.items.map((item) => item.id), ["ask", "run"]);
  assert.deepEqual(feed.counts, { needs: 1, running: 1, unread: 0, error: 0 });
  assert.equal(feed.items[0]!.url, "https://x.example/projects/p/threads/ask");
  assert.equal(sameContent(feed, { ...feed, generatedAt: 99 }), true);
});

test("oneLine flattens markdown and cuts at a word", () => {
  assert.equal(oneLine("**Done.**\n\n- a\n- b"), "Done. - a - b");
  assert.ok(oneLine("word ".repeat(60), 40).endsWith("…"));
});

const feedOf = (threads: FeedThread[], activities: Record<string, string> = {}) => buildFeed({
  threads, projectNames: new Map(), machineNames: new Map(), snippets: {}, activities,
  webUrl: "", maxItems: 20, now: 1,
});

test("subagents: an idle parent with a working subagent is working", () => {
  const feed = feedOf([
    thread({ id: "p" }),
    thread({ id: "c", parentThreadId: "p", status: "active" }),
  ], { c: "Команда: npm test" });
  assert.deepEqual(feed.items.map((i) => [i.id, i.state, i.activity]), [["p", "running", "Субагент: Команда: npm test"]]);
  assert.deepEqual(feed.counts, { needs: 0, running: 1, unread: 0, error: 0 });
});

test("subagents: the parent's own step wins over a subagent's", () => {
  const feed = feedOf([
    thread({ id: "c", parentThreadId: "p", status: "active" }),
    thread({ id: "p", status: "active" }),
  ], { p: "Думает", c: "Читает a.ts" });
  assert.equal(feed.items[0]!.activity, "Думает");
});

test("subagents: a subagent waiting for you makes the parent wait", () => {
  const feed = feedOf([
    thread({ id: "p", status: "active" }),
    thread({ id: "c", parentThreadId: "p", hasPendingInteraction: true }),
  ]);
  assert.deepEqual(feed.items.map((i) => [i.id, i.state]), [["p", "needs"]]);
  assert.deepEqual(feed.counts, { needs: 1, running: 0, unread: 0, error: 0 });
});

test("subagents: a subagent's error or unread reply does not relabel the parent", () => {
  const feed = feedOf([
    thread({ id: "p" }),
    thread({ id: "c1", parentThreadId: "p", status: "error" }),
    thread({ id: "c2", parentThreadId: "p", latestAttentionAt: 5 }),
  ]);
  assert.deepEqual(feed.items.map((i) => [i.id, i.state]), [["p", "idle"]]);
});

test("subagents: nested and orphaned subagents", () => {
  const nested = feedOf([
    thread({ id: "p", latestAttentionAt: 5 }),
    thread({ id: "c", parentThreadId: "p" }),
    thread({ id: "g", parentThreadId: "c", status: "active" }),
  ], { g: "Думает" });
  assert.deepEqual(nested.items.map((i) => [i.id, i.state, i.activity]), [["p", "running", "Субагент: Думает"]]);
  // Parent archived or outside the list: the subagent stands on its own.
  const orphan = feedOf([thread({ id: "c", parentThreadId: "gone", status: "active" })], { c: "Думает" });
  assert.deepEqual(orphan.items.map((i) => [i.id, i.state, i.activity]), [["c", "running", "Думает"]]);
});

test("activity: short descriptions of the current step", () => {
  assert.equal(describeActivity({ type: "commandExecution", command: "/bin/bash -lc 'npm test'" }), "Команда: npm test");
  assert.equal(describeActivity({ type: "commandExecution", command: "ls", description: "List files" }), "List files");
  assert.equal(describeActivity({ type: "fileRead", path: "/a/b/c.ts" }), "Читает c.ts");
  assert.equal(describeActivity({ type: "fileChange", changes: [{ path: "/x/a.ts" }, { path: "/x/b.ts" }, { path: "/x/c.ts" }] }), "Правит a.ts, b.ts…");
  assert.equal(describeActivity({ type: "reasoning" }), "Думает");
  assert.equal(describeActivity({ type: "toolCall", tool: "ctx_search" }), "Инструмент ctx_search");
  assert.equal(describeActivity({ type: "mystery", presentation: { label: { pending: "Doing X" } } }), "Doing X");
  assert.equal(describeActivity(null), "");
});

test("chat: user, other-thread and agent messages, tool steps skipped", () => {
  const messages = chatFromEvents([
    { type: "client/turn/requested", createdAt: 1, data: { initiator: "user", input: [{ type: "text", text: "Привет" }, { type: "image" }] } },
    { type: "item/completed", createdAt: 2, data: { item: { type: "commandExecution", text: "ignored" } } },
    { type: "item/completed", createdAt: 3, data: { item: { type: "agentMessage", text: " Готово " } } },
    { type: "client/turn/requested", createdAt: "1970-01-01T00:00:00.004Z", data: { initiator: "agent", senderThreadId: "thr_x", input: [{ type: "text", text: "от соседа" }] } },
    { type: "client/turn/requested", createdAt: 5, data: { input: [{ type: "image" }] } },
    { type: "item/completed", createdAt: 6, data: { item: { type: "agentMessage", text: "   " } } },
  ]);
  assert.deepEqual(messages, [
    { role: "user", text: "Привет", at: 1 },
    { role: "agent", text: "Готово", at: 3 },
    { role: "thread", text: "от соседа", at: 4 },
  ]);
  const many = chatFromEvents(Array.from({ length: 50 }, (_, i) => ({ type: "item/completed", createdAt: i, data: { item: { type: "agentMessage", text: `m${i}` } } })), 40);
  assert.equal(many.length, 40);
  assert.equal(many.at(-1)!.text, "m49");
});

test("titles: bb's fallback title, then a Russian placeholder", () => {
  const feed = feedOf([
    thread({ id: "a", title: null, titleFallback: "Первое сообщение", updatedAt: 2 }),
    thread({ id: "b", title: null, updatedAt: 1 }),
  ]);
  assert.deepEqual(feed.items.map((i) => i.title), ["Первое сообщение", "Без названия"]);
});

test("the status file may be a POSIX path or a Windows drive path", () => {
  assert.equal(statusFile("/Users/example/Library/Application Support/bb-menubar/status.json"), "/Users/example/Library/Application Support/bb-menubar/status.json");
  assert.equal(statusFile("C:\\Users\\example\\AppData\\Local\\bb-menubar\\status.json"), "C:/Users/example/AppData/Local/bb-menubar/status.json");
  assert.equal(statusFile(" d:/bb/status.json "), "d:/bb/status.json");
  assert.equal(statusFile("status.json"), null);
  assert.equal(statusFile(""), null);
});

test("a backslash in a POSIX status path is part of the name", () => {
  assert.equal(statusFile("/Users/example/odd\\name/status.json"), "/Users/example/odd\\name/status.json");
});

test("keepRecent: keeps the events behind the last N messages, same chat", () => {
  const ev = (seq: number, kind: "user" | "agent" | "tool") => ({
    seq, createdAt: seq,
    type: kind === "user" ? "client/turn/requested" : "item/completed",
    data: kind === "user" ? { input: [{ type: "text", text: `u${seq}` }] }
      : { item: { type: kind === "agent" ? "agentMessage" : "commandExecution", text: `a${seq}` } },
  });
  const events = Array.from({ length: 120 }, (_, i) => ev(i, i % 3 === 0 ? "user" : i % 3 === 1 ? "agent" : "tool"));
  const kept = keepRecent(events, 40);
  assert.deepEqual(chatFromEvents(kept), chatFromEvents(events));
  assert.ok(kept.length < events.length);
  assert.equal(keepRecent(events.slice(0, 5), 40).length, 5);
});

test("descendantsFrom: level by level as the per-parent lists, null on a full page", () => {
  const rows = [
    thread({ id: "root" }), thread({ id: "a", parentThreadId: "root" }), thread({ id: "b", parentThreadId: "root" }),
    thread({ id: "a1", parentThreadId: "a" }), thread({ id: "a11", parentThreadId: "a1" }),
    thread({ id: "a111", parentThreadId: "a11" }), thread({ id: "x", parentThreadId: "other" }),
  ];
  assert.deepEqual(descendantsFrom(rows, "root")!.map((t) => t.id), ["a", "b", "a1", "a11"]);
  assert.deepEqual(descendantsFrom(rows, "none"), []);
  const full = Array.from({ length: THREAD_PAGE }, (_, i) => thread({ id: `t${i}` }));
  assert.equal(descendantsFrom(full, "t0"), null);
});

test("machineNamesFrom: persistent machines from the row, null without the field", () => {
  const hosts = [{ id: "h1", name: "Tru", type: "persistent" }, { id: "h2", name: "cloud", type: "ephemeral" }];
  const names = machineNamesFrom([
    thread({ id: "t1", environmentHostId: "h1" }), thread({ id: "t2", environmentHostId: "h2" }),
    thread({ id: "t3", environmentHostId: null }),
  ], hosts)!;
  assert.deepEqual([...names], [["t1", "Tru"]]);
  assert.equal(machineNamesFrom([thread({ id: "t1" })], hosts), null);
});
