import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { AUTO_FIELDS } from './core';

const gitState = z.object({
  branch: z.string().nullable(), head: z.string().nullable(), headTime: z.number().nullable(),
  dirty: z.number(), untracked: z.number(), ahead: z.number(), behind: z.number(),
  hasUpstream: z.boolean(), remote: z.string().nullable(), stash: z.number(),
});
const plainState = z.object({ files: z.number(), bytes: z.number(), latestMtime: z.number().nullable(), digest: z.string().nullable(), truncated: z.boolean() });
export const scanSchema = z.object({
  scannedAt: z.number(),
  kind: z.enum(['git', 'plain', 'missing', 'error']),
  error: z.string().optional(),
  git: gitState.optional(),
  plain: plainState.optional(),
  parts: z.array(z.object({ path: z.string(), git: gitState })).optional(),
  docHash: z.string().nullable(),
});
const manifestSchema = z.record(z.string(), z.tuple([z.string(), z.number()]));
const syncReason = z.enum(['dirty', 'diverged', 'ahead', 'no-upstream', 'no-remote', 'detached', 'fetch-failed', 'merge-failed', 'error']);
const repoSyncSchema = z.object({
  path: z.string(), branch: z.string().nullable(), before: z.string().nullable(), after: z.string().nullable(),
  fetched: z.boolean(), fetchError: z.string().nullable(), action: z.enum(['pulled', 'up-to-date', 'skipped']), reason: syncReason.nullable(),
  ahead: z.number(), behind: z.number(), dirty: z.number(), commits: z.array(z.string()), stat: z.string().nullable(),
});
const pullResultSchema = z.object({ kind: z.enum(['git', 'plain', 'missing', 'hands-off', 'error']), repos: z.array(repoSyncSchema), error: z.string().nullable() });
export const worktreeSchema = z.object({
  environmentId: z.string(), projectId: z.string(), hostId: z.string(), hostName: z.string(), path: z.string(), branch: z.string().nullable(),
  liveThreads: z.number(), archivedThreads: z.number(), lastActivity: z.number().nullable(), retireAt: z.number().nullable(),
  bytes: z.number().nullable(), exists: z.boolean().nullable(), state: z.enum(['active', 'idle', 'orphan', 'retiring', 'missing']),
});
export const syncEventSchema = z.object({
  at: z.number(), hostId: z.string(), hostName: z.string(), path: z.string(), threadId: z.string().nullable(),
  apply: z.boolean(), kind: z.enum(['git', 'plain', 'missing', 'hands-off', 'error']),
  repos: z.array(z.object({ path: z.string(), branch: z.string().nullable(), action: z.enum(['pulled', 'up-to-date', 'skipped']), reason: syncReason.nullable(), commits: z.number(), behind: z.number(), ahead: z.number(), dirty: z.number() })),
});

export const hostContract = defineRpcContract({
  scan: {
    input: z.object({ targets: z.array(z.object({ id: z.string(), path: z.string(), manifest: z.boolean() })).max(200) }),
    output: z.object({ results: z.array(z.object({ id: z.string(), scan: scanSchema, manifest: manifestSchema.nullable() })) }),
    experimental_retryable: true,
  },
  fetch: {
    input: z.object({ paths: z.array(z.string().min(1)).max(100) }),
    output: z.object({ results: z.array(z.object({ path: z.string(), ok: z.boolean(), error: z.string().nullable() })) }),
    experimental_retryable: true,
  },
  sizes: {
    input: z.object({ paths: z.array(z.string().min(1)).max(50) }),
    output: z.object({ sizes: z.array(z.object({ path: z.string(), bytes: z.number().nullable(), exists: z.boolean() })) }),
    experimental_retryable: true,
  },
  // Writes into the project (fast-forward only), so never retried automatically.
  pull: {
    input: z.object({ path: z.string().min(1), apply: z.boolean() }),
    output: pullResultSchema,
  },
});

const autoField = z.enum(AUTO_FIELDS);
const link = z.object({ label: z.string(), url: z.string() });
export const entrySchema = z.object({
  summary: z.string(), notes: z.string(), category: z.string(), categories: z.array(z.string()), tags: z.array(z.string()), aliases: z.array(z.string()),
  links: z.array(link), status: z.enum(['active', 'paused', 'archive']), independent: z.boolean(), localPaths: z.array(z.string()), locked: z.array(autoField),
  describedAt: z.number().nullable(), describedDocHash: z.string().nullable(), updatedAt: z.number(),
});
export const patchSchema = z.object({
  summary: z.string().max(2000), notes: z.string().max(8000), category: z.string().max(200),
  tags: z.array(z.string().max(200)).max(50), aliases: z.array(z.string().max(200)).max(50),
  links: z.array(link).max(50), status: z.enum(['active', 'paused', 'archive']), independent: z.boolean(),
  localPaths: z.array(z.string().max(300)).max(50),
}).partial().strict();
const diffSchema = z.object({
  changed: z.number(), onlyA: z.number(), onlyB: z.number(), a: z.string(), b: z.string(),
  sample: z.array(z.object({ path: z.string(), kind: z.enum(['changed', 'onlyA', 'onlyB']), newer: z.enum(['a', 'b']).nullable() })),
});
const projectView = z.object({
  id: z.string(), name: z.string(), remote: z.string().nullable(), createdAt: z.number(), icon: z.string().nullable(),
  entry: entrySchema, described: z.boolean(),
  sources: z.array(z.object({ id: z.string(), hostId: z.string(), hostName: z.string(), path: z.string(), isDefault: z.boolean(), connected: z.boolean(), scan: scanSchema.nullable() })),
  verdict: z.object({ level: z.enum(['ok', 'info', 'attention', 'risk', 'unknown']), label: z.string(), details: z.array(z.string()) }),
  diff: diffSchema.nullable(),
});
export type ProjectView = z.infer<typeof projectView>;
const catalogSchema = z.object({
  projects: z.array(projectView),
  hosts: z.array(z.object({ id: z.string(), name: z.string(), connected: z.boolean() })),
  /** Category name → name of the group it is shown under in the sidebar. */
  groups: z.record(z.string(), z.string()),
  scanning: z.boolean(), scannedAt: z.number().nullable(),
});
export type Catalog = z.infer<typeof catalogSchema>;

export const rpcContract = defineRpcContract({
  catalog: { input: z.null(), output: catalogSchema },
  save: { input: z.object({ projectId: z.string(), patch: patchSchema }).strict(), output: projectView },
  unlock: { input: z.object({ projectId: z.string(), fields: z.array(autoField) }).strict(), output: projectView },
  refresh: { input: z.object({ projectId: z.string().nullable() }).strict(), output: z.object({ started: z.boolean() }) },
  rename_category: { input: z.object({ from: z.string().min(1).max(60), to: z.string().min(1).max(40) }).strict(), output: z.object({ changed: z.number(), groups: z.record(z.string(), z.string()) }) },
  rename_group: { input: z.object({ from: z.string().min(1).max(40), to: z.string().max(40) }).strict(), output: z.object({ groups: z.record(z.string(), z.string()) }) },
  set_group: { input: z.object({ category: z.string().min(1).max(60), group: z.string().max(40) }).strict(), output: z.object({ groups: z.record(z.string(), z.string()) }) },
  threads: {
    input: z.object({ projectId: z.string() }).strict(),
    output: z.object({ total: z.number(), threads: z.array(z.object({ id: z.string(), title: z.string(), status: z.string(), updatedAt: z.number(), hostName: z.string().nullable(), pinned: z.boolean() })) }),
  },
  describe_with_agent: { input: z.object({ projectId: z.string() }).strict(), output: z.object({ threadId: z.string() }) },
  history: { input: z.object({ projectId: z.string() }).strict(), output: z.object({ events: z.array(syncEventSchema) }) },
  worktrees: { input: z.object({ projectId: z.string().nullable(), sizes: z.boolean() }).strict(), output: z.object({ worktrees: z.array(worktreeSchema) }) },
});
