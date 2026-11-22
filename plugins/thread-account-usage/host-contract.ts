import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';
export const hostContract = defineRpcContract({
  codexResets: { input: z.null(), output: z.object({ email: z.string().nullable(), count: z.number().int().nonnegative().nullable() }) },
  claudeProfile: { input: z.null(), output: z.object({ email: z.string().nullable(), organizationType: z.string().nullable(), rateLimitTier: z.string().nullable() }) },
});
