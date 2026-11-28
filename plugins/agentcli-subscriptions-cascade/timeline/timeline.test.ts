// Лента треда: «без лишнего» (одна строка на переход, обычный ход без строк),
// соответствие протоколу моста, карточки подтверждения и решения.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { interactionRequestPayloadSchema, threadDeltaSchema } from '@get-bb/plugin-sdk/provider-bridge';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import {
  CONFIRM_KIND, DECISION_KIND, ROUTE_KIND, TIMELINE_ICON_FILES, routePayloadSchema, timelineExtensionKinds, type ConfirmRequest, type DecisionRequest,
} from './contract.ts';
import {
  bridgeAskPort, confirmInteraction, consentFromDecision, createRouteTimeline, decide, decideAction, unwrapRequestAnswer,
  type CardInteraction, type RouteDelta,
} from './emitter.ts';
import { routeLabel, routePresentation } from './presentation.ts';
import { describeAnswer, registerTimelineServer, serverAskPort } from './server.ts';

const here = dirname(fileURLToPath(import.meta.url));
const NOW = Date.UTC(2026, 10, 27, 12, 0, 0);
const MIN = 60_000;
const ctx = { now: NOW, timeZone: 'UTC' };
const TRU = { machine: 'Tru', provider: 'Claude', account: 'Max', model: 'Opus' };
const MAC = { machine: 'Mac', provider: 'Claude', account: 'vclaude', model: 'Opus' };

function harness(ask?: (r: CardInteraction, s: AbortSignal) => Promise<unknown>) {
  const deltas: RouteDelta[] = [];
  const warnings: string[] = [];
  let n = 0;
  const timeline = createRouteTimeline({
    sink: d => deltas.push(d), ask, now: () => NOW, newId: () => `id${++n}`, timeZone: 'UTC', warn: w => warnings.push(w),
  });
  const rows = () => deltas.filter(d => d.kind === 'item.open').length;
  const closes = () => deltas.filter((d): d is Extract<RouteDelta, { kind: 'item.close' }> => d.kind === 'item.close');
  return { timeline, deltas, warnings, rows, closes };
}

test('свёрнутые строки: короткие подписи веса «Thought 8s»', () => {
  const label = (p: unknown) => routeLabel(routePayloadSchema.parse(p), ctx);
  const sw = { type: 'switch', from: TRU, to: MAC, at: NOW };
  assert.equal(label({ ...sw, reason: 'limit', state: 'done', steps: [{ label: 'пауза', ms: 500 }, { label: 'flush', ms: 3000 }] }).completed, 'Tru исчерпан → Mac · Opus · 3,5 с');
  assert.equal(label({ ...sw, reason: 'limit', state: 'running' }).pending, 'Tru исчерпан → Mac · Opus…');
  assert.equal(label({ type: 'switch', reason: 'return', window: 'Max', from: MAC, to: TRU, state: 'done', at: NOW }).completed, 'Лимит Max сброшен → Tru ← Mac');
  // S5: возврат Codex → Claude на той же машине — видно смену провайдера.
  const MAC_CODEX = { machine: 'Mac', provider: 'Codex', account: 'Codex' };
  assert.equal(label({ type: 'switch', reason: 'return', from: MAC_CODEX, to: MAC, state: 'done', at: NOW }).completed, 'Лимит сброшен → Mac · Claude ← Codex');
  assert.equal(label({ type: 'switch', reason: 'return', from: { ...MAC_CODEX, machine: 'UA' }, to: MAC, state: 'done', at: NOW }).completed, 'Лимит сброшен → Mac · Claude ← UA · Codex');
  assert.equal(label({ type: 'switch', reason: 'limit', from: MAC, to: MAC_CODEX, state: 'done', at: NOW }).completed, 'Mac · Claude исчерпан → Mac · Codex');
  assert.equal(label({ ...sw, reason: 'unavailable', state: 'done' }).completed, 'Tru не на связи → Mac · Opus');
  assert.equal(label({ ...sw, reason: 'limit', state: 'failed', error: 'копии разошлись' }).completed, 'Не перешёл на Mac: копии разошлись');
  assert.equal(label({ type: 'switch', reason: 'start', from: null, to: MAC, state: 'done', steps: [{ label: 's', ms: 1200 }], at: NOW }).completed, 'Ход на Mac · Opus · 1,2 с');
  assert.equal(label({ type: 'wait', cause: 'reset', window: 'Max', until: NOW + 12 * MIN, at: NOW }).pending, 'Жду сброса Max · 12:12');
  assert.equal(label({ type: 'wait', cause: 'offline', machine: 'Mac', outcome: 'Mac на связи', at: NOW }).completed, 'Жду Mac · Mac на связи');
});

test('строки ленты тихие: tint только у сбоя (хост красит им значок)', () => {
  const p = (x: unknown) => routePresentation(routePayloadSchema.parse(x), ctx);
  const ok = p({ type: 'switch', reason: 'limit', from: TRU, to: MAC, state: 'done', at: NOW });
  assert.equal(ok.tint, undefined);
  assert.equal(ok.icon.glyph, 'agentcli-subscriptions-cascade/route-switch');
  assert.equal(p({ type: 'wait', cause: 'offline', machine: 'Mac', at: NOW }).tint, undefined);
  assert.ok(p({ type: 'problem', message: 'x', at: NOW }).tint);
  assert.equal(p({ type: 'switch', reason: 'limit', from: TRU, to: MAC, state: 'failed', at: NOW }).icon.glyph, 'agentcli-subscriptions-cascade/route-error');
  assert.ok(p({ type: 'problem', message: 'x'.repeat(290), at: NOW }).label.completed.length <= 120);
});

test('переход — ровно одна строка: синхронизация и flush сворачиваются в неё', () => {
  const { timeline, deltas, warnings, rows, closes } = harness();
  const sw = timeline.emitSwitch({ reason: 'limit', window: 'Max', from: TRU, to: MAC, resetAt: NOW + 3_600_000, handoff: 'Возобновить сессию · события 13–14' });
  sw.step('пауза Tru', 110);
  const sync = timeline.emitSync({ from: 'Tru', to: 'Mac', files: 12, sample: ['src/a.ts'] });
  sync.progress(6, 2000);
  sync.done({ ms: 600, bytes: 48_000 });
  timeline.emitFlush({ from: 'Tru', to: 'Mac', ms: 150, verify: 'ok' });
  sw.done();
  assert.equal(rows(), 1);
  assert.deepEqual(warnings, []);
  const close = closes()[0]!;
  assert.equal(close.presentation.label.completed, 'Tru исчерпан → Mac · Opus · 0,9 с');
  const payload = close.item.payload;
  assert.ok(payload.type === 'switch');
  assert.deepEqual(payload.steps.map(s => s.label), ['пауза Tru', 'синхронизация Tru → Mac', 'flush Tru → Mac']);
  assert.equal(payload.verify, 'ok');
  assert.equal(payload.sync?.files, 12);
  assert.equal(payload.sync?.done, undefined, 'прогресс не остаётся в закрытой строке');
  assert.ok(deltas.some(d => d.kind === 'item.progress' && d.message === 'синхронизация 6 из 12 · ≈2 с'));
});

test('обычный ход строк не даёт: только состояние для метки «Mac · Opus»; flush после хода — тихо', () => {
  const { timeline, deltas, rows } = harness();
  const run = timeline.emitRun(MAC, { stepId: 'mac-claude', profileId: 'auto' });
  run.end();
  timeline.emitFlush({ from: 'Mac', to: 'Tru', ms: 600, verify: 'ok' });
  assert.equal(rows(), 0);
  const states = deltas.filter((d): d is Extract<RouteDelta, { kind: 'extension.state' }> => d.kind === 'extension.state');
  assert.equal(states[0]!.payload.phase, 'running');
  assert.equal(states[0]!.payload.stage?.machine, 'Mac');
  assert.equal(states.at(-1)!.payload.lastSync?.verify, 'ok');
  timeline.emitFlush({ from: 'Mac', to: 'Tru', ms: 900, verify: 'mismatch', mismatches: ['a.ts', 'b.ts'] });
  assert.equal(rows(), 1, 'расхождение после хода — одна запись в ленте');
});

test('каждое событие проходит схему thread/delta SDK, payload — свою схему', () => {
  const { timeline, deltas } = harness();
  const sw = timeline.emitSwitch({ reason: 'limit', from: TRU, to: MAC });
  timeline.emitSync({ from: 'Tru', to: 'Mac', files: 3, full: true }).done({ ms: 400 });
  sw.done();
  timeline.emitRun(MAC).end();
  timeline.emitWaiting({ cause: 'reset', window: 'Max', until: NOW + MIN }).resolve('лимит вернулся');
  timeline.emitFailure({ message: 'Mac пропал посреди хода', stage: MAC });
  timeline.emitSwitch({ reason: 'return', window: 'Max', from: MAC, to: TRU }).fail('копии разошлись', ['a.ts']);
  for (const delta of deltas) {
    const parsed = threadDeltaSchema.safeParse(delta);
    assert.ok(parsed.success, `${delta.kind}: ${parsed.success ? '' : parsed.error.message}`);
    if (delta.kind === 'item.open' || delta.kind === 'item.close') {
      assert.equal(delta.item.kind, ROUTE_KIND);
      assert.ok(timelineExtensionKinds.route.item.safeParse(delta.item.payload).success);
    }
    if (delta.kind === 'extension.state') assert.ok(timelineExtensionKinds.route.state.safeParse(delta.payload).success);
  }
});

test('синхронизация без перехода открывает переход «start»; новый переход закрывает незаконченный', () => {
  const { timeline, rows, closes } = harness();
  timeline.emitRun(MAC).end();
  timeline.emitSync({ from: 'Tru', to: 'Mac', files: 1 }).done({ ms: 200 });
  timeline.emitSwitch({ reason: 'limit', from: MAC, to: TRU });
  assert.equal(rows(), 2);
  const first = closes()[0]!.item.payload;
  assert.ok(first.type === 'switch' && first.reason === 'start' && first.state === 'failed');
});

test('ошибка в данных строки не роняет ход: строка пропущена, повторное закрытие — без события', () => {
  const { timeline, deltas, warnings } = harness();
  const bad = timeline.emitSwitch({ reason: 'limit', from: TRU, to: { machine: '' } });
  bad.done();
  assert.equal(bad.id, null);
  assert.equal(deltas.filter(d => d.kind === 'item.open').length, 0);
  assert.equal(warnings.length, 1);
  const sw = timeline.emitSwitch({ reason: 'limit', from: TRU, to: MAC });
  sw.done(); sw.fail('x');
  assert.equal(deltas.filter(d => d.kind === 'item.close').length, 1);
});

const confirmInput = {
  stepId: 'mac-codex', continuing: false, from: TRU, to: { machine: 'Mac', provider: 'Codex', account: 'Рабочий', model: 'GPT-6.2' },
  reason: 'лимит Max до 15:40', handoff: 'Новая сессия со сводкой', threadUntil: NOW + 220 * MIN,
};
const decisionInput = {
  title: 'Mac не на связи', message: 'Ход не повторён автоматически: на Mac мог остаться незавершённый инструмент.', stage: MAC,
  actions: [{ id: 'retry' as const, label: 'Повторить на Mac' }, { id: 'skip' as const, label: 'Пропустить Mac' }, { id: 'cancel' as const, label: 'Отменить ход' }],
};

test('подтверждение: «Да · в треде до сброса» → согласие consent.ts до сброса окна', async () => {
  let seen: CardInteraction | null = null;
  const { timeline } = harness(async request => {
    seen = request;
    return { kind: 'request_answer', value: { action: 'go', scope: 'thread', proposalId: request.data.proposalId, revision: request.data.revision } };
  });
  const decision = await timeline.requestConfirmation(confirmInput);
  assert.equal(seen!.kind, CONFIRM_KIND);
  assert.equal(seen!.title, 'Продолжить на Mac · Codex?');
  assert.equal(decision.action, 'go');
  const consent = consentFromDecision(decision, { stepId: 'mac-codex', bindingEpoch: 'e1', threadId: 'thr_1', turnId: 't1', projectId: 'p1', now: NOW }, null);
  assert.equal(consent?.scope, 'thread');
  assert.equal(consent?.until, NOW + 220 * MIN);
});

test('подтверждение: ответ на чужое предложение и запрещённое «навсегда» не исполняются', () => {
  const request = { ...confirmInput, proposalId: 'p1', revision: 2, returning: false, defaultScope: 'turn', allowForever: false } as ConfirmRequest;
  assert.equal(decide({ action: 'go', scope: 'turn', proposalId: 'p0', revision: 2 }, request).action, 'invalid');
  assert.equal(decide({ action: 'go', scope: 'turn', proposalId: 'p1', revision: 1 }, request).action, 'invalid');
  assert.equal(decide({ action: 'go', scope: 'forever', proposalId: 'p1', revision: 2 }, request).action, 'invalid');
  assert.equal(decide({ action: 'wait', proposalId: 'p1', revision: 2 }, request).action, 'wait');
  assert.equal(decide('мусор', request).action, 'invalid');
  assert.equal(decide({ dismissed: 'timeout' }, request).action, 'dismissed');
  assert.equal(unwrapRequestAnswer({ kind: 'request_answer', value: 1 }), 1);
});

test('решение при сбое: только предложенные действия', async () => {
  const request = { ...decisionInput, proposalId: 'p1', revision: 1 } as DecisionRequest;
  assert.equal(decideAction({ action: 'retry', proposalId: 'p1', revision: 1 }, request).action, 'retry');
  assert.equal(decideAction({ action: 'wait', proposalId: 'p1', revision: 1 }, request).action, 'invalid');
  const { timeline } = harness(async r => ({ action: 'skip', proposalId: r.data.proposalId, revision: r.data.revision }));
  const result = await timeline.requestDecision(decisionInput);
  assert.equal(result.action, 'skip');
});

test('карточки: новая заменяет старую, внешняя отмена снимает, ответ принимается один раз', async () => {
  const signals: AbortSignal[] = [];
  const answers: ((v: unknown) => void)[] = [];
  const { timeline } = harness((_, signal) => {
    signals.push(signal);
    return new Promise(resolve => answers.push(resolve));
  });
  const first = timeline.requestConfirmation(confirmInput);
  const second = timeline.requestDecision(decisionInput);
  assert.equal((await first).action, 'superseded');
  assert.equal(signals[0]!.aborted, true);
  assert.equal(await Promise.race([second, Promise.resolve(null)]), null, 'вторая карточка ждёт ответа');
  answers[1]!({ action: 'retry', proposalId: 'prop_id2', revision: 2 });
  answers[1]!({ action: 'cancel', proposalId: 'prop_id2', revision: 2 });
  assert.equal((await second).action, 'retry');
  const controller = new AbortController();
  const third = timeline.requestConfirmation(confirmInput, { signal: controller.signal });
  controller.abort();
  assert.equal((await third).action, 'superseded');
});

test('путь B: запросы карточек проходят interactionRequestPayloadSchema SDK, ошибка runtime → dismissed', async () => {
  const sent: CardInteraction[] = [];
  let fail = false;
  const { timeline } = harness(bridgeAskPort(async payload => {
    sent.push(payload);
    if (fail) throw new Error('runtime stopped waiting');
    return { kind: 'request_answer', value: { action: 'cancel', proposalId: payload.data.proposalId, revision: payload.data.revision } };
  }));
  assert.equal((await timeline.requestConfirmation(confirmInput)).action, 'cancel');
  assert.equal((await timeline.requestDecision(decisionInput)).action, 'cancel');
  for (const payload of sent) {
    const parsed = interactionRequestPayloadSchema.safeParse(payload);
    assert.ok(parsed.success, parsed.success ? '' : parsed.error.message);
  }
  assert.deepEqual(sent.map(s => s.kind), [CONFIRM_KIND, DECISION_KIND]);
  fail = true;
  assert.equal((await timeline.requestConfirmation(confirmInput)).action, 'dismissed');
});

test('без транспорта карточек: dismissed/unavailable, ход не запускается', async () => {
  const { timeline } = harness();
  assert.equal((await timeline.requestConfirmation(confirmInput)).action, 'dismissed');
});

test('путь A: bb.ui.requestInput с формами confirm-step и decide; отмена формы → dismissed', async () => {
  const calls: { rendererId: string; threadId: string; presentation: { icon: { glyph: string } } }[] = [];
  let outcome: unknown = { outcome: 'cancelled', reason: 'user' };
  const ui = { requestInput: async (req: never) => { calls.push(req); return outcome; } } as never;
  const { timeline } = harness(serverAskPort(ui, 'thr_1'));
  assert.equal((await timeline.requestConfirmation(confirmInput)).action, 'dismissed');
  assert.equal(calls[0]!.rendererId, 'confirm-step');
  assert.equal(calls[0]!.threadId, 'thr_1');
  assert.equal(calls[0]!.presentation.icon.glyph, 'agentcli-subscriptions-cascade/route-confirm');
  outcome = { outcome: 'submitted', value: { action: 'go', scope: 'turn', proposalId: 'prop_id2', revision: 2 } };
  assert.equal((await timeline.requestConfirmation(confirmInput)).action, 'go');
  outcome = { outcome: 'submitted', value: { action: 'retry', proposalId: 'prop_id3', revision: 3 } };
  assert.equal((await timeline.requestDecision(decisionInput)).action, 'retry');
  assert.equal(calls[2]!.rendererId, 'decide');
  const request = confirmInteraction({ ...confirmInput, proposalId: 'p', revision: 1, returning: false, defaultScope: 'turn', allowForever: true, preview: undefined } as ConfirmRequest);
  assert.equal(describeAnswer({ action: 'go', scope: 'thread' }, request), 'Mac · GPT-6.2 — в треде до сброса');
});

test('RPC схемы: без источника — null, с источником — данные движка, сбой источника — null', async () => {
  const { bb, harness: h } = createFakePluginHost({ pluginId: 'agentcli-subscriptions-cascade' });
  const server = registerTimelineServer(bb);
  assert.equal(await h.behavior.callRpc('threadScheme', { threadId: 'thr_1' }), null);
  const off = server.provideScheme(threadId => ({ name: 'Авто', text: `сейчас ${threadId}`, test: false, attempts: [{ stepId: 's' }], config: { steps: [] } }));
  assert.deepEqual(await h.behavior.callRpc('threadScheme', { threadId: 'thr_1' }), { name: 'Авто', text: 'сейчас thr_1', test: false, attempts: [{ stepId: 's' }], config: { steps: [] } });
  off();
  server.provideScheme(() => { throw new Error('нет'); });
  assert.equal(await h.behavior.callRpc('threadScheme', { threadId: 'thr_1' }), null);
  await h.lifecycle.dispose();
});

test('значки строк: файлы на месте, объявлены в манифесте, без опасных элементов', () => {
  const manifest = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
  const declared = manifest.bb?.branding?.experimental_icons ?? {};
  for (const [name, path] of Object.entries(TIMELINE_ICON_FILES)) {
    assert.ok(existsSync(join(here, '..', path)), `нет файла ${path}`);
    assert.equal(declared[name], path, `bb.branding.experimental_icons.${name} не объявлен`);
    const svg = readFileSync(join(here, '..', path), 'utf8');
    assert.ok(Buffer.byteLength(svg) < 32 * 1024 && !/<script|<style|\son\w+=/i.test(svg));
  }
});
