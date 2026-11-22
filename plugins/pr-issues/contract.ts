import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';

const activity = z.object({ login: z.string(), at: z.number(), url: z.string().nullable(), text: z.string(), kind: z.enum(['comment', 'review', 'opened']) });
const tone = z.enum(['good', 'bad', 'warn', 'info', 'neutral']);
const itemView = z.object({
  key: z.string(), provider: z.literal('github'), kind: z.enum(['pr', 'issue']), repo: z.string(), number: z.number(), title: z.string(), url: z.string(), author: z.string(),
  state: z.enum(['open', 'merged', 'closed']), stateReason: z.string().nullable(), draft: z.boolean(),
  createdAt: z.number(), updatedAt: z.number(), closedAt: z.number().nullable(),
  reviewDecision: z.string().nullable(), checks: z.string().nullable(), mergeable: z.string().nullable(), permission: z.string().nullable(),
  reviewRequestedFromMe: z.boolean(), assignedToMe: z.boolean(), changesRequestedAt: z.number().nullable(), lastMine: z.number().nullable(), lastOther: activity.nullable(),
  comments: z.number(), unresolvedThreads: z.number(), labels: z.array(z.string()), relations: z.array(z.enum(['authored', 'review', 'involved', 'project'])),
  status: z.string(), tone, bucket: z.enum(['action', 'waiting', 'done']), reason: z.string(), unread: z.boolean(), muted: z.boolean(), mine: z.boolean(), notice: z.boolean(),
  projects: z.array(z.object({ id: z.string(), name: z.string() })),
});
export type ItemViewDto = z.infer<typeof itemView>;
const feedEvent = z.object({ at: z.number(), key: z.string(), repo: z.string(), number: z.number(), kind: z.enum(['pr', 'issue']), title: z.string(), url: z.string(), text: z.string(), tone });
export type FeedEventDto = z.infer<typeof feedEvent>;
const board = z.object({
  me: z.string().nullable(),
  items: z.array(itemView),
  events: z.array(feedEvent),
  fetchedAt: z.number().nullable(),
  fetching: z.boolean(),
  error: z.string().nullable(),
  warnings: z.array(z.string()),
  repos: z.array(z.string()),
  since: z.number().nullable(),
});
export type Board = z.infer<typeof board>;
const key = z.string().min(3).max(300);
const sourceMode = z.enum(['all', 'mine', 'hidden']);
export type SourcesDto = { orgs: { login: string; mode: 'all' | 'mine' | 'hidden'; explicit: boolean; me: boolean; member: boolean; count: number; repos: { repo: string; mode: 'all' | 'mine' | 'hidden'; explicit: boolean; inherited: 'all' | 'mine' | 'hidden'; count: number; projects: string[] }[] }[] };

export const rpcContract = defineRpcContract({
  board: { input: z.null(), output: board },
  refresh: { input: z.null(), output: z.object({ started: z.boolean() }) },
  mark_seen: { input: z.object({ keys: z.array(key).max(1000) }).strict(), output: z.object({ changed: z.number() }) },
  mute: { input: z.object({ key, muted: z.boolean() }).strict(), output: z.object({ ok: z.boolean() }) },
  act: {
    input: z.object({ key, action: z.enum(['comment', 'close', 'reopen', 'merge', 'approve']), body: z.string().max(20000).optional() }).strict(),
    output: z.object({ ok: z.boolean(), message: z.string() }),
  },
  delegate: { input: z.object({ key, projectId: z.string().min(1) }).strict(), output: z.object({ threadId: z.string() }) },
  sources: {
    input: z.null(),
    output: z.object({ orgs: z.array(z.object({
      login: z.string(), mode: sourceMode, explicit: z.boolean(), me: z.boolean(), member: z.boolean(), count: z.number(),
      repos: z.array(z.object({ repo: z.string(), mode: sourceMode, explicit: z.boolean(), inherited: sourceMode, count: z.number(), projects: z.array(z.string()) })),
    })) }),
  },
  set_source: {
    input: z.object({ key: z.string().regex(/^(org:[\w.-]+|repo:[\w.-]+\/[\w.-]+)$/), mode: sourceMode.nullable() }).strict(),
    output: z.object({ ok: z.boolean() }),
  },
  projects: { input: z.null(), output: z.object({ projects: z.array(z.object({ id: z.string(), name: z.string(), repo: z.string().nullable() })) }) },
});
