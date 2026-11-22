export type GoalCommand = "resume" | "pause" | "clear";

export type GoalDecision =
  | { action: "proceed" }
  | { action: "wait"; reason: string }
  | { action: "reject"; message: string };

const COMMANDS: readonly GoalCommand[] = ["resume", "pause", "clear"];

export type Language = "en" | "ru";

const TEXT = {
  en: {
    resume: "runs by itself after the current Codex turn",
    queued: "/goal resume is already queued in this thread and runs after the current turn. No need to send it again.",
    pause: "Codex is working, so /goal pause would reach the model as plain text. Press Stop: BB ends the turn and pauses the active Goal.",
    clear: "Codex is working, so /goal clear would reach the model as plain text. Send it when the thread is idle, or run bb thread clear-goal for this thread.",
  },
  ru: {
    resume: "выполнится сам после текущего хода Codex",
    queued: "/goal resume уже в очереди этого треда и выполнится после текущего хода. Повтор не нужен.",
    pause: "Codex работает, поэтому /goal pause ушёл бы модели текстом. Нажмите «Стоп»: BB остановит ход и поставит активную цель на паузу.",
    clear: "Codex работает, поэтому /goal clear ушёл бы модели текстом. Отправьте команду, когда тред остановится, или выполните bb thread clear-goal для этого треда.",
  },
} as const;

/** Messages in the chosen language; anything unknown falls back to English. */
export function texts(language: unknown) {
  return TEXT[language === "ru" ? "ru" : "en"];
}

/** The command Codex's provider would run for this text when it starts a turn. */
export function parseGoalCommand(blocks: readonly { type: string }[], text: string): GoalCommand | null {
  if (blocks.some((block) => block.type !== "text")) return null;
  const word = /^\/goal\s+(\S+)$/u.exec(text.trim())?.[1]?.toLowerCase();
  return COMMANDS.find((command) => command === word) ?? null;
}

/**
 * Codex runs a Goal command only when the message starts a turn. Joined to a
 * running turn it reaches the model as text and the Goal keeps its status.
 */
export function decide(args: {
  providerId: string;
  attempt: "start-turn" | "join-turn";
  /** A person typed it. A message from another thread carries a sender note, so Codex never reads it as a command. */
  fromUser: boolean;
  blocks: readonly { type: string }[];
  text: string;
  language?: Language;
}): GoalDecision {
  const t = texts(args.language);
  if (args.providerId !== "codex" || args.attempt !== "join-turn" || !args.fromUser) return { action: "proceed" };
  switch (parseGoalCommand(args.blocks, args.text)) {
    case "resume":
      return { action: "wait", reason: t.resume };
    case "pause":
      return { action: "reject", message: t.pause };
    case "clear":
      return { action: "reject", message: t.clear };
    default:
      return { action: "proceed" };
  }
}

/** Whether the thread's queue already holds a `/goal resume` this plugin made wait. */
export function hasHeldResume(rows: unknown, pluginId: string): boolean {
  const list = Array.isArray(rows) ? rows : [];
  return list.some((row) => {
    if (typeof row !== "object" || row === null) return false;
    const waitingOn: unknown = Reflect.get(row, "waitingOn");
    const content: unknown = Reflect.get(row, "content");
    if (typeof waitingOn !== "object" || waitingOn === null || !Array.isArray(content)) return false;
    if (Reflect.get(waitingOn, "kind") !== "plugin" || Reflect.get(waitingOn, "pluginId") !== pluginId) return false;
    const blocks = content.filter((block): block is { type: string; text?: unknown } =>
      typeof block === "object" && block !== null && typeof Reflect.get(block, "type") === "string");
    const text = blocks.map((block) => (typeof block.text === "string" ? block.text : "")).join("");
    return blocks.length === content.length && parseGoalCommand(blocks, text) === "resume";
  });
}
