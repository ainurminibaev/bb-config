// События хода (RouteNote от сервера) → строки ленты timeline/ в форме thread/delta.
// Один RouteTimeline на тред: строка перехода открывается на switch и
// закрывается, когда начался ход (run) или случился сбой (problem).
import { createRouteTimeline, type RouteDelta, type RouteTimeline, type RunHandle, type SwitchHandle, type WaitHandle } from '../timeline/emitter.ts';
import type { RouteNote } from './route-contract.ts';
import { prepMessage } from './prep-progress.ts';
import type { FeedRenderer } from './wrapper.ts';

interface ThreadFeed {
  timeline: RouteTimeline;
  buffer: RouteDelta[];
  turnId: string | undefined;
  openSwitch: SwitchHandle | null;
  /** Строку перехода открыла подготовка (prep): итоговые switch/sync её не дублируют. */
  prepStepId: string | null;
  run: RunHandle | null;
  wait: WaitHandle | null;
}

export function createTimelineFeed(options: { warn?(message: string): void; now?(): number } = {}): FeedRenderer {
  const threads = new Map<string, ThreadFeed>();
  function feedOf(threadId: string): ThreadFeed {
    let feed = threads.get(threadId);
    if (!feed) {
      const state: ThreadFeed = { timeline: null as unknown as RouteTimeline, buffer: [], turnId: undefined, openSwitch: null, prepStepId: null, run: null, wait: null };
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
    case 'prep': {
      // Подготовка идёт: одна строка перехода на весь путь, обновляется на месте.
      if (!feed.openSwitch || feed.prepStepId !== note.stepId) {
        feed.openSwitch?.fail('переход заменён новым');
        feed.openSwitch = tl.emitSwitch({ reason: note.reason, from: note.from, to: note.to, stepId: note.stepId });
        feed.prepStepId = note.stepId;
      }
      const steps = note.steps.map(s => ({ label: s.label, ms: s.ms, state: s.state }));
      const sync = note.sync?.files !== undefined ? { files: note.sync.files, ...(note.sync.done !== undefined ? { done: note.sync.done } : {}), ...(note.sync.bytes !== undefined ? { bytes: note.sync.bytes } : {}) } : undefined;
      feed.openSwitch.report({ steps, ...(sync ? { sync } : {}), message: `⟳ ${prepMessage(note)}` });
      return;
    }
    case 'switch':
      if (feed.openSwitch && feed.prepStepId === note.stepId) return; // строку уже открыла подготовка
      feed.openSwitch?.done();
      feed.prepStepId = null;
      feed.openSwitch = tl.emitSwitch({ reason: note.reason, window: note.window, from: note.from, to: note.to, resetAt: note.resetAt ?? null, stepId: note.stepId });
      return;
    case 'sync':
      // Шаги уже показала подготовка; итог flush добавляем, только если строка не её.
      if (feed.openSwitch && feed.prepStepId !== null && note.ok) return;
      tl.emitFlush({ from: note.from, to: note.to, ms: note.ms, verify: note.ok ? 'ok' : 'mismatch', ...(note.ok || !note.detail ? {} : { mismatches: [note.detail] }) });
      return;
    case 'run':
      feed.wait?.resolve('ход начался');
      feed.wait = null;
      feed.openSwitch?.done();
      feed.openSwitch = null;
      feed.prepStepId = null;
      feed.run?.end();
      feed.run = tl.emitRun(note.stage, { stepId: note.stepId });
      return;
    case 'wait':
      feed.wait?.resolve();
      feed.wait = tl.emitWaiting({ cause: note.cause, until: note.until ?? null, note: note.note, stepId: note.stepId });
      return;
    case 'problem':
      if (feed.openSwitch) {
        // Строка перехода закрывается сбоем; причина с действиями — одной строкой ниже.
        feed.openSwitch.fail(note.note ? 'подготовка прервана — причина ниже' : note.message);
        feed.openSwitch = null;
        feed.prepStepId = null;
        if (!note.note) return;
      }
      tl.emitFailure({ message: note.message, stage: note.stage, stepId: note.stepId, ...(note.note ? { note: note.note } : {}) });
      return;
    case 'state':
      if (note.phase === 'idle') { feed.run?.end(); feed.run = null; }
      tl.setRouteState(note.phase, note.stage, { ...(note.stepId ? { stepId: note.stepId } : {}), ...(note.profileId ? { profileId: note.profileId } : {}) });
      return;
  }
}
