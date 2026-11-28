import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { PluginCliError, cliCommand, defineCli } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { rpcContract, type WatchView } from "./contract.ts";
import {
  SETTING_DEFAULTS,
  SETTING_LABELS,
  configFrom,
  evaluate,
  isSettingKey,
  latestGoal,
  newWatch,
  parseSettingValue,
  runsCodex,
  shouldEnroll,
  type Config,
  type Settings,
  type Snapshot,
  type Watch,
} from "./policy.ts";
import { CASCADE_PLUGIN_ID, CASCADE_STATUS_METHOD, isCascadeProvider, passportCache } from "./cascade-passport.ts";

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

  const settings = bb.settings.define({
    enabled: { type: "boolean", label: SETTING_LABELS.enabled, default: SETTING_DEFAULTS.enabled },
    autoEnroll: { type: "boolean", label: SETTING_LABELS.autoEnroll, default: SETTING_DEFAULTS.autoEnroll },
    defaultMode: {
      type: "select",
      label: "Режим по умолчанию",
      options: ["supervise", "observe"],
      experimental_optionLabels: { supervise: "Надзор с подталкиванием", observe: "Только наблюдать и сообщать" },
      default: SETTING_DEFAULTS.defaultMode,
    },
    intervalMinutes: {
      type: "number",
      label: "Интервал проверки, минут",
      experimental_schema: z.number().int().min(1).max(60),
      default: SETTING_DEFAULTS.intervalMinutes,
    },
    maxNudges: {
      type: "number",
      label: "Максимум подталкиваний на тред",
      experimental_schema: z.number().int().min(0).max(10),
      default: SETTING_DEFAULTS.maxNudges,
    },
    checkGoal: { type: "boolean", label: SETTING_LABELS.checkGoal, default: SETTING_DEFAULTS.checkGoal },
  });
  const current = async (): Promise<Settings> => {
    const v = obj(await settings.get());
    return {
      enabled: typeof v.enabled === "boolean" ? v.enabled : SETTING_DEFAULTS.enabled,
      autoEnroll: typeof v.autoEnroll === "boolean" ? v.autoEnroll : SETTING_DEFAULTS.autoEnroll,
      defaultMode: v.defaultMode === "observe" ? "observe" : "supervise",
      intervalMinutes: num(v.intervalMinutes) ?? SETTING_DEFAULTS.intervalMinutes,
      maxNudges: num(v.maxNudges) ?? SETTING_DEFAULTS.maxNudges,
      checkGoal: typeof v.checkGoal === "boolean" ? v.checkGoal : SETTING_DEFAULTS.checkGoal,
    };
  };

  const since = async (): Promise<number> => {
    const stored = num(await kv.get(SINCE));
    if (stored !== null) return stored;
    const now = Date.now();
    await kv.set(SINCE, now);
    return now;
  };
  // Паспорт «Каскада подписок»: только для его тредов. Нет ответа — ступень неизвестна, тред не считается Codex.
  const passportOf = passportCache((threadId, signal) => bb.sdk.plugins.callRpc({
    pluginId: CASCADE_PLUGIN_ID, method: CASCADE_STATUS_METHOD, input: { threadId }, outputSchema: z.unknown(), signal }));
  /** Провайдер текущей ступени каскада; у обычного треда — null без обращений к каскаду. */
  const stepOf = async (t: Obj | null): Promise<string | null> => {
    const id = t ? str(t.id) : null;
    if (!t || id === null || !isCascadeProvider(t.providerId)) return null;
    return (await passportOf({ id, providerId: t.providerId }))?.step?.providerId ?? null;
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

  const enroll = async (thread: Obj, requested: Watch["mode"] | null, force: boolean): Promise<Watch | null> => {
    const id = str(thread.id);
    if (id === null) return null;
    const cur = await current();
    if (!force && (!cur.enabled || !cur.autoEnroll)) return null;
    const mode = requested ?? cur.defaultMode;
    const cfg = configFrom(cur);
    const existing = await load(id);
    if (existing && (!existing.done || !force)) return force ? existing : null;
    if (!force) {
      // Event payloads can be stale or partial: decide on the stored thread row.
      if (!shouldEnroll(thread, await since(), await stepOf(thread))) return null;
      const fresh = await getThread(id);
      if (fresh === null || !shouldEnroll(fresh, await since(), await stepOf(fresh))) return null;
      thread = fresh;
    }
    const parent = str(thread.parentThreadId);
    // Without a parent there is nobody to report to, so never write into the thread.
    const w = newWatch(id, parent, parent === null ? "observe" : mode, Date.now(), cfg);
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
  const check = async (watch: Watch, act: boolean, cfg: Config) => {
    let w = watch;
    const s = await snapshot(w.threadId);
    // The parent can change or be removed after enrollment; follow the current row.
    const row = s.exists ? await getThread(w.threadId) : null;
    const parent = row === null ? w.parentThreadId : str(row.parentThreadId);
    if (parent !== w.parentThreadId) w = { ...w, parentThreadId: parent, mode: parent === null ? "observe" : w.mode };
    const { decision, idleActiveSince } = evaluate(w, s, cfg);
    if (!act) return { snapshot: s, decision };
    const next: Watch = { ...w, idleActiveSince, lastCheckAt: s.now, lastSummary: decision.summary, title: s.title, nextCheckAt: s.now + cfg.intervalMs };
    switch (decision.kind) {
      case "finish":
        next.done = true;
        next.doneReason = decision.reason;
        break;
      case "nudge":
        // Тред каскада ушёл со ступени Codex: подсказки про /goal ему не подходят — только наблюдаем.
        if (isCascadeProvider(row?.providerId) && (await stepOf(row)) !== "codex") {
          next.lastSummary = `${decision.summary} (ступень каскада не Codex — не подталкиваю)`;
          break;
        }
        await sendText(w.threadId, decision.text);
        next.nudges += 1;
        next.lastNudgeAt = s.now;
        next.lastSummary = `${decision.summary} → подтолкнул (${next.nudges}/${cfg.maxNudges})`;
        if (decision.key === "goal") next.nextCheckAt = s.now + cfg.firstCheckMs;
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
      const cur = await current();
      if (!cur.enabled) return;
      const w = await load(threadId);
      if (w && !w.done) await check(w, true, configFrom(cur));
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
      if (shouldEnroll(obj(t), cutoff, await stepOf(obj(t)))) await enroll(obj(t), null, false);
    }
  };

  // Lifecycle: enroll new delegated Codex threads and re-check soon after notable changes.
  const onThread = (why: string, recheckMs: number | null) => ({ thread }: { thread: unknown }) => {
    void (async () => {
      const t = obj(thread);
      const id = str(t.id);
      if (id === null) return;
      await enroll(t, null, false);
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
          const enabled = (await current()).enabled;
          for (const w of enabled ? await allWatches() : []) {
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

  const line = (w: Watch, maxNudges: number) =>
    `${w.threadId}  ${w.done ? `снято (${w.doneReason})` : w.mode === "observe" ? "наблюдение" : "надзор"}  подталкиваний ${w.nudges}/${maxNudges}  ${w.lastSummary ?? "ещё не проверялся"}`;

  const setMode = async (threadId: string, mode: Watch["mode"]) => {
    const w = await load(threadId);
    if (!w) return false;
    if (mode === "supervise" && w.parentThreadId === null) throw new Error("у треда нет родителя: сообщать некому, доступно только наблюдение");
    await save({ ...w, mode, alerts: mode === "supervise" ? w.alerts.filter((k) => k !== "nudge-limit") : w.alerts });
    return true;
  };

  /** "Check now" from the settings screen: acts when supervision is on, otherwise only reports. */
  const checkNow = async (threadId: string): Promise<string> => {
    const cur = await current();
    const w = (await load(threadId)) ?? newWatch(threadId, null, "observe", Date.now());
    const acting = cur.enabled && !w.done && (await load(threadId)) !== undefined && (await load(threadId)) !== null;
    if (acting && busy.has(threadId)) return "проверка уже идёт";
    if (acting) busy.add(threadId);
    try {
      const { decision } = await check({ ...w, done: false }, acting, configFrom(cur));
      return `${decision.summary}${acting ? "" : " (без действий)"}`;
    } finally {
      if (acting) busy.delete(threadId);
    }
  };

  bb.rpc.register(rpcContract, {
    overview: async ({ includeDone }) => {
      const cur = await current();
      const list = (await allWatches()).filter((w) => includeDone || !w.done).sort((a, b) => b.enrolledAt - a.enrolledAt).slice(0, 200);
      const titles = await Promise.all(list.map(async (w) => {
        if (w.title) return w.title;
        const t = await getThread(w.threadId).catch(() => null);
        return (t && (str(t.title) ?? str(t.titleFallback))) ?? w.threadId;
      }));
      const watches: WatchView[] = list.map((w, i) => ({
        threadId: w.threadId,
        title: titles[i],
        mode: w.mode,
        done: w.done,
        doneReason: w.doneReason,
        nudges: w.nudges,
        lastCheckAt: w.lastCheckAt,
        lastSummary: w.lastSummary,
        hasParent: w.parentThreadId !== null,
      }));
      return { enabled: cur.enabled, maxNudges: cur.maxNudges, intervalMinutes: cur.intervalMinutes, watches };
    },
    remove: async ({ threadId }) => {
      const w = await load(threadId);
      if (w) await save({ ...w, done: true, doneReason: "снят вручную" });
      return { ok: Boolean(w) };
    },
    checkNow: async ({ threadId }) => ({ summary: await checkNow(threadId) }),
    setMode: async ({ threadId, mode }) => ({ ok: await setMode(threadId, mode) }),
  });

  // Turning supervision back on starts every open watch afresh instead of acting on stale timers.
  settings.onChange((next: unknown, prev: unknown) => {
    if (obj(next).enabled !== true || obj(prev).enabled !== false) return;
    void (async () => {
      const cfg = configFrom(await current());
      for (const w of await allWatches()) {
        if (!w.done) await save({ ...w, idleActiveSince: null, nextCheckAt: Date.now() + cfg.firstCheckMs });
      }
      await reconcile();
    })().catch((error: unknown) => bb.log.warn(`re-enable failed: ${errText(error)}`));
  });
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
            const cur = await current();
            const list = (await allWatches()).filter((w) => input.options.all || !w.done).sort((a, b) => b.enrolledAt - a.enrolledAt);
            if (input.options.json) return { exitCode: 0, stdout: JSON.stringify(list, null, 2) };
            const head = cur.enabled ? "" : "Надзор выключен (bb codex-watch config set enabled true): треды не проверяются.\n";
            return { exitCode: 0, stdout: head + (list.length ? list.map((w) => line(w, cur.maxNudges)).join("\n") : "Под надзором нет тредов.") };
          },
        }),
        check: cliCommand({
          summary: "Проверить тред сейчас без действий: цель, статус, что сделал бы надзор",
          positionals: [threadArg],
          options: { json: { type: "boolean", description: "JSON" } },
          async run(input) {
            const id = input.positionals.thread;
            const cur = await current();
            const w = (await load(id)) ?? newWatch(id, null, "observe", Date.now());
            const { snapshot: s, decision } = await check({ ...w, done: false }, false, configFrom(cur));
            if (input.options.json) return { exitCode: 0, stdout: JSON.stringify({ watch: w, snapshot: s, decision }, null, 2) };
            const goal = s.goal ? `${s.goal.status} — ${s.goal.objective}` : "не поставлена";
            const idle = s.lastEventAt ? `${Math.round((s.now - s.lastEventAt) / 1000)} с назад` : "нет";
            return {
              exitCode: 0,
              stdout: [`Тред: ${s.title} (${id})`, `Статус: ${s.status}`, `Цель: ${goal}`, `Последнее событие: ${idle}`, `Вопросы/разрешения: ${s.pendingInteractionIds.length}`, `В очереди: ${s.queuedCount}`, `Надзор: ${!cur.enabled ? "выключен в настройках" : (await load(id)) ? line(w, cur.maxNudges) : "не подключён"}`, `Решение сейчас: ${decision.kind} — ${decision.summary}`].join("\n"),
            };
          },
        }),
        add: cliCommand({
          summary: "Поставить существующий тред Codex под надзор (по умолчанию новые дочерние треды подключаются сами)",
          positionals: [threadArg],
          options: {
            observe: { type: "boolean", description: "Только наблюдать: не писать ребёнку и родителю" },
            supervise: { type: "boolean", description: "Надзор с подталкиванием (иначе — режим по умолчанию из настроек)" },
          },
          async run(input) {
            const t = await getThread(input.positionals.thread);
            if (t === null) throw new PluginCliError(`тред ${input.positionals.thread} не найден`, { code: "thread_not_found" });
            if (!runsCodex(t, await stepOf(t))) throw new PluginCliError(isCascadeProvider(t.providerId)
              ? "надзор рассчитан на треды Codex: тред каскада сейчас не на ступени Codex (или каскад не ответил)"
              : "надзор рассчитан на треды Codex", { code: "not_codex" });
            const existing = await load(input.positionals.thread);
            const mode = input.options.observe ? "observe" : input.options.supervise ? "supervise" : null;
            if (existing && !existing.done && mode !== null) await setMode(existing.threadId, mode);
            const w = await enroll(t, mode, true);
            const cur = await current();
            return { exitCode: 0, stdout: (w ? line((await load(w.threadId)) ?? w, cur.maxNudges) : "не подключён") + (cur.enabled ? "" : "\nНадзор выключен в настройках: тред будет проверяться после включения.") };
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
        mode: cliCommand({
          summary: "Сменить режим треда под надзором: supervise (с подталкиванием) или observe (только наблюдать и сообщать)",
          positionals: [threadArg, { name: "mode", description: "supervise или observe", required: true }],
          async run(input) {
            const mode = input.positionals.mode;
            if (mode !== "supervise" && mode !== "observe") throw new PluginCliError("режим: supervise или observe", { code: "bad_mode" });
            try {
              if (!(await setMode(input.positionals.thread, mode))) throw new PluginCliError("тред не под надзором", { code: "not_watched", hint: `bb codex-watch add ${input.positionals.thread}` });
            } catch (error) {
              if (error instanceof PluginCliError) throw error;
              throw new PluginCliError(errText(error), { code: "no_parent" });
            }
            return { exitCode: 0, stdout: `Режим: ${mode === "observe" ? "только наблюдать и сообщать" : "надзор с подталкиванием"}.` };
          },
        }),
        "config get": cliCommand({
          summary: "Показать настройки надзора",
          positionals: [{ name: "key", description: "Один параметр (иначе все)", required: false }],
          options: { json: { type: "boolean", description: "JSON" } },
          async run(input) {
            const cur = await current();
            const key = input.positionals.key;
            if (key !== undefined && !isSettingKey(key)) throw new PluginCliError(`неизвестный параметр ${key}`, { code: "bad_key", hint: `Параметры: ${Object.keys(SETTING_DEFAULTS).join(", ")}` });
            if (input.options.json) return { exitCode: 0, stdout: JSON.stringify(key ? { [key]: cur[key as keyof Settings] } : cur, null, 2) };
            const keys = (key ? [key] : Object.keys(SETTING_DEFAULTS)) as (keyof Settings)[];
            return { exitCode: 0, stdout: keys.map((k) => `${k} = ${String(cur[k])}    # ${SETTING_LABELS[k]}`).join("\n") };
          },
        }),
        "config set": cliCommand({
          summary: "Изменить настройку надзора: enabled, autoEnroll, defaultMode, intervalMinutes, maxNudges, checkGoal",
          positionals: [
            { name: "key", description: "Параметр", required: true },
            { name: "value", description: "Значение (true/false, supervise/observe, число)", required: true },
          ],
          async run(input) {
            const key = input.positionals.key;
            if (!isSettingKey(key)) throw new PluginCliError(`неизвестный параметр ${key}`, { code: "bad_key", hint: `Параметры: ${Object.keys(SETTING_DEFAULTS).join(", ")}` });
            let value: Settings[keyof Settings];
            try {
              value = parseSettingValue(key, input.positionals.value);
            } catch (error) {
              throw new PluginCliError(errText(error), { code: "bad_value" });
            }
            await (settings as unknown as { experimental_set(v: Obj): Promise<unknown> }).experimental_set({ [key]: value });
            return { exitCode: 0, stdout: `${key} = ${String(value)}` };
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
            const t = await getThread(id);
            if (isCascadeProvider(t?.providerId) && (await stepOf(t)) !== "codex")
              throw new PluginCliError("тред каскада сейчас не на ступени Codex: /goal resume он не поймёт", { code: "not_codex" });
            if (s.goal.status === "active" || s.goal.status === "complete") return { exitCode: 0, stdout: `Цель уже ${s.goal.status}.` };
            await sendText(id, "/goal resume");
            const w = await load(id);
            if (w) await save({ ...w, done: false, alerts: w.alerts.filter((k) => !k.startsWith("goal:")), nextCheckAt: Date.now() + configFrom(await current()).firstCheckMs });
            return { exitCode: 0, stdout: "Отправил /goal resume. Проверьте через минуту: bb codex-watch check " + id };
          },
        }),
      },
    }),
  );
}
