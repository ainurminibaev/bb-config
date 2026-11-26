import { z } from 'zod';

const count = z.number().finite().nonnegative();
const tokens = z.object({
  input: count,
  output: count,
  cacheRead: count,
  cacheWrite: count,
  estimated: z.boolean(),
});
export const conversionRateSchema = z.object({
  input: count, output: count, cacheRead: count, cacheWrite5m: count, cacheWrite1h: count,
});
export type ConversionRate = z.infer<typeof conversionRateSchema>;
export const vclaudeUsageSchema = z.object({
  fetchedAt: z.string(),
  limitUnits: count,
  remainingUnits: count,
  endsAt: z.string().nullable(),
  paidRub: count.nullable(),
  usedRub: count.nullable(),
  days: z.number().int().positive().nullable(),
  conversionRates: z.record(z.string(), conversionRateSchema),
  models: z.array(z.object({
    id: z.string(),
    name: z.string(),
    units: count,
    requests: count,
    tokens: tokens.nullable(),
    rates: conversionRateSchema.nullable(),
  })),
});
export type VClaudeUsage = z.infer<typeof vclaudeUsageSchema>;

export const comparisonSchema = z.object({
  catalog: z.array(z.object({
    name: z.string(),
    priceRub: count,
    limitUnits: count.positive(),
    periodDays: z.number().int().positive(),
  })),
  estimate: z.object({
    observedAt: z.string(),
    resetsAt: z.string(),
    weekProgress: count,
    segments: z.number().int().nonnegative(),
    unitsPerPercent: count.positive().nullable(),
    usdPerPercent: count.positive().nullable(),
    unitsRange: z.tuple([count, count]).nullable(),
    dailyUnits: count,
    dailyApiUsd: count,
    unpricedRequests: z.number().int().nonnegative(),
    estimatedWriteRequests: z.number().int().nonnegative(),
  }).nullable(),
  message: z.string().nullable(),
});
export type VClaudeComparison = z.infer<typeof comparisonSchema>;
