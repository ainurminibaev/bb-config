import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';

const snapshotResult = z.object({
  kind: z.enum(['git', 'shadow', 'missing', 'hands-off', 'error']),
  commit: z.string().nullable(),
  /** HEAD the snapshot was taken on (git folders). */
  base: z.string().nullable(),
  changed: z.boolean(),
  files: z.number(),
  skippedFiles: z.number(),
  pushed: z.boolean(),
  pushNote: z.string().nullable(),
  secrets: z.array(z.string()),
  /** The folder matched its branch, so the old local snapshot was dropped. */
  removed: z.boolean(),
  error: z.string().nullable(),
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
