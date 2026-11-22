export type GoalCommand = "resume" | "pause" | "clear";

export type GoalDecision =
  | { action: "proceed" }
  | { action: "wait"; reason: string }
  | { action: "reject"; message: string };

const COMMANDS: readonly GoalCommand[] = ["resume", "pause", "clear"];

export const RESUME_REASON = "выполнится сам после текущего хода Codex";

export const ALREADY_QUEUED_MESSAGE =
  "/goal resume уже в очереди этого треда и выполнится после текущего хода. Повтор не нужен.";

export const PAUSE_MESSAGE =
  "Codex работает, поэтому /goal pause ушёл бы модели текстом. Нажмите «Стоп»: BB остановит ход и поставит активную цель на паузу.";

export const CLEAR_MESSAGE =
  "Codex работает, поэтому /goal clear ушёл бы модели текстом. Отправьте команду, когда тред остановится, или выполните bb thread clear-goal для этого треда.";

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
}): GoalDecision {
  if (args.providerId !== "codex" || args.attempt !== "join-turn" || !args.fromUser) return { action: "proceed" };
  switch (parseGoalCommand(args.blocks, args.text)) {
    case "resume":
      return { action: "wait", reason: RESUME_REASON };
    case "pause":
      return { action: "reject", message: PAUSE_MESSAGE };
    case "clear":
      return { action: "reject", message: CLEAR_MESSAGE };
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
