import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { decide, hasHeldResume, texts } from "./policy.ts";

export default function codexGoalQueue(bb: BbPluginApi) {
  const holding = new Set<string>();
  const settings = bb.settings.define({
    language: {
      type: "select",
      label: "Message language / Язык сообщений",
      options: ["en", "ru"],
      default: "en",
    },
  });

  const recheck = (why: string) => {
    void bb.experimental_hooks.recheck("message.dispatch").catch((error: unknown) => {
      bb.log.warn(`recheck after ${why} failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  };

  bb.experimental_hooks.on("message.dispatch", async (ctx) => {
    try {
      const { language } = await settings.get();
      const decision = decide({
        providerId: ctx.requestedExecution.providerId,
        attempt: ctx.attempt,
        fromUser: ctx.initiator === "user" && ctx.senderThreadId === null,
        blocks: ctx.input.blocks,
        text: ctx.input.text,
        language: language === "ru" ? "ru" : "en",
      });
      if (decision.action !== "wait") {
        if (ctx.queuedMessages.length > 0) holding.delete(ctx.thread.id);
        return decision;
      }
      if (ctx.queuedMessages.length === 0) {
        const queued: unknown = await bb.sdk.threads.queuedMessages.list({ threadId: ctx.thread.id });
        const rows: unknown = Array.isArray(queued) ? queued : Reflect.get(Object(queued), "messages");
        if (hasHeldResume(rows, bb.pluginId)) return { action: "reject", message: texts(language).queued };
      }
      holding.add(ctx.thread.id);
      return decision;
    } catch (error) {
      bb.log.warn(`goal command check failed; message sent unchanged: ${error instanceof Error ? error.message : String(error)}`);
      return { action: "proceed" };
    }
  });

  // bb re-asks about a held message when the turn ends, but that can run while
  // the turn still counts as running; ask again once the thread has settled.
  for (const event of ["thread.idle", "thread.failed"] as const) {
    bb.events.on(event, ({ thread }) => {
      if (holding.has(thread.id)) recheck(event);
    });
  }
  // Held messages outlive a reload; the set above does not.
  recheck("start");
}
