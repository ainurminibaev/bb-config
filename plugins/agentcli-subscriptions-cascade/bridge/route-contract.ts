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
  z.object({ kind: z.literal('switch'), reason: z.enum(['limit', 'return', 'unavailable', 'auth', 'error', 'manual', 'start']), from: stageLabelSchema.nullable(), to: stageLabelSchema, resetAt: z.number().nullable().optional(), stepId: text(120), window: text(60).optional() }),
  z.object({ kind: z.literal('sync'), from: text(80), to: text(80), ms: z.number().nonnegative(), ok: z.boolean(), detail: text(300).optional() }),
  z.object({ kind: z.literal('run'), stage: stageLabelSchema, stepId: text(120) }),
  z.object({ kind: z.literal('wait'), cause: z.enum(['reset', 'offline', 'recheck']), until: z.number().nullable().optional(), note: text(300).optional(), stepId: text(120).optional() }),
  /** note — что сделать владельцу: «Повторите ход · пропустить ступень … · настройки …». */
  z.object({ kind: z.literal('problem'), message: text(300), stage: stageLabelSchema.optional(), stepId: text(120).optional(), note: text(300).optional() }),
  /**
   * Подготовка хода идёт (синхронизация): строка перехода обновляется на месте.
   * Шлёт запускатель, пока ждёт решения сервера (RPC turnProgress).
   */
  z.object({
    kind: z.literal('prep'),
    reason: z.enum(['limit', 'return', 'unavailable', 'auth', 'error', 'manual', 'start']),
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
});
export type RouteTurnInput = z.input<typeof routeTurnInputSchema>;

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
  }),
  z.object({
    action: z.literal('refuse'),
    message: z.string(),
    /** Повторить ход позже имеет смысл (ожидание сброса, машина офлайн). */
    retryable: z.boolean().default(false),
    notes: z.array(routeNoteSchema).default([]),
  }),
]);
export type RouteTurnOutput = z.infer<typeof routeTurnOutputSchema>;

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
    /** Общий путь проекта на машинах каскада (основная копия — на опоре). */
    path: z.string().nullable(),
    /** Где актуальная копия файлов прямо сейчас: машина хода или опора после flush. */
    freshCopyHostId: z.string().nullable(),
  }),
]);
export type ThreadStatus = z.infer<typeof threadStatusSchema>;

export const executorRpcContract = defineRpcContract({
  routeTurn: { input: routeTurnInputSchema, output: routeTurnOutputSchema },
  finishTurn: { input: finishTurnInputSchema, output: z.object({ notes: z.array(routeNoteSchema) }) },
  threadStatus: { input: z.object({ threadId: z.string().min(1) }), output: threadStatusSchema },
  /** Идущая подготовка хода треда (для строки ленты); null — не готовится. */
  turnProgress: { input: z.object({ threadId: z.string().min(1) }), output: z.object({ note: z.unknown().nullable() }) },
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
