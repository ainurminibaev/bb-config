import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';

const snapshotResult = z.object({
  kind: z.enum(['git', 'shadow', 'missing', 'hands-off', 'skipped', 'error']),
  commit: z.string().nullable(),
  /** HEAD the snapshot was taken on (git folders). */
  base: z.string().nullable(),
  changed: z.boolean(),
  files: z.number(),
  skippedFiles: z.number(),
  pushed: z.boolean(),
  pushNote: z.string().nullable(),
  secrets: z.array(z.string()),
  /** The folder matched its branch and the old snapshot's work is in the branch, so it was dropped. */
  removed: z.boolean(),
  /** The folder is clean but the old snapshot's work is not in the branch: kept on purpose. */
  kept: z.boolean(),
  error: z.string().nullable(),
  /** Git repositories nested in a folder without git, snapshotted separately. */
  nested: z.array(z.object({ path: z.string(), commit: z.string().nullable(), files: z.number(), error: z.string().nullable() })),
});
export type SnapshotResult = z.infer<typeof snapshotResult>;
const restoreResult = z.object({ ok: z.boolean(), message: z.string() });
export type RestoreResult = z.infer<typeof restoreResult>;

export const hostContract = defineRpcContract({
  // Never retried automatically: a snapshot may push.
  snapshot: {
    input: z.object({ path: z.string().min(1), ref: z.string().min(1), message: z.string(), push: z.boolean() }),
    output: snapshotResult,
  },
  restore: {
    input: z.object({ path: z.string().min(1), ref: z.string().min(1) }),
    output: restoreResult,
  },
});

const priorityView = z.object({
  mode: z.enum(['normal', 'low', 'background']),
  /** The ancestor the mode comes from, when inherited. */
  from: z.string().nullable(),
  holding: z.boolean(),
  unknown: z.boolean(),
  /** One line for people: state, window, usage and the current threshold. */
  text: z.string(),
  window: z.string().nullable(),
  used: z.number().nullable(),
  threshold: z.number().nullable(),
  rules: z.array(z.string()),
  /** Effective rule per window, and whether it is this thread's own. */
  policies: z.array(z.object({ key: z.enum(['short', 'long', 'model']), label: z.string(), enabled: z.boolean(), low: z.number(), high: z.number(), nearMinutes: z.number(), custom: z.boolean() })),
});
export type PriorityView = z.infer<typeof priorityView>;
const policyInput = z.object({ enabled: z.boolean(), low: z.number().min(1).max(100), high: z.number().min(1).max(100), nearMinutes: z.number().min(0).max(10080) }).strict();

export const rpcContract = defineRpcContract({
  priority: { input: z.object({ threadId: z.string().min(1) }).strict(), output: priorityView },
  setPriority: {
    input: z.object({
      threadId: z.string().min(1), mode: z.enum(['normal', 'low', 'background']),
      /** Omitted: keep the thread's own thresholds. Null: back to the plugin settings. */
      custom: z.object({ short: policyInput.optional(), long: policyInput.optional(), model: policyInput.optional() }).strict().nullable().optional(),
    }).strict(),
    output: priorityView,
  },
  /** Sidebar marks for many threads at once: only threads that are not normal. */
  marks: { input: z.object({ threadIds: z.array(z.string()).max(500) }).strict(), output: z.record(z.string(), z.object({ mode: z.enum(['low', 'background']), holding: z.boolean(), title: z.string() })) },
});
