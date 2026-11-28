// Первые адаптеры: claude-code и codex.
// Готово: разбор событий (stream-json Claude, app-server Codex) и лимиты.
// Заготовки: start/resume и exportContext/importContext — их дадут треды
// исполнителя (путь A/B) и передачи контекста (cross-provider.md).
import {
  AdapterRegistry, pendingRuntime,
  type AdapterEvent, type Capabilities, type Instant, type Limits, type LimitsAdapter, type ProviderAdapter, type Reading, type Stage, type WindowSample,
} from './adapter.ts';
import { periodOf, readingFromPackageUsage, readingFromUsageLimits, toInstant } from './limits.ts';

const rec = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const str = (v: unknown): string | null => typeof v === 'string' && v.length > 0 ? v : null;
const num = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;

/** Кадр — строка JSONL или уже разобранный объект. */
export function frameObject(frame: unknown): Record<string, unknown> | null {
  if (typeof frame === 'string') {
    try { const v: unknown = JSON.parse(frame); return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null; } catch { return null; }
  }
  return frame && typeof frame === 'object' && !Array.isArray(frame) ? frame as Record<string, unknown> : null;
}

export interface AdapterDeps {
  /** `bb.sdk.system.usageLimits({ hostId, refresh: true })` — все провайдеры машины. */
  usageLimits(hostId: string, signal: AbortSignal): Promise<Record<string, unknown>>;
  /** RPC `thread-account-usage.vclaude`: `{ usage, error }`; плагин не установлен — reject. */
  vclaudeUsage(refresh: boolean, signal: AbortSignal): Promise<unknown>;
  /** 0.4.0: квота Codex через app-server машины (если usageLimits её не отдал, например HTTP 403). */
  codexRateLimits?(hostId: string, signal: AbortSignal): Promise<unknown>;
  now(): Instant;
}

/** Reading → краткая сводка для события `limits` хода. */
export function summarizeLimits(reading: Reading, threshold = 99): Limits {
  if (reading.kind === 'unknown') return { state: 'unknown', observedAt: new Date(reading.checkedAt).toISOString(), windows: [] };
  const used = reading.windows.map(w => w.usedPercent ?? 0);
  const state = reading.admission?.state === 'rejected' || used.some(u => u >= threshold) ? 'exhausted' : used.some(u => u >= 80) ? 'warning' : 'available';
  return {
    state, observedAt: new Date(reading.receivedAt).toISOString(),
    windows: reading.windows.map(w => ({ name: w.windowId, ...(w.usedPercent === null ? {} : { usedFraction: w.usedPercent / 100 }), ...(w.resetsAt ? { resetsAt: new Date(w.resetsAt).toISOString() } : {}) })),
  };
}

function eventSample(stage: Stage, receivedAt: Instant, partial: Omit<WindowSample, 'meter' | 'receivedAt'> & { meter?: string }): WindowSample {
  return { meter: stage.provider, receivedAt, ...partial };
}

// ---------------------------------------------------------------- Claude Code

/**
 * Лимиты Claude: подписка — опрос через BB и события; шлюз vclaude — остаток
 * пакета из thread-account-usage; другой шлюз — только события CLI.
 */
export function claudeLimits(deps: AdapterDeps): LimitsAdapter {
  return {
    provider: 'claude-code',
    supports: stage => stage.quotaSource === 'vclaude' ? { poll: true, events: true }
      : stage.authority === 'gateway' ? { poll: false, events: true } : { poll: true, events: true },
    async read(stage, signal) {
      const now = deps.now();
      if (stage.quotaSource === 'vclaude') {
        try { return readingFromPackageUsage(await deps.vclaudeUsage(true, signal), stage, deps.now()); }
        catch { return { kind: 'unknown', reason: 'unsupported', checkedAt: now }; }
      }
      if (stage.authority === 'gateway') return { kind: 'unknown', reason: 'unsupported', checkedAt: now };
      return readingFromUsageLimits((await deps.usageLimits(stage.hostId, signal))['claude-code'], stage, deps.now(), true);
    },
    onNativeEvent: (stage, event, receivedAt) => claudeEventReading(stage, event, receivedAt),
  };
}

/**
 * `rate_limit_event.rate_limit_info` (utilization — доля 0–1, resetsAt — секунды)
 * и payload строки статуса (`rate_limits.*`, `spend_limit` шлюза) → Reading.
 */
export function claudeEventReading(stage: Stage, event: unknown, receivedAt: Instant): Reading | null {
  const e = rec(event);
  if (e.type === 'rate_limit_event') {
    const info = rec(e.rate_limit_info);
    const status = str(info.status);
    const reset = toInstant(info.resetsAt);
    const fraction = num(info.utilization);
    const kind = str(info.rateLimitType) ?? 'unified';
    const windows: WindowSample[] = fraction === null ? [] : [eventSample(stage, receivedAt, {
      windowId: `event:${kind}`, period: periodOf(kind, kind), scope: { kind: 'account' }, usedPercent: fraction * 100,
      resetsAt: reset, observedAt: receivedAt, timeBasis: 'source', origin: 'claude-event',
    })];
    return {
      kind: 'sample', windows, coverage: 'partial', bindingEpoch: stage.bindingEpoch, receivedAt,
      ...(status === 'rejected' ? { admission: { state: 'rejected' as const, observedAt: receivedAt, ...(reset ? { retryAt: reset } : {}) } }
        : status ? { admission: { state: 'allowed' as const, observedAt: receivedAt } } : {}),
    };
  }
  const rateLimits = rec(e.rate_limits);
  const spend = rec(rateLimits.spend_limit ?? e.spend_limit);
  const windows: WindowSample[] = [];
  for (const [key, period] of [['five_hour', 'five-hour'], ['seven_day', 'weekly']] as const) {
    const w = rec(rateLimits[key]);
    const used = num(w.used_percentage);
    if (used === null) continue;
    windows.push(eventSample(stage, receivedAt, { windowId: `statusline:${key}`, period, scope: { kind: 'account' }, usedPercent: used, resetsAt: toInstant(w.resets_at), observedAt: receivedAt, timeBasis: 'source', origin: 'statusline' }));
  }
  const spendUsed = num(spend.used_percentage);
  if (spendUsed !== null) {
    const limitUsd = num(spend.limit_usd);
    const usedUsd = num(spend.used_usd);
    const period = str(spend.period);
    windows.push(eventSample(stage, receivedAt, {
      meter: 'gateway-spend', windowId: `spend:${period ?? 'other'}`, period: period === 'daily' || period === 'weekly' || period === 'monthly' ? period : 'other',
      scope: { kind: 'account' }, usedPercent: spendUsed, resetsAt: toInstant(spend.resets_at), observedAt: receivedAt, timeBasis: 'source', origin: 'statusline',
      ...(limitUsd !== null && usedUsd !== null ? { remaining: { amount: Math.max(0, limitUsd - usedUsd), unit: 'USD', estimated: true } } : {}),
    }));
  }
  return windows.length > 0 ? { kind: 'sample', windows, coverage: 'partial', bindingEpoch: stage.bindingEpoch, receivedAt } : null;
}

/** Кадры `claude -p --output-format stream-json` → семантические события. */
export function parseClaudeFrame(frame: unknown): AdapterEvent[] {
  const f = frameObject(frame);
  if (!f) return [{ kind: 'diagnostic', code: 'claude:unparsed' }];
  if (f.type === 'system' && f.subtype === 'init' && str(f.session_id)) return [{ kind: 'session', nativeId: str(f.session_id)! }];
  if (f.type === 'assistant') {
    const message = rec(f.message);
    const content = Array.isArray(message.content) ? message.content.map(rec) : [];
    return content.flatMap((block, i): AdapterEvent[] => {
      if (block.type === 'text' && typeof block.text === 'string') return [{ kind: 'text', item: `${str(message.id) ?? 'msg'}:${i}`, text: block.text, mode: 'replace' }];
      if (block.type === 'tool_use' && str(block.id)) return [{ kind: 'tool', call: str(block.id)!, state: 'inFlight' }];
      return [];
    });
  }
  if (f.type === 'user') {
    const content = Array.isArray(rec(f.message).content) ? (rec(f.message).content as unknown[]).map(rec) : [];
    return content.filter(b => b.type === 'tool_result' && str(b.tool_use_id)).map(b => ({ kind: 'tool', call: str(b.tool_use_id)!, state: b.is_error === true ? 'failed' : 'done' } as AdapterEvent));
  }
  if (f.type === 'control_request' && rec(f.request).subtype === 'can_use_tool') {
    const request = rec(f.request);
    return [{ kind: 'approval', request: str(f.request_id) ?? '', call: str(request.tool_use_id) ?? '', summary: str(request.tool_name) ?? 'инструмент' }];
  }
  if (f.type === 'result') return [{ kind: 'end', status: f.is_error === true ? 'failed' : f.subtype === 'success' ? 'completed' : 'interrupted' }];
  if (f.type === 'rate_limit_event') return [{ kind: 'diagnostic', code: 'claude:rate_limit_event' }];  // лимиты идут через limits.onNativeEvent
  return [];
}

// ---------------------------------------------------------------- Codex

export function codexLimits(deps: AdapterDeps): LimitsAdapter {
  return {
    provider: 'codex',
    supports: () => ({ poll: true, events: true }),
    async read(stage, signal) {
      const usage = await deps.usageLimits(stage.hostId, signal).then(u => u.codex).catch(() => undefined);
      const reading = readingFromUsageLimits(usage, stage, deps.now(), true);
      if (reading.kind === 'sample' || !deps.codexRateLimits) return reading;
      // usageLimits не отдал квоту (403 с российского IP) — спросить сам Codex на машине.
      const own = await deps.codexRateLimits(stage.hostId, signal).catch(() => null);
      const fromCodex = readingFromUsageLimits(rec(own).usage ?? undefined, stage, deps.now(), true);
      return fromCodex.kind === 'sample' ? fromCodex : reading;
    },
    onNativeEvent: (stage, event, receivedAt) => codexEventReading(stage, event, receivedAt),
  };
}

/** `account/rateLimits/updated`: primary/secondary, usedPercent — проценты, resetsAt — секунды. */
export function codexEventReading(stage: Stage, event: unknown, receivedAt: Instant): Reading | null {
  const e = rec(event);
  if (e.method !== 'account/rateLimits/updated') return null;
  const limits = rec(rec(e.params).rateLimits);
  const windows: WindowSample[] = [];
  for (const slot of ['primary', 'secondary'] as const) {
    const w = rec(limits[slot]);
    const used = num(w.usedPercent);
    if (used === null) continue;
    const minutes = num(w.windowDurationMins);
    windows.push(eventSample(stage, receivedAt, {
      windowId: `rpc:${slot}`, period: minutes === 300 ? 'five-hour' : minutes === 10_080 ? 'weekly' : 'other', ...(minutes ? { durationMinutes: minutes } : {}),
      scope: { kind: 'account' }, usedPercent: used, resetsAt: toInstant(w.resetsAt), observedAt: receivedAt, timeBasis: 'source', origin: 'codex-event',
    }));
  }
  return windows.length > 0 ? { kind: 'sample', windows, coverage: 'partial', bindingEpoch: stage.bindingEpoch, receivedAt } : null;
}

/** Уведомления `codex app-server` → семантические события. */
export function parseCodexFrame(frame: unknown): AdapterEvent[] {
  const f = frameObject(frame);
  if (!f) return [{ kind: 'diagnostic', code: 'codex:unparsed' }];
  const p = rec(f.params);
  const item = rec(p.item);
  switch (f.method) {
    case 'thread/started': return str(rec(p.thread).id) ? [{ kind: 'session', nativeId: str(rec(p.thread).id)! }] : [];
    case 'item/agentMessage/delta': return [{ kind: 'text', item: str(p.itemId) ?? 'agent', text: str(p.delta) ?? '', mode: 'append' }];
    case 'item/started': return item.type === 'commandExecution' || item.type === 'fileChange' ? [{ kind: 'tool', call: str(item.id) ?? '', state: 'inFlight' }] : [];
    case 'item/completed': return item.type === 'commandExecution' || item.type === 'fileChange' ? [{ kind: 'tool', call: str(item.id) ?? '', state: item.status === 'failed' ? 'failed' : 'done' }] : [];
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return [{ kind: 'approval', request: String(f.id ?? ''), call: str(p.itemId) ?? '', summary: str(p.reason) ?? (f.method.includes('command') ? 'команда' : 'изменение файла') }];
    case 'turn/completed': {
      const status = str(rec(p.turn).status);
      return [{ kind: 'end', status: status === 'completed' ? 'completed' : status === 'interrupted' ? 'interrupted' : 'failed' }];
    }
    case 'account/rateLimits/updated': return [{ kind: 'diagnostic', code: 'codex:rateLimits' }];
    default: return [];
  }
}

// ---------------------------------------------------------------- реестр

function capabilities(protocolVersion: string, limits: (stage: Stage) => Capabilities['limits']) {
  return async (stage: Stage): Promise<Capabilities> => ({
    protocolVersion, resumeById: true, durableInputReceipt: false, approval: 'interactive',
    inputMime: ['text/plain', 'image/png', 'image/jpeg'], limits: limits(stage),
  });
}

export function claudeCodeAdapter(deps: AdapterDeps): ProviderAdapter {
  return {
    id: 'claude-code', displayName: 'Claude',
    capabilities: capabilities('claude-code/stream-json', stage => stage.authority === 'gateway' ? 'events' : 'query'),
    relayEnv: { command: 'BB_CLAUDE_CODE_EXECUTABLE' },
    ...pendingRuntime('claude-code'),
    parseEvent: parseClaudeFrame,
    limits: claudeLimits(deps),
  };
}

export function codexAdapter(deps: AdapterDeps): ProviderAdapter {
  return {
    id: 'codex', displayName: 'Codex',
    capabilities: capabilities('codex/app-server-v2', () => 'query'),
    relayEnv: { command: 'BB_CODEX_BRIDGE_APP_SERVER_COMMAND', args: 'BB_CODEX_BRIDGE_APP_SERVER_ARGS' },
    ...pendingRuntime('codex'),
    parseEvent: parseCodexFrame,
    limits: codexLimits(deps),
  };
}

export function defaultRegistry(deps: AdapterDeps): AdapterRegistry {
  const registry = new AdapterRegistry();
  registry.register(claudeCodeAdapter(deps));
  registry.register(codexAdapter(deps));
  return registry;
}
