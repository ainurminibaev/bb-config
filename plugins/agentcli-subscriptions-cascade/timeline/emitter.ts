// API ленты для исполнителя хода. Один экземпляр — один тред.
//
//   const tl = createRouteTimeline({ sink, ask, ... });
//   const sw = tl.emitSwitch({ reason: 'limit', window: 'Max', from: TRU, to: MAC, resetAt });
//   sw.step('пауза Tru', 110);
//   const sync = tl.emitSync({ from: 'Tru', to: 'Mac', files: 12 });  // шаг внутри строки перехода
//   sync.progress(6); sync.done({ ms: 600 });
//   tl.emitFlush({ from: 'Tru', to: 'Mac', ms: 600, verify: 'ok' });  // внутри перехода — шаг
//   sw.done();                                       // «Tru исчерпан → Mac · Opus · 1,0 с»
//   const run = tl.emitRun(MAC);                      // строк нет: метка «Mac · Opus» в контексте треда
//   run.end();
//   tl.emitFlush({ from: 'Mac', to: 'Tru', ms: 600, verify: 'ok' });  // после хода — тихо, в состояние
//   const d = await tl.requestConfirmation({...});    // карточка над полем ввода
//   const r = await tl.requestDecision({...});        // сбой, нужен выбор владельца
//
// Транспорт не зашит:
// - sink(delta) — элементы thread/delta моста (item.open / item.progress /
//   item.close / extension.state) в форме Provider Bridge Protocol;
// - ask(request, signal) — показ карточки и ожидание ответа: путь B — мост шлёт
//   `interaction/request` (bridgeAskPort), путь A — bb.ui.requestInput (serverAskPort).
// Ошибка в данных строки не роняет ход: строка пропускается, причина уходит в warn.
import { grant, type Consent, type ConsentContext } from '../consent.ts';
import {
  CONFIRM_KIND, DECISION_KIND, ROUTE_KIND, confirmAnswerSchema, confirmRequestSchema, decisionAnswerSchema,
  decisionRequestSchema, routePayloadSchema, routeStateSchema,
  type ConfirmRequest, type ConfirmRequestInput, type DecisionActionId, type DecisionRequest, type DecisionRequestInput,
  type RoutePayload, type RoutePayloadInput, type RouteState, type StageRef, type StepTiming, type SwitchPayload,
} from './contract.ts';
import { files } from './format.ts';
import { routePresentation, stageShort, type RoutePresentation } from './presentation.ts';

type ItemKey = { providerItemId: string };
type ExtensionItem = { type: 'extension'; kind: typeof ROUTE_KIND; payload: RoutePayload };
export type RouteDelta =
  | { kind: 'item.open'; key: ItemKey; item: ExtensionItem; presentation: RoutePresentation; providerTurnId?: string }
  | { kind: 'item.progress'; key: ItemKey; message: string; providerTurnId?: string }
  | { kind: 'item.close'; key: ItemKey; item: ExtensionItem; presentation: RoutePresentation; status: 'completed'; providerTurnId?: string }
  | { kind: 'extension.state'; extensionKind: typeof ROUTE_KIND; payload: RouteState };

/** Полезная нагрузка `interaction/request` для карточек над полем ввода. */
export type CardInteraction =
  | { kind: typeof CONFIRM_KIND; title: string; data: ConfirmRequest }
  | { kind: typeof DECISION_KIND; title: string; data: DecisionRequest };
export type ConfirmInteraction = Extract<CardInteraction, { kind: typeof CONFIRM_KIND }>;

/** Ответ ask: значение формы (`request_answer.value`) или отказ показа. */
export type AskResult = unknown;
type Dismissed = { dismissed: 'cancelled' | 'timeout' | 'unavailable' };

export interface TimelinePorts {
  sink(delta: RouteDelta): void;
  ask?(request: CardInteraction, signal: AbortSignal): Promise<AskResult>;
  /** providerTurnId текущего хода, если мост его знает. */
  turnId?(): string | undefined;
  now?(): number;
  newId?(): string;
  timeZone?: string;
  warn?(message: string): void;
}

type Settled<R> =
  /** Карточку заменила новая (смена кандидата) или исполнитель снял её сам. */
  | { action: 'superseded'; request: R }
  /** Форму закрыли без выбора или истёк срок — ход остаётся ожидающим. */
  | { action: 'dismissed'; reason: Dismissed['dismissed']; request: R }
  /** Ответ не разобран или относится к другой карточке — не исполнять, спросить заново. */
  | { action: 'invalid'; reason: string; request: R };

export type ConfirmationDecision =
  | { action: 'go'; scope: 'turn' | 'thread' | 'forever'; request: ConfirmRequest }
  | { action: 'skip' | 'wait' | 'cancel'; request: ConfirmRequest }
  | Settled<ConfirmRequest>;

export type DecisionResult = { action: DecisionActionId; request: DecisionRequest } | Settled<DecisionRequest>;

export interface SwitchInput {
  reason: SwitchPayload['reason'];
  window?: string;
  from: StageRef | null;
  to: StageRef;
  resetAt?: number | null;
  handoff?: string;
  stepId?: string;
  at?: number;
}
export interface SyncInput { from: string; to: string; files: number; bytes?: number; full?: boolean; sample?: string[] }
export interface FlushInput { from: string; to: string; ms: number; verify: 'ok' | 'mismatch' | 'skipped'; mismatches?: string[] }

export interface RowHandle { readonly id: string | null }
export interface SwitchHandle extends RowHandle {
  /** Шаг перехода с длительностью: «пауза Tru 110 мс». */
  step(label: string, ms: number, state?: StepTiming['state']): void;
  /**
   * Подготовка идёт: шаги и счётчики заменяются целиком, текст обновляет ту же
   * строку (item.progress) — «Подготовка Mac: синхронизация Tru → Mac · 23 % · 0:47».
   */
  report(input: { steps: StepTiming[]; sync?: { files: number; done?: number; bytes?: number }; message: string }): void;
  done(patch?: { handoff?: string }): void;
  fail(error: string, mismatches?: string[]): void;
}
export interface SyncHandle {
  progress(done: number, etaMs?: number): void;
  done(result?: { ms?: number; bytes?: number; sample?: string[] }): void;
  fail(error: string, ms?: number): void;
}
export interface WaitHandle extends RowHandle { resolve(outcome?: string): void }
export interface RunHandle { end(): void }

export interface RouteTimeline {
  emitSwitch(input: SwitchInput): SwitchHandle;
  emitSync(input: SyncInput): SyncHandle;
  emitFlush(input: FlushInput): void;
  emitRun(stage: StageRef, options?: { stepId?: string; profileId?: string }): RunHandle;
  emitWaiting(input: { cause: 'reset' | 'offline' | 'recheck'; machine?: string; window?: string; until?: number | null; note?: string; stepId?: string }): WaitHandle;
  emitFailure(input: { message: string; stage?: StageRef; note?: string; resolution?: string; stepId?: string }): RowHandle;
  setRouteState(phase: RouteState['phase'], stage: StageRef | null, extra?: Pick<RouteState, 'stepId' | 'profileId'>): void;
  requestConfirmation(input: Omit<ConfirmRequestInput, 'proposalId' | 'revision'> & { proposalId?: string; revision?: number }, options?: { signal?: AbortSignal }): Promise<ConfirmationDecision>;
  requestDecision(input: Omit<DecisionRequestInput, 'proposalId' | 'revision'> & { proposalId?: string; revision?: number }, options?: { signal?: AbortSignal }): Promise<DecisionResult>;
  /** Снять ожидающую карточку (кандидат сменился, ход отменён). */
  supersedeConfirmation(): void;
}

const NONE: RowHandle = { id: null };
/** JSON-копия: поле со значением undefined протокол моста не принимает. */
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function createRouteTimeline(ports: TimelinePorts): RouteTimeline {
  const now = ports.now ?? Date.now;
  const newId = ports.newId ?? (() => globalThis.crypto.randomUUID());
  const warn = ports.warn ?? (() => {});
  let pendingCard: { controller: AbortController; supersede(): void } | null = null;
  let revision = 0;
  let state: RouteState = { phase: 'idle', stage: null, at: now() };
  let openSwitch: ReturnType<typeof open> = null;

  const ctx = () => ({ now: now(), timeZone: ports.timeZone });
  const turn = () => {
    const id = ports.turnId?.();
    return id ? { providerTurnId: id } : {};
  };

  function parse(input: RoutePayloadInput): RoutePayload | null {
    const parsed = routePayloadSchema.safeParse(input);
    if (parsed.success) return plain(parsed.data);
    warn(`лента: строка «${input.type}» пропущена — ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    return null;
  }

  function send(delta: RouteDelta): void {
    try { ports.sink(delta); } catch (error) { warn(`лента: sink — ${error instanceof Error ? error.message : String(error)}`); }
  }

  /** Открытая строка: pending до close. Закрываем как completed — сбой несёт payload и значок. */
  function open(input: RoutePayloadInput) {
    const first = parse(input);
    if (!first) return null;
    const key = { providerItemId: `cascade:${newId()}` };
    let current: RoutePayload = first;
    let closed = false;
    send({ kind: 'item.open', key, item: item(current), presentation: routePresentation(current, ctx()), ...turn() });
    return {
      id: key.providerItemId,
      get closed() { return closed; },
      get payload() { return current; },
      /** Изменить payload открытой строки (без события) — попадёт в close. */
      patch(update: (p: RoutePayload) => RoutePayloadInput) { if (!closed) current = parse(update(current)) ?? current; },
      progress(message: string) { if (!closed) send({ kind: 'item.progress', key, message, ...turn() }); },
      close(update?: (p: RoutePayload) => RoutePayloadInput) {
        if (closed) return;
        closed = true;
        if (update) current = parse(update(current)) ?? current;
        send({ kind: 'item.close', key, item: item(current), presentation: routePresentation(current, ctx()), status: 'completed', ...turn() });
      },
    };
  }

  function setState(next: Partial<RouteState>): void {
    const parsed = routeStateSchema.safeParse({ ...state, ...next, at: now() });
    if (!parsed.success) { warn(`лента: состояние пропущено — ${parsed.error.message}`); return; }
    state = plain(parsed.data);
    send({ kind: 'extension.state', extensionKind: ROUTE_KIND, payload: state });
  }

  const asSwitch = (p: RoutePayload) => p as SwitchPayload;

  function addStep(label: string, ms: number, stepState: StepTiming['state'] = 'done'): void {
    openSwitch?.patch(p => {
      const s = asSwitch(p);
      const steps = s.steps.filter(x => !(x.label === label && x.state === 'running'));
      return { ...s, steps: [...steps, { label, ms, state: stepState }] };
    });
  }

  function emitSwitch(input: SwitchInput): SwitchHandle {
    if (openSwitch && !openSwitch.closed) openSwitch.close(p => ({ ...asSwitch(p), state: 'failed', error: 'переход заменён новым' }));
    const row = open({ type: 'switch', state: 'running', steps: [], ...input, at: input.at ?? now() });
    openSwitch = row;
    if (!row) return { id: null, step() {}, report() {}, done() {}, fail() {} };
    setState({ phase: 'preparing', stage: input.to, stepId: input.stepId });
    return {
      id: row.id,
      step: (label, ms, s) => { if (openSwitch === row) addStep(label, ms, s); },
      report({ steps, sync, message }) {
        if (openSwitch !== row) return;
        row.patch(p => ({ ...asSwitch(p), steps: steps.slice(-20), ...(sync ? { sync: { files: sync.files, ...(sync.done !== undefined ? { done: Math.min(sync.done, sync.files) } : {}), ...(sync.bytes !== undefined ? { bytes: sync.bytes } : {}) } } : {}) }));
        row.progress(message.slice(0, 300));
      },
      done(patch = {}) {
        // Незакрытые шаги подготовки к моменту хода закончились.
        row.close(p => ({ ...asSwitch(p), ...patch, state: 'done', steps: asSwitch(p).steps.map(x => (x.state === 'running' ? { ...x, state: 'done' as const } : x)), sync: asSwitch(p).sync ? { ...asSwitch(p).sync!, done: undefined, etaMs: undefined } : undefined }));
        if (openSwitch === row) openSwitch = null;
      },
      fail(error, mismatches) {
        row.close(p => ({ ...asSwitch(p), state: 'failed', error: error.slice(0, 300), ...(mismatches ? { mismatches: mismatches.slice(0, 20) } : {}) }));
        if (openSwitch === row) openSwitch = null;
        setState({ phase: 'waiting' });
      },
    };
  }

  return {
    emitSwitch,

    emitSync(input) {
      // Синхронизация — всегда шаг перехода. Без открытого перехода (первый ход не на домашней машине) — переход «start».
      if (!openSwitch || openSwitch.closed) emitSwitch({ reason: 'start', from: null, to: state.stage ?? { machine: input.to } });
      const row = openSwitch;
      const label = `синхронизация ${input.from} → ${input.to}`;
      row?.patch(p => ({ ...asSwitch(p), sync: { files: input.files, bytes: input.bytes, full: input.full, sample: input.sample?.slice(0, 20) }, steps: [...asSwitch(p).steps, { label, ms: 0, state: 'running' }] }));
      row?.progress(`синхронизация ${files(input.files)}${input.full ? ', первая полная' : ''}`);
      return {
        progress(done, etaMs) {
          row?.patch(p => ({ ...asSwitch(p), sync: { ...asSwitch(p).sync!, done: Math.min(done, input.files), etaMs } }));
          row?.progress(`синхронизация ${Math.min(done, input.files)} из ${input.files}${etaMs ? ` · ≈${Math.ceil(etaMs / 1000)} с` : ''}`);
        },
        done(result = {}) {
          row?.patch(p => ({ ...asSwitch(p), sync: { ...asSwitch(p).sync!, ...(result.bytes !== undefined ? { bytes: result.bytes } : {}), ...(result.sample ? { sample: result.sample.slice(0, 20) } : {}) } }));
          if (row === openSwitch) addStep(label, result.ms ?? 0);
        },
        fail(error, ms) {
          if (row === openSwitch) addStep(label, ms ?? 0, 'failed');
          row?.patch(p => ({ ...asSwitch(p), error: error.slice(0, 300) }));
        },
      };
    },

    emitFlush(input) {
      if (openSwitch && !openSwitch.closed) {
        // Перед ходом: flush и сверка — шаги той же строки перехода.
        addStep(`flush ${input.from} → ${input.to}`, input.ms);
        openSwitch.patch(p => ({ ...asSwitch(p), verify: input.verify, ...(input.mismatches?.length ? { mismatches: input.mismatches.slice(0, 20) } : {}) }));
        return;
      }
      // После хода: успех — тихо, в состояние (подсказка метки). Расхождение — запись в ленте; решение — requestDecision.
      setState({ lastSync: { from: input.from, to: input.to, ms: input.ms, verify: input.verify, at: now() } });
      if (input.verify === 'mismatch') {
        const n = input.mismatches?.length ?? 0;
        const row = open({ type: 'problem', message: `${input.from} → ${input.to}: копии разошлись${n ? ` (${files(n)})` : ''}`, note: input.mismatches?.slice(0, 5).join(', '), at: now() });
        row?.close();
      }
    },

    emitRun(stage, options = {}) {
      setState({ phase: 'running', stage, stepId: options.stepId, profileId: options.profileId });
      return { end: () => setState({ phase: 'idle' }) };
    },

    emitWaiting(input) {
      const row = open({ type: 'wait', ...input, at: now() });
      setState({ phase: 'waiting' });
      if (!row) return { id: null, resolve() {} };
      return { id: row.id, resolve(outcome) { row.close(p => ({ ...p, ...(outcome ? { outcome } : {}) }) as RoutePayloadInput); } };
    },

    emitFailure(input) {
      const row = open({ type: 'problem', ...input, at: now() });
      if (!row) return NONE;
      row.close();
      return { id: row.id };
    },

    setRouteState(phase, stage, extra = {}) {
      setState({ phase, stage, ...extra });
    },

    supersedeConfirmation: () => pendingCard?.supersede(),

    async requestConfirmation(input, options = {}) {
      const request = plain(confirmRequestSchema.parse({ ...input, proposalId: input.proposalId ?? `prop_${newId()}`, revision: input.revision ?? ++revision }));
      return ask<ConfirmRequest, ConfirmationDecision>({ kind: CONFIRM_KIND, title: confirmTitle(request), data: request }, request, value => decide(value, request), options.signal);
    },

    async requestDecision(input, options = {}) {
      const request = plain(decisionRequestSchema.parse({ ...input, proposalId: input.proposalId ?? `prop_${newId()}`, revision: input.revision ?? ++revision }));
      return ask<DecisionRequest, DecisionResult>({ kind: DECISION_KIND, title: request.title, data: request }, request, value => decideAction(value, request), options.signal);
    },
  };

  /** Одна карточка за раз: новая заменяет старую. Ответ принимается один раз. */
  function ask<R, D>(interaction: CardInteraction, request: R, parseAnswer: (value: unknown) => D, external?: AbortSignal): Promise<D | Settled<R>> {
    if (!ports.ask) return Promise.resolve({ action: 'dismissed', reason: 'unavailable', request });
    pendingCard?.supersede();
    const controller = new AbortController();
    return new Promise(resolve => {
      let settled = false;
      const settle = (result: D | Settled<R>) => {
        if (settled) return;
        settled = true;
        if (pendingCard?.controller === controller) pendingCard = null;
        external?.removeEventListener('abort', onAbort);
        resolve(result);
      };
      const supersede = () => { controller.abort(); settle({ action: 'superseded', request }); };
      const onAbort = () => supersede();
      if (external?.aborted) { supersede(); return; }
      external?.addEventListener('abort', onAbort, { once: true });
      pendingCard = { controller, supersede };
      ports.ask!(interaction, controller.signal).then(
        value => settle(dismissedOf(value, request) ?? parseAnswer(unwrapRequestAnswer(value))),
        error => settle(controller.signal.aborted
          ? { action: 'superseded', request }
          : { action: 'invalid', reason: error instanceof Error ? error.message : String(error), request }),
      );
    });
  }
}

function item(payload: RoutePayload): ExtensionItem {
  return { type: 'extension', kind: ROUTE_KIND, payload };
}

function dismissedOf<R>(value: unknown, request: R): Settled<R> | null {
  if (value && typeof value === 'object' && 'dismissed' in value) {
    const reason = (value as { dismissed: unknown }).dismissed;
    return { action: 'dismissed', reason: reason === 'timeout' || reason === 'unavailable' ? reason : 'cancelled', request };
  }
  return null;
}

/** Заголовок карточки (≤160 символов, PLUGIN_INTERACTION_MAX_TITLE_LENGTH). */
export function confirmTitle(request: Pick<ConfirmRequest, 'continuing' | 'returning' | 'from' | 'to'>): string {
  const to = [request.to.machine, request.to.provider].filter(Boolean).join(' · ');
  const title = request.continuing ? `Ещё один ход на ${to}?`
    : request.returning ? `Вернуться на ${to}?`
    : request.from ? `Продолжить на ${to}?`
    : `Начать на ${to}?`;
  return title.slice(0, 160);
}

export function confirmInteraction(request: ConfirmRequest): ConfirmInteraction {
  return { kind: CONFIRM_KIND, title: confirmTitle(request), data: request };
}

const sameProposal = (a: { proposalId: string; revision: number }, b: { proposalId: string; revision: number }) =>
  a.proposalId === b.proposalId && a.revision === b.revision;

/** Разбор ответа карточки подтверждения с проверкой, что он относится к ней (CAS по proposalId и ревизии). */
export function decide(value: unknown, request: ConfirmRequest): ConfirmationDecision {
  const dismissed = dismissedOf(value, request);
  if (dismissed) return dismissed;
  const parsed = confirmAnswerSchema.safeParse(unwrapRequestAnswer(value));
  if (!parsed.success) return { action: 'invalid', reason: 'ответ карточки не разобран', request };
  const answer = parsed.data;
  if (!sameProposal(answer, request)) return { action: 'invalid', reason: 'ответ относится к другой карточке', request };
  if (answer.action === 'go') {
    if (answer.scope === 'forever' && !request.allowForever) return { action: 'invalid', reason: '«навсегда» для этой ступени запрещено', request };
    return { action: 'go', scope: answer.scope, request };
  }
  return { action: answer.action, request };
}

/** Разбор ответа карточки решения: действие должно быть из предложенных. */
export function decideAction(value: unknown, request: DecisionRequest): DecisionResult {
  const dismissed = dismissedOf(value, request);
  if (dismissed) return dismissed;
  const parsed = decisionAnswerSchema.safeParse(unwrapRequestAnswer(value));
  if (!parsed.success) return { action: 'invalid', reason: 'ответ карточки не разобран', request };
  if (!sameProposal(parsed.data, request)) return { action: 'invalid', reason: 'ответ относится к другой карточке', request };
  if (!request.actions.some(a => a.id === parsed.data.action)) return { action: 'invalid', reason: 'действие не предлагалось', request };
  return { action: parsed.data.action, request };
}

/** Мост получает `{ kind: "request_answer", value }`; сервер — само значение. */
export function unwrapRequestAnswer(resolution: unknown): unknown {
  if (resolution && typeof resolution === 'object' && (resolution as { kind?: unknown }).kind === 'request_answer') {
    return (resolution as { value?: unknown }).value;
  }
  return resolution;
}

/**
 * ask для пути B: мост отправляет `interaction/request` с этим payload и
 * отдаёт резолюцию `{ kind: "request_answer", value }`. JSON-RPC делает
 * исполнитель (bridge/); здесь — только форма запроса и разбор ответа.
 * Ошибка runtime (bb перестал ждать) → dismissed: ход остаётся ожидающим,
 * исполнитель шлёт provider.warning по docs/provider-plugin-api.md §4.
 */
export function bridgeAskPort(send: (payload: CardInteraction, signal: AbortSignal) => Promise<unknown>) {
  return async (request: CardInteraction, signal: AbortSignal): Promise<AskResult> => {
    try {
      return unwrapRequestAnswer(await send(request, signal));
    } catch (error) {
      if (signal.aborted) throw error;
      return { dismissed: 'unavailable' } satisfies Dismissed;
    }
  };
}

/** Решение «Перейти» → согласие consent.ts; остальные решения согласия не дают. */
export function consentFromDecision(decision: ConfirmationDecision, ctx: ConsentContext, resetAt: number | null): Consent | null {
  if (decision.action !== 'go') return null;
  return grant(decision.scope, ctx, decision.scope === 'thread' ? (resetAt ?? decision.request.threadUntil) : resetAt);
}

export { stageShort };
