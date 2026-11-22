import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';
const scope = z.object({threadId:z.string().min(1)});
export const retryUi = defineRpcContract({
  retryPreference: {
    input: scope, output:z.object({turnId:z.string().nullable(), enabled:z.boolean(),eligible:z.boolean(),origin:z.string(),backup:z.string(),stage:z.enum(["origin","backup","waiting"]),resetAt:z.number()}),
    tags: ({threadId}) => ['preference:' + threadId],
  },
  setRetryPreference: {
    input: scope.extend({turnId:z.string().min(1).optional(),enabled:z.boolean()}), output:z.boolean(),
  },
});
