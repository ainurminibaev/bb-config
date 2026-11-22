import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { VERSION_RE } from './logic.ts';

export const resultSchema = z.object({
  platform: z.string(),
  state: z.enum(['ok', 'installed', 'planned', 'no-cli', 'error']),
  message: z.string(),
  /** Version this host installed or kept (the newest candidate its Node can run). */
  pinned: z.string(),
  /** Newest candidate offered by the server; differs from `pinned` when Node is too old for it. */
  offered: z.string(),
  nodeVersion: z.string().nullable(),
  /** Release that failed setup/doctor here and was rolled back; the server stops offering it to this host. */
  failedVersion: z.string().nullable(),
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
      /** Allowed releases, newest first, with their engines.node ranges. */
      candidates: z.array(z.object({ version: z.string().regex(VERSION_RE), node: z.string().max(200).nullable() })).min(1).max(20),
      /** false = dry run: report the plan, change nothing. */
      apply: z.boolean(),
      /** Run `context-mode doctor` at the end (slow: hook timing probes). */
      verify: z.boolean(),
    }),
    output: resultSchema,
  },
});
