// Pure supervision policy for delegated Codex threads. No BB calls here, so the
// rules are testable on their own; server.ts gathers facts and applies the result.

export type GoalStatus = "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";

export interface Goal {
  status: GoalStatus;
  objective: string;
}

export interface Watch {
  threadId: string;
  parentThreadId: string | null;
  /** supervise: may nudge the child and alert the parent. observe: only records what it would do. */
  mode: "supervise" | "observe";
  enrolledAt: number;
  nextCheckAt: number;
  nudges: number;
  lastNudgeAt: number | null;
  /** When the check first saw the turn over while the Goal was still active. */
  idleActiveSince: number | null;
  /** Alert keys already sent, so each problem reaches the parent once. */
  alerts: string[];
  done: boolean;
  doneReason: string | null;
  lastCheckAt: number | null;
  lastSummary: string | null;
  /** Thread title at the last check, for the settings screen. */
  title?: string;
}

export interface Snapshot {
  now: number;
  exists: boolean;
  archived: boolean;
  title: string;
  status: string;
  goal: Goal | null;
  pendingInteractionIds: string[];
  queuedCount: number;
  firstTurnStartedAt: number | null;
  lastEventAt: number | null;
  lastEventSeq: number | null;
}

export interface Config {
  firstCheckMs: number;
  intervalMs: number;
  goalGraceMs: number;
  idleNudgeMs: number;
  stallMs: number;
  nudgeCooldownMs: number;
  maxNudges: number;
  maxWatchMs: number;
  /** Ask a child without a Goal to set one, and report a turn that ended without one. */
  checkGoal: boolean;
}

export const DEFAULTS: Config = {
  firstCheckMs: 2 * 60_000,
  intervalMs: 5 * 60_000,
  goalGraceMs: 90_000,
  idleNudgeMs: 4 * 60_000,
  stallMs: 15 * 60_000,
  nudgeCooldownMs: 4 * 60_000,
  maxNudges: 3,
  maxWatchMs: 3 * 24 * 60 * 60_000,
  checkGoal: true,
};

/** User-facing settings (BB plugin settings and `bb codex-watch config`). */
export interface Settings {
  enabled: boolean;
  autoEnroll: boolean;
  defaultMode: "supervise" | "observe";
  intervalMinutes: number;
  maxNudges: number;
  checkGoal: boolean;
}

export const SETTING_DEFAULTS: Settings = {
  enabled: true,
  autoEnroll: true,
  defaultMode: "supervise",
  intervalMinutes: 5,
  maxNudges: 3,
  checkGoal: true,
};

export const SETTING_LABELS: Record<keyof Settings, string> = {
  enabled: "Надзор включён",
  autoEnroll: "Автоподключение новых Codex-детей",
  defaultMode: "Режим по умолчанию (supervise — надзор с подталкиванием, observe — только наблюдать и сообщать)",
  intervalMinutes: "Интервал проверки, минут (1–60)",
  maxNudges: "Максимум подталкиваний на тред (0–10)",
  checkGoal: "Проверять постановку цели",
};

export function isSettingKey(key: string): key is keyof Settings {
  return Object.hasOwn(SETTING_DEFAULTS, key);
}

/** Parses a CLI value for a setting; throws with a readable message on bad input. */
export function parseSettingValue<K extends keyof Settings>(key: K, raw: string): Settings[K] {
  const value = raw.trim().toLowerCase();
  const fail = (why: string): never => { throw new Error(`${key}: ${why}`); };
  switch (key) {
    case "enabled":
    case "autoEnroll":
    case "checkGoal": {
      if (["true", "on", "yes", "1", "да", "вкл"].includes(value)) return true as Settings[K];
      if (["false", "off", "no", "0", "нет", "выкл"].includes(value)) return false as Settings[K];
      return fail("ожидается true или false");
    }
    case "defaultMode":
      if (value === "supervise" || value === "observe") return value as Settings[K];
      return fail("ожидается supervise или observe");
    case "intervalMinutes": {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 60) fail("целое число от 1 до 60");
      return n as Settings[K];
    }
    case "maxNudges": {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0 || n > 10) fail("целое число от 0 до 10");
      return n as Settings[K];
    }
  }
  return fail("неизвестный параметр");
}

/** Policy timing derived from the user's settings. */
export function configFrom(settings: Settings): Config {
  const intervalMs = settings.intervalMinutes * 60_000;
  return {
    ...DEFAULTS,
    intervalMs,
    // A stopped turn with an active Goal is nudged on the second look.
    idleNudgeMs: Math.max(60_000, intervalMs - 60_000),
    nudgeCooldownMs: Math.max(60_000, intervalMs - 60_000),
    firstCheckMs: Math.min(DEFAULTS.firstCheckMs, intervalMs),
    maxNudges: settings.maxNudges,
    checkGoal: settings.checkGoal,
  };
}

export const GOAL_NUDGE =
  "[Надзор Codex] У этого треда не поставлена цель (Goal). Сейчас вызови инструмент create_goal: objective — одна-две фразы " +
  "с конечным результатом поручения выше и критерием готовности. Затем продолжай работу. Закрывай цель через update_goal " +
  "только после проверки результата.";

export const CONTINUE_NUDGE =
  "[Надзор Codex] Ход остановился, а цель ещё активна. Проверь, что осталось сделать по цели, и продолжай. " +
  "Если без решения человека дальше нельзя — сформулируй один конкретный вопрос. Если всё готово — проверь результат " +
  "и закрой цель через update_goal.";

export type Decision =
  | { kind: "wait"; summary: string }
  | { kind: "nudge"; key: string; text: string; summary: string }
  | { kind: "alert"; key: string; text: string; summary: string }
  | { kind: "finish"; reason: string; summary: string };

/** What one check should do. `idleActiveSince` is the new value to store. */
export interface Evaluation {
  decision: Decision;
  idleActiveSince: number | null;
}

const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));

function raw(w: Watch, s: Snapshot, cfg: Config): Evaluation {
  const keep = w.idleActiveSince;
  const wait = (summary: string, idle: number | null = null): Evaluation => ({ decision: { kind: "wait", summary }, idleActiveSince: idle });
  const ref = `«${s.title}» (@thread:${w.threadId})`;

  if (!s.exists || s.archived) {
    return { decision: { kind: "finish", reason: "тред удалён или в архиве", summary: "наблюдение снято: тред удалён или в архиве" }, idleActiveSince: null };
  }
  const running = s.status === "active" || s.status === "starting" || s.status === "pending" || s.status === "stopping";

  if (s.pendingInteractionIds.length > 0) {
    const id = s.pendingInteractionIds[0];
    return {
      decision: {
        kind: "alert",
        key: `interaction:${id}`,
        summary: "ждёт ответа или разрешения",
        text: `Тред ${ref} ждёт ответа или разрешения. Посмотри: bb thread interactions list ${w.threadId}; ответь сам, если решение в рамках поручения, иначе спроси владельца.`,
      },
      idleActiveSince: keep,
    };
  }

  if (s.goal?.status === "complete") {
    if (running) return wait("цель выполнена, ход завершается");
    return { decision: { kind: "finish", reason: "цель выполнена", summary: "наблюдение снято: цель выполнена" }, idleActiveSince: null };
  }

  if (s.status === "error") {
    if (s.queuedCount > 0) return wait("ход упал, повтор стоит в очереди");
    return {
      decision: {
        kind: "alert",
        key: `error:${s.lastEventSeq ?? 0}`,
        summary: "ход завершился ошибкой, повтора в очереди нет",
        text: `Тред ${ref} завершил ход ошибкой, повтора в очереди нет. Проверь: bb thread show ${w.threadId}; bb thread log ${w.threadId} --limit 20.`,
      },
      idleActiveSince: null,
    };
  }

  if (s.goal === null && !cfg.checkGoal) {
    if (running) return stalled(w, s, cfg, ref) ?? wait("работает без цели (проверка цели выключена)");
    if (s.firstTurnStartedAt === null) return wait("ход ещё не начался");
    return { decision: { kind: "finish", reason: "ход закончен", summary: "наблюдение снято: ход закончен (цель не требуется)" }, idleActiveSince: null };
  }

  if (s.goal === null) {
    if (running) {
      if (s.firstTurnStartedAt !== null && s.now - s.firstTurnStartedAt >= cfg.goalGraceMs) {
        return { decision: { kind: "nudge", key: "goal", text: GOAL_NUDGE, summary: "работает без цели" }, idleActiveSince: null };
      }
      return wait("ждём постановки цели");
    }
    if (s.firstTurnStartedAt === null) return wait("ход ещё не начался");
    return {
      decision: {
        kind: "alert",
        key: "idle-without-goal",
        summary: "ход закончен, цели нет",
        text: `Тред ${ref} закончил ход, а цель (Goal) так и не была поставлена. Проверь результат сам; если работа не закончена — продолжи её сообщением, начав с цели. Дальнейший надзор за тредом снят.`,
      },
      idleActiveSince: null,
    };
  }

  const status = s.goal.status;
  if (status === "active") {
    if (running) return stalled(w, s, cfg, ref) ?? wait("работает по цели");
    const since = keep ?? s.now;
    if (s.now - since >= cfg.idleNudgeMs) {
      return { decision: { kind: "nudge", key: "continue", text: CONTINUE_NUDGE, summary: "ход остановился при активной цели" }, idleActiveSince: null };
    }
    return wait("ход закончился, цель активна — ждём продолжения", since);
  }

  if (running) return wait(`цель: ${status}, ход идёт`);
  if (status === "usageLimited" && s.queuedCount > 0) return wait("лимит, повтор в очереди");
  const why: Record<Exclude<GoalStatus, "active" | "complete">, string> = {
    paused: "цель на паузе (тред остановили)",
    blocked: "агент признал цель заблокированной",
    usageLimited: "цель остановлена лимитом подписки",
    budgetLimited: "исчерпан бюджет токенов цели",
  };
  return {
    decision: {
      kind: "alert",
      key: `goal:${status}`,
      summary: why[status],
      text: `Тред ${ref}: ${why[status]}. Прочитай последний ответ (bb thread output ${w.threadId}). Возобновить цель после решения: bb codex-watch resume-goal ${w.threadId}.`,
    },
    idleActiveSince: null,
  };
}

function stalled(w: Watch, s: Snapshot, cfg: Config, ref: string): Evaluation | null {
  if (s.lastEventAt === null || s.now - s.lastEventAt < cfg.stallMs) return null;
  return {
    decision: {
      kind: "alert",
      key: `stall:${s.lastEventSeq ?? 0}`,
      summary: `нет событий ${minutes(s.now - s.lastEventAt)} мин`,
      text: `Тред ${ref} работает, но ${minutes(s.now - s.lastEventAt)} мин не выдаёт событий — возможно, зависла команда. Проверь: bb thread log ${w.threadId} --limit 10. Остановка — bb thread stop (цель встанет на паузу).`,
    },
    idleActiveSince: null,
  };
}

/** Applies observe mode, the nudge limit, cooldown, alert de-duplication and the watch lifetime. */
export function evaluate(w: Watch, s: Snapshot, cfg: Config = DEFAULTS): Evaluation {
  if (s.now - w.enrolledAt >= cfg.maxWatchMs) {
    return { decision: { kind: "finish", reason: "истёк срок наблюдения", summary: "наблюдение снято по сроку" }, idleActiveSince: null };
  }
  const result = raw(w, s, cfg);
  const d = result.decision;
  if (d.kind === "alert" && w.alerts.includes(d.key)) {
    if (d.key === "idle-without-goal") return { decision: { kind: "finish", reason: "ход закончен без цели", summary: d.summary }, idleActiveSince: null };
    return { decision: { kind: "wait", summary: `${d.summary} (родитель уже предупреждён)` }, idleActiveSince: result.idleActiveSince };
  }
  if (d.kind === "nudge") {
    if (w.mode === "observe") return { decision: { kind: "wait", summary: `${d.summary} (наблюдение без вмешательства)` }, idleActiveSince: result.idleActiveSince };
    if (w.nudges >= cfg.maxNudges) {
      const key = "nudge-limit";
      if (w.alerts.includes(key)) return { decision: { kind: "wait", summary: `${d.summary}; лимит подталкиваний исчерпан` }, idleActiveSince: result.idleActiveSince };
      return {
        decision: {
          kind: "alert",
          key,
          summary: `${d.summary}; лимит подталкиваний исчерпан`,
          text: `Тред «${s.title}» (@thread:${w.threadId}): ${d.summary}, ${cfg.maxNudges === 0 ? "подталкивание выключено настройкой" : `${cfg.maxNudges} подталкивания не помогли`}. Нужен твой разбор: bb thread log ${w.threadId} --limit 20. Надзор больше не вмешивается.`,
        },
        idleActiveSince: result.idleActiveSince,
      };
    }
    if (w.lastNudgeAt !== null && s.now - w.lastNudgeAt < cfg.nudgeCooldownMs) {
      return { decision: { kind: "wait", summary: `${d.summary} (недавно подталкивали)` }, idleActiveSince: result.idleActiveSince };
    }
  }
  return result;
}

export function newWatch(threadId: string, parentThreadId: string | null, mode: Watch["mode"], now: number, cfg: Config = DEFAULTS): Watch {
  return {
    threadId,
    parentThreadId,
    mode,
    enrolledAt: now,
    nextCheckAt: now + cfg.firstCheckMs,
    nudges: 0,
    lastNudgeAt: null,
    idleActiveSince: null,
    alerts: [],
    done: false,
    doneReason: null,
    lastCheckAt: null,
    lastSummary: null,
  };
}

/** Delegated Codex threads created after the plugin started watching are enrolled automatically. */
export function shouldEnroll(t: { providerId?: unknown; parentThreadId?: unknown; visibility?: unknown; createdAt?: unknown; archivedAt?: unknown }, since: number): boolean {
  return (
    t.providerId === "codex" &&
    typeof t.parentThreadId === "string" &&
    t.parentThreadId.length > 0 &&
    t.visibility !== "hidden" &&
    typeof t.createdAt === "number" &&
    t.createdAt >= since &&
    (t.archivedAt === null || t.archivedAt === undefined)
  );
}

/** Latest Codex Goal from events listed newest first; null when none was set or it was cleared. */
export function latestGoal(rowsNewestFirst: readonly unknown[]): Goal | null {
  for (const row of rowsNewestFirst) {
    if (typeof row !== "object" || row === null) continue;
    const type = Reflect.get(row, "type");
    const data: unknown = Reflect.get(row, "data");
    if (type === "thread/goal/cleared") return null;
    if (typeof data !== "object" || data === null) continue;
    if (type === "thread/goal/updated") return toGoal(data);
    if (type === "thread/extensionState/updated" && Reflect.get(data, "kind") === "provider-codex/goal") {
      const payload: unknown = Reflect.get(data, "payload");
      return payload === null ? null : toGoal(payload);
    }
  }
  return null;
}

const STATUSES: readonly GoalStatus[] = ["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"];

function toGoal(value: unknown): Goal | null {
  if (typeof value !== "object" || value === null) return null;
  const status = Reflect.get(value, "status");
  const objective = Reflect.get(value, "objective");
  if (!STATUSES.includes(status as GoalStatus)) return null;
  return { status: status as GoalStatus, objective: typeof objective === "string" ? objective : "" };
}
