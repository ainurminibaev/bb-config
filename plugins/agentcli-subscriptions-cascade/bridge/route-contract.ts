// Контракт «исполнитель хода ↔ сервер плагина».
// Запускатель (дочерний процесс штатного моста) спрашивает сервер перед
// каждым запуском CLI и сообщает итог после. Вызов идёт по REST сервера BB:
// POST {BB_SERVER_URL}/api/v1/plugins/agentcli-subscriptions-cascade/rpc/<метод>.
// Паспорт треда (threadStatus) — для других плагинов, по мягкой зависимости.
import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';

const text = (max: number) => z.string().max(max);

/** Ступень для подписи в ленте (не идентификаторы). */
export const stageLabelSchema = z.object({
  machine: text(80).min(1),
  provider: text(80).optional(),
  account: text(80).optional(),
  model: text(80).optional(),
});
export type StageLabel = z.infer<typeof stageLabelSchema>;

/**
 * Нейтральные события для ленты треда. Мост переводит их в строки
 * timeline/ (emitSwitch, emitSync …) — так исполнитель не зависит от формы
 * строк, которую доводит параллельный тред.
 */
export const routeNoteSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('switch'), reason: z.enum(['limit', 'return', 'unavailable', 'auth', 'error', 'manual', 'start', 'removed']), from: stageLabelSchema.nullable(), to: stageLabelSchema, resetAt: z.number().nullable().optional(), stepId: text(120), window: text(60).optional() }),
  z.object({ kind: z.literal('sync'), from: text(80), to: text(80), ms: z.number().nonnegative(), ok: z.boolean(), detail: text(300).optional() }),
  z.object({ kind: z.literal('run'), stage: stageLabelSchema, stepId: text(120) }),
  z.object({ kind: z.literal('wait'), cause: z.enum(['reset', 'offline', 'recheck']), until: z.number().nullable().optional(), note: text(300).optional(), stepId: text(120).optional() }),
  /** note — что сделать владельцу: «Повторите ход · пропустить ступень … · настройки …». */
  z.object({ kind: z.literal('problem'), message: text(300), stage: stageLabelSchema.optional(), stepId: text(120).optional(), note: text(300).optional() }),
  /**
   * Уведомление синхронизации (карантин опоздавших записей, снятая блокировка,
   * перенос прежнего содержимого): ход идёт, но владелец должен это увидеть —
   * отдельной строкой, а не в подробностях успешного flush, которые лента прячет.
   */
  z.object({ kind: z.literal('notice'), message: text(300), stepId: text(120).optional() }),
  /**
   * Подготовка хода идёт (синхронизация): строка перехода обновляется на месте.
   * Шлёт запускатель, пока ждёт решения сервера (RPC turnProgress).
   */
  z.object({
    kind: z.literal('prep'),
    reason: z.enum(['limit', 'return', 'unavailable', 'auth', 'error', 'manual', 'start', 'removed']),
    from: stageLabelSchema.nullable(), to: stageLabelSchema, stepId: text(120),
    phase: text(120), elapsedMs: z.number().nonnegative(),
    steps: z.array(z.object({ label: text(80), ms: z.number().nonnegative(), state: z.enum(['running', 'done', 'failed']) })).max(20),
    sync: z.object({ files: z.number().nonnegative().optional(), done: z.number().nonnegative().optional(), bytes: z.number().nonnegative().optional() }).optional(),
    attempt: text(160).optional(),
  }),
  z.object({ kind: z.literal('state'), phase: z.enum(['idle', 'preparing', 'running', 'waiting']), stage: stageLabelSchema.nullable(), stepId: text(120).optional(), profileId: text(120).optional() }),
]);
export type RouteNote = z.infer<typeof routeNoteSchema>;

export const nativeProviderSchema = z.enum(['claude-code', 'codex']);
export type NativeProvider = z.infer<typeof nativeProviderSchema>;

export const routeTurnInputSchema = z.object({
  threadId: z.string().min(1),
  projectId: z.string().nullable().default(null),
  /** Какой штатный мост запустил CLI. */
  provider: nativeProviderSchema,
  /** ID профиля из аргументов CLI (`--model auto`); null — профиль треда. */
  requestedModel: z.string().nullable().default(null),
  /** Короткая проба моста (без сохранения сессии): ступень не меняется, синхронизации нет. */
  probe: z.boolean().default(false),
  /** Папка, в которой мост запустил CLI. */
  cwd: z.string().min(1),
  /**
   * Логический ход (одно сообщение пользователя): разовое согласие карточки
   * действует на все повторные routeTurn этого хода. null — новый ход на каждый вызов.
   */
  turnKey: z.string().min(1).max(160).nullable().default(null),
  /**
   * 0.3.0: запускатель умеет ждать решения по билету. Подготовка (ожидание
   * рабочей папки, первая синхронизация) идёт до 20 мин, а HTTP-запрос дольше
   * 300 с рвёт undici («fetch failed»). С `async` сервер отвечает не позже чем
   * через ~20 с: решением или `{ action: 'pending', ticket }`, дальше — опрос
   * `routeTurnResult`. Без флага (старый запускатель) — ответ, как раньше.
   */
  async: z.boolean().optional(),
});
export type RouteTurnInput = z.input<typeof routeTurnInputSchema>;

/** Что показать в карточке подтверждения (поля ConfirmRequest из timeline/ без proposalId и ревизии). */
export const confirmPromptSchema = z.object({
  stepId: text(120).min(1),
  continuing: z.boolean(),
  returning: z.boolean().default(false),
  from: stageLabelSchema.nullable(),
  to: stageLabelSchema,
  reason: text(300),
  handoff: text(200).nullable().default(null),
  threadUntil: z.number().nullable(),
  allowForever: z.boolean().default(true),
});
export type ConfirmPrompt = z.infer<typeof confirmPromptSchema>;

export const routeTurnOutputSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('run'),
    stepId: z.string(),
    hostId: z.string(),
    providerId: z.string(),
    /** ID модели у CLI машины ступени; null — модель CLI по умолчанию. */
    modelId: z.string().nullable(),
    /** Ступень на машине моста — запуск без канала. */
    local: z.boolean(),
    /** Папка на машине ступени; null — та же, что у моста. */
    cwd: z.string().nullable(),
    /** Переменные синхронизации и ступени для CLI (без секретов). */
    env: z.record(z.string(), z.string()).default({}),
    stage: stageLabelSchema,
    notes: z.array(routeNoteSchema).default([]),
    /**
     * `adopt --native` (0.3.0): первый ход переведённого треда продолжает
     * исходную сессию Claude — запускатель копирует её jsonl под ID сессии
     * этого треда (если там ещё нет разговора) и стартует с `--resume`.
     */
    seedSession: z.object({ sessionId: z.string().regex(/^[0-9a-zA-Z-]{8,80}$/u) }).nullable().optional(),
  }),
  z.object({
    action: z.literal('refuse'),
    message: z.string(),
    /** Повторить ход позже имеет смысл (ожидание сброса, машина офлайн). */
    retryable: z.boolean().default(false),
    /**
     * Как отдать отказ штатному мосту, чтобы сработал штатный автоповтор BB
     * (provider-retry): `limit` — как лимит (повтор после ответа доступности
     * каскада, ход пойдёт на другую ступень/провайдера); `overload` — как
     * перегрузка (повтор через секунды, без смены ступени: плагин обновился).
     */
    retryAs: z.enum(['limit', 'overload']).optional(),
    notes: z.array(routeNoteSchema).default([]),
  }),
  z.object({
    /** Ступень требует подтверждения: исполнитель показывает карточку, ответ — answerConfirmation, затем routeTurn снова. */
    action: z.literal('confirm'),
    prompt: confirmPromptSchema,
    /** Провайдер ступени карточки. */
    providerId: z.string(),
    notes: z.array(routeNoteSchema).default([]),
  }),
]);
export type RouteTurnOutput = z.infer<typeof routeTurnOutputSchema>;
/** Итог хода после карточек подтверждения: запуск или отказ. */
export type RoutedTurn = Exclude<RouteTurnOutput, { action: 'confirm' }>;

export const answerConfirmationInputSchema = z.object({
  threadId: z.string().min(1),
  projectId: z.string().nullable().default(null),
  stepId: z.string().min(1),
  turnKey: z.string().min(1).max(160).nullable().default(null),
  /** Ответ карточки; dismissed — закрыта без выбора (ход ждёт, ничего не запоминаем). */
  action: z.enum(['go', 'skip', 'wait', 'cancel', 'dismissed']),
  scope: z.enum(['turn', 'thread', 'forever']).nullable().default(null),
  /** Граница тредового согласия (из карточки). */
  threadUntil: z.number().nullable().default(null),
});
export type AnswerConfirmationInput = z.input<typeof answerConfirmationInputSchema>;

export const answerConfirmationOutputSchema = z.object({
  /** continue — снова routeTurn; refuse — ход не идёт (message, retryable). */
  next: z.enum(['continue', 'refuse']),
  message: z.string().default(''),
  retryable: z.boolean().default(false),
  notes: z.array(routeNoteSchema).default([]),
});
export type AnswerConfirmationOutput = z.infer<typeof answerConfirmationOutputSchema>;

/** Нативные сессии треда: у каждого провайдера своя, курсор — номер события треда (seq). */
export const nativeSessionSchema = z.object({
  nativeId: z.string().min(1),
  coveredSeq: z.number().int().nonnegative(),
});
export const nativeSessionsSchema = z.object({
  /** providerThreadId, который знает BB (первая нативная сессия треда). */
  outerId: z.string().min(1),
  active: nativeProviderSchema,
  sessions: z.record(z.string(), nativeSessionSchema),
});
export type NativeSessions = z.infer<typeof nativeSessionsSchema>;

export const handoffBriefInputSchema = z.object({
  threadId: z.string().min(1),
  /** Курсор сессии получателя; 0 — первый переход (сводка). */
  afterSeq: z.number().int().nonnegative(),
  mode: z.enum(['snapshot', 'delta']),
  from: text(80),
  to: text(80),
  /** Текущий запрос пользователя (clientRequestId): он передаётся ходом отдельно и в сводку не входит. */
  currentRequestId: z.string().nullable().default(null),
  /** Текст текущего ввода: «Please continue.» автоповтора — тогда в сводку идёт исходная просьба. */
  currentText: z.string().max(20_000).nullable().default(null),
});
export const handoffBriefOutputSchema = z.object({
  /** Блок для начала хода; пусто — добавлять нечего. */
  text: z.string(),
  /** До какого события треда покрыт контекст. */
  throughSeq: z.number().int().nonnegative(),
});

/** Событие лимита из потока CLI (rate_limit_event Claude, account/rateLimits Codex). */
export const limitObservationSchema = z.object({
  status: z.enum(['allowed', 'allowed_warning', 'rejected', 'unknown']),
  resetsAt: z.number().nullable().default(null),
  windowType: z.string().nullable().default(null),
  raw: z.unknown().optional(),
});
export type LimitObservation = z.infer<typeof limitObservationSchema>;

export const finishTurnInputSchema = z.object({
  threadId: z.string().min(1),
  projectId: z.string().nullable().default(null),
  stepId: z.string(),
  hostId: z.string(),
  probe: z.boolean().default(false),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().nonnegative().default(0),
  limits: z.array(limitObservationSchema).max(50).default([]),
  /** Сбой канала до машины ступени: следующий ход выберет ступень заново. */
  transportError: z.string().nullable().default(null),
});
export type FinishTurnInput = z.input<typeof finishTurnInputSchema>;

/**
 * Паспорт треда для других плагинов. Тред каскада узнаётся по providerId треда
 * `subscriptions-cascade` (ID провайдера; ID плагина — `agentcli-subscriptions-cascade`).
 * `step.accountKey` у шлюза vclaude — «vclaude».
 */
export const threadStatusSchema = z.union([
  z.object({ cascade: z.literal(false) }),
  z.object({
    cascade: z.literal(true),
    profileId: z.string().nullable(),
    step: z.object({
      hostId: z.string(), providerId: z.string(), model: z.string().nullable(),
      accountKey: z.string().nullable(), kind: z.enum(['subscription', 'gateway']),
    }).nullable(),
    anchorHostId: z.string().nullable(),
    syncMode: z.string(),
    /**
     * Папка актуальной копии файлов треда на машине freshCopyHostId (0.3.3): на опоре —
     * checkout или worktree треда, на исполнителе — реплика `<общий путь>/<slug>`.
     * Неизвестна — null (не общий корень реплик).
     */
    path: z.string().nullable(),
    /** Где актуальная копия файлов прямо сейчас: машина хода или опора после flush. */
    freshCopyHostId: z.string().nullable(),
  }),
]);
export type ThreadStatus = z.infer<typeof threadStatusSchema>;

/** Решение ещё готовится: спросить `routeTurnResult` с этим билетом. */
export const routeTurnPendingSchema = z.object({ action: z.literal('pending'), ticket: z.string().min(1) });
export const routeTurnAsyncOutputSchema = z.union([routeTurnPendingSchema, routeTurnOutputSchema]);

export const executorRpcContract = defineRpcContract({
  routeTurn: { input: routeTurnInputSchema, output: routeTurnAsyncOutputSchema },
  /** Решение по билету `routeTurn` (ждёт до ~20 с): готово — решение, иначе снова pending. */
  routeTurnResult: { input: z.object({ ticket: z.string().min(1) }), output: routeTurnAsyncOutputSchema },
  finishTurn: { input: finishTurnInputSchema, output: z.object({ notes: z.array(routeNoteSchema) }) },
  threadStatus: { input: z.object({ threadId: z.string().min(1) }), output: threadStatusSchema },
  /**
   * Синхронизация хода на закреплённой машине (app-server Codex живёт долго):
   * prepare — файлы к ходу на машине, finish — вернуть на опору.
   */
  syncTurn: {
    input: z.object({ threadId: z.string().min(1), stepId: z.string(), hostId: z.string(), phase: z.enum(['prepare', 'finish']) }),
    output: z.object({ ok: z.boolean(), message: z.string(), cwd: z.string().nullable(), notes: z.array(routeNoteSchema) }),
  },
  /** Модель недоступна на аккаунте ступени («requires usage credits»): попытка ступень × модель снимается. */
  turnModelUnavailable: {
    input: z.object({ threadId: z.string().min(1), stepId: z.string(), modelId: z.string().nullable(), reason: z.string().max(300) }),
    output: z.object({ ok: z.boolean() }),
  },
  /** Лимит, полученный в ходе (rate_limit_event rejected): ступень сразу помечается исчерпанной. */
  turnLimits: {
    input: z.object({ threadId: z.string().min(1), stepId: z.string(), limits: z.array(limitObservationSchema).max(50) }),
    output: z.object({ exhausted: z.boolean() }),
  },
  /** Идущая подготовка хода треда (для строки ленты); null — не готовится. */
  turnProgress: { input: z.object({ threadId: z.string().min(1) }), output: z.object({ note: z.unknown().nullable() }) },
  /** Ответ карточки подтверждения: согласие со сроком, пропуск ступени, ожидание, отмена. */
  answerConfirmation: { input: answerConfirmationInputSchema, output: answerConfirmationOutputSchema },
  /** Какой провайдер возьмёт следующий ход (без побочных эффектов) — мост выбирает штатный мост ступени. */
  peekProvider: {
    input: z.object({ threadId: z.string().min(1), projectId: z.string().nullable().default(null), requestedModel: z.string().nullable().default(null) }),
    output: z.object({ providerId: nativeProviderSchema.nullable(), modelId: z.string().nullable(), stage: stageLabelSchema.nullable() }),
  },
  /** Сводка (первый переход) или дельта событий после курсора (возврат) для другой нативной сессии. */
  handoffBrief: { input: handoffBriefInputSchema, output: handoffBriefOutputSchema },
  /** Нативные сессии треда: чтение (sessions не задан) и запись. */
  nativeSessions: {
    input: z.object({ threadId: z.string().min(1), sessions: nativeSessionsSchema.nullable().default(null) }),
    output: z.object({ sessions: nativeSessionsSchema.nullable() }),
  },
  /** Тестовая квота одного треда (S1–S13): `set` — «<ступень>=exhausted|ok|unknown|unavailable[,<сброс>];…». */
  testQuota: {
    input: z.object({ threadId: z.string().min(1), set: z.string().max(2000).optional(), clear: z.boolean().default(false) }),
    output: z.object({ threadId: z.string(), steps: z.record(z.string(), z.object({ state: z.string(), resetsAt: z.string().nullable() })).nullable() }),
  },
});

/**
 * Ответ штатному provider-retry (BB 0.50, встроенный плагин): при ошибке
 * лимита (`errorInfo.category === "rate-limit"` или HTTP 429) он спрашивает все
 * плагины с этим discoverable-методом, можно ли повторить ход. Каскад отвечает
 * за свои треды: есть готовая ступень — `ready` (повтор сразу, ход пойдёт на
 * следующую ступень), всё исчерпано — `blocked` до ближайшего сброса,
 * ждать дольше порога — `unavailable`; чужой тред — `not-routed`.
 * Форма — дословно контракт provider-retry (`provider-retry.v1.availability`).
 */
export const PROVIDER_RETRY_AVAILABILITY = 'provider-retry.v1.availability';
export const retryAvailabilitySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('not-routed') }),
  z.object({ kind: z.literal('ready') }),
  z.object({ kind: z.literal('blocked'), retryAt: z.number().int().nonnegative() }),
  z.object({ kind: z.literal('unavailable'), reason: z.enum(['no-enabled-account', 'authentication', 'reset-unknown', 'source-unavailable']) }),
]);
export type RetryAvailability = z.infer<typeof retryAvailabilitySchema>;
export const retryAvailabilityContract = defineRpcContract({
  [PROVIDER_RETRY_AVAILABILITY]: {
    input: z.object({ threadId: z.string().min(1), requestId: z.string().min(1) }),
    output: retryAvailabilitySchema,
  },
});
