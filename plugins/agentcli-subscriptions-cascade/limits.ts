// Мониторинг лимитов: модуль плагина, по LimitsAdapter на провайдер.
// Правила (limits-adapters.md): unknown не равен ни нулю, ни полному запасу;
// положительное решение — только по свежему показанию с известным временем;
// известное исчерпание держится до сброса; при нескольких блокирующих окнах
// возврат — после самого позднего сброса.
import type { Instant, LimitsAdapter, Reading, Stage, WindowSample } from './adapter.ts';
import type { Policies } from './contract.ts';
import { canonicalModelKey } from './models.ts';

const rec = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const str = (v: unknown): string | null => typeof v === 'string' && v.length > 0 ? v : null;
const finite = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;

/** ISO с часовым поясом или Unix-секунды/миллисекунды → Instant; иначе null. */
export function toInstant(value: unknown): Instant | null {
  const n = finite(value);
  if (n !== null) return n > 1e12 ? n : n * 1000;
  const s = str(value);
  if (!s || !/(Z|[+-]\d{2}:?\d{2})$/.test(s)) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

export function periodOf(label: string, kind: unknown): WindowSample['period'] {
  const text = `${typeof kind === 'string' ? kind : ''} ${label}`.toLowerCase();
  if (/five|5[- ]?h|session/.test(text)) return 'five-hour';
  if (/week|seven/.test(text)) return 'weekly';
  if (/day|daily/.test(text)) return 'daily';
  if (/month/.test(text)) return 'monthly';
  return 'other';
}

const FAMILIES = ['opus', 'sonnet', 'fable', 'haiku', 'gpt', 'codex', 'gemini'];

/**
 * Ответ `bb.sdk.system.usageLimits({ hostId, refresh })[provider]` → Reading.
 * refresh=true даёт `direct-read`; иначе время источника неизвестно (`unknown-cache`).
 */
export function readingFromUsageLimits(raw: unknown, stage: Stage, receivedAt: Instant, refreshed: boolean): Reading {
  const data = rec(raw);
  const status = str(data.status);
  if (raw === undefined || raw === null) return { kind: 'unknown', reason: 'empty', checkedAt: receivedAt };
  if (status === 'unauthenticated' || status === 'expired') return { kind: 'unknown', reason: 'auth', checkedAt: receivedAt };
  if (status === 'rate_limited' || status === 'throttled') return { kind: 'unknown', reason: 'throttled', checkedAt: receivedAt };
  if (status !== 'ok') return { kind: 'unknown', reason: status ? 'unsupported' : 'malformed', checkedAt: receivedAt };
  const list = Array.isArray(data.windows) ? data.windows : [];
  const windows: WindowSample[] = list.flatMap(item => {
    const w = rec(item);
    const label = str(w.label) ?? str(w.kind);
    if (!label) return [];
    const used = finite(w.usedPercent);
    const model = str(w.model) ?? FAMILIES.find(f => label.toLowerCase().includes(f) && str(w.kind) === 'model') ?? null;
    return [{
      meter: stage.provider, windowId: `${str(w.kind) ?? 'window'}:${label}`, period: periodOf(label, w.kind),
      scope: model ? { kind: 'model', id: model } : { kind: 'account' },
      usedPercent: used === null ? null : Math.max(0, used), resetsAt: toInstant(w.resetsAt),
      observedAt: refreshed ? receivedAt : null, receivedAt,
      timeBasis: refreshed ? 'direct-read' : 'unknown-cache', origin: 'bb',
    } satisfies WindowSample];
  });
  if (windows.length === 0) return { kind: 'unknown', reason: 'empty', checkedAt: receivedAt };
  const subject = str(data.accountKey) ?? str(data.accountEmail)?.toLowerCase();
  return { kind: 'sample', windows, coverage: 'snapshot', bindingEpoch: stage.bindingEpoch, ...(subject ? { subjectRef: subject } : {}), receivedAt };
}

/**
 * Пакет шлюза vclaude из RPC `thread-account-usage.vclaude` → Reading.
 * Остаток — в единицах пакета (remaining), не процент окна; у пакета нет
 * периодического сброса, есть окончание срока (expiresAt). Ключи и адреса
 * кабинета остаются в thread-account-usage.
 */
export function readingFromPackageUsage(raw: unknown, stage: Stage, receivedAt: Instant): Reading {
  const data = rec(rec(raw).usage);
  const error = str(rec(raw).error);
  const limit = finite(data.limitUnits);
  const left = finite(data.remainingUnits);
  if (limit === null || left === null) return { kind: 'unknown', reason: error ? 'unsupported' : 'empty', checkedAt: receivedAt };
  if (limit === 0) return { kind: 'sample', windows: [], coverage: 'snapshot', bindingEpoch: stage.bindingEpoch, receivedAt, admission: { state: 'rejected', observedAt: toInstant(data.fetchedAt) } };
  const observedAt = toInstant(data.fetchedAt);
  const window: WindowSample = {
    meter: 'gateway-package', windowId: 'package:vclaude', period: 'other', scope: { kind: 'package', id: 'vclaude' },
    usedPercent: Math.max(0, 100 * (1 - left / limit)), remaining: { amount: Math.max(0, left), unit: 'ед.', estimated: false },
    resetsAt: null, ...(toInstant(data.endsAt) ? { expiresAt: toInstant(data.endsAt)! } : {}),
    observedAt, receivedAt, timeBasis: observedAt === null ? 'unknown-cache' : 'source', origin: 'gateway-cabinet',
  };
  return { kind: 'sample', windows: [window], coverage: 'snapshot', bindingEpoch: stage.bindingEpoch, subjectRef: 'vclaude', receivedAt };
}

const windowKey = (w: WindowSample) => `${w.meter}|${w.windowId}`;
/** Исчерпано: пакет — по единицам и сроку; окно — по проценту. */
function exhaustedAt(w: WindowSample, threshold: number, now?: Instant): boolean {
  if (w.remaining) return w.remaining.amount <= 0 || (w.expiresAt !== undefined && now !== undefined && w.expiresAt <= now);
  return w.usedPercent !== null && w.usedPercent >= threshold;
}

/**
 * Слияние показаний: более новое окно заменяет старое; известное исчерпание
 * держится до сброса, даже если новый частичный ответ его не содержит.
 * Показание другого bindingEpoch отбрасывает старое целиком.
 */
export function mergeReading(prev: Reading | undefined, next: Reading, now: Instant, threshold = 99): Reading {
  if (!prev || prev.kind !== 'sample') return next;
  if (next.kind === 'sample' && next.bindingEpoch !== prev.bindingEpoch) return next;
  const held = prev.windows.filter(w => exhaustedAt(w, threshold) && (w.resetsAt === null || w.resetsAt > now));
  if (next.kind === 'unknown') {
    // Отказ источника не обнуляет подтверждённое исчерпание.
    return held.length > 0 ? { ...prev, windows: held, coverage: 'partial' } : next;
  }
  const byKey = new Map(next.windows.map(w => [windowKey(w), w]));
  for (const w of prev.windows) {
    const fresh = byKey.get(windowKey(w));
    const stamp = (x: WindowSample) => x.observedAt ?? -1;
    if (fresh && stamp(fresh) < stamp(w) && w.timeBasis !== 'unknown-cache') byKey.set(windowKey(w), w);  // запоздалое не заменяет новое
    if (!fresh && held.includes(w)) byKey.set(windowKey(w), w);
  }
  return { ...next, windows: [...byKey.values()] };
}

/** Относится ли окно к модели: окна аккаунта и пакета — ко всем; модельное — к своей модели. */
export function windowAppliesTo(w: WindowSample, modelId: string | null): boolean {
  if (w.scope.kind !== 'model') return true;
  if (!w.scope.id) return true;
  if (!modelId) return false;
  const want = canonicalModelKey(w.scope.id);
  const have = canonicalModelKey(modelId);
  return have === want || have.includes(want);
}

/** Состояние ступени для движка. */
export interface StepHealth {
  /** CLI готов: установлен, вход выполнен, машина на связи. */
  available: boolean;
  exhausted: boolean;
  /** Квота неизвестна (нет данных, данные устарели, источник не поддерживается). */
  unknown: boolean;
  /** Когда можно вернуться: самый поздний сброс блокирующих окон; null — неизвестно. */
  resetsAt: Instant | null;
  reason: string | null;
}

export function healthFromReading(reading: Reading | undefined, modelId: string | null, args: {
  connected: boolean; now: Instant; policies: Pick<Policies, 'minRemainingPercent' | 'positiveFreshSeconds'>;
}): StepHealth {
  const { now } = args;
  if (!args.connected) return { available: false, exhausted: false, unknown: true, resetsAt: null, reason: 'машина не на связи' };
  if (!reading) return { available: true, exhausted: false, unknown: true, resetsAt: null, reason: 'лимиты неизвестны' };
  if (reading.kind === 'unknown') {
    const why: Record<typeof reading.reason, string> = {
      unsupported: 'источник лимитов не поддерживается (шлюз?)', auth: 'нет входа или нет доступа к квоте', identity: 'аккаунт не подтверждён',
      offline: 'машина не на связи', throttled: 'источник ограничил запросы', timeout: 'чтение не уложилось в срок',
      malformed: 'непонятный ответ', empty: 'окон нет', stale: 'данные устарели',
    };
    return { available: reading.reason !== 'offline', exhausted: false, unknown: true, resetsAt: reading.retryAt ?? null, reason: `квота неизвестна: ${why[reading.reason]}` };
  }
  const threshold = 100 - args.policies.minRemainingPercent;
  if (reading.admission?.state === 'rejected' && (reading.admission.retryAt === undefined || reading.admission.retryAt > now)) {
    return { available: true, exhausted: true, unknown: false, resetsAt: reading.admission.retryAt ?? null, reason: 'провайдер отклонил ход по лимиту' };
  }
  const applicable = reading.windows.filter(w => windowAppliesTo(w, modelId));
  const blocking = applicable.filter(w => exhaustedAt(w, threshold, now) && (w.resetsAt === null || w.resetsAt > now));
  if (blocking.length > 0) {
    const resets = blocking.map(w => w.resetsAt);
    const resetsAt = resets.some(r => r === null) ? null : Math.max(...(resets as number[]));
    return { available: true, exhausted: true, unknown: false, resetsAt, reason: blocking.map(w => w.windowId.split(':').slice(1).join(':') || w.windowId).join(', ') };
  }
  const freshMs = args.policies.positiveFreshSeconds * 1000;
  const fresh = applicable.length > 0 && reading.coverage === 'snapshot'
    && applicable.every(w => w.timeBasis !== 'unknown-cache' && w.observedAt !== null && now - w.observedAt <= freshMs);
  if (!fresh) return { available: true, exhausted: false, unknown: true, resetsAt: null, reason: 'квота неизвестна: данные устарели' };
  return { available: true, exhausted: false, unknown: false, resetsAt: null, reason: null };
}

const millions = (n: number) => n >= 1e6 ? `${(n / 1e6).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} млн` : n.toLocaleString('ru-RU', { maximumFractionDigits: 0 });
const day = (t: Instant) => new Date(t).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }).replace('.', '');

/** Строка лимитов ступени для экрана: пакет — в единицах, окна — в процентах. */
export function describeReading(reading: Reading | undefined, health: StepHealth): { state: 'available' | 'exhausted' | 'unknown' | 'unavailable'; text: string } {
  const state = !health.available ? 'unavailable' : health.exhausted ? 'exhausted' : health.unknown ? 'unknown' : 'available';
  if (!reading || reading.kind === 'unknown') return { state, text: health.reason ?? 'квота неизвестна' };
  const parts = reading.windows.map(w => {
    if (w.remaining && w.usedPercent !== null && w.usedPercent < 100) {
      const total = w.remaining.amount / (1 - w.usedPercent / 100);
      return `осталось ${millions(w.remaining.amount)} из ${millions(total)} ${w.remaining.unit}${w.expiresAt ? `, до ${day(w.expiresAt)}` : ''}`;
    }
    const label = w.windowId.split(':').slice(1).join(':') || w.windowId;
    return `${label} ${w.usedPercent === null ? '?' : Math.round(w.usedPercent)}%`;
  });
  const text = parts.join(' · ') || (health.reason ?? '');
  return { state, text: health.unknown && health.reason ? `${text} (${health.reason})` : text };
}

/** Ключ общей квоты: подтверждённая группа или своя запись ступени. */
export const quotaKey = (stage: Stage) => stage.quotaGroup ? `group:${stage.quotaGroup}` : `${stage.hostId}|${stage.provider}|${stage.profileRef}|${stage.bindingEpoch}`;

/**
 * Кэш показаний по ключу квоты. Параллельные чтения одного субъекта
 * объединяются; перед ходом общий бюджет ожидания — preTurnBudgetMs.
 */
export class LimitMonitor {
  private readonly readings = new Map<string, Reading>();
  private readonly pending = new Map<string, Promise<Reading>>();
  private readonly adapters: (provider: string) => LimitsAdapter | undefined;
  private readonly threshold: number;
  constructor(adapters: (provider: string) => LimitsAdapter | undefined, threshold = 99) {
    this.adapters = adapters;
    this.threshold = threshold;
  }

  current(stage: Stage): Reading | undefined { return this.readings.get(quotaKey(stage)); }

  /** Пассивное событие нативного CLI (rate_limit_event, account/rateLimits/updated, statusline). */
  observe(stage: Stage, event: unknown, receivedAt: Instant): void {
    const reading = this.adapters(stage.provider)?.onNativeEvent(stage, event, receivedAt);
    if (reading) this.store(stage, reading, receivedAt);
  }

  async refresh(stage: Stage, budgetMs: number): Promise<Reading | undefined> {
    const adapter = this.adapters(stage.provider);
    if (!adapter || !adapter.supports(stage).poll) return this.current(stage);
    const key = quotaKey(stage);
    let job = this.pending.get(key);
    if (!job) {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      // Бюджет соблюдается, даже если адаптер не слушает сигнал: гонка с таймером.
      const timeout = new Promise<Reading>(resolve => {
        timer = setTimeout(() => { controller.abort(); resolve({ kind: 'unknown', reason: 'timeout', checkedAt: Date.now() }); }, budgetMs);
      });
      const read = adapter.read(stage, controller.signal)
        .catch((): Reading => ({ kind: 'unknown', reason: controller.signal.aborted ? 'timeout' : 'malformed', checkedAt: Date.now() }));
      job = Promise.race([read, timeout]).finally(() => { clearTimeout(timer); this.pending.delete(key); });
      this.pending.set(key, job);
    }
    const reading = await job;
    this.store(stage, reading, Date.now());
    return this.current(stage);
  }

  private store(stage: Stage, reading: Reading, now: Instant): void {
    const key = quotaKey(stage);
    // Результат опроса старого поколения связи игнорируется.
    if (reading.kind === 'sample' && reading.bindingEpoch !== stage.bindingEpoch) return;
    this.readings.set(key, mergeReading(this.readings.get(key), reading, now, this.threshold));
  }
}
