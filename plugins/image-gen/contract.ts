import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';

const path = z.string().min(1).max(4096);

// Host entry: runs on every enrolled machine with the plugin's host bundle.
export const hostContract = defineRpcContract({
  probe: { input: z.object({}).strict(), output: z.any(), experimental_retryable: true },
  jobDir: { input: z.object({ jobId: z.string().regex(/^img_[a-z0-9]{6,32}_[0-9]{1,3}$/) }).strict(), output: z.object({ jobDir: z.string() }) },
  prepareJob: { input: z.object({ jobId: z.string().regex(/^img_[a-z0-9]{6,32}_[0-9]{1,3}$/), request: z.any() }).strict(), output: z.object({ jobDir: z.string(), runner: z.string(), python: z.string() }) },
  readResult: { input: z.object({ jobDir: path }).strict(), output: z.any(), experimental_retryable: true },
  lease: { input: z.object({ path, token: z.string().uuid(), expiresAt: z.number(), create: z.boolean() }).strict(), output: z.boolean() },
  info: { input: z.object({ path }).strict(), output: z.object({ size: z.number(), sha256: z.string() }), experimental_retryable: true },
  read: { input: z.object({ path, offset: z.number().int().nonnegative(), size: z.number().int().positive().max(1048576) }).strict(), output: z.string(), experimental_retryable: true },
  write: { input: z.object({ path, transferId: z.string().regex(/^[a-z0-9-]{8,64}$/), offset: z.number().int().nonnegative(), data: z.string().max(1500000), sha256: z.string().optional(), final: z.boolean() }).strict(), output: z.any() },
  cleanup: { input: z.object({ jobDir: path }).strict(), output: z.boolean() },
});

export const generateSchema = z.object({
  prompt: z.string().min(1).max(8000),
  outputDir: path.describe('Absolute folder on the caller machine (normally inside the project). Files are never overwritten.'),
  references: z.array(path).max(8).default([]).describe('Absolute paths of reference/edit images on the caller machine'),
  count: z.number().int().min(1).max(4).default(1),
  size: z.string().max(40).optional(),
  transparent: z.boolean().optional(),
  executor: z.string().optional().describe('Executor id or machine name; normally omit'),
  clientKey: z.string().max(120).optional().describe('Stable key of this request; repeats return the same job'),
  reason: z.enum(['request', 'codex_unavailable', 'codex_limited']).default('request'),
  excludeCurrentAccount: z.boolean().default(false),
  waitSeconds: z.number().int().min(0).max(240).default(120),
  mode: z.enum(['generate', 'edit']).default('generate'),
  callerHostId: z.string().optional().describe('Only outside a thread: machine that owns outputDir/references'),
}).strict();

export const editSchema = z.object({
  image: path.describe('Absolute path of the image to edit, on the caller machine'),
  instruction: z.string().min(1).max(8000).describe('What to change'),
  outputDir: path,
  references: z.array(path).max(7).default([]),
  count: z.number().int().min(1).max(4).default(1),
  size: z.string().max(40).optional(),
  transparent: z.boolean().optional(),
  executor: z.string().optional(),
  clientKey: z.string().max(120).optional(),
  reason: z.enum(['request', 'codex_unavailable', 'codex_limited']).default('request'),
  excludeCurrentAccount: z.boolean().default(false),
  waitSeconds: z.number().int().min(0).max(240).default(120),
  callerHostId: z.string().optional(),
}).strict();

export const rpcContract = defineRpcContract({
  services: { input: z.null(), output: z.any() },
  generate: { input: generateSchema.extend({ threadId: z.string().optional() }), output: z.any() },
  edit: { input: editSchema.extend({ threadId: z.string().optional() }), output: z.any() },
  status: { input: z.object({ jobId: z.string() }).strict(), output: z.any() },
  cancel: { input: z.object({ jobId: z.string() }).strict(), output: z.any() },
  retry: { input: z.object({ jobId: z.string(), confirmUnknown: z.boolean().default(false) }).strict(), output: z.any() },
});
