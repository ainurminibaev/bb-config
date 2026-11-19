import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';

export const hintSchema = z.discriminatedUnion('show', [
  z.object({ show: z.literal(false) }),
  z.object({
    show: z.literal(true),
    usedTokens: z.number().int().nonnegative(),
    idleMinutes: z.number().int().nonnegative(),
    lastActivityAt: z.number(),
  }),
]);
export const rpcContract = defineRpcContract({
  hint: { input: z.object({ threadId: z.string().min(1) }), output: hintSchema },
});
export type HintResult = z.infer<typeof hintSchema>;
