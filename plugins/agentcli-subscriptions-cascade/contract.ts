// Модель данных «Каскада подписок»: конфигурация, обнаруженные аккаунты и RPC.
// Схемы терпимы к неизвестным полям (z.object по умолчанию их отбрасывает),
// поэтому старая или более новая конфигурация читается без падения.
import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';

export const PLUGIN_ID = 'agentcli-subscriptions-cascade';
export const PROVIDER_ID = 'subscriptions-cascade';
/** ID профиля «Авто» — он же ID модели в списке провайдера. */
export const AUTO_MODEL_ID = 'auto';
/**
 * Устаревший префикс модели провайдера `m:<ключ строки>` (до профилей).
 * Такой ID читается как профиль «только X», чтобы старые треды не ломались.
 */
export const MODEL_ID_PREFIX = 'm:';
/**
 * 0.3.4: профиль «Авто · подтреды на Codex». Сам тред ходит как «Авто», а его
 * подтреды каскада — только по ступеням Codex (см. subthreads.ts).
 */
export const AUTO_CODEX_CHILDREN_ID = 'auto-codex-children';
/**
 * 0.3.4: синтетический профиль подтреда «Подтред · Codex»: только ступени Codex,
 * любая машина, без подтверждения входа; Codex недоступен — «Авто». В настройках
 * не хранится и в списке моделей не показывается.
 */
export const SUBTHREAD_CODEX_ID = 'subthread-codex';

/** Платформа машины. `windows` — нативный Windows, `wsl` — Linux внутри WSL. */
export const platformSchema = z.enum(['linux', 'macos', 'wsl', 'windows', 'unknown']);
export type Platform = z.infer<typeof platformSchema>;

export const machineSchema = z.object({
  hostId: z.string().min(1),
  /** Имя для служебных строк («Tru», «Mac»). */
  label: z.string().min(1),
  enabled: z.boolean().default(true),
  platform: platformSchema.default('unknown'),
  /** Общий путь файлов. Linux/macOS/WSL — `/opt/bbfs`, нативный Windows — свой. */
  sharedPath: z.string().min(1).default('/opt/bbfs'),
  /** Нативный Windows: пути переводятся (сам перевод — позже). */
  pathTranslation: z.boolean().default(false),
  /** Машина-опора: после хода на другой машине файлы выравниваются по ней. */
  anchor: z.boolean().default(false),
  /**
   * SSH-цель опоры с этой машины (`tru`, `root@host`) для сессий Mutagen.
   * У опоры не используется. null — берётся прежнее значение из хранилища
   * плагина (`sync:anchor-ssh:<hostId>`), если оно есть.
   */
  anchorSsh: z.string().max(200).nullable().default(null),
  /** Адрес этой машины для SSH с других машин каскада (у опоры — HostName алиаса `bb-<опора>`). */
  sshAddress: z.string().max(253).nullable().default(null),
});
export type Machine = z.infer<typeof machineSchema>;

/**
 * Ступень каскада: машина × провайдер (CLI) × аккаунт. Порядок массива —
 * порядок каскада, задаётся владельцем свободно.
 */
export const stepSchema = z.object({
  id: z.string().min(1),
  hostId: z.string().min(1),
  /** ID провайдера BB, чей CLI запускается: `claude-code`, `codex`, позже `gemini-cli`, `acp-*`. */
  providerId: z.string().min(1),
  /** Ключ аккаунта (email или метка); null — тот, что залогинен в CLI машины. */
  account: z.string().nullable().default(null),
  /**
   * Чья квота: подписка провайдера или API-шлюз (нативный CLI с ANTHROPIC_BASE_URL
   * и т. п.). Обе — полноправные ступени; различаются только источником лимитов.
   */
  authority: z.enum(['subscription', 'gateway']).default('subscription'),
  /** Локальная непрозрачная ссылка на профиль CLI на машине; null — профиль по умолчанию. */
  profileRef: z.string().nullable().default(null),
  /** Подтверждённая владельцем общая квота (одна подписка на нескольких ступенях). */
  quotaGroup: z.string().nullable().default(null),
  /**
   * Откуда брать квоту: provider — штатно (usageLimits и события CLI);
   * vclaude — пакет шлюза vclaude из плагина thread-account-usage (остаток в единицах пакета).
   */
  quotaSource: z.enum(['provider', 'vclaude']).default('provider'),
  /** Квота неизвестна: skip — перейти к следующей ступени, try — идти и ловить лимит в ходе. */
  onUnknown: z.enum(['skip', 'try']).default('skip'),
  /** Подпись для строк («Max 20», «Codex Plus»). Пусто — из обнаружения. */
  label: z.string().default(''),
  enabled: z.boolean().default(true),
  /** Переход на ступень только после подтверждения владельца (профиль может переопределить). */
  confirm: z.boolean().default(false),
  /**
   * Сколько ходов (всех тредов и подтредов) одновременно идут на ступени (0.3.0);
   * null — без лимита. Для слабой машины рядом с продом.
   */
  maxConcurrent: z.number().int().min(1).max(64).nullable().default(null),
  /** Ступень занята (maxConcurrent): wait — ход ждёт освобождения, next — идёт на следующую ступень профиля. */
  onBusy: z.enum(['wait', 'next']).default('wait'),
});
export type Step = z.infer<typeof stepSchema>;

/** Происхождение значения в ячейке таблицы ассоциаций. */
export const cellSourceSchema = z.enum(['auto', 'manual', 'none']);
export const associationSchema = z.object({
  modelId: z.string().nullable(),
  source: cellSourceSchema,
});
export type Association = z.infer<typeof associationSchema>;

/** Строка таблицы ассоциаций: модель по названию и её ID на каждой машине. */
export const modelRowSchema = z.object({
  key: z.string().min(1).regex(/^[a-z0-9][a-z0-9._-]*$/),
  displayName: z.string().min(1),
  /** Чей CLI исполняет модель. */
  providerId: z.string().min(1),
  enabled: z.boolean().default(true),
  /** hostId → ID модели у CLI этой машины. */
  cells: z.record(z.string(), associationSchema).default({}),
});
export type ModelRow = z.infer<typeof modelRowSchema>;

/** lazy — синхронизация на время хода; warm — постоянная; off — проект не синхронизируется, ходит только по ступеням своей машины. */
export const syncModeSchema = z.enum(['lazy', 'warm', 'off']);
export type SyncMode = z.infer<typeof syncModeSchema>;

export const DEFAULT_SYNC_IGNORES = [
  'node_modules', '.pnpm-store', 'dist', 'build', 'out', '.next', '.nuxt', '.turbo',
  '.cache', 'target', '__pycache__', '.venv', 'venv', 'coverage',
] as const;

export const filesSchema = z.object({
  defaultSyncMode: syncModeSchema.default('lazy'),
  /** projectId → режим синхронизации (настройка проекта). */
  projectSyncModes: z.record(z.string(), syncModeSchema).default({}),
  syncEnv: z.boolean().default(true),
  ignores: z.array(z.string().min(1)).default([...DEFAULT_SYNC_IGNORES]),
  /**
   * Сборка брошенных реплик сама: после архивации или удаления треда каскада
   * (через минуту) и раз в сутки. Вручную — `bb subscriptions-cascade gc`.
   */
  autoGc: z.boolean().default(true),
});
export type FilesConfig = z.infer<typeof filesSchema>;

export const policiesSchema = z.object({
  /**
   * Путь исполнения хода: off — только настройка; relay — этап 1 (путь A,
   * подмена CLI штатных провайдеров); provider — этап 2 (путь B, свой провайдер).
   */
  // Пустые настройки — каскад готов к работе; «Выключено» (off) — явный выбор владельца.
  executionMode: z.enum(['off', 'relay', 'provider']).default('provider'),
  /**
   * Общий приоритет моделей (ключи строк таблицы) для политики `any`.
   * Строки, которых здесь нет, идут следом в порядке таблицы.
   */
  modelPriority: z.array(z.string()).default([]),
  /** Подтреды могут тратить лимит других машин. */
  subthreadsUseOtherMachines: z.boolean().default(false),
  /** Возврат на приоритетную ступень между ходами, не раньше чем через N минут. */
  returnAfterMinutes: z.number().int().min(0).max(24 * 60).default(30),
  /** Каскад модели исчерпан: ждать сброса до N часов, потом спросить владельца. */
  exhaustedWaitHours: z.number().min(0).max(7 * 24).default(6),
  /** Остаток ниже порога (в процентах) — окно считается исчерпанным. */
  minRemainingPercent: z.number().min(0).max(50).default(1),
  /** Положительное решение только по показанию не старше N секунд. */
  positiveFreshSeconds: z.number().int().min(5).max(3600).default(60),
  /** Общий бюджет ожидания чтения лимитов перед ходом. */
  preTurnBudgetMs: z.number().int().min(500).max(60_000).default(5_000),
  /**
   * 0.3.5: показание не старше стольких минут с запасом (≤ 90 % использовано) —
   * квота известна, даже если оно старше positiveFreshSeconds. 0 — выключено.
   */
  staleOkMinutes: z.number().int().min(0).max(120).default(15),
  /** 0.3.8: показание пакета шлюза (vclaude) свежее столько минут: кабинет обновляется раз в 10–15 мин. */
  packageFreshMinutes: z.number().int().min(1).max(240).default(20),
  /**
   * 0.3.6: тёплый хвост ленивого режима, минут. После хода на исполнителе W работает
   * ещё столько; повторный ход на той же машине готовится одним flush (~1–2 с). 0 — выключено.
   */
  warmTailMinutes: z.number().int().min(0).max(240).default(30),
  /** Фоновая перепроверка приоритетной ступени при спросе. */
  recheckMinutes: z.number().int().min(1).max(120).default(5),
});
export type Policies = z.infer<typeof policiesSchema>;

/**
 * Политика моделей профиля:
 * - only — только модель X;
 * - prefer-then-any — сначала X на всех ступенях, когда X нигде недоступна — любые по приоритету;
 * - any — на каждой ступени лучшая доступная модель по общему приоритету.
 */
export const profilePolicySchema = z.enum(['only', 'prefer-then-any', 'any']);
export type ProfilePolicy = z.infer<typeof profilePolicySchema>;

/**
 * Профиль каскада — именованная настройка, которая видна пунктом в списке
 * моделей провайдера. Порядок массива — порядок в списке моделей.
 */
export const profileSchema = z.object({
  /** Стабильный ID; он же ID модели провайдера. */
  id: z.string().min(1).regex(/^[a-z0-9][a-z0-9._-]*$/),
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  policy: profilePolicySchema.default('any'),
  /** Ключ строки таблицы для `only` и `prefer-then-any`. */
  modelKey: z.string().nullable().default(null),
  /** Свой порядок ступеней (ID); null — как в общем каскаде. Новые ступени идут в конец. */
  stepOrder: z.array(z.string()).nullable().default(null),
  /** Исключённые ступени. */
  excludedSteps: z.array(z.string()).default([]),
  /** Исключённые провайдеры целиком («без Codex»), включая будущие ступени. */
  excludedProviders: z.array(z.string()).default([]),
  /** stepId → «спрашивать при входе» поверх настройки ступени. */
  confirm: z.record(z.string(), z.boolean()).default({}),
  /**
   * 0.3.4 (устарело с 0.3.5): `codex` читается как `descendants: 'subthread-codex'`.
   */
  subthreads: z.enum(['same', 'codex']).optional(),
  /**
   * 0.3.5: правило для всех потомков треда на этом профиле (профиль = self +
   * descendants). ID профиля, по которому идут подтреды, их подтреды и т.д.;
   * `subthread-codex` — «только Codex, любая машина». Нет поля — потомки идут по
   * своему профилю (обычно это профиль родителя из BB_CASCADE_PROFILE).
   */
  descendants: z.string().min(1).nullable().optional(),
  /**
   * 0.3.5: правило потомков исчерпано везде. `wait` (по умолчанию) — ждать сброса
   * или спросить владельца, другие ступени не тратятся; `fallback` — ход по «Авто»
   * со строкой в ленте.
   */
  onDescendantsExhausted: z.enum(['wait', 'fallback']).optional(),
  /**
   * 0.3.5: «квота неизвестна» поверх настройки ступени (`step.onUnknown`). Нет поля —
   * как у ступени. «Подтред · Codex» ставит `try`: неизвестная квота Codex — повод
   * попробовать ступень и узнать лимит из хода, а не откат на Claude.
   */
  onUnknown: z.enum(['skip', 'try']).optional(),
  /** 0.4.1: «спрашивать при входе» для ступеней без своей отметки в `confirm`; нет — как у ступени. */
  confirmDefault: z.boolean().optional(),
  /** 0.4.1: не показывать в списке моделей (прежний профиль: старые треды на нём работают). */
  hidden: z.boolean().optional(),
});
export type Profile = z.infer<typeof profileSchema>;

/** Состояние лимита ступени: есть, исчерпан, неизвестен, ступень недоступна. */
export const quotaStateSchema = z.enum(['available', 'exhausted', 'unknown', 'unavailable']);
export type QuotaState = z.infer<typeof quotaStateSchema>;

/**
 * Тестовый источник квоты для приёмочных сценариев (S1–S13): лимит каждой
 * ступени задаётся вручную, реальные лимиты не тратятся. Действует только
 * в перечисленных тредах; превью и схема профиля на экране тоже его учитывают.
 */
export const testQuotaEntrySchema = z.object({
  state: quotaStateSchema.default('available'),
  /** Время сброса (ISO); null — неизвестно. Исчерпание с прошедшим сбросом — «лимит есть». */
  resetsAt: z.string().nullable().default(null),
});
export type TestQuotaEntry = z.infer<typeof testQuotaEntrySchema>;

export const testQuotaSchema = z.object({
  enabled: z.boolean().default(false),
  /** Тестовые треды. Пусто — подмена не действует ни в одном треде. */
  threadIds: z.array(z.string().min(1)).default([]),
  /** stepId → лимит. Ступень без записи считается «лимит есть». */
  steps: z.record(z.string(), testQuotaEntrySchema).default({}),
  /**
   * Подмена для одного живого треда (CLI `test-quota --thread`): threadId →
   * stepId → лимит. Действует независимо от `enabled`; ступень без записи — «лимит есть».
   */
  threads: z.record(z.string(), z.record(z.string(), testQuotaEntrySchema)).default({}),
  /**
   * Приёмка S13: мост считается несовместимым (как после обновления BB с другой
   * формой моста), без правки BB. Ходы каскада отклоняются с подсказкой.
   */
  bridgeIncompatible: z.boolean().default(false),
});
export type TestQuota = z.infer<typeof testQuotaSchema>;

export const configSchema = z.object({
  version: z.literal(1).default(1),
  machines: z.array(machineSchema).default([]),
  steps: z.array(stepSchema).default([]),
  models: z.array(modelRowSchema).default([]),
  /** Профили каскада; пусто после удаления владельцем — пусто, умолчания только при отсутствии поля. */
  profiles: z.array(profileSchema).default([]),
  /**
   * 0.3.4: встроенные профили, уже предложенные этой установке. Новый встроенный
   * профиль добавляется в существующие настройки один раз; удалил владелец — не
   * возвращается.
   */
  offeredProfiles: z.array(z.string()).default([]),
  policies: policiesSchema.default(policiesSchema.parse({})),
  files: filesSchema.default(filesSchema.parse({})),
  testQuota: testQuotaSchema.default(testQuotaSchema.parse({})),
});
export type CascadeConfig = z.infer<typeof configSchema>;

// ---- Обнаружение (runtime, в конфигурацию не пишется) ----

export const limitWindowSchema = z.object({
  /** Тип окна: 5 часов, неделя, модельное окно, пакет. */
  kind: z.enum(['five-hour', 'weekly', 'model', 'package', 'other']),
  label: z.string(),
  usedPercent: z.number().min(0).max(100).nullable(),
  resetsAt: z.string().nullable(),
  /** Модели, к которым окно относится (пусто — ко всем). */
  models: z.array(z.string()).default([]),
});
export type LimitWindow = z.infer<typeof limitWindowSchema>;

export const catalogModelSchema = z.object({ id: z.string(), displayName: z.string(), model: z.string().optional() });
export type CatalogModel = z.infer<typeof catalogModelSchema>;

export const discoveredAccountSchema = z.object({
  hostId: z.string(),
  providerId: z.string(),
  installed: z.boolean(),
  loggedIn: z.boolean(),
  account: z.string().nullable(),
  plan: z.string().nullable(),
  models: z.array(catalogModelSchema),
  windows: z.array(limitWindowSchema),
  /** ok или причина unknown из Reading (auth, unsupported, …): «квота неизвестна» честно. */
  limitsStatus: z.string(),
  error: z.string().nullable(),
  fetchedAt: z.string(),
  /** 0.3.5: версия CLI из providerCliStatus (проверка готовности ступени); null — неизвестна. */
  cliVersion: z.string().nullable().optional(),
});
export type DiscoveredAccount = z.infer<typeof discoveredAccountSchema>;

export const discoveredHostSchema = z.object({
  hostId: z.string(),
  name: z.string(),
  connected: z.boolean(),
  platform: platformSchema,
});

// ---- Мастер «Настроить» ----

export const wizardStepIdSchema = z.enum(['probe', 'folder', 'mutagen', 'ssh', 'verify']);
export type WizardStepId = z.infer<typeof wizardStepIdSchema>;
export const wizardStepStatusSchema = z.enum(['pending', 'running', 'done', 'failed', 'skipped', 'manual']);
export const wizardMachineStateSchema = z.object({
  hostId: z.string(),
  steps: z.record(z.string(), z.object({
    status: wizardStepStatusSchema,
    message: z.string().nullable(),
    at: z.string().nullable(),
  })),
  /**
   * Ждёт согласия владельца (шаг ssh): какой ключ и куда добавить. Согласие —
   * wizardRun с allowSsh: [hostId] или CLI `setup --machine <id> --allow-ssh`.
   */
  pendingConsent: z.object({ text: z.string(), fingerprint: z.string(), publicKey: z.string() }).nullable().optional(),
});
export type WizardMachineState = z.infer<typeof wizardMachineStateSchema>;

export const wizardPlanStepSchema = z.object({
  id: wizardStepIdSchema,
  title: z.string(),
  /** Команда проверки: код 0 — шаг уже выполнен. */
  check: z.string().nullable(),
  /** Команда применения. null — шаг выполняется вручную. */
  apply: z.string().nullable(),
  /** Права: системное окно macOS, root без запроса, ручной шаг. */
  privilege: z.enum(['none', 'macos-dialog', 'root', 'manual', 'consent']),
  note: z.string().nullable(),
});
export type WizardPlanStep = z.infer<typeof wizardPlanStepSchema>;

// ---- RPC для экрана настроек ----

const cellStatusSchema = z.enum(['auto', 'manual', 'unmatched', 'ambiguous', 'missing', 'no-cli', 'unknown', 'blocked']);
export type CellStatus = z.infer<typeof cellStatusSchema>;

export const stateSchema = z.object({
  config: configSchema,
  hosts: z.array(discoveredHostSchema),
  accounts: z.array(discoveredAccountSchema),
  /** Раскладка ячеек таблицы: rowKey → hostId → статус и кандидаты. */
  cells: z.record(z.string(), z.record(z.string(), z.object({
    status: cellStatusSchema,
    modelId: z.string().nullable(),
    candidates: z.array(z.string()),
    /** blocked: почему модель недоступна на аккаунте машины («requires usage credits») и до когда. */
    reason: z.string().optional(),
  }))),
  wizard: z.array(wizardMachineStateSchema),
  /** Лимиты по ступеням (модуль мониторинга): состояние и строка для экрана. */
  stepLimits: z.record(z.string(), z.object({
    state: quotaStateSchema, text: z.string(),
    /** Сброс блокирующего окна, мс; null — неизвестен. Для превью и схемы профиля. */
    resetsAt: z.number().nullable().default(null),
  })),
  /** Проекты BB — для режима синхронизации по проекту. */
  projects: z.array(z.object({ id: z.string(), name: z.string() })),
  issues: z.array(z.string()),
  /** 0.3.5: готовность ступеней (`check`): неготовая включена, но маршрут её пропускает с причиной. */
  readiness: z.record(z.string(), z.object({ ready: z.boolean(), reason: z.string().nullable(), at: z.number() })).optional(),
});
export type CascadeState = z.infer<typeof stateSchema>;

export const rpcContract = defineRpcContract({
  state: { input: z.object({ refresh: z.boolean().default(false) }), output: stateSchema },
  saveConfig: { input: z.object({ config: configSchema }), output: stateSchema },
  /** Добавить машины, ступени и строки моделей из обнаруженного. Ничего не удаляет. */
  adoptDiscovered: { input: z.null(), output: stateSchema },
  wizardPlan: { input: z.object({ hostId: z.string() }), output: z.object({ steps: z.array(wizardPlanStepSchema) }) },
  /** Запуск мастера. dryRun — только план, без команд на машинах. */
  /**
   * Запуск мастера; состояние каждого шага хранится на сервере — повтор продолжает
   * с места остановки. dryRun — только план. recheck — повторить все проверки,
   * ничего не удаляя. reset — «Настроить с нуля»: снять сессии Mutagen каскада и
   * выданные ключи, сбросить шаги (файлы проектов и общий путь не трогаются).
   * allowSsh — машины, которым владелец разрешил вход на опору по ключу.
   */
  wizardRun: {
    input: z.object({
      hostIds: z.array(z.string()).optional(), dryRun: z.boolean().default(true),
      recheck: z.boolean().default(false), reset: z.boolean().default(false), allowSsh: z.array(z.string()).default([]),
    }),
    output: z.object({ wizard: z.array(wizardMachineStateSchema) }),
  },
});

// ---- Хост-RPC: только чтение фактов о машине ----

export const hostContract = defineRpcContract({
  /** 0.4.0: квота Codex через app-server машины (`account/rateLimits/read`), форма usageLimits().codex. */
  codexRateLimits: {
    input: z.object({}).default({}),
    output: z.object({ usage: z.record(z.string(), z.unknown()).nullable(), error: z.string().nullable() }),
  },
  probe: {
    input: z.object({ sharedPath: z.string() }),
    output: z.object({
      platform: platformSchema,
      isRoot: z.boolean(),
      user: z.string().nullable(),
      sharedPathExists: z.boolean(),
      sharedPathWritable: z.boolean(),
      mutagenVersion: z.string().nullable(),
    }),
  },
});
