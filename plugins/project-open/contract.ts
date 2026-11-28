import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';

export const directorySchema = z.object({
  version: z.literal(1),
  self: z.string(),
  machines: z.record(z.string(), z.object({
    name: z.string(), platform: z.string().nullable(), roots: z.array(z.string()), hostKeys: z.array(z.string()),
    /** The account BB runs under there. */
    user: z.string().nullable().optional(),
  })),
});
export type Directory = z.infer<typeof directorySchema>;

export const hostContract = defineRpcContract({
  /** Public SSH host keys of this machine: what its SSH server proves itself with. Nothing secret. */
  identity: { input: z.null(), output: z.object({ platform: z.string(), hostKeys: z.array(z.string()), handler: z.boolean(), user: z.string().nullable().optional() }) },
  save: { input: directorySchema, output: z.object({ saved: z.boolean() }) },
});
export const rpcContract = defineRpcContract({
  /** Hands the Macs with the Finder handler the machines and project folders BB knows. */
  prepare: { input: z.null(), output: z.object({ saved: z.number() }) },
  /**
   * Папка треда «Каскада подписок»: машина со свежей копией и общий путь из его паспорта.
   * null — обычный тред или каскад не ответил: папка окружения, как раньше.
   */
  threadFolder: { input: z.object({ threadId: z.string().min(1) }), output: z.object({ hostId: z.string(), path: z.string() }).nullable() },
});
