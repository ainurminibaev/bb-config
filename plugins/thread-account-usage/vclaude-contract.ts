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
  // End of the whole paid queue (latest possible: a waiting package starts at the
  // previous one's end, earlier if that one's limit runs out). Was nearest_expiry before 0.2.3.
  endsAt: z.string().nullable(),
  // Cabinet's nearest_expiry: end of the running package.
  nearestExpiry: z.string().nullable().default(null),
  // Start of the running package: with endsAt, the term the pace tick measures.
  startedAt: z.string().nullable().default(null),
  // Packages in the order they run: running first, then waiting ones.
  queue: z.array(z.object({
    name: z.string(), state: z.string(), limitUnits: count, usedUnits: count, priceRub: count,
    startsAt: z.string().nullable(), endsAt: z.string().nullable(), estimated: z.boolean(),
  })).default([]),
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
