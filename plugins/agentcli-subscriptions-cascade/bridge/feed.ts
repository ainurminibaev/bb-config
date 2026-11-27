// События хода (RouteNote от сервера) → строки ленты timeline/ в форме thread/delta.
// Один RouteTimeline на тред: строка перехода открывается на switch и
// закрывается, когда начался ход (run) или случился сбой (problem).
import { createRouteTimeline, type RouteDelta, type RouteTimeline, type RunHandle, type SwitchHandle, type WaitHandle } from '../timeline/emitter.ts';
import type { RouteNote } from './route-contract.ts';
import type { FeedRenderer } from './wrapper.ts';

interface ThreadFeed {
  timeline: RouteTimeline;
  buffer: RouteDelta[];
  turnId: string | undefined;
  openSwitch: SwitchHandle | null;
  run: RunHandle | null;
  wait: WaitHandle | null;
}

export function createTimelineFeed(options: { warn?(message: string): void; now?(): number } = {}): FeedRenderer {
  const threads = new Map<string, ThreadFeed>();
  function feedOf(threadId: string): ThreadFeed {
    let feed = threads.get(threadId);
    if (!feed) {
      const state: ThreadFeed = { timeline: null as unknown as RouteTimeline, buffer: [], turnId: undefined, openSwitch: null, run: null, wait: null };
      state.timeline = createRouteTimeline({
        sink: delta => { state.buffer.push(delta); },
        turnId: () => state.turnId,
        warn: options.warn,
        now: options.now,
      });
      feed = state;
      threads.set(threadId, feed);
    }
    return feed;
  }
  return {
    render(threadId, notes, providerTurnId) {
      const feed = feedOf(threadId);
      feed.turnId = providerTurnId;
      feed.buffer = [];
      for (const note of notes) apply(feed, note);
      return feed.buffer;
    },
  };
}

function apply(feed: ThreadFeed, note: RouteNote): void {
  const tl = feed.timeline;
  switch (note.kind) {
    case 'switch':
      feed.openSwitch?.done();
      feed.openSwitch = tl.emitSwitch({ reason: note.reason, window: note.window, from: note.from, to: note.to, resetAt: note.resetAt ?? null, stepId: note.stepId });
      return;
    case 'sync':
      tl.emitFlush({ from: note.from, to: note.to, ms: note.ms, verify: note.ok ? 'ok' : 'mismatch', ...(note.ok || !note.detail ? {} : { mismatches: [note.detail] }) });
      return;
    case 'run':
      feed.wait?.resolve('ход начался');
      feed.wait = null;
      feed.openSwitch?.done();
      feed.openSwitch = null;
      feed.run?.end();
      feed.run = tl.emitRun(note.stage, { stepId: note.stepId });
      return;
    case 'wait':
      feed.wait?.resolve();
      feed.wait = tl.emitWaiting({ cause: note.cause, until: note.until ?? null, note: note.note, stepId: note.stepId });
      return;
    case 'problem':
      if (feed.openSwitch) { feed.openSwitch.fail(note.message); feed.openSwitch = null; return; }
      tl.emitFailure({ message: note.message, stage: note.stage, stepId: note.stepId });
      return;
    case 'state':
      if (note.phase === 'idle') { feed.run?.end(); feed.run = null; }
      tl.setRouteState(note.phase, note.stage, { ...(note.stepId ? { stepId: note.stepId } : {}), ...(note.profileId ? { profileId: note.profileId } : {}) });
      return;
  }
}
