import { test } from "node:test";
import assert from "node:assert/strict";
import { CONTINUE_NUDGE, DEFAULTS, GOAL_NUDGE, SETTING_DEFAULTS, configFrom, evaluate, isSettingKey, latestGoal, newWatch, parseSettingValue, shouldEnroll, type Snapshot, type Watch } from "./policy.ts";

const T0 = 1_000_000_000;
const MIN = 60_000;
const watch = (over: Partial<Watch> = {}): Watch => ({ ...newWatch("thr_child", "thr_parent", "supervise", T0), ...over });
const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  now: T0 + 3 * MIN,
  exists: true,
  archived: false,
  title: "Задача",
  status: "active",
  goal: null,
  pendingInteractionIds: [],
  queuedCount: 0,
  firstTurnStartedAt: T0,
  lastEventAt: T0 + 3 * MIN - 5_000,
  lastEventSeq: 40,
  ...over,
});
const active = { status: "active", objective: "Сделать отчёт" } as const;

test("a running child without a Goal after the grace period is nudged to call create_goal", () => {
  const { decision } = evaluate(watch(), snap());
  assert.equal(decision.kind, "nudge");
  assert.equal(decision.kind === "nudge" && decision.text, GOAL_NUDGE);
});

test("a fresh child gets time to set its own Goal", () => {
  assert.equal(evaluate(watch(), snap({ now: T0 + 30_000 })).decision.kind, "wait");
});

test("a child working on an active Goal is left alone", () => {
  assert.deepEqual(evaluate(watch(), snap({ goal: active })).decision, { kind: "wait", summary: "работает по цели" });
});

test("a completed Goal on an idle thread ends supervision silently", () => {
  assert.equal(evaluate(watch(), snap({ status: "idle", goal: { ...active, status: "complete" } })).decision.kind, "finish");
});

test("an idle thread with an active Goal is nudged only on the second look", () => {
  const first = evaluate(watch(), snap({ status: "idle", goal: active }));
  assert.equal(first.decision.kind, "wait");
  assert.equal(first.idleActiveSince, T0 + 3 * MIN);
  const second = evaluate(watch({ idleActiveSince: first.idleActiveSince }), snap({ status: "idle", goal: active, now: T0 + 8 * MIN }));
  assert.equal(second.decision.kind, "nudge");
  assert.equal(second.decision.kind === "nudge" && second.decision.text, CONTINUE_NUDGE);
});

test("a pending question goes to the parent once", () => {
  const s = snap({ goal: active, pendingInteractionIds: ["int_1"] });
  const first = evaluate(watch(), s).decision;
  assert.equal(first.kind, "alert");
  assert.equal(first.kind === "alert" && first.key, "interaction:int_1");
  assert.equal(evaluate(watch({ alerts: ["interaction:int_1"] }), s).decision.kind, "wait");
});

test("a long silence while running is reported as a possible hang, not nudged", () => {
  const d = evaluate(watch(), snap({ goal: active, now: T0 + 30 * MIN, lastEventAt: T0 + 10 * MIN })).decision;
  assert.equal(d.kind, "alert");
  assert.match(d.kind === "alert" ? d.text : "", /20 мин/);
});

test("blocked, paused and limited Goals are reported to the parent with the resume command", () => {
  for (const status of ["blocked", "paused", "budgetLimited"] as const) {
    const d = evaluate(watch(), snap({ status: "idle", goal: { ...active, status } })).decision;
    assert.equal(d.kind, "alert", status);
    assert.match(d.kind === "alert" ? d.text : "", /codex-watch resume-goal thr_child/);
  }
  assert.equal(evaluate(watch(), snap({ status: "idle", goal: { ...active, status: "usageLimited" }, queuedCount: 1 })).decision.kind, "wait");
});

test("nudges stop at the limit and the parent is told once", () => {
  const w = watch({ nudges: DEFAULTS.maxNudges, lastNudgeAt: T0 });
  const d = evaluate(w, snap({ now: T0 + 20 * MIN, lastEventAt: T0 + 20 * MIN })).decision;
  assert.equal(d.kind, "alert");
  assert.equal(d.kind === "alert" && d.key, "nudge-limit");
  assert.equal(evaluate({ ...w, alerts: ["nudge-limit"] }, snap({ now: T0 + 25 * MIN, lastEventAt: T0 + 25 * MIN })).decision.kind, "wait");
});

test("a recent nudge is not repeated before the cooldown", () => {
  assert.equal(evaluate(watch({ nudges: 1, lastNudgeAt: T0 + 2 * MIN }), snap()).decision.kind, "wait");
});

test("observe mode never nudges", () => {
  const d = evaluate(watch({ mode: "observe" }), snap()).decision;
  assert.equal(d.kind, "wait");
  assert.match(d.summary, /без вмешательства/);
});

test("an idle thread that never got a Goal is reported once, then supervision ends", () => {
  const s = snap({ status: "idle" });
  assert.equal(evaluate(watch(), s).decision.kind, "alert");
  assert.equal(evaluate(watch({ alerts: ["idle-without-goal"] }), s).decision.kind, "finish");
});

test("an error with a queued retry waits; without one the parent is told", () => {
  assert.equal(evaluate(watch(), snap({ status: "error", queuedCount: 1 })).decision.kind, "wait");
  assert.equal(evaluate(watch(), snap({ status: "error" })).decision.kind, "alert");
});

test("archived or deleted threads and old watches end supervision", () => {
  assert.equal(evaluate(watch(), snap({ archived: true })).decision.kind, "finish");
  assert.equal(evaluate(watch(), snap({ exists: false })).decision.kind, "finish");
  assert.equal(evaluate(watch(), snap({ now: T0 + DEFAULTS.maxWatchMs })).decision.kind, "finish");
});

test("only visible delegated Codex threads created after the start are enrolled", () => {
  const base = { providerId: "codex", parentThreadId: "thr_p", visibility: "visible", createdAt: T0 + 1, archivedAt: null };
  assert.equal(shouldEnroll(base, T0), true);
  assert.equal(shouldEnroll({ ...base, providerId: "claude-code" }, T0), false);
  assert.equal(shouldEnroll({ ...base, parentThreadId: null }, T0), false);
  assert.equal(shouldEnroll({ ...base, visibility: "hidden" }, T0), false);
  assert.equal(shouldEnroll({ ...base, createdAt: T0 - 1 }, T0), false);
});

test("the Goal is read from the newest provider-codex/goal extension state", () => {
  const goal = (status: string, kind = "provider-codex/goal") => ({ type: "thread/extensionState/updated", data: { kind, payload: { objective: "x", status } } });
  assert.deepEqual(latestGoal([goal("complete"), goal("active")]), { status: "complete", objective: "x" });
  assert.deepEqual(latestGoal([goal("active", "bb/provider-model-catalog"), goal("blocked")]), { status: "blocked", objective: "x" });
  assert.equal(latestGoal([{ type: "thread/goal/cleared", data: {} }, goal("active")]), null);
  assert.equal(latestGoal([{ type: "thread/extensionState/updated", data: { kind: "provider-codex/goal", payload: null } }]), null);
  assert.equal(latestGoal([]), null);
});

test("settings defaults reproduce the built-in policy", () => {
  const cfg = configFrom(SETTING_DEFAULTS);
  assert.equal(cfg.intervalMs, 5 * MIN);
  assert.equal(cfg.maxNudges, 3);
  assert.equal(cfg.checkGoal, true);
  assert.equal(cfg.idleNudgeMs, DEFAULTS.idleNudgeMs);
  assert.equal(cfg.nudgeCooldownMs, DEFAULTS.nudgeCooldownMs);
});

test("the interval setting drives check timing", () => {
  const cfg = configFrom({ ...SETTING_DEFAULTS, intervalMinutes: 1 });
  assert.equal(cfg.intervalMs, MIN);
  assert.equal(cfg.firstCheckMs, MIN);
  assert.equal(cfg.idleNudgeMs, MIN);
  const ten = configFrom({ ...SETTING_DEFAULTS, intervalMinutes: 10 });
  assert.equal(ten.idleNudgeMs, 9 * MIN);
  assert.equal(ten.firstCheckMs, DEFAULTS.firstCheckMs);
});

test("with goal checking off a goal-less child is neither nudged nor reported", () => {
  const cfg = configFrom({ ...SETTING_DEFAULTS, checkGoal: false });
  assert.equal(evaluate(watch(), snap(), cfg).decision.kind, "wait");
  assert.equal(evaluate(watch(), snap({ status: "idle" }), cfg).decision.kind, "finish");
  assert.equal(evaluate(watch(), snap({ now: T0 + 30 * MIN, lastEventAt: T0 + 10 * MIN }), cfg).decision.kind, "alert");
});

test("maxNudges = 0 never nudges and tells the parent once", () => {
  const cfg = configFrom({ ...SETTING_DEFAULTS, maxNudges: 0 });
  const d = evaluate(watch(), snap(), cfg).decision;
  assert.equal(d.kind, "alert");
  assert.match(d.kind === "alert" ? d.text : "", /выключено настройкой/);
});

test("CLI values are parsed strictly", () => {
  assert.equal(parseSettingValue("enabled", "off"), false);
  assert.equal(parseSettingValue("enabled", "TRUE"), true);
  assert.equal(parseSettingValue("defaultMode", "observe"), "observe");
  assert.equal(parseSettingValue("intervalMinutes", "15"), 15);
  assert.equal(parseSettingValue("maxNudges", "0"), 0);
  assert.throws(() => parseSettingValue("intervalMinutes", "0"));
  assert.throws(() => parseSettingValue("intervalMinutes", "2.5"));
  assert.throws(() => parseSettingValue("maxNudges", "11"));
  assert.throws(() => parseSettingValue("defaultMode", "loud"));
  assert.throws(() => parseSettingValue("checkGoal", "maybe"));
  assert.equal(isSettingKey("maxNudges"), true);
  assert.equal(isSettingKey("toString"), false);
});
