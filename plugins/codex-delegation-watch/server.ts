import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { PluginCliError, cliCommand, defineCli } from "@get-bb/plugin-sdk";
import { DEFAULTS, evaluate, latestGoal, newWatch, shouldEnroll, type Snapshot, type Watch } from "./policy.ts";

const WATCH = "watch:";
const SINCE = "meta:since";
const TICK_MS = 30_000;

type Obj = Record<string, unknown>;
const obj = (value: unknown): Obj => (typeof value === "object" && value !== null ? (value as Obj) : {});
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" && value !== "" && Number.isFinite(Number(value)) ? Number(value) : null);
const errText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export default function codexDelegationWatch(bb: BbPluginApi) {
  const kv = bb.storage.kv;
  const sdk = () => bb.sdk as unknown as {
    threads: {
      get(a: Obj): Promise<unknown>;
      list(a: Obj): Promise<unknown>;
      send(a: Obj): Promise<unknown>;
      events: { list(a: Obj): Promise<unknown> };
      interactions: { list(a: Obj): Promise<unknown> };
      queuedMessages: { list(a: Obj): Promise<unknown> };
    };
  };
  const busy = new Set<string>();

  const since = async (): Promise<number> => {
    const stored = num(await kv.get(SINCE));
    if (stored !== null) return stored;
    const now = Date.now();
    await kv.set(SINCE, now);
    return now;
  };
  const load = async (threadId: string) => (await kv.get(WATCH + threadId)) as Watch | null | undefined;
  const save = (w: Watch) => kv.set(WATCH + w.threadId, w);

  const getThread = async (threadId: string): Promise<Obj | null> => {
    try {
      const result = obj(await sdk().threads.get({ threadId }));
      return "thread" in result ? obj(result.thread) : result;
    } catch (error) {
      if (/not.?found|404/i.test(errText(error))) return null;
      throw error;
    }
  };

  const enroll = async (thread: Obj, mode: Watch["mode"], force: boolean): Promise<Watch | null> => {
    const id = str(thread.id);
    if (id === null) return null;
    const existing = await load(id);
    if (existing && (!existing.done || !force)) return force ? existing : null;
    if (!force) {
      // Event payloads can be stale or partial: decide on the stored thread row.
      if (!shouldEnroll(thread, await since())) return null;
      const fresh = await getThread(id);
      if (fresh === null || !shouldEnroll(fresh, await since())) return null;
      thread = fresh;
    }
    const parent = str(thread.parentThreadId);
    // Without a parent there is nobody to report to, so never write into the thread.
    const w = newWatch(id, parent, parent === null ? "observe" : mode, Date.now());
    await save(w);
    bb.log.info(`watching ${id} (${w.mode}) parent=${parent} createdAt=${String(thread.createdAt)}`);
    return w;
  };

  const snapshot = async (threadId: string): Promise<Snapshot> => {
    const now = Date.now();
    const t = await getThread(threadId);
    if (t === null || t.deletedAt) {
      return { now, exists: false, archived: false, title: threadId, status: "deleted", goal: null, pendingInteractionIds: [], queuedCount: 0, firstTurnStartedAt: null, lastEventAt: null, lastEventSeq: null };
    }
    const list = (a: Obj) => sdk().threads.events.list({ threadId, ...a }).then((rows) => (Array.isArray(rows) ? rows : []));
    const [goalRows, lastRows, firstRows, interactions, queued] = await Promise.all([
      list({ types: ["thread/extensionState/updated", "thread/goal/updated", "thread/goal/cleared"], order: "desc", limit: "50" }),
      list({ order: "desc", limit: "1" }),
      list({ types: ["turn/started"], order: "asc", limit: "1" }),
      sdk().threads.interactions.list({ threadId }).catch(() => []),
      sdk().threads.queuedMessages.list({ threadId }).catch(() => []),
    ]);
    const pending = (Array.isArray(interactions) ? interactions : []).map((i) => str(obj(i).id)).filter((id): id is string => id !== null);
    const queuedRows = Array.isArray(queued) ? queued : Array.isArray(obj(queued).messages) ? (obj(queued).messages as unknown[]) : [];
    const last = obj(lastRows[0]);
    const runtime = obj(t.runtime);
    return {
      now,
      exists: true,
      archived: t.archivedAt !== null && t.archivedAt !== undefined,
      title: str(t.title) ?? str(t.titleFallback) ?? threadId,
      status: str(t.status) ?? str(runtime.displayStatus) ?? "unknown",
      goal: latestGoal(goalRows),
      pendingInteractionIds: pending,
      queuedCount: queuedRows.length,
      firstTurnStartedAt: num(obj(firstRows[0]).createdAt),
      lastEventAt: num(last.createdAt),
      lastEventSeq: num(last.seq),
    };
  };

  const sendText = (threadId: string, text: string) =>
    sdk().threads.send({ threadId, mode: "auto", input: [{ type: "text", text }] });

  const notifyParent = async (w: Watch, text: string): Promise<boolean> => {
    if (w.parentThreadId === null) {
      bb.log.warn(`no parent for ${w.threadId}: ${text}`);
      return false;
    }
    const parent = await getThread(w.parentThreadId);
    if (parent === null || parent.archivedAt) {
      bb.log.warn(`parent ${w.parentThreadId} of ${w.threadId} is gone: ${text}`);
      return false;
    }
    await sendText(w.parentThreadId, `[Надзор Codex] ${text}`);
    return true;
  };

  /** One check. `act: false` only reports what would happen. */
  const check = async (watch: Watch, act: boolean) => {
    let w = watch;
    const s = await snapshot(w.threadId);
    // The parent can change or be removed after enrollment; follow the current row.
    const row = s.exists ? await getThread(w.threadId) : null;
    const parent = row === null ? w.parentThreadId : str(row.parentThreadId);
    if (parent !== w.parentThreadId) w = { ...w, parentThreadId: parent, mode: parent === null ? "observe" : w.mode };
    const { decision, idleActiveSince } = evaluate(w, s, DEFAULTS);
    if (!act) return { snapshot: s, decision };
    const next: Watch = { ...w, idleActiveSince, lastCheckAt: s.now, lastSummary: decision.summary, nextCheckAt: s.now + DEFAULTS.intervalMs };
    switch (decision.kind) {
      case "finish":
        next.done = true;
        next.doneReason = decision.reason;
        break;
      case "nudge":
        await sendText(w.threadId, decision.text);
        next.nudges += 1;
        next.lastNudgeAt = s.now;
        next.lastSummary = `${decision.summary} → подтолкнул (${next.nudges}/${DEFAULTS.maxNudges})`;
        if (decision.key === "goal") next.nextCheckAt = s.now + DEFAULTS.firstCheckMs;
        break;
      case "alert":
        if (w.mode === "supervise") await notifyParent(w, decision.text);
        next.alerts = [...w.alerts, decision.key];
        if (decision.key === "idle-without-goal") {
          next.done = true;
          next.doneReason = "ход закончен без цели";
        }
        if (decision.key === "nudge-limit") next.mode = "observe";
        break;
      case "wait":
        break;
    }
    await save(next);
    bb.log.info(`${w.threadId}: ${next.lastSummary}`);
    return { snapshot: s, decision };
  };

  const runCheck = async (threadId: string, why: string) => {
    if (busy.has(threadId)) return;
    busy.add(threadId);
    try {
      const w = await load(threadId);
      if (w && !w.done) await check(w, true);
    } catch (error) {
      bb.log.warn(`check ${threadId} after ${why} failed: ${errText(error)}`);
    } finally {
      busy.delete(threadId);
    }
  };

  const allWatches = async (): Promise<Watch[]> => {
    const keys = await kv.list(WATCH);
    const values = await Promise.all(keys.map((key) => kv.get(key)));
    return values.filter((w): w is Watch => typeof obj(w).threadId === "string") as Watch[];
  };

  const reconcile = async () => {
    const cutoff = await since();
    const result: unknown = await sdk().threads.list({ hasParent: true, limit: 200 });
    const threads = Array.isArray(result) ? result : Array.isArray(obj(result).threads) ? (obj(result).threads as unknown[]) : [];
    for (const t of threads) {
      if (shouldEnroll(obj(t), cutoff)) await enroll(obj(t), "supervise", false);
    }
  };

  // Lifecycle: enroll new delegated Codex threads and re-check soon after notable changes.
  const onThread = (why: string, recheckMs: number | null) => ({ thread }: { thread: unknown }) => {
    void (async () => {
      const t = obj(thread);
      const id = str(t.id);
      if (id === null) return;
      await enroll(t, "supervise", false);
      if (recheckMs === null) return;
      const w = await load(id);
      if (w && !w.done) {
        const at = Date.now() + recheckMs;
        if (at < w.nextCheckAt) await save({ ...w, nextCheckAt: at });
      }
    })().catch((error: unknown) => bb.log.warn(`${why} handler failed: ${errText(error)}`));
  };
  bb.events.on("thread.created", onThread("thread.created", null));
  bb.events.on("thread.active", onThread("thread.active", null));
  bb.events.on("thread.idle", onThread("thread.idle", 10_000));
  bb.events.on("thread.failed", onThread("thread.failed", 10_000));
  for (const event of ["thread.archived", "thread.deleted"] as const) {
    bb.events.on(event, ({ thread }) => {
      const id = str(obj(thread).id);
      if (id !== null) void runCheck(id, event);
    });
  }
  bb.events.on("interaction.pending", ({ thread }) => {
    const id = str(obj(thread).id);
    if (id !== null) void runCheck(id, "interaction.pending");
  });

  bb.background.service("supervisor", {
    async start(signal: AbortSignal) {
      await reconcile().catch((error: unknown) => bb.log.warn(`reconcile failed: ${errText(error)}`));
      while (!signal.aborted) {
        try {
          const now = Date.now();
          for (const w of await allWatches()) {
            if (signal.aborted) break;
            if (!w.done && w.nextCheckAt <= now) await runCheck(w.threadId, "schedule");
          }
        } catch (error) {
          bb.log.warn(`tick failed: ${errText(error)}`);
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, TICK_MS);
          signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
        });
      }
    },
  });

  const line = (w: Watch) =>
    `${w.threadId}  ${w.done ? `снято (${w.doneReason})` : w.mode === "observe" ? "наблюдение" : "надзор"}  подталкиваний ${w.nudges}/${DEFAULTS.maxNudges}  ${w.lastSummary ?? "ещё не проверялся"}`;
  const threadArg = { name: "thread", description: "ID треда Codex", required: true } as const;

  bb.cli.register(
    defineCli({
      name: "codex-watch",
      summary: "Надзор за делегированными тредами Codex: цель поставлена, работа идёт, проблемы доходят до родителя",
      commands: {
        status: cliCommand({
          summary: "Список тредов под надзором и итог последней проверки",
          options: { all: { type: "boolean", description: "Показать и снятые с надзора" }, json: { type: "boolean", description: "JSON" } },
          async run(input) {
            const list = (await allWatches()).filter((w) => input.options.all || !w.done).sort((a, b) => b.enrolledAt - a.enrolledAt);
            if (input.options.json) return { exitCode: 0, stdout: JSON.stringify(list, null, 2) };
            return { exitCode: 0, stdout: list.length ? list.map(line).join("\n") : "Под надзором нет тредов." };
          },
        }),
        check: cliCommand({
          summary: "Проверить тред сейчас без действий: цель, статус, что сделал бы надзор",
          positionals: [threadArg],
          options: { json: { type: "boolean", description: "JSON" } },
          async run(input) {
            const id = input.positionals.thread;
            const w = (await load(id)) ?? newWatch(id, null, "observe", Date.now());
            const { snapshot: s, decision } = await check({ ...w, done: false }, false);
            if (input.options.json) return { exitCode: 0, stdout: JSON.stringify({ watch: w, snapshot: s, decision }, null, 2) };
            const goal = s.goal ? `${s.goal.status} — ${s.goal.objective}` : "не поставлена";
            const idle = s.lastEventAt ? `${Math.round((s.now - s.lastEventAt) / 1000)} с назад` : "нет";
            return {
              exitCode: 0,
              stdout: [`Тред: ${s.title} (${id})`, `Статус: ${s.status}`, `Цель: ${goal}`, `Последнее событие: ${idle}`, `Вопросы/разрешения: ${s.pendingInteractionIds.length}`, `В очереди: ${s.queuedCount}`, `Надзор: ${(await load(id)) ? line(w) : "не подключён"}`, `Решение сейчас: ${decision.kind} — ${decision.summary}`].join("\n"),
            };
          },
        }),
        add: cliCommand({
          summary: "Поставить существующий тред Codex под надзор (по умолчанию новые дочерние треды подключаются сами)",
          positionals: [threadArg],
          options: { observe: { type: "boolean", description: "Только наблюдать: не писать ребёнку и родителю" } },
          async run(input) {
            const t = await getThread(input.positionals.thread);
            if (t === null) throw new PluginCliError(`тред ${input.positionals.thread} не найден`, { code: "thread_not_found" });
            if (t.providerId !== "codex") throw new PluginCliError("надзор рассчитан на треды Codex", { code: "not_codex" });
            const w = await enroll(t, input.options.observe ? "observe" : "supervise", true);
            return { exitCode: 0, stdout: w ? line(w) : "не подключён" };
          },
        }),
        remove: cliCommand({
          summary: "Снять тред с надзора",
          positionals: [threadArg],
          async run(input) {
            const w = await load(input.positionals.thread);
            if (!w) return { exitCode: 0, stdout: "Тред не был под надзором." };
            await save({ ...w, done: true, doneReason: "снят вручную" });
            return { exitCode: 0, stdout: "Снят с надзора." };
          },
        }),
        "resume-goal": cliCommand({
          summary: "Возобновить цель остановленного треда Codex командой /goal resume (только когда тред не работает)",
          positionals: [threadArg],
          async run(input) {
            const id = input.positionals.thread;
            const s = await snapshot(id);
            if (!s.exists) throw new PluginCliError("тред не найден", { code: "thread_not_found" });
            if (s.status !== "idle" && s.status !== "error") throw new PluginCliError(`тред сейчас ${s.status}; /goal resume выполняется только в начале хода`, { code: "thread_busy", hint: "Дождитесь окончания хода." });
            if (s.goal === null) throw new PluginCliError("у треда нет цели", { code: "no_goal" });
            if (s.goal.status === "active" || s.goal.status === "complete") return { exitCode: 0, stdout: `Цель уже ${s.goal.status}.` };
            await sendText(id, "/goal resume");
            const w = await load(id);
            if (w) await save({ ...w, done: false, alerts: w.alerts.filter((k) => !k.startsWith("goal:")), nextCheckAt: Date.now() + DEFAULTS.firstCheckMs });
            return { exitCode: 0, stdout: "Отправил /goal resume. Проверьте через минуту: bb codex-watch check " + id };
          },
        }),
      },
    }),
  );
}
