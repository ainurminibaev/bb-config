import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const watchViewSchema = z.object({
  threadId: z.string(),
  title: z.string(),
  mode: z.enum(["supervise", "observe"]),
  done: z.boolean(),
  doneReason: z.string().nullable(),
  nudges: z.number(),
  lastCheckAt: z.number().nullable(),
  lastSummary: z.string().nullable(),
  hasParent: z.boolean(),
});
export type WatchView = z.infer<typeof watchViewSchema>;

const threadInput = z.object({ threadId: z.string().regex(/^thr_[a-z0-9]+$/) });

/** RPC used by the settings screen. */
export const rpcContract = defineRpcContract({
  overview: {
    input: z.object({ includeDone: z.boolean() }),
    output: z.object({ enabled: z.boolean(), maxNudges: z.number(), intervalMinutes: z.number(), watches: z.array(watchViewSchema) }),
  },
  remove: { input: threadInput, output: z.object({ ok: z.boolean() }) },
  checkNow: { input: threadInput, output: z.object({ summary: z.string() }) },
  setMode: { input: threadInput.extend({ mode: z.enum(["supervise", "observe"]) }), output: z.object({ ok: z.boolean() }) },
});
