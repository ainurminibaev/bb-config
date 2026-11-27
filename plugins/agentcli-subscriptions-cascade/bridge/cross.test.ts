// Карточка подтверждения в ходе и переход Claude ↔ Codex внутри треда:
// сервер (confirm → answerConfirmation, сроки согласия, peekProvider),
// сводка и дельта событий треда, цикл карточек в запускателе, мост
// (interaction/request, переключение штатных мостов, нативные сессии и курсоры).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import type { Consent } from '../consent.ts';
import type { CascadeConfig } from '../contract.ts';
import { ACCOUNTS, MAC_CODEX, MAC_GW, TRU, TRU_MAX, UA_CODEX, UA_PRO, config as baseConfig, exhausted, ok } from '../fixtures.ts';
import { resolveRoute, type BridgeAnswer, type ConfirmPorts } from '../launcher/confirm.ts';
import { askBridge } from '../launcher/main.ts';
import { CONFIRM_KIND } from '../timeline/contract.ts';
import { createTimelineFeed } from './feed.ts';
import { buildHandoff, type ThreadEventRow } from './handoff.ts';
import type { ConfirmPrompt, NativeSessions, RouteTurnOutput } from './route-contract.ts';
import { createRouteService, type RouteDeps, type StoredThreadState } from './route-service.ts';
import { createCascadeBridge, type ServerPort } from './wrapper.ts';

const NOW = Date.parse('2026-11-27T12:00:00Z');
const TRU_RESET = Date.parse('2026-11-27T15:40:00Z');
const CLAUDE_OUT = { [TRU_MAX]: exhausted(TRU_RESET), [MAC_GW]: exhausted(null), [UA_PRO]: exhausted(null) };

function cfg(): CascadeConfig {
  const c = baseConfig();
  return { ...c, policies: { ...c.policies, executionMode: 'provider' } };
}

function fixture(options: { health?: Record<string, ReturnType<typeof exhausted> | typeof ok>; now?: () => number; events?: ThreadEventRow[] } = {}) {
  const store = new Map<string, StoredThreadState>();
  const project = new Map<string, Consent[]>();
  let now = NOW;
  const deps: RouteDeps = {
    loadConfig: async () => cfg(),
    accounts: () => ACCOUNTS,
    health: () => stepId => options.health?.[stepId] ?? ok,
    refreshLimits: async () => {},
    observeLimit: () => {},
    threadInfo: async () => ({ projectId: 'proj_1', hostId: TRU, parentThreadId: null, providerId: 'subscriptions-cascade' }),
    load: async id => store.get(id),
    save: async (id, s) => { store.set(id, s); },
    // Ход на чужой машине требует подготовленной папки (иначе отказ): фейковая синхронизация.
    sync: {
      prepareTurn: async () => ({ ok: true, cwd: '/opt/bbfs/proj', env: {}, timings: [], notices: [] }),
      finishTurn: async () => ({ ok: true, cwd: '/opt/bbfs/proj', env: {}, timings: [], notices: [] }),
    },
    now: () => now,
    projectConsents: async id => project.get(id) ?? [],
    saveProjectConsents: async (id, list) => { project.set(id, list); },
    threadEvents: async (_t, after) => (options.events ?? []).filter(e => e.seq > after),
  };
  return { routes: createRouteService(deps), store, project, setNow: (t: number) => { now = t; } };
}

/** Тред прошлым ходом был на Tru (Max), теперь всё Claude исчерпано. */
function seedOnTru(store: Map<string, StoredThreadState>, threadId = 'thr_1') {
  store.set(threadId, {
    engine: { threadId, projectId: 'proj_1', turnId: '', isSubthread: false, homeHostId: TRU, currentStepId: TRU_MAX, switchedAt: null, waitingSince: null, consents: [], skippedStepIds: [] },
    profileId: 'auto', lastRun: { stepId: TRU_MAX, hostId: TRU, providerId: 'claude-code', modelId: null, at: NOW - 60_000 }, pendingFlushHostId: null,
  });
}

const turn = (turnKey: string, provider: 'claude-code' | 'codex' = 'codex', threadId = 'thr_1') =>
  ({ threadId, projectId: 'proj_1', provider, requestedModel: 'auto', cwd: '/srv/projects/proj', turnKey });

function asConfirm(r: RouteTurnOutput) {
  assert.equal(r.action, 'confirm', JSON.stringify(r).slice(0, 300));
  return r as Extract<RouteTurnOutput, { action: 'confirm' }>;
}

test('карточка S3: все Claude исчерпаны → карточка Codex; «Да на этот ход» — ход идёт, следующий ход спрашивает снова', async () => {
  const fx = fixture({ health: CLAUDE_OUT });
  seedOnTru(fx.store);
  const card = asConfirm(await fx.routes.routeTurn(turn('k1')));
  assert.equal(card.providerId, 'codex');
  assert.equal(card.prompt.stepId, MAC_CODEX);
  assert.equal(card.prompt.continuing, false);
  assert.equal(card.prompt.threadUntil, TRU_RESET, 'граница тредового согласия — сброс окна Tru');
  assert.match(card.prompt.reason, /лимит Tru исчерпан до 15:40 UTC/u);
  assert.match(card.prompt.handoff ?? '', /Codex: новая сессия со сводкой/u);
  assert.equal(card.notes[0]!.kind, 'state');

  const answer = await fx.routes.answerConfirmation({ threadId: 'thr_1', stepId: MAC_CODEX, turnKey: 'k1', action: 'go', scope: 'turn', threadUntil: TRU_RESET });
  assert.equal(answer.next, 'continue');
  const run = await fx.routes.routeTurn(turn('k1'));
  assert.ok(run.action === 'run' && run.stepId === MAC_CODEX, 'тот же ход после «Да» — ход идёт');
  // Повтор routeTurn того же хода (вторая проба) — без новой карточки.
  assert.equal((await fx.routes.routeTurn(turn('k1'))).action, 'run');
  // Новый ход: разовое согласие кончилось — «Ещё один ход?».
  const again = asConfirm(await fx.routes.routeTurn(turn('k2')));
  assert.equal(again.prompt.continuing, true);
});

test('карточка: «в треде до сброса» действует до сброса, «всегда» — на другие треды проекта', async () => {
  const fx = fixture({ health: CLAUDE_OUT });
  seedOnTru(fx.store);
  asConfirm(await fx.routes.routeTurn(turn('k1')));
  await fx.routes.answerConfirmation({ threadId: 'thr_1', stepId: MAC_CODEX, turnKey: 'k1', action: 'go', scope: 'thread', threadUntil: TRU_RESET });
  assert.equal((await fx.routes.routeTurn(turn('k1'))).action, 'run');
  assert.equal((await fx.routes.routeTurn(turn('k2'))).action, 'run', 'тредовое согласие — без карточки');
  assert.equal(fx.store.get('thr_1')!.engine.consents.filter(c => c.scope === 'thread').length, 1);
  fx.setNow(TRU_RESET + 1);
  // После сброса окна Tru вернулся бы сам, но здесь Claude по-прежнему исчерпан: согласие истекло — снова карточка.
  asConfirm(await fx.routes.routeTurn(turn('k3')));

  const fy = fixture({ health: CLAUDE_OUT });
  seedOnTru(fy.store, 'thr_1');
  asConfirm(await fy.routes.routeTurn(turn('k1')));
  await fy.routes.answerConfirmation({ threadId: 'thr_1', stepId: MAC_CODEX, turnKey: 'k1', action: 'go', scope: 'forever', threadUntil: null });
  assert.equal(fy.project.get('proj_1')!.length, 1, '«всегда» — правило проекта, а не треда');
  assert.equal((await fy.routes.routeTurn(turn('k1'))).action, 'run');
  seedOnTru(fy.store, 'thr_2');
  assert.equal((await fy.routes.routeTurn(turn('n1', 'codex', 'thr_2'))).action, 'run', 'другой тред проекта — без карточки');
});

test('карточка: «Пропустить» — следующая ступень этого хода; «Ждать» — ожидание сброса; «Отменить» и закрытая — ход не идёт', async () => {
  const fx = fixture({ health: CLAUDE_OUT });
  seedOnTru(fx.store);
  asConfirm(await fx.routes.routeTurn(turn('k1')));
  await fx.routes.answerConfirmation({ threadId: 'thr_1', stepId: MAC_CODEX, turnKey: 'k1', action: 'skip' });
  const next = asConfirm(await fx.routes.routeTurn(turn('k1')));
  assert.equal(next.prompt.stepId, UA_CODEX);
  await fx.routes.answerConfirmation({ threadId: 'thr_1', stepId: UA_CODEX, turnKey: 'k1', action: 'skip' });
  const none = await fx.routes.routeTurn(turn('k1'));
  assert.equal(none.action, 'refuse', 'все ступени пропущены — ожидание сброса');
  assert.ok(none.action === 'refuse' && none.retryable);
  // Пропуски не переходят на следующий ход.
  assert.equal(asConfirm(await fx.routes.routeTurn(turn('k2'))).prompt.stepId, MAC_CODEX);

  const wait = await fx.routes.answerConfirmation({ threadId: 'thr_1', stepId: MAC_CODEX, turnKey: 'k2', action: 'wait', threadUntil: TRU_RESET });
  assert.equal(wait.next, 'refuse');
  assert.equal(wait.retryable, true);
  assert.ok(wait.notes.some(n => n.kind === 'wait' && n.until === TRU_RESET));
  const cancel = await fx.routes.answerConfirmation({ threadId: 'thr_1', stepId: MAC_CODEX, turnKey: 'k2', action: 'cancel' });
  assert.ok(cancel.next === 'refuse' && !cancel.retryable && /отменён/u.test(cancel.message));
  const dismissed = await fx.routes.answerConfirmation({ threadId: 'thr_1', stepId: MAC_CODEX, turnKey: 'k2', action: 'dismissed' });
  assert.ok(dismissed.next === 'refuse' && /без ответа/u.test(dismissed.message));
});

test('peekProvider: Claude свободен — claude-code; все Claude исчерпаны — codex (и для карточки)', async () => {
  const free = fixture();
  assert.equal((await free.routes.peekProvider({ threadId: 'thr_1' })).providerId, 'claude-code');
  const out = fixture({ health: CLAUDE_OUT });
  seedOnTru(out.store);
  const peek = await out.routes.peekProvider({ threadId: 'thr_1' });
  assert.equal(peek.providerId, 'codex');
  // Без побочных эффектов: состояние треда не изменилось.
  assert.equal(out.store.get('thr_1')!.engine.currentStepId, TRU_MAX);
});

const EVENTS: ThreadEventRow[] = [
  { seq: 3, type: 'client/turn/requested', data: { requestId: 'creq_1', input: [{ type: 'text', text: 'Сделай колонку KEEP-COLUMN, .env не трогай' }] } },
  { seq: 5, type: 'item/completed', data: { item: { type: 'reasoning', content: ['секретные мысли'] } } },
  { seq: 7, type: 'item/completed', data: { item: { type: 'commandExecution', command: 'npm test', status: 'completed', exitCode: 0 } } },
  { seq: 9, type: 'item/completed', data: { item: { type: 'agentMessage', text: 'Колонка добавлена, тесты прошли.' } } },
  { seq: 12, type: 'item/completed', data: { item: { type: 'fileChange', status: 'completed', changes: [{ path: 'src/a.ts' }] } } },
  { seq: 13, type: 'client/turn/requested', data: { requestId: 'creq_2', input: [{ type: 'text', text: 'Теперь EDIT-READY' }] } },
  { seq: 14, type: 'item/completed', data: { item: { type: 'agentMessage', text: 'RECEIPT-11' } } },
  { seq: 20, type: 'client/turn/requested', data: { requestId: 'creq_now', input: [{ type: 'text', text: 'текущий запрос' }] } },
];

test('сводка (первый переход) и дельта (возврат): seq, без рассуждений и без текущего запроса', () => {
  const snap = buildHandoff(EVENTS.filter(e => e.seq <= 12), { threadId: 'thr_x', afterSeq: 0, mode: 'snapshot', from: 'Claude', to: 'Codex', currentRequestId: null });
  assert.equal(snap.throughSeq, 12);
  assert.match(snap.text, /^<cascade-handoff from="Claude" to="Codex" through-seq="12">/u);
  assert.match(snap.text, /\[3\] Пользователь: Сделай колонку KEEP-COLUMN, \.env не трогай/u);
  assert.match(snap.text, /\[7\] Команда: `npm test` — completed, код 0/u);
  assert.match(snap.text, /\[12\] Правка файлов: src\/a\.ts/u);
  assert.match(snap.text, /bb thread messages thr_x --json --after-seq 0/u);
  assert.doesNotMatch(snap.text, /секретные мысли/u);

  const delta = buildHandoff(EVENTS, { threadId: 'thr_x', afterSeq: 12, mode: 'delta', from: 'Codex', to: 'Claude', currentRequestId: 'creq_now' });
  assert.equal(delta.throughSeq, 14, 'текущий запрос (seq 20) не входит, курсор — до него');
  assert.match(delta.text, /^<cascade-delta from="Codex" to="Claude" after-seq="12" through-seq="14">/u);
  assert.match(delta.text, /EDIT-READY[\s\S]*RECEIPT-11/u);
  assert.doesNotMatch(delta.text, /KEEP-COLUMN|текущий запрос/u, 'прежнее не дублируется, текущий запрос — отдельно');
  assert.match(delta.text, /--after-seq 12/u);
  // Пустой интервал — пустой текст, курсор на месте.
  assert.deepEqual(buildHandoff(EVENTS, { threadId: 'thr_x', afterSeq: 14, mode: 'delta', from: 'Codex', to: 'Claude', currentRequestId: 'creq_now' }), { text: '', throughSeq: 14 });
  // Предел: ранние события — ссылкой.
  const small = buildHandoff(EVENTS, { threadId: 'thr_x', afterSeq: 0, mode: 'snapshot', from: 'Claude', to: 'Codex', currentRequestId: 'creq_now', maxChars: 60 });
  assert.match(small.text, /Ранние события \(seq 1–\d+\) не вошли/u);
  assert.match(small.text, /RECEIPT-11/u);
});

test('сервер handoffBrief читает события треда после курсора', async () => {
  const fx = fixture({ events: EVENTS });
  const brief = await fx.routes.handoffBrief({ threadId: 'thr_1', afterSeq: 12, mode: 'delta', from: 'Codex', to: 'Claude', currentRequestId: 'creq_now' });
  assert.equal(brief.throughSeq, 14);
  assert.match(brief.text, /RECEIPT-11/u);
  const saved: NativeSessions = { outerId: 'c-1', active: 'codex', sessions: { 'claude-code': { nativeId: 'c-1', coveredSeq: 12 }, codex: { nativeId: 'x-1', coveredSeq: 12 } } };
  await fx.routes.nativeSessions('thr_1', saved);
  assert.deepEqual((await fx.routes.nativeSessions('thr_1', null)).sessions, saved);
});

// ---- Запускатель: цикл карточек ----

function confirmPorts(script: RouteTurnOutput[], answers: BridgeAnswer[]) {
  const calls: string[] = [];
  const prompt: ConfirmPrompt = { stepId: MAC_CODEX, continuing: false, returning: false, from: { machine: 'Tru' }, to: { machine: 'MacBook', provider: 'Codex' }, reason: 'лимит', handoff: null, threadUntil: TRU_RESET, allowForever: true };
  const ports: ConfirmPorts = {
    routeTurn: async key => { calls.push(`route:${key}`); return script.shift()!; },
    ask: async (p, key) => { calls.push(`ask:${p.stepId}:${key}`); return answers.shift()!; },
    answer: async a => {
      calls.push(`answer:${a.action}:${a.scope ?? '-'}:${a.threadUntil}`);
      return a.action === 'go' || a.action === 'skip' ? { next: 'continue', message: '', retryable: false, notes: [] } : { next: 'refuse', message: a.action, retryable: a.action === 'wait', notes: [] };
    },
    feed: async () => {},
    log: () => {},
  };
  return { ports, calls, card: { action: 'confirm', prompt, providerId: 'codex', notes: [] } as RouteTurnOutput };
}

const RUN: RouteTurnOutput = { action: 'run', stepId: MAC_CODEX, hostId: 'host_mac', providerId: 'codex', modelId: null, local: false, cwd: null, env: {}, stage: { machine: 'MacBook' }, notes: [] };

test('запускатель: карточка ждёт ответа; «Да» — тот же ход идёт с тем же turnKey', async () => {
  const fx = confirmPorts([], []);
  const go = confirmPorts([fx.card, RUN], [{ action: 'go', scope: 'thread' }]);
  const result = await resolveRoute(go.ports, 'turn-a');
  assert.equal(result.action, 'run');
  assert.deepEqual(go.calls, ['route:turn-a', `ask:${MAC_CODEX}:turn-a`, `answer:go:thread:${TRU_RESET}`, 'route:turn-a']);
  const wait = confirmPorts([fx.card], [{ action: 'wait' }]);
  const waited = await resolveRoute(wait.ports, 'turn-b');
  assert.ok(waited.action === 'refuse' && waited.retryable);
  const nobody = confirmPorts([fx.card], [{ action: 'unavailable', reason: 'нет моста' }]);
  const refused = await resolveRoute(nobody.ports, 'turn-c');
  assert.ok(refused.action === 'refuse' && /карточку показать не удалось \(нет моста\)/u.test(refused.message));
  assert.ok(!nobody.calls.some(c => c.startsWith('answer')), 'без ответа владельца серверу ничего не пишется');
});

test('запускатель: нет сокета моста — карточка недоступна, ход не идёт', async () => {
  const card = confirmPorts([], []).card as Extract<RouteTurnOutput, { action: 'confirm' }>;
  const answer = await askBridge({ env: {} }, 'thr_1', card.prompt, 'k');
  assert.equal(answer.action, 'unavailable');
});

// ---- Мост: карточка и переход между провайдерами ----

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

interface FakeInner { lines: Record<string, unknown>[]; handle(m: Record<string, unknown>): void }

/** Кэш с двумя штатными мостами и обёртка над ними с фальшивым сервером. */
function switchFixture(server: Partial<Record<string, (input: Record<string, unknown>) => unknown>>, behave: { claudeResume?: 'ok' | 'fail' } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cascade-cross-')));
  const digests: Record<string, string> = {};
  for (const [provider, pluginId] of [['claude-code', 'provider-claude-code'], ['codex', 'provider-codex']] as const) {
    const source = `// ${provider}`;
    digests[provider] = sha(source);
    mkdirSync(join(root, pluginId, digests[provider]!), { recursive: true });
    writeFileSync(join(root, pluginId, digests[provider]!, 'host.mjs'), source);
  }
  const out: Record<string, unknown>[] = [];
  const calls: [string, Record<string, unknown>][] = [];
  let bridge!: ReturnType<typeof createCascadeBridge>;
  const emit = (m: unknown) => bridge.ingestInnerOutput(`${JSON.stringify(m)}\n`);
  let sessions = 0;
  const makeInner = (provider: 'claude' | 'codex'): FakeInner => {
    const inner: FakeInner = {
      lines: [],
      handle(m) {
        inner.lines.push(m);
        const params = (m.params ?? {}) as Record<string, unknown>;
        if (m.method === 'initialize') emit({ jsonrpc: '2.0', id: m.id, result: { ok: true } });
        if (m.method === 'thread/start') emit({ jsonrpc: '2.0', id: m.id, result: { providerThreadId: `${provider}-s${sessions += 1}`, sessionRestorable: true } });
        if (m.method === 'thread/resume') {
          if (provider === 'claude' && behave.claudeResume === 'fail') emit({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: 'session file missing' } });
          else emit({ jsonrpc: '2.0', id: m.id, result: { providerThreadId: params.providerThreadId, sessionRestorable: true } });
        }
        if (m.method === 'turn/start') {
          emit({ jsonrpc: '2.0', id: m.id, result: { providerTurnId: `${provider}-t` } });
          emit({ jsonrpc: '2.0', method: 'thread/delta', params: { threadId: params.threadId, providerThreadId: params.providerThreadId, deltas: [{ kind: 'turn.open', providerTurnId: `${provider}-t` }] } });
        }
      },
    };
    return inner;
  };
  const claude = makeInner('claude');
  const codex = makeInner('codex');
  const port: ServerPort = {
    async call<T>(method: string, input: unknown): Promise<T> {
      calls.push([method, input as Record<string, unknown>]);
      const handler = server[method];
      if (!handler) throw new Error(`нет ${method}`);
      return handler(input as Record<string, unknown>) as T;
    },
  };
  bridge = createCascadeBridge({
    providerId: 'subscriptions-cascade',
    ownArtifactUrl: pathToFileURL('/x/a/b/host.mjs').href,
    loadDeps: {
      cacheRoot: root,
      importModule: async url => ({ experimental_providerBridge: { experimental_apiVersion: 1, handleLine: (l: string) => (url.includes('provider-codex') ? codex : claude).handle(JSON.parse(l) as Record<string, unknown>) } }),
    },
    feed: createTimelineFeed({ now: () => NOW }),
    server: port,
    write: line => { out.push(JSON.parse(line) as Record<string, unknown>); },
    socketDir: root,
    innerTimeoutMs: 2_000,
  });
  const options = { providerOptions: { cascade: { provider: 'claude-code', digests } } };
  const flush = () => new Promise(r => setTimeout(r, 20));
  return { bridge, out, calls, claude, codex, options, flush };
}

test('мост S3/S5: Claude → Codex (новая сессия со сводкой) → Claude (resume + дельта), BB видит один providerThreadId', async () => {
  let peek: 'claude-code' | 'codex' = 'claude-code';
  let saved: NativeSessions | null = null;
  const fx = switchFixture({
    nativeSessions: input => { if (input.sessions) saved = input.sessions as NativeSessions; return { sessions: input.sessions ?? saved }; },
    peekProvider: () => ({ providerId: peek, modelId: peek === 'codex' ? 'gpt-6.2-sol' : null, stage: null }),
    handoffBrief: input => input.mode === 'snapshot' ? { text: 'SNAPSHOT-0-12', throughSeq: 12 } : { text: `DELTA-${input.afterSeq}-14`, throughSeq: 14 },
  });
  const { bridge, out, claude, codex, options } = fx;
  bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
  bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'thread/start', params: { threadId: 'thr_1', cwd: '/p', options: { ...options, model: 'auto' } } }));
  await fx.flush();
  const outer = ((out.find(m => m.id === 2)!.result) as { providerThreadId: string }).providerThreadId;
  assert.equal(outer, 'claude-s1');
  // Ход 1 — Claude, без переключения.
  bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'turn/start', params: { threadId: 'thr_1', providerThreadId: outer, clientRequestId: 'creq_1', input: [{ type: 'text', text: 'привет' }], options } }));
  await fx.flush();
  assert.equal(claude.lines.filter(l => l.method === 'turn/start').length, 1);

  // Ход 2 — все Claude исчерпаны: Codex, новая сессия, сводка первым элементом ввода.
  peek = 'codex';
  bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'turn/start', params: { threadId: 'thr_1', providerThreadId: outer, clientRequestId: 'creq_2', input: [{ type: 'text', text: 'дальше' }], options: { ...options, model: 'auto' } } }));
  await fx.flush();
  const codexStart = codex.lines.find(l => l.method === 'thread/start')!;
  assert.ok(codexStart, 'у Codex своя нативная сессия');
  const codexTurn = codex.lines.find(l => l.method === 'turn/start')! as { params: { providerThreadId: string; input: { text: string }[]; options: { model?: string; providerOptions: { cascade: { provider: string } } } } };
  assert.equal(codexTurn.params.providerThreadId, 'codex-s2');
  assert.deepEqual(codexTurn.params.input.map(i => i.text), ['SNAPSHOT-0-12', 'дальше']);
  assert.equal(codexTurn.params.options.model, 'gpt-6.2-sol', 'Codex получает модель ступени, а не профиль каскада');
  assert.equal(codexTurn.params.options.providerOptions.cascade.provider, 'codex');
  assert.deepEqual(saved, { outerId: 'claude-s1', active: 'codex', sessions: { 'claude-code': { nativeId: 'claude-s1', coveredSeq: 12 }, codex: { nativeId: 'codex-s2', coveredSeq: 12 } } });
  // Вывод Codex идёт в BB под providerThreadId треда.
  const codexDelta = out.filter(m => m.method === 'thread/delta').at(-1)!.params as { providerThreadId: string };
  assert.equal(codexDelta.providerThreadId, 'claude-s1');
  assert.ok(!out.some(m => (m.result as { providerThreadId?: string } | undefined)?.providerThreadId === 'codex-s2'), 'служебный ответ thread/start в BB не уходит');
  // Прочие команды треда — активному мосту с его ID сессии.
  bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'turn/interrupt', params: { threadId: 'thr_1', providerThreadId: outer } }));
  await fx.flush();
  assert.equal((codex.lines.at(-1) as { method: string; params: { providerThreadId: string } }).params.providerThreadId, 'codex-s2');

  // Ход 3 — Claude свободен: возврат в прежнюю сессию (resume) + дельта после её курсора (12).
  peek = 'claude-code';
  bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'turn/start', params: { threadId: 'thr_1', providerThreadId: outer, clientRequestId: 'creq_3', input: [{ type: 'text', text: 'вернулись' }], options } }));
  await fx.flush();
  const resume = claude.lines.find(l => l.method === 'thread/resume') as { params: { providerThreadId: string } } | undefined;
  assert.equal(resume?.params.providerThreadId, 'claude-s1');
  const back = claude.lines.filter(l => l.method === 'turn/start').at(-1) as { params: { providerThreadId: string; input: { text: string }[] } };
  assert.equal(back.params.providerThreadId, 'claude-s1');
  assert.deepEqual(back.params.input.map(i => i.text), ['DELTA-12-14', 'вернулись']);
  assert.deepEqual((saved as NativeSessions | null)!.sessions, { 'claude-code': { nativeId: 'claude-s1', coveredSeq: 14 }, codex: { nativeId: 'codex-s2', coveredSeq: 14 } });
  assert.equal((saved as NativeSessions | null)!.active, 'claude-code');
  await bridge.close();
});

test('мост: прежняя сессия Claude недоступна — новая сессия со сводкой и строка в ленте', async () => {
  const saved: NativeSessions = { outerId: 'claude-s0', active: 'codex', sessions: { 'claude-code': { nativeId: 'claude-s0', coveredSeq: 12 }, codex: { nativeId: 'codex-s9', coveredSeq: 12 } } };
  const briefs: Record<string, unknown>[] = [];
  const fx = switchFixture({
    nativeSessions: input => ({ sessions: input.sessions ?? saved }),
    peekProvider: () => ({ providerId: 'claude-code', modelId: null, stage: null }),
    handoffBrief: input => { briefs.push(input); return input.mode === 'snapshot' ? { text: 'SNAPSHOT-FULL', throughSeq: 14 } : { text: 'DELTA', throughSeq: 14 }; },
  }, { claudeResume: 'fail' });
  const { bridge, out, claude, options } = fx;
  bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
  // Мост перезапущен: BB возобновляет тред по своему providerThreadId — активен Codex.
  bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'thread/resume', params: { threadId: 'thr_1', providerThreadId: 'claude-s0', cwd: '/p', options } }));
  await fx.flush();
  assert.equal((fx.codex.lines.find(l => l.method === 'thread/resume') as { params: { providerThreadId: string } }).params.providerThreadId, 'codex-s9');
  bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'turn/start', params: { threadId: 'thr_1', providerThreadId: 'claude-s0', clientRequestId: 'creq_4', input: [{ type: 'text', text: 'снова Claude' }], options } }));
  await fx.flush();
  assert.deepEqual(briefs.map(b => [b.mode, b.afterSeq]), [['delta', 12], ['snapshot', 0]]);
  const turnStart = claude.lines.filter(l => l.method === 'turn/start').at(-1) as { params: { providerThreadId: string; input: { text: string }[] } };
  assert.match(turnStart.params.providerThreadId, /^claude-s\d+$/u);
  assert.notEqual(turnStart.params.providerThreadId, 'claude-s0');
  assert.equal(turnStart.params.input[0]!.text, 'SNAPSHOT-FULL');
  const rows = out.filter(m => m.method === 'thread/delta').flatMap(m => (m.params as { deltas: { kind: string; item?: { payload?: { message?: string } } }[] }).deltas);
  assert.ok(rows.some(d => d.kind === 'item.open' && /Прежняя сессия Claude недоступна/u.test(JSON.stringify(d))), 'строка в ленте о новой сессии');
  await bridge.close();
});

test('мост: сервер не ответил — ход остаётся у активного провайдера', async () => {
  const fx = switchFixture({});
  const { bridge, claude, codex, options } = fx;
  bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
  bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'thread/start', params: { threadId: 'thr_1', cwd: '/p', options } }));
  bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'turn/start', params: { threadId: 'thr_1', providerThreadId: 'claude-s1', input: [{ type: 'text', text: 'x' }], options } }));
  await fx.flush();
  await bridge.close();
  assert.equal(claude.lines.filter(l => l.method === 'turn/start').length, 1);
  assert.equal(codex.lines.length, 0);
});

test('мост: карточка — interaction/request в runtime с payload формы каскада, ответ разобран (CAS)', async () => {
  const fx = switchFixture({ nativeSessions: () => ({ sessions: null }), peekProvider: () => ({ providerId: 'claude-code', modelId: null, stage: null }) });
  const { bridge, out, options } = fx;
  bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
  bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'thread/start', params: { threadId: 'thr_1', cwd: '/p', options } }));
  bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'turn/start', params: { threadId: 'thr_1', providerThreadId: 'claude-s1', input: [], options } }));
  await fx.flush();
  // Без сокета (песочница): вызов карточки напрямую через ленту с транспортом моста.
  const feed = createTimelineFeed({ now: () => NOW });
  const prompt: ConfirmPrompt = { stepId: MAC_CODEX, continuing: false, returning: false, from: { machine: 'Tru', provider: 'Claude' }, to: { machine: 'MacBook', provider: 'Codex' }, reason: 'лимит Tru исчерпан до 15:40 UTC', handoff: 'Codex: новая сессия со сводкой треда', threadUntil: TRU_RESET, allowForever: true };
  const sent: unknown[] = [];
  const pending = feed.confirm!('thr_1', prompt, async payload => {
    sent.push(payload);
    const data = (payload as { data: { proposalId: string; revision: number } }).data;
    return { kind: 'request_answer', value: { action: 'go', scope: 'thread', proposalId: data.proposalId, revision: data.revision } };
  }, 'claude-t', new AbortController().signal);
  assert.deepEqual(await pending, { action: 'go', scope: 'thread' });
  const payload = sent[0] as { kind: string; title: string; data: { threadUntil: number; to: { provider: string } } };
  assert.equal(payload.kind, CONFIRM_KIND);
  assert.match(payload.title, /Продолжить на MacBook · Codex\?/u);
  assert.equal(payload.data.threadUntil, TRU_RESET);
  // Ответ к другой карточке — спросить заново; «навсегда» при запрете — тоже.
  let asks = 0;
  const retry = await feed.confirm!('thr_1', { ...prompt, allowForever: false }, async payload => {
    asks += 1;
    const data = (payload as { data: { proposalId: string; revision: number } }).data;
    return { kind: 'request_answer', value: asks === 1 ? { action: 'go', scope: 'turn', proposalId: 'чужая', revision: 1 } : asks === 2 ? { action: 'go', scope: 'forever', ...data } : { action: 'skip', ...data } };
  }, undefined, new AbortController().signal);
  assert.equal(asks, 3);
  assert.deepEqual(retry, { action: 'skip' });
  // Отказ runtime показать — карточка недоступна; снятая карточка (ход прерван) — закрыта.
  assert.equal((await feed.confirm!('thr_1', prompt, async () => { throw new Error('нет'); }, undefined, new AbortController().signal)).action, 'unavailable');
  const aborted = new AbortController();
  const hanging = feed.confirm!('thr_1', prompt, () => new Promise(() => {}), undefined, aborted.signal);
  aborted.abort();
  assert.deepEqual(await hanging, { action: 'dismissed' });
  // Мост знает providerThreadId треда (из ответа на thread/start) — карточка адресуема.
  assert.equal((out.find(m => m.id === 2)!.result as { providerThreadId: string }).providerThreadId, 'claude-s1');
  await bridge.close();
});

test('сквозная карточка: запускатель → сокет моста → interaction/request → ответ владельца → запускатель', async t => {
  const { createServer } = await import('node:net');
  const probe = join(realpathSync(mkdtempSync(join(tmpdir(), 'cxp-'))), 's.sock');
  const canListen = await new Promise<boolean>(resolve => { const s = createServer(); s.on('error', () => resolve(false)); s.listen(probe, () => s.close(() => resolve(true))); });
  if (!canListen) { t.skip('unix-сокеты недоступны в этой среде'); return; }
  const fx = switchFixture({ nativeSessions: () => ({ sessions: null }), peekProvider: () => ({ providerId: 'claude-code', modelId: null, stage: null }) });
  const { bridge, out, options } = fx;
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'cxd-')));
  const before = { claude: process.env.BB_CLAUDE_CODE_EXECUTABLE, codex: process.env.BB_CODEX_BRIDGE_APP_SERVER_COMMAND };
  bridge.start!({ pluginId: 'agentcli-subscriptions-cascade', dataDir, tempDir: dataDir });
  try {
    await fx.flush();
    const { readFileSync } = await import('node:fs');
    const socket = readFileSync(process.env.BB_CLAUDE_CODE_EXECUTABLE!, 'utf8').match(/CASCADE_FEED_SOCKET='([^']+)'/u)?.[1];
    assert.ok(socket);
    bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
    bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'thread/start', params: { threadId: 'thr_1', cwd: '/p', options } }));
    bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'turn/start', params: { threadId: 'thr_1', providerThreadId: 'claude-s1', input: [], options } }));
    await fx.flush();
    const prompt: ConfirmPrompt = { stepId: MAC_CODEX, continuing: false, returning: false, from: { machine: 'Tru' }, to: { machine: 'MacBook', provider: 'Codex' }, reason: 'лимит', handoff: null, threadUntil: TRU_RESET, allowForever: true };
    const answer = askBridge({ env: { CASCADE_FEED_SOCKET: socket } }, 'thr_1', prompt, 'turn-1');
    let request: { id: string; params: { providerThreadId: string; turnId: string | null; payload: { kind: string; data: { proposalId: string; revision: number } } } } | undefined;
    for (let i = 0; i < 50 && !request; i += 1) { await fx.flush(); request = out.find(m => m.method === 'interaction/request') as typeof request; }
    assert.ok(request, 'мост отправил interaction/request');
    assert.equal(request!.params.providerThreadId, 'claude-s1');
    assert.equal(request!.params.turnId, 'claude-t', 'карточка — внутри текущего хода');
    assert.equal(request!.params.payload.kind, CONFIRM_KIND);
    const data = request!.params.payload.data;
    bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: request!.id, result: { kind: 'request_answer', value: { action: 'go', scope: 'turn', proposalId: data.proposalId, revision: data.revision } } }));
    assert.deepEqual(await answer, { action: 'go', scope: 'turn' });
  } finally {
    await bridge.close();
    if (before.claude === undefined) delete process.env.BB_CLAUDE_CODE_EXECUTABLE; else process.env.BB_CLAUDE_CODE_EXECUTABLE = before.claude;
    if (before.codex === undefined) delete process.env.BB_CODEX_BRIDGE_APP_SERVER_COMMAND; else process.env.BB_CODEX_BRIDGE_APP_SERVER_COMMAND = before.codex;
  }
});
