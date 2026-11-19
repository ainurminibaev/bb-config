import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';

export const stateSchema = z.object({
  /** This thread's own mark, null when not marked. */
  own: z.number().nullable(),
  /** The mark that applies: own, or the nearest marked ancestor's. */
  effective: z.number().nullable(),
  inheritedFrom: z.string().nullable(),
  holding: z.string().nullable(),
  summary: z.string(),
});
export const rpcContract = defineRpcContract({
  state: { input: z.object({ threadId: z.string().min(1) }), output: stateSchema },
  toggle: { input: z.object({ threadId: z.string().min(1) }), output: stateSchema },
  /** Effective percent per thread id; threads that are not low priority are left out. */
  marks: { input: z.object({ threadIds: z.array(z.string()).max(500) }), output: z.record(z.string(), z.object({ percent: z.number(), holding: z.boolean(), title: z.string() })) },
});
export type State = z.infer<typeof stateSchema>;
