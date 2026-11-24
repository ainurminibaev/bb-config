import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';

const threadInput = z.object({ threadId: z.string().min(1) });
export const viewSchema = z.object({
  description: z.string(),
  manual: z.boolean(),
  recap: z.string(),
  recapOpen: z.boolean(),
  recapUnseen: z.boolean(),
  generatedAt: z.number().nullable(),
  model: z.string().nullable(),
  busy: z.boolean(),
  error: z.string().nullable(),
});
export type DescriptionView = z.infer<typeof viewSchema>;
export const rpcContract = defineRpcContract({
  get: { input: threadInput, output: viewSchema },
  refresh: { input: threadInput, output: viewSchema },
  /** An empty text returns the description to automatic updates. */
  setDescription: { input: threadInput.extend({ text: z.string().max(2000) }), output: viewSchema },
  setRecapOpen: { input: threadInput.extend({ open: z.boolean() }), output: viewSchema },
});
