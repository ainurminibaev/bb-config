import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { rpcContract } from './contract';
import { decide } from './logic';

export default async function freshThreadHint(bb: BbPluginApi) {
  const settings = bb.settings.define({
    minTokens: { type: 'number', label: 'Show from this context size, tokens', default: 150_000 },
    idleMinutes: { type: 'number', label: 'Show after this many idle minutes (the Claude cache lives 60)', default: 60 },
  });

  bb.rpc.register(rpcContract, {
    hint: async ({ threadId }) => {
      const thread = await bb.sdk.threads.get({ threadId });
      // Cheap exits first: most threads are not idle Claude threads.
      if (thread.providerId !== 'claude-code' || thread.status !== 'idle') return { show: false as const };
      const [{ minTokens, idleMinutes }, context, last] = await Promise.all([
        settings.get(),
        bb.sdk.threads.context({ threadId }),
        // The last model activity is what the cache lifetime counts from;
        // thread.updatedAt also moves on renames and reads.
        bb.sdk.threads.events.list({ threadId, types: ['turn/completed', 'thread/tokenUsage/updated'], order: 'desc', limit: '1' }),
      ]);
      return decide({
        providerId: thread.providerId, status: thread.status,
        usedTokens: context.usage?.usedTokens ?? null,
        lastActivityAt: last[0]?.createdAt ?? null,
        now: Date.now(), minTokens, idleMinutes,
      });
    },
  });
}
