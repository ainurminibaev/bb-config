// События хода (RouteNote от сервера) → строки ленты timeline/ в форме thread/delta.
// Один RouteTimeline на тред: строка перехода открывается на switch и
// закрывается, когда начался ход (run) или случился сбой (problem).
//
// Карточка подтверждения (confirm): timeline.requestConfirmation с транспортом
// моста (bridgeAskPort → `interaction/request`). Одна карточка на тред: новая
// снимает старую. Ответ, относящийся к другой карточке, — спросить заново.
import type { BridgeAnswer } from '../launcher/confirm.ts';
import {
  bridgeAskPort, createRouteTimeline, type ConfirmationDecision, type RouteDelta, type RouteTimeline, type RunHandle, type SwitchHandle, type WaitHandle,
} from '../timeline/emitter.ts';
import type { ConfirmPrompt, RouteNote } from './route-contract.ts';
import type { FeedRenderer, InteractionSend } from './wrapper.ts';
import { prepMessage } from './prep-progress.ts';

interface ThreadFeed {
  timeline: RouteTimeline;
  buffer: RouteDelta[];
  turnId: string | undefined;
  openSwitch: SwitchHandle | null;
  /** Строку перехода открыла подготовка (prep): итоговые switch/sync её не дублируют. */
  prepStepId: string | null;
  run: RunHandle | null;
  wait: WaitHandle | null;
  /** Транспорт карточки текущего запроса. */
  send: InteractionSend | null;
}

/** Решение карточки → ответ запускателю. */
export function answerOf(decision: ConfirmationDecision): BridgeAnswer | 'retry' {
  switch (decision.action) {
    case 'go': return { action: 'go', scope: decision.scope };
    case 'skip': case 'wait': case 'cancel': return { action: decision.action };
    case 'invalid': return 'retry';
    case 'dismissed': return decision.reason === 'unavailable' ? { action: 'unavailable', reason: 'BB не показал карточку' } : { action: 'dismissed' };
    case 'superseded': return { action: 'dismissed' };
  }
}

export function createTimelineFeed(options: { warn?(message: string): void; now?(): number } = {}): FeedRenderer {
  const threads = new Map<string, ThreadFeed>();
  function feedOf(threadId: string): ThreadFeed {
    let feed = threads.get(threadId);
    if (!feed) {
      const state: ThreadFeed = { timeline: null as unknown as RouteTimeline, buffer: [], turnId: undefined, openSwitch: null, prepStepId: null, run: null, wait: null, send: null };
      state.timeline = createRouteTimeline({
        sink: delta => { state.buffer.push(delta); },
        ask: bridgeAskPort((payload, signal) => state.send ? state.send(payload, signal) : Promise.reject(new Error('нет канала карточки'))),
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
    async confirm(threadId, prompt: ConfirmPrompt, send, providerTurnId, signal) {
      const feed = feedOf(threadId);
      feed.turnId = providerTurnId;
      feed.send = send;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const decision = await feed.timeline.requestConfirmation({
          stepId: prompt.stepId, continuing: prompt.continuing, returning: prompt.returning,
          from: prompt.from, to: prompt.to, reason: prompt.reason, handoff: prompt.handoff,
          threadUntil: prompt.threadUntil, allowForever: prompt.allowForever, defaultScope: 'turn',
        }, { signal });
        const answer = answerOf(decision);
        if (answer !== 'retry') return answer;
        options.warn?.(`карточка ${threadId}: ${decision.action === 'invalid' ? decision.reason : ''} — спрашиваю заново`);
      }
      return { action: 'unavailable', reason: 'ответ карточки не разобран' };
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
