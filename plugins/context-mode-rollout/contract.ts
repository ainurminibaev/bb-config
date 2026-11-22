import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { VERSION_RE } from './logic.ts';

export const resultSchema = z.object({
  platform: z.string(),
  state: z.enum(['ok', 'installed', 'planned', 'no-cli', 'error']),
  message: z.string(),
  pinned: z.string(),
  versionBefore: z.string().nullable(),
  versionAfter: z.string().nullable(),
  clis: z.array(z.string()),
  actions: z.array(z.string()),
  agents: z.array(z.object({ id: z.string(), status: z.string(), changes: z.number() })),
});
export type EnsureResult = z.infer<typeof resultSchema>;

export const hostContract = defineRpcContract({
  ensure: {
    input: z.object({
      version: z.string().regex(VERSION_RE),
      /** false = dry run: report the plan, change nothing. */
      apply: z.boolean(),
      /** Run `context-mode doctor` at the end (slow: hook timing probes). */
      verify: z.boolean(),
    }),
    output: resultSchema,
  },
});
