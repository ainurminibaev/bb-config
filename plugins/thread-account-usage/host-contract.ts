import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';
const agWindow = z.object({
  label: z.string(), kind: z.enum(['five-hour', 'weekly', 'model', 'other']), usedPercent: z.number().finite(),
  resetsAt: z.string().nullable(), endsAt: z.string().nullable().optional(), scope: z.array(z.string()).optional(),
});
const agAccount = z.object({
  email: z.string().nullable(), plan: z.string().nullable(), status: z.enum(['ok', 'stale', 'unavailable']),
  message: z.string().nullable(), fetchedAt: z.string().nullable(), windows: z.array(agWindow), note: z.string().nullable(),
  // Antig: bought and left seconds, tokens per billed second from today's history.
  meter: z.object({ total: z.number(), left: z.number(), tokensPerUnit: z.number().nullable() }).nullable().optional(),
  tokens: z.object({ gemini: z.object({ input: z.number(), cacheRead: z.number(), cacheWrite: z.number(), output: z.number(), generations: z.number() }), 'claude-gpt': z.object({ input: z.number(), cacheRead: z.number(), cacheWrite: z.number(), output: z.number(), generations: z.number() }) }).nullable().optional(),
});
const codexWindowVolume = z.object({
  plan: z.string().nullable(), resetsAt: z.string(), samples: z.number(), percentSpan: z.number(),
  input: z.number(), cached: z.number(), output: z.number(),
});
export const hostContract = defineRpcContract({
  codexResets: { input: z.null(), output: z.object({ email: z.string().nullable(), count: z.number().int().nonnegative().nullable() }) },
  antigravity: { input: z.object({ refresh: z.boolean().default(false) }), output: z.object({ google: agAccount.nullable(), antig: agAccount.nullable() }) },
  codexVolume: { input: z.null(), output: z.array(codexWindowVolume) },
  claudeProfile: { input: z.null(), output: z.object({ email: z.string().nullable(), organizationType: z.string().nullable(), rateLimitTier: z.string().nullable() }) },
});
