import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';

export const directorySchema = z.object({
  version: z.literal(1),
  self: z.string(),
  machines: z.record(z.string(), z.object({
    name: z.string(), platform: z.string().nullable(), roots: z.array(z.string()), hostKeys: z.array(z.string()),
  })),
});
export type Directory = z.infer<typeof directorySchema>;

export const hostContract = defineRpcContract({
  /** Public SSH host keys of this machine: what its SSH server proves itself with. Nothing secret. */
  identity: { input: z.null(), output: z.object({ platform: z.string(), hostKeys: z.array(z.string()), handler: z.boolean() }) },
  save: { input: directorySchema, output: z.object({ saved: z.boolean() }) },
});
export const rpcContract = defineRpcContract({
  /** Hands the Macs with the Finder handler the machines and project folders BB knows. */
  prepare: { input: z.null(), output: z.object({ saved: z.number() }) },
});
