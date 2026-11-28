// Лента треда «Каскада»: виды строк, состояние треда, карточки над полем ввода и RPC.
// Чистые схемы (zod 4 — Standard Schema v1): ими сервер BB проверяет payload
// extension-элементов при приёме (extensionKinds), ими же их читает рендерер.
//
// Правило «без лишнего»:
// - обычный ход строк не даёт: ступень видна тихой меткой «Mac · Opus» в контексте треда;
// - переход и возврат — одна строка веса «Thought 8s»; подготовка, синхронизация
//   и сверка сворачиваются в неё и раскрываются по клику;
// - заметны только две вещи, обе — карточкой над полем ввода (ход ждёт ответа):
//   подтверждение ступени и сбой, при котором нужно решение владельца.
import { z } from 'zod';
import { defineRpcContract } from '@get-bb/plugin-sdk';
import { PLUGIN_ID } from '../contract.ts';

/** Локальное имя вида строки; полный вид — `<pluginId>/route`. */
export const ROUTE_KIND_NAME = 'route';
export const ROUTE_KIND = `${PLUGIN_ID}/${ROUTE_KIND_NAME}` as const;
/** id форм pendingInteraction; мост адресует их видом `<pluginId>/<id>`. */
export const CONFIRM_FORM_ID = 'confirm-step';
export const CONFIRM_KIND = `${PLUGIN_ID}/${CONFIRM_FORM_ID}` as const;
export const DECISION_FORM_ID = 'decide';
export const DECISION_KIND = `${PLUGIN_ID}/${DECISION_FORM_ID}` as const;

/** Свои значки строк (bb.branding.experimental_icons). Чужой или необъявленный глиф сервер отвергает. */
export const ROUTE_ICONS = {
  switch: 'route-switch',
  wait: 'route-wait',
  problem: 'route-error',
  confirm: 'route-confirm',
} as const;
export const routeGlyph = (name: keyof typeof ROUTE_ICONS) => `${PLUGIN_ID}/${ROUTE_ICONS[name]}`;
/** Записи для package.json → bb.branding.experimental_icons (пути от корня плагина). */
export const TIMELINE_ICON_FILES: Record<string, string> = Object.fromEntries(
  Object.values(ROUTE_ICONS).map(name => [name, `./timeline/icons/${name.replace(/^route-/, '')}.svg`]),
);

const text = (max: number) => z.string().max(max);
const at = z.number().int().nonnegative();

/** Ступень для показа: машина × CLI × аккаунт × модель (подписи, не идентификаторы). */
export const stageRefSchema = z.object({
  machine: text(80).min(1),
  provider: text(80).optional(),
  account: text(80).optional(),
  /** Короткое имя модели: «Opus», «GPT-6.2». */
  model: text(80).optional(),
});
export type StageRef = z.infer<typeof stageRefSchema>;

/** Шаг перехода с длительностью — для раскрытой строки. */
export const stepTimingSchema = z.object({
  label: text(80),
  ms: z.number().nonnegative(),
  state: z.enum(['done', 'running', 'failed', 'skipped']).default('done'),
});
export type StepTiming = z.infer<typeof stepTimingSchema>;

export const switchReasonSchema = z.enum(['limit', 'return', 'unavailable', 'auth', 'error', 'manual', 'start', 'removed']);
export type SwitchReason = z.infer<typeof switchReasonSchema>;

/** Переход между ступенями: одна строка на весь путь «выбор → пауза → синхронизация → сверка». */
export const switchPayloadSchema = z.object({
  type: z.literal('switch'),
  /**
   * limit — исчерпан лимит; return — приоритетная ступень освободилась;
   * unavailable — машина или CLI не на связи; auth — вход истёк; error — сбой
   * ступени; manual — выбор владельца; start — первый ход треда не на домашней машине.
   */
  reason: switchReasonSchema,
  /** Подпись окна или пакета: «Max», «5 ч», «пакет vclaude». */
  window: text(60).optional(),
  from: stageRefSchema.nullable(),
  to: stageRefSchema,
  resetAt: at.nullable().optional(),
  /** «Возобновить сессию · события 13–14» или «Новая сессия со сводкой». */
  handoff: text(200).optional(),
  state: z.enum(['running', 'done', 'failed']),
  steps: z.array(stepTimingSchema).max(20).default([]),
  sync: z.object({
    files: z.number().int().nonnegative(),
    done: z.number().int().nonnegative().optional(),
    bytes: z.number().nonnegative().optional(),
    full: z.boolean().optional(),
    etaMs: z.number().nonnegative().optional(),
    /** Несколько путей для раскрытой строки; полный список не храним. */
    sample: z.array(text(300)).max(20).optional(),
  }).optional(),
  verify: z.enum(['ok', 'mismatch', 'skipped']).optional(),
  mismatches: z.array(text(300)).max(20).optional(),
  error: text(300).optional(),
  stepId: text(120).optional(),
  at,
});

/** Тред ждёт сам, без решения владельца: сброса окна, машины, перепроверки квоты. */
export const waitPayloadSchema = z.object({
  type: z.literal('wait'),
  cause: z.enum(['reset', 'offline', 'recheck']),
  machine: text(80).optional(),
  window: text(60).optional(),
  until: at.nullable().optional(),
  note: text(300).optional(),
  /** Чем закончилось ожидание — для закрытой строки. */
  outcome: text(120).optional(),
  stepId: text(120).optional(),
  at,
});

/** Запись о сбое в ленте. Решение, если оно нужно, спрашивает карточка decide. */
export const problemPayloadSchema = z.object({
  type: z.literal('problem'),
  message: text(300),
  stage: stageRefSchema.optional(),
  note: text(300).optional(),
  /** Что выбрал владелец или что сделал каскад: «Повтор на Mac», «Ступень пропущена». */
  resolution: text(120).optional(),
  stepId: text(120).optional(),
  at,
});

export const routePayloadSchema = z.discriminatedUnion('type', [switchPayloadSchema, waitPayloadSchema, problemPayloadSchema]);
export type RoutePayload = z.infer<typeof routePayloadSchema>;
export type RoutePayloadInput = z.input<typeof routePayloadSchema>;
export type SwitchPayload = z.infer<typeof switchPayloadSchema>;

/** Состояние треда (extension.state): где думает CLI. Читается experimental_useThreadExtensionState. */
export const routeStateSchema = z.object({
  phase: z.enum(['idle', 'preparing', 'running', 'waiting']),
  stage: stageRefSchema.nullable(),
  stepId: text(120).optional(),
  /** Профиль треда («Авто», «Opus») — для схемы. */
  profileId: text(120).optional(),
  /** Последняя синхронизация после хода: тихо, только для подсказки метки. */
  lastSync: z.object({ from: text(80), to: text(80), ms: z.number().nonnegative(), verify: z.enum(['ok', 'mismatch', 'skipped']), at }).optional(),
  at,
});
export type RouteState = z.infer<typeof routeStateSchema>;

/** Объявление для bb.providers.register({ extensionKinds }). */
export const timelineExtensionKinds = {
  [ROUTE_KIND_NAME]: { item: routePayloadSchema, state: routeStateSchema },
};

// ---- Карточка подтверждения перехода (cross-provider.md, «Карточка подтверждения») ----

export const consentScopeSchema = z.enum(['turn', 'thread', 'forever']);

const proposal = {
  /** ID предложения и ревизия ожидающего хода: ответ на старую карточку отклоняется. */
  proposalId: text(120).min(1),
  revision: z.number().int().nonnegative(),
};

export const confirmRequestSchema = z.object({
  ...proposal,
  stepId: text(120).min(1),
  /** true — та же защищённая ступень после разового согласия («ещё один ход?»). */
  continuing: z.boolean(),
  /** true — возврат на более приоритетную ступень. */
  returning: z.boolean().default(false),
  from: stageRefSchema.nullable(),
  to: stageRefSchema,
  /** Коротко, без точки: «лимит Max на Tru до 15:40». */
  reason: text(300),
  handoff: text(200).nullable(),
  /** Граница тредового согласия: сброс окна, вызвавшего переход; null — до ручного сброса. */
  threadUntil: at.nullable(),
  preview: z.object({
    decisions: z.number().int().nonnegative().optional(),
    files: z.number().int().nonnegative().optional(),
    attachments: z.array(text(200)).max(20).optional(),
    note: text(300).optional(),
  }).optional(),
  defaultScope: consentScopeSchema.default('turn'),
  /** Владелец может запретить «навсегда» для ступени. */
  allowForever: z.boolean().default(true),
});
export type ConfirmRequest = z.infer<typeof confirmRequestSchema>;
export type ConfirmRequestInput = z.input<typeof confirmRequestSchema>;

export const confirmAnswerSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('go'), scope: consentScopeSchema, ...proposal }),
  z.object({ action: z.literal('skip'), ...proposal }),
  z.object({ action: z.literal('wait'), ...proposal }),
  z.object({ action: z.literal('cancel'), ...proposal }),
]);
export type ConfirmAnswer = z.infer<typeof confirmAnswerSchema>;

// ---- Карточка решения при сбое (ход ждёт владельца) ----

export const decisionActionIdSchema = z.enum(['retry', 'skip', 'wait', 'cancel']);
export type DecisionActionId = z.infer<typeof decisionActionIdSchema>;

export const decisionRequestSchema = z.object({
  ...proposal,
  /** Заголовок: что случилось, одной фразой. «Mac не на связи». */
  title: text(160).min(1),
  /** Что это значит для хода и что сделает каждое действие. */
  message: text(400),
  stage: stageRefSchema.optional(),
  /** Первое действие — основное. 1–3 действия. */
  actions: z.array(z.object({ id: decisionActionIdSchema, label: text(40) })).min(1).max(3),
  stepId: text(120).optional(),
});
export type DecisionRequest = z.infer<typeof decisionRequestSchema>;
export type DecisionRequestInput = z.input<typeof decisionRequestSchema>;
export const decisionAnswerSchema = z.object({ action: decisionActionIdSchema, ...proposal });
export type DecisionAnswer = z.infer<typeof decisionAnswerSchema>;

// ---- RPC: схема каскада для метки ступени ----

export const timelineRpcContract = defineRpcContract({
  /**
   * Схема «i» для треда: план движка (explainProfile) с текущими лимитами.
   * Отдаёт то, что нужно CascadeDiagram из profiles-view.tsx. null — схемы нет
   * (исполнитель ещё не передал состояние треда).
   */
  threadScheme: {
    input: z.object({ threadId: text(120).min(1) }),
    output: z.object({
      name: text(120),
      text: text(400),
      test: z.boolean(),
      attempts: z.array(z.json()),
      config: z.json(),
    }).nullable(),
  },
});
