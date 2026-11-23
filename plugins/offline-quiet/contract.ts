import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';

export const stateSchema = z.object({
  quietNames: z.array(z.string()),
  allWarningsQuiet: z.boolean(),
});
export const rpcContract = defineRpcContract({
  state: { input: z.object({}), output: stateSchema },
});
