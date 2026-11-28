// Единый контракт адаптера провайдера. Сведён из трёх источников:
// - cross-provider.md — запуск/resume, разбор событий, exportContext/importContext;
// - limits-adapters.md — LimitsAdapter, Reading, WindowSample (дословно);
// - recon-bb-sdk (выжимка) — путь A: подмена CLI штатного провайдера через relayEnv.
// Адаптеры регистрируются по строковому ID провайдера; движок каскада от них не зависит.
// Gemini CLI и ACP подключаются новым адаптером без изменения движка.

// ---------------------------------------------------------------- общие типы

/** Unix-миллисекунды UTC. */
export type Instant = number;

/**
 * Ступень с точки зрения адаптера: машина × провайдер × профиль.
 * `host` из cross-provider.md = `hostId`; `profileGeneration` = `bindingEpoch`.
 */
export type Stage = Readonly<{
  hostId: string;
  provider: string;
  /** Локальная непрозрачная ссылка на профиль CLI; сервер не знает каталогов и токенов. */
  profileRef: string;
  /** Подписка провайдера или API-шлюз (нативный CLI + ANTHROPIC_BASE_URL и т. п.). */
  authority: 'subscription' | 'gateway';
  /** Явно подтверждённая общая квота. */
  quotaGroup?: string;
  /** Источник квоты ступени (provider | vclaude); адаптер лимитов выбирает чтение по нему. */
  quotaSource?: string;
  /** Поколение связи профиль–аккаунт–маршрут; смена делает старые согласия и чтения недействительными. */
  bindingEpoch: string;
}>;

// ---------------------------------------------------------------- 1. запуск

export type Capabilities = {
  protocolVersion: string;
  resumeById: boolean;
  durableInputReceipt: boolean;
  approval: 'interactive' | 'deny-only';
  inputMime: readonly string[];
  limits: 'query' | 'events' | 'unknown';
};

export type Session = Readonly<{
  thread: string; stage: Stage; workspace: string; nativeId: string;
  generation: number; coveredSeq: number;
}>;

export type Turn = {
  thread: string; turn: string; attempt: string; epoch: number;
  stage: Stage; workspace: string; request: string;
  /** ID модели у CLI этой машины (из таблицы ассоциаций); null — по умолчанию CLI. */
  model: string | null;
  attachments: readonly Attachment[];
};

export type Run<Frame> = {
  frames: AsyncIterable<Frame>;
  answer(request: string, decision: 'allow-once' | 'deny'): Promise<void>;
  stopAndDrain(): Promise<'quiescent' | 'unconfirmed'>;
};

/** Типизированные отказы на границе моста; только отказ до отправки разрешает другой способ доставки. */
export type AdapterFailure = 'sessionMissing' | 'syncMismatch' | 'unsupportedInput' | 'deliveryUnknown' | 'notImplemented';
export class AdapterError extends Error {
  readonly reason: AdapterFailure;
  readonly beforeDispatch: boolean;
  constructor(reason: AdapterFailure, message: string, beforeDispatch: boolean) {
    super(message);
    this.reason = reason;
    this.beforeDispatch = beforeDispatch;
  }
}

/**
 * Путь A (этап 1): какую переменную окружения штатного провайдера BB подменить
 * на relay. Claude — `BB_CLAUDE_CODE_EXECUTABLE`; Codex — `BB_CODEX_BRIDGE_APP_SERVER_COMMAND`
 * и `_ARGS`. null — провайдер путь A не поддерживает (только путь B).
 */
export type RelayEnv = { command: string; args?: string } | null;

// ---------------------------------------------------------------- 2. события

export type EffectState = 'awaitingApproval' | 'denied' | 'inFlight' | 'unknown'
  | 'done' | 'failed' | 'cancelledBeforeDispatch';

/** Семантическое событие хода (имя из cross-provider.md — `CascadeEvent`). */
export type AdapterEvent =
  | { kind: 'session'; nativeId: string }
  | { kind: 'inputAccepted'; receipt: string }
  | { kind: 'text'; item: string; text: string; mode: 'append' | 'replace' }
  | { kind: 'tool'; call: string; state: EffectState; evidence?: string }
  | { kind: 'approval'; request: string; call: string; summary: string }
  | { kind: 'limits'; value: Limits }
  | { kind: 'end'; status: 'completed' | 'interrupted' | 'failed' }
  | { kind: 'diagnostic'; code: string };

// ---------------------------------------------------------------- 3. контекст

export type Fact = { seq: number; kind: 'decision' | 'edit' | 'task' | 'message'; text: string; evidence: readonly string[] };
export type Effect = { seq: number; actionId: string; state: EffectState; description: string; receiptRef?: string };
export type Attachment = { seq: number; ref: string; name: string; mime: string; bytes: number; sha256: string; required: boolean };
export type Slice = {
  thread: string; after: number; through: number; mode: 'snapshot' | 'delta';
  facts: readonly Fact[]; effects: readonly Effect[]; attachments: readonly Attachment[];
};
export type Packet = Readonly<Slice & { version: 1; digest: string }>;

// ---------------------------------------------------------------- 4. лимиты (limits-adapters.md)

export type WindowSample = {
  meter: string;
  windowId: string;
  period: 'five-hour' | 'weekly' | 'daily' | 'monthly' | 'other';
  durationMinutes?: number;
  scope: { kind: 'account' | 'model' | 'package' | 'other'; id?: string };
  usedPercent: number | null;
  remaining?: { amount: number; unit: string; estimated: boolean };
  resetsAt: Instant | null;
  /** Окончание пакета. */
  expiresAt?: Instant;
  /** Время источника или свежего прямого чтения. */
  observedAt: Instant | null;
  /** Получение на сервере BB. */
  receivedAt: Instant;
  timeBasis: 'source' | 'direct-read' | 'unknown-cache';
  origin: 'bb' | 'claude-control' | 'claude-event' | 'statusline' | 'codex-rpc' | 'codex-event' | 'rollout' | 'gateway-cli'
    /** Расширение контракта: кабинет шлюза, прочитанный другим плагином (vclaude из thread-account-usage). */
    | 'gateway-cabinet';
};

export type Reading =
  | { kind: 'sample'; windows: WindowSample[]; coverage: 'snapshot' | 'partial';
      bindingEpoch: string; subjectRef?: string; receivedAt: Instant;
      admission?: { state: 'allowed' | 'rejected'; meter?: string; model?: string; observedAt: Instant | null; retryAt?: Instant } }
  | { kind: 'unknown'; reason: 'unsupported' | 'auth' | 'identity' | 'offline' | 'throttled' | 'timeout' | 'malformed' | 'empty' | 'stale' | 'source-error';
      checkedAt: Instant; retryAt?: Instant;
      /** 0.3.7: текст ошибки источника («Codex usage request failed (HTTP 403)»). */
      detail?: string };

export interface LimitsAdapter {
  readonly provider: string;
  supports(stage: Stage): { poll: boolean; events: boolean };
  read(stage: Stage, signal: AbortSignal): Promise<Reading>;
  onNativeEvent(stage: Stage, event: unknown, receivedAt: Instant): Reading | null;
}

/** Краткая сводка лимитов для событий хода (cross-provider.md `Limits`). */
export type Limits = {
  state: 'available' | 'warning' | 'exhausted' | 'unknown';
  observedAt: string;
  windows: readonly { name: string; usedFraction?: number; resetsAt?: string }[];
};

// ---------------------------------------------------------------- единый адаптер

export interface ProviderAdapter<Input = unknown, Frame = unknown> {
  readonly id: string;
  readonly displayName: string;
  capabilities(stage: Stage): Promise<Capabilities>;
  // 1. Запуск нативного CLI
  readonly relayEnv: RelayEnv;
  start(turn: Turn, input: Input): Promise<Run<Frame>>;
  resume(session: Session, turn: Turn, input: Input): Promise<Run<Frame>>;
  // 2. Разбор событий
  parseEvent(frame: Frame): readonly AdapterEvent[];
  // 3. Передача контекста при смене провайдера
  exportContext(slice: Slice): Promise<Packet>;
  importContext(packet: Packet, turn: Turn): Promise<Input>;
  // 4. Чтение лимитов: остаток, сброс, тип окна
  readonly limits: LimitsAdapter;
}

export class AdapterRegistry {
  private readonly byId = new Map<string, ProviderAdapter>();
  register(adapter: ProviderAdapter): void {
    if (this.byId.has(adapter.id)) throw new Error(`Адаптер ${adapter.id} уже зарегистрирован`);
    this.byId.set(adapter.id, adapter);
  }
  get(id: string): ProviderAdapter | undefined { return this.byId.get(id); }
  list(): ProviderAdapter[] { return [...this.byId.values()]; }
}

/** Заготовка частей, которые ещё пишут параллельные треды (запуск, контекст). */
export function pendingRuntime(provider: string): Pick<ProviderAdapter, 'start' | 'resume' | 'exportContext' | 'importContext'> {
  const pending = (what: string) => new AdapterError('notImplemented', `${provider}: ${what} ещё не реализовано`, true);
  return {
    start: async () => { throw pending('запуск хода'); },
    resume: async () => { throw pending('продолжение сессии'); },
    exportContext: async () => { throw pending('экспорт контекста'); },
    importContext: async () => { throw pending('импорт контекста'); },
  };
}
