import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { comparisonSchema, vclaudeUsageSchema } from './vclaude-contract';
export const windowSchema = z.object({
  label: z.string(), kind: z.enum(['five-hour', 'weekly', 'model', 'other']),
  usedPercent: z.number().finite(), resetsAt: z.string().nullable(), endsAt: z.string().nullable().optional(),
  // Model families the window limits (Antigravity groups); absent = all models.
  scope: z.array(z.string()).optional(),
});
export const volumeSchema = z.object({
  window: z.string(), tokens: z.number().nullable(), tokensLabel: z.string().nullable(),
  usd: z.number().nullable(), pricePerMTokens: z.number().nullable(),
  source: z.string(), confidence: z.enum(['official', 'measured', 'estimate', 'none']),
});
export const accountSchema = z.object({
  key: z.string(), providerId: z.string(), providerName: z.string(),
  hostIds: z.array(z.string()), hostNames: z.array(z.string()),
  email: z.string().nullable(), plan: z.string().nullable(),
  status: z.enum(['ok', 'stale', 'unavailable']), message: z.string().nullable(),
  fetchedAt: z.string().nullable(), windows: z.array(windowSchema),
  resetCount: z.number().int().nonnegative().nullable().default(null),
  // One line in the provider's own units (Antig: hours left, at ×1.75/×2, today).
  note: z.string().nullable().optional(),
  // Packages: total and left in the provider's units (Antig seconds, VClaude units).
  meter: z.object({ total: z.number(), left: z.number(), tokensPerUnit: z.number().nullable() }).nullable().optional(),
  volume: volumeSchema.nullable().optional(),
  tokens: z.object({ gemini: z.object({ input: z.number(), cacheRead: z.number(), cacheWrite: z.number(), output: z.number(), generations: z.number() }), 'claude-gpt': z.object({ input: z.number(), cacheRead: z.number(), cacheWrite: z.number(), output: z.number(), generations: z.number() }) }).nullable().optional(),
});
export const snapshotSchema = z.object({
  threadId: z.string(), providerId: z.string(), model: z.string().nullable(),
  hostId: z.string().nullable(), hostName: z.string().nullable(),
  binding: z.enum(['host-cli', 'uncertain', 'unavailable']),
  message: z.string().nullable(), account: accountSchema.nullable(),
  // The thread's budget is spent or its last answer was a provider's limit refusal.
  exhausted: z.object({ title: z.string(), detail: z.string(), link: z.string().nullable() }).nullable().optional(),
});
export const rpcContract = defineRpcContract({
  comparison: { input: z.object({ refresh: z.boolean().default(false) }), output: comparisonSchema },
  vclaude: { input: z.object({ refresh: z.boolean().default(false) }), output: z.object({ usage: vclaudeUsageSchema.nullable(), error: z.string().nullable() }) },
  thread: { input: z.object({ threadId: z.string().min(1), refresh: z.boolean().default(false) }), output: snapshotSchema },
  accounts: { input: z.object({ refresh: z.boolean().default(false) }), output: z.object({ accounts: z.array(accountSchema) }) },
  history: { input: z.object({ days: z.number().int().min(1).max(30).default(7) }), output: z.object({
    series: z.array(z.object({ key: z.string(), account: z.string(), label: z.string(), points: z.array(z.tuple([z.number(), z.number()])) })),
  }) },
  overview: { input: z.object({ refresh: z.boolean().default(false) }), output: z.object({ accounts: z.array(accountSchema), googleAnswer: z.string() }) },
  discuss: { input: z.object({ text: z.string().max(4000).default('') }), output: z.object({ threadId: z.string() }) },
  details: { input: z.object({ key: z.string().min(1).max(500) }), output: z.object({
    account: accountSchema.nullable(), threads: z.array(z.object({ id: z.string(), title: z.string(), hostName: z.string(), updatedAt: z.number() })),
  }) },
});
export type QuotaWindow = z.infer<typeof windowSchema>;
export type Account = z.infer<typeof accountSchema>;
export type Snapshot = z.infer<typeof snapshotSchema>;
export type Volume = z.infer<typeof volumeSchema>;
