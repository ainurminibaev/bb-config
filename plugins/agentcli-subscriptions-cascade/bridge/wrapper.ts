// Мост провайдера «Каскад подписок» поверх импортированных штатных мостов.
//
// - initialize: грузим штатный мост Claude Code (свежую версию из кэша демона)
//   и отдаём его ответ; моста нет — отвечаем сами, ход потом откажет с подсказкой.
// - model/list: каталог профилей каскада (providerOptions.catalog), штатный не спрашиваем.
// - thread/* и turn/*: мост активного провайдера треда (Claude Code или Codex)
//   ровно той версии, что посчитал сервер (`providerOptions.cascade.digests`).
// - Переход Claude ↔ Codex внутри треда (turn/start): сервер говорит, какой
//   провайдер возьмёт ход (peekProvider). У каждого провайдера своя нативная
//   сессия; BB знает один providerThreadId треда (outerId) — мост переводит его
//   в ID нативной сессии активного провайдера и обратно. Курсор сессии — номер
//   события треда: первый переход — сводка, возврат — thread/resume прежней
//   сессии + дельта событий после курсора; сессия недоступна — новая со сводкой.
// - CLI подменяется запускателем: BB_CLAUDE_CODE_EXECUTABLE и
//   BB_CODEX_BRIDGE_APP_SERVER_COMMAND указывают на скрипты в dataDir.
// - Мост → runtime: перехват process.stdout.write. providerId в событиях лимита
//   переписывается на наш, provider-turn запоминается для строк ленты.
// - Запускатель шлёт в локальный сокет моста события ленты и запросы карточки
//   подтверждения; карточка уходит в runtime как `interaction/request`, ответ —
//   строкой обратно в сокет.
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BridgeAnswer } from '../launcher/confirm.ts';
import { LAUNCHER_ENV } from '../launcher/main.ts';
import { historyHint } from './context-brief.ts';
import type { ConfirmPrompt, NativeSessions, RouteNote } from './route-contract.ts';
import { catalogFrom } from './static-catalog.ts';
import {
  loadNativeBridge, NativeLoadError, nativeLoadHint, NATIVE_BRIDGES,
  type BridgeContext, type BridgeEntry, type LoadDeps, type LoadedNativeBridge, type NativeProviderId,
} from './native.ts';

export const BRIDGE_PROTOCOL_VERSION = 2;

type Json = Record<string, unknown>;
const rec = (v: unknown): Json => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Json : {};

/** Транспорт карточки: payload `interaction/request` → резолюция runtime. */
export type InteractionSend = (payload: unknown, signal: AbortSignal) => Promise<unknown>;

/** Перевод событий ленты в thread/delta и карточка подтверждения (реализация — timeline/, здесь только порт). */
export interface FeedRenderer {
  render(threadId: string, notes: readonly RouteNote[], providerTurnId: string | undefined): unknown[];
  confirm?(threadId: string, prompt: ConfirmPrompt, send: InteractionSend, providerTurnId: string | undefined, signal: AbortSignal): Promise<BridgeAnswer>;
}

/** Вызов RPC сервера каскада (REST BB_SERVER_URL). */
export interface ServerPort { call<T>(method: string, input: unknown): Promise<T> }

export interface CascadeBridgeOptions {
  providerId: string;
  ownArtifactUrl: string;
  loadDeps: LoadDeps;
  feed?: FeedRenderer;
  /** RPC сервера; нет — по BB_SERVER_URL из окружения моста. */
  server?: ServerPort;
  /** node, которым запускать запускатель (тот же, что у моста). */
  nodePath?: string;
  /** Запись в stdout в обход перехвата (для тестов — своя). */
  write?(line: string): void;
  log?(line: string): void;
  socketDir?: string;
  /** Срок ответа штатного моста на служебный thread/start|resume, мс. */
  innerTimeoutMs?: number;
}

interface Inner { loaded: LoadedNativeBridge; started: boolean; initialized: boolean }

const shellQuote = (value: string) => `'${value.replace(/'/gu, `'\\''`)}'`;
const PROVIDER_LABEL: Record<NativeProviderId, string> = { 'claude-code': 'Claude', codex: 'Codex' };

export function launcherScript(args: { nodePath: string; artifact: string; provider: NativeProviderId; self: string; feed: string | null; log: string; pluginId: string }): string {
  const env = [
    `${LAUNCHER_ENV.main}=1`,
    `${LAUNCHER_ENV.provider}=${args.provider}`,
    `${LAUNCHER_ENV.self}=${shellQuote(args.self)}`,
    `${LAUNCHER_ENV.log}=${shellQuote(args.log)}`,
    `${LAUNCHER_ENV.pluginId}=${shellQuote(args.pluginId)}`,
    ...(args.feed ? [`${LAUNCHER_ENV.feed}=${shellQuote(args.feed)}`] : []),
  ];
  return `#!/bin/sh\n# Каскад подписок: запускатель ${args.provider} (создаётся мостом, не править)\n${env.join(' ')} exec ${shellQuote(args.nodePath)} ${shellQuote(args.artifact)} "$@"\n`;
}

/** Ответ initialize, когда штатного моста нет: ход откажет с подсказкой. */
function fallbackInitialize() {
  return {
    ok: true, protocolVersion: BRIDGE_PROTOCOL_VERSION,
    capabilities: { sessionRestore: false, threadArchive: false, threadRename: false, threadGoalClear: false, fork: 'none', approvalEnforcedBy: 'runtime', grammarVersions: [3, 3], steerMode: 'queue', skills: { configure: false }, commands: { list: false } },
  };
}

/** RPC сервера каскада по REST BB (тот же путь, что у запускателя). */
export function httpServerPort(env: NodeJS.ProcessEnv, pluginId: () => string, fetchImpl: typeof fetch = fetch): ServerPort {
  return {
    async call<T>(method: string, input: unknown): Promise<T> {
      const base = env.BB_SERVER_URL;
      if (!base) throw new Error('нет BB_SERVER_URL в окружении моста');
      const response = await fetchImpl(`${base.replace(/\/+$/u, '')}/api/v1/plugins/${pluginId()}/rpc/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(30_000),
      });
      const json = await response.json().catch(() => null) as { ok?: boolean; result?: T; error?: { message?: string } } | null;
      if (!response.ok || !json?.ok) throw new Error(json?.error?.message ?? `HTTP ${response.status}`);
      return json.result as T;
    },
  };
}

/** Параметры сессии (thread/start|resume) без ID сессии и ввода — для открытия сессии другого провайдера. */
function sessionTemplate(params: Json): Json {
  const { providerThreadId: _id, input: _input, ...rest } = params;
  return rest;
}

/** options для штатного моста провайдера: свой мост в cascade.provider, модель ступени для Codex. */
function optionsFor(options: unknown, provider: NativeProviderId, modelId: string | null): Json {
  const base = structuredClone(rec(options));
  const providerOptions = rec(base.providerOptions);
  base.providerOptions = { ...providerOptions, cascade: { ...rec(providerOptions.cascade), provider } };
  // Профиль каскада («auto») для Claude подменяет запускатель; Codex берёт модель из turn/start.
  if (provider === 'codex') {
    if (modelId) base.model = modelId; else delete base.model;
  }
  return base;
}

export function createCascadeBridge(options: CascadeBridgeOptions): BridgeEntry & { close(): Promise<void>; ingestInnerOutput(text: string): void } {
  const log = options.log ?? (() => {});
  let rawWrite: (line: string) => void = options.write ?? (line => { process.stdout.write(line); });
  const inners = new Map<NativeProviderId, Inner>();
  const threadInner = new Map<string, Inner>();
  const threadTurn = new Map<string, string>();
  const pendingInnerRequests = new Map<string, Inner>();
  const swallowIds = new Set<string>();
  // Переход между провайдерами и карточки.
  const threadOuter = new Map<string, string>();
  const threadNative = new Map<string, NativeSessions>();
  /** Сервер ответил, что сессий другого провайдера у треда нет: не спрашивать на каждую команду. */
  const nativeMissing = new Set<string>();
  const nativeToOuter = new Map<string, string>();
  const threadTemplate = new Map<string, Json>();
  const startRequests = new Map<string, string>();
  const internalWaiters = new Map<string, (message: Json) => void>();
  const pendingAsks = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  let initParams: unknown = null;
  let context: BridgeContext | null = null;
  let loadError: NativeLoadError | null = null;
  let feedServer: Server | null = null;
  let feedPath: string | null = null;
  let internalId = 0;
  /**
   * Тред, команду которого мост последней отдал мосту Codex (он мог поднять app-server).
   * Процесс моста служит треду своего runtime; запись живёт 10 минут.
   */
  let codexThread: { threadId: string; at: number } | null = null;
  const noteCodexStart = (threadId: string) => {
    codexThread = { threadId, at: Date.now() };
    process.env.CASCADE_THREAD_ID = threadId; // запасной путь, если сокета нет
    if (serverEnv.BB_SERVER_URL) process.env.CASCADE_SERVER_URL = serverEnv.BB_SERVER_URL;
  };
  // Адрес сервера BB: у процесса моста BB_SERVER_URL может не быть — берём его из
  // envVars запросов runtime (model/list, thread/*, turn/*). Без него peekProvider
  // падал молча, и ход Codex уходил в мост Claude (петля S3 на 0.2.0).
  const serverEnv: NodeJS.ProcessEnv = { ...process.env };
  const server: ServerPort = options.server ?? httpServerPort(serverEnv, () => context?.pluginId ?? 'agentcli-subscriptions-cascade');
  const learnServerUrl = (params: Json) => {
    for (const vars of [rec(params.envVars), rec(rec(params.options).envVars)]) {
      if (typeof vars.BB_SERVER_URL === 'string' && vars.BB_SERVER_URL) { serverEnv.BB_SERVER_URL = vars.BB_SERVER_URL; process.env.CASCADE_SERVER_URL = vars.BB_SERVER_URL; return; }
    }
  };

  const send = (message: unknown) => rawWrite(`${JSON.stringify(message)}\n`);
  const reply = (id: unknown, result: unknown) => send({ jsonrpc: '2.0', id, result });
  const fail = (id: unknown, message: string, data?: unknown) => send({ jsonrpc: '2.0', id, error: { code: -32000, message, ...(data === undefined ? {} : { data }) } });

  // ---- Перехват вывода штатных мостов ----
  let outBuffer = '';
  function onInnerOutput(text: string): void {
    outBuffer += text;
    let newline = outBuffer.indexOf('\n');
    while (newline !== -1) {
      const line = outBuffer.slice(0, newline);
      outBuffer = outBuffer.slice(newline + 1);
      const rewritten = rewriteOutgoing(line);
      if (rewritten !== null) rawWrite(`${rewritten}\n`);
      newline = outBuffer.indexOf('\n');
    }
  }

  function rewriteOutgoing(line: string): string | null {
    let message: Json;
    try { message = JSON.parse(line) as Json; } catch { return line; }
    const id = message.id;
    if (message.method === undefined && (typeof id === 'string' || typeof id === 'number')) {
      const key = String(id);
      const waiter = internalWaiters.get(key);
      if (waiter) { internalWaiters.delete(key); waiter(message); return null; }
      if (swallowIds.has(key)) { swallowIds.delete(key); return null; }
      // Ответ на thread/start runtime: так мост узнаёт providerThreadId треда для карточек.
      const startThread = startRequests.get(JSON.stringify(id));
      if (startThread) {
        startRequests.delete(JSON.stringify(id));
        const providerThreadId = rec(message.result).providerThreadId;
        if (typeof providerThreadId === 'string' && !threadOuter.has(startThread)) threadOuter.set(startThread, providerThreadId);
      }
    }
    let changed = false;
    if (typeof message.method === 'string' && id !== undefined) {
      // Запрос штатного моста к runtime (вопрос пользователю, разрешение): ответ вернём ему же.
      const threadId = rec(message.params).threadId;
      const inner = typeof threadId === 'string' ? threadInner.get(threadId) : undefined;
      if (inner) pendingInnerRequests.set(JSON.stringify(id), inner);
    }
    if (message.method === 'thread/delta') {
      const params = rec(message.params);
      const threadId = typeof params.threadId === 'string' ? params.threadId : null;
      for (const delta of Array.isArray(params.deltas) ? params.deltas as unknown[] : []) {
        const d = rec(delta);
        if ((d.kind === 'turn.open' || d.kind === 'input.accepted') && typeof d.providerTurnId === 'string' && threadId) threadTurn.set(threadId, d.providerTurnId);
        changed = rewriteProviderId(d) || changed;
      }
    }
    if (nativeToOuter.size > 0) changed = rewriteNativeIds(message) || changed;
    return changed ? JSON.stringify(message) : line;
  }

  /** `provider.rateLimits.providerId` зашит в штатном мосте — переписываем на наш. */
  function rewriteProviderId(value: Json, depth = 0): boolean {
    if (depth > 6) return false;
    let changed = false;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'providerId' && (child === 'claude-code' || child === 'codex')) { value[key] = options.providerId; changed = true; continue; }
      if (child !== null && typeof child === 'object') {
        if (Array.isArray(child)) { for (const item of child) if (item && typeof item === 'object') changed = rewriteProviderId(item as Json, depth + 1) || changed; }
        else changed = rewriteProviderId(child as Json, depth + 1) || changed;
      }
    }
    return changed;
  }

  /** ID нативной сессии второго провайдера → providerThreadId, который знает BB. */
  function rewriteNativeIds(value: Json, depth = 0): boolean {
    if (depth > 6) return false;
    let changed = false;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'providerThreadId' && typeof child === 'string') {
        const outer = nativeToOuter.get(child);
        if (outer && outer !== child) { value[key] = outer; changed = true; }
        continue;
      }
      if (child !== null && typeof child === 'object') {
        if (Array.isArray(child)) { for (const item of child) if (item && typeof item === 'object') changed = rewriteNativeIds(item as Json, depth + 1) || changed; }
        else changed = rewriteNativeIds(child as Json, depth + 1) || changed;
      }
    }
    return changed;
  }

  function installTap(): void {
    if (options.write) return; // тест: перехват не нужен, мосты пишут через свой write
    const original = process.stdout.write.bind(process.stdout) as (...args: unknown[]) => boolean;
    rawWrite = line => { original(line); };
    process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      onInnerOutput(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      const callback = rest.find(arg => typeof arg === 'function') as (() => void) | undefined;
      callback?.();
      return true;
    }) as typeof process.stdout.write;
  }

  // ---- Сокет ленты и карточек для запускателя ----
  function startFeed(): void {
    if (!options.feed || process.platform === 'win32') return;
    const dir = options.socketDir ?? tmpdir();
    feedPath = join(dir, `cxf-${process.pid}.sock`);
    try { rmSync(feedPath, { force: true }); } catch { /* нет файла */ }
    feedServer = createServer(socket => {
      let buffer = '';
      const controller = new AbortController();
      socket.setEncoding('utf8');
      socket.on('data', chunk => {
        buffer += chunk;
        if (buffer.length > 1 << 20) { socket.destroy(); return; }
        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
          feedLine(buffer.slice(0, newline), socket, controller.signal);
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
        }
      });
      socket.on('end', () => { if (buffer.trim()) feedLine(buffer, socket, controller.signal); buffer = ''; });
      // Запускатель ушёл, не дождавшись ответа (ход прерван) — карточку снимаем.
      socket.on('close', () => controller.abort());
      socket.on('error', () => {});
    });
    feedServer.on('error', error => log(`feed server: ${error.message}`));
    feedServer.listen(feedPath);
  }

  function feedLine(line: string, socket: Socket, signal: AbortSignal): void {
    if (!line.trim()) return;
    let message: { threadId?: unknown; notes?: unknown; confirm?: unknown; whoami?: unknown };
    try { message = JSON.parse(line) as typeof message; } catch (error) { log(`feed: ${String(error)}`); return; }
    // Запускатель app-server Codex не знает свой тред (штатный мост Codex не передаёт
    // ему BB_THREAD_ID): мост отвечает тредом, для которого он только что открывает
    // сессию Codex. Нет такого — «maintenance» (служебный app-server без треда).
    if (message.whoami === 'codex') {
      const threadId = codexThread && Date.now() - codexThread.at < 10 * 60_000 ? codexThread.threadId : null;
      // Адрес сервера BB тоже: штатный мост Codex не передаёт app-server и BB_SERVER_URL.
      const serverUrl = serverEnv.BB_SERVER_URL ?? null;
      socket.end(`${JSON.stringify(threadId ? { threadId, serverUrl } : { maintenance: true, serverUrl })}\n`);
      return;
    }
    if (typeof message.threadId !== 'string') return;
    const threadId = message.threadId;
    if (message.confirm && typeof message.confirm === 'object') {
      void askConfirmation(threadId, message.confirm as ConfirmPrompt, signal)
        .catch(error => ({ action: 'unavailable', reason: error instanceof Error ? error.message : String(error) }) as BridgeAnswer)
        .then(answer => { if (!socket.destroyed) socket.end(`${JSON.stringify(answer)}\n`); });
      return;
    }
    if (Array.isArray(message.notes)) emitNotes(threadId, message.notes as RouteNote[]);
  }

  function emitNotes(threadId: string, notes: readonly RouteNote[]): void {
    if (!options.feed) return;
    let deltas: unknown[];
    try { deltas = options.feed.render(threadId, notes, threadTurn.get(threadId)); } catch (error) { log(`feed render: ${String(error)}`); return; }
    if (deltas.length > 0) send({ jsonrpc: '2.0', method: 'thread/delta', params: { threadId, deltas } });
  }

  // ---- Карточка подтверждения: interaction/request в runtime ----
  function requestInteraction(threadId: string, payload: unknown, signal: AbortSignal): Promise<unknown> {
    const providerThreadId = threadOuter.get(threadId);
    if (!providerThreadId) return Promise.reject(new Error('мост не знает сессию треда'));
    const id = `cascade-ask-${internalId += 1}`;
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new Error('карточка снята')); return; }
      pendingAsks.set(id, { resolve, reject });
      signal.addEventListener('abort', () => { if (pendingAsks.delete(id)) reject(new Error('карточка снята')); }, { once: true });
      send({ jsonrpc: '2.0', id, method: 'interaction/request', params: { providerThreadId, threadId, turnId: threadTurn.get(threadId) ?? null, payload } });
    });
  }

  async function askConfirmation(threadId: string, prompt: ConfirmPrompt, signal: AbortSignal): Promise<BridgeAnswer> {
    if (!options.feed?.confirm) return { action: 'unavailable', reason: 'лента каскада не подключена' };
    if (!threadOuter.has(threadId)) return { action: 'unavailable', reason: 'мост не знает сессию треда' };
    log(`confirm ${threadId} ${prompt.stepId}`);
    return options.feed.confirm(threadId, prompt, (payload, s) => requestInteraction(threadId, payload, s), threadTurn.get(threadId), signal);
  }

  // ---- Штатные мосты ----
  function writeLaunchers(ctx: BridgeContext): void {
    const dir = join(ctx.dataDir, 'launcher');
    mkdirSync(dir, { recursive: true });
    const artifact = fileURLToPath(options.ownArtifactUrl);
    for (const provider of Object.keys(NATIVE_BRIDGES) as NativeProviderId[]) {
      const self = join(dir, `${provider}.sh`);
      writeFileSync(self, launcherScript({
        nodePath: options.nodePath ?? process.execPath, artifact, provider, self, feed: feedPath,
        log: join(dir, 'launcher.log'), pluginId: ctx.pluginId,
      }));
      chmodSync(self, 0o755);
      process.env[NATIVE_BRIDGES[provider].executableEnv.command] = self;
      // Штатный мост Codex при заданной COMMAND без ARGS запускает её без аргументов —
      // codex стартует TUI («stdin is not a terminal»). Аргументы app-server — явно.
      const argsEnv = NATIVE_BRIDGES[provider].executableEnv.args;
      if (argsEnv && !process.env[argsEnv]) process.env[argsEnv] = JSON.stringify(['app-server']);
    }
  }

  async function ensureInner(provider: NativeProviderId, digest: string | null): Promise<Inner> {
    const current = inners.get(provider);
    if (current && (digest === null || current.loaded.digest === digest)) return current;
    const loaded = await loadNativeBridge(provider, digest, options.loadDeps);
    const inner: Inner = { loaded, started: false, initialized: false };
    if (context) { loaded.entry.start?.(context); inner.started = true; }
    if (initParams !== null) {
      const id = `cascade-init-${internalId += 1}`;
      swallowIds.add(id);
      loaded.entry.handleLine(JSON.stringify({ jsonrpc: '2.0', id, method: 'initialize', params: initParams }));
      inner.initialized = true;
    }
    inners.set(provider, inner);
    log(`loaded ${provider} ${loaded.digest.slice(0, 12)} from ${loaded.path}`);
    return inner;
  }

  /** Служебный запрос штатному мосту; ответ не уходит в runtime. */
  function innerRequest(inner: Inner, method: string, params: Json): Promise<Json> {
    const id = `cascade-int-${internalId += 1}`;
    return new Promise(resolve => {
      const timer = setTimeout(() => { if (internalWaiters.delete(id)) resolve({ error: { message: `${method}: штатный мост не ответил` } }); }, options.innerTimeoutMs ?? 120_000);
      timer.unref?.();
      internalWaiters.set(id, message => { clearTimeout(timer); resolve(message); });
      inner.loaded.entry.handleLine(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  function cascadeOptions(params: Json): { provider: NativeProviderId | null; digests: Record<string, string>; forceIncompatible: boolean } {
    const cascade = rec(rec(rec(params.options).providerOptions).cascade);
    const provider = cascade.provider === 'codex' || cascade.provider === 'claude-code' ? cascade.provider : null;
    const digests = Object.fromEntries(Object.entries(rec(cascade.digests)).filter((e): e is [string, string] => typeof e[1] === 'string'));
    return { provider, digests, forceIncompatible: cascade.testBridgeIncompatible === true };
  }

  /** Нативные сессии треда: память моста, иначе сервер (после перезапуска моста). */
  async function nativeOf(threadId: string): Promise<NativeSessions | null> {
    const known = threadNative.get(threadId);
    if (known) return known;
    if (nativeMissing.has(threadId)) return null;
    const loaded = await server.call<{ sessions: NativeSessions | null }>('nativeSessions', { threadId, sessions: null }).catch(error => {
      log(`nativeSessions ${threadId}: ${String(error)}`);
      return { sessions: null };
    });
    if (loaded.sessions) remember(threadId, loaded.sessions); else nativeMissing.add(threadId);
    return loaded.sessions;
  }

  function remember(threadId: string, state: NativeSessions): void {
    threadNative.set(threadId, state);
    threadOuter.set(threadId, state.outerId);
    for (const session of Object.values(state.sessions)) if (session.nativeId !== state.outerId) nativeToOuter.set(session.nativeId, state.outerId);
  }

  /** ID нативной сессии активного провайдера вместо ID, который знает BB. */
  function toNative(params: Json, state: NativeSessions | null): void {
    if (!state || params.providerThreadId !== state.outerId) return;
    const active = state.sessions[state.active];
    if (active) params.providerThreadId = active.nativeId;
  }

  interface Switched { provider: NativeProviderId; params: Json }

  /**
   * turn/start: провайдер хода по решению сервера. Тот же — без изменений;
   * другой — сессия этого провайдера (resume с дельтой или новая со сводкой),
   * ввод хода получает блок контекста первым элементом.
   */
  async function prepareTurnStart(threadId: string, params: Json, fallback: NativeProviderId, digests: Record<string, string>): Promise<Switched> {
    const outer = typeof params.providerThreadId === 'string' ? params.providerThreadId : threadOuter.get(threadId) ?? null;
    let state = await nativeOf(threadId);
    if (!state && outer) state = { outerId: outer, active: fallback, sessions: { [fallback]: { nativeId: outer, coveredSeq: 0 } } };
    const active: NativeProviderId = state?.active ?? fallback;
    const peek = await server.call<{ providerId: NativeProviderId | null; modelId: string | null }>('peekProvider', {
      threadId, requestedModel: typeof rec(params.options).model === 'string' ? rec(params.options).model : null,
    }).catch(error => { log(`peekProvider ${threadId}: ${String(error)}`); return null; });
    const target = peek?.providerId ?? active;
    const template = threadTemplate.get(threadId);
    if (target === active || !state || !template) {
      if (target !== active) log(`switch ${threadId} ${active}→${target} skipped: ${!state ? 'нет сессии треда' : 'нет параметров сессии'}`);
      const next = { ...params };
      toNative(next, state);
      if (active === 'codex') next.options = optionsFor(params.options, 'codex', peek?.providerId === 'codex' ? peek.modelId : null);
      return { provider: active, params: next };
    }

    const inner = await ensureInner(target, digests[target] ?? null);
    const from = PROVIDER_LABEL[active];
    const to = PROVIDER_LABEL[target];
    const requestId = typeof params.clientRequestId === 'string' ? params.clientRequestId : null;
    const currentText = (Array.isArray(params.input) ? params.input as unknown[] : []).map(i => rec(i)).filter(i => i.type === 'text').map(i => String(i.text ?? '')).join('\n') || null;
    const brief = async (afterSeq: number, mode: 'snapshot' | 'delta') => server.call<{ text: string; throughSeq: number }>('handoffBrief', {
      threadId, afterSeq, mode, from, to, currentRequestId: requestId, currentText: currentText?.slice(0, 20_000) ?? null,
    }).catch(error => {
      log(`handoffBrief ${threadId}: ${String(error)}`);
      // Сводку собрать не удалось: только как дочитать тред; курсор не двигаем.
      return { text: `<cascade-handoff from="${from}" to="${to}">\n${historyHint(threadId, [], afterSeq)}\n</cascade-handoff>`, throughSeq: afterSeq };
    });
    const sessionOptions = optionsFor(template.options ?? params.options, target, target === 'codex' ? peek?.modelId ?? null : null);
    const existing = state.sessions[target];
    let handoff = await brief(existing?.coveredSeq ?? 0, existing ? 'delta' : 'snapshot');
    let nativeId: string | null = null;
    const notes: RouteNote[] = [];
    if (existing) {
      // Возврат: прежняя сессия этого провайдера (--resume) + дельта после её курсора.
      if (target === 'codex') noteCodexStart(threadId);
      const resumed = await innerRequest(inner, 'thread/resume', { ...template, threadId, providerThreadId: existing.nativeId, options: sessionOptions });
      const result = rec(resumed.result);
      if (!resumed.error && result.sessionRestorable !== false) nativeId = typeof result.providerThreadId === 'string' ? result.providerThreadId : existing.nativeId;
      else {
        const reason = String(rec(resumed.error).message ?? 'сессия не восстанавливается');
        log(`resume ${target} ${existing.nativeId} failed: ${reason}`);
        notes.push({ kind: 'problem', message: `Прежняя сессия ${to} недоступна (${reason.slice(0, 120)}) — новая сессия со сводкой треда.` });
        handoff = await brief(0, 'snapshot');
      }
    }
    if (!nativeId) {
      if (target === 'codex') noteCodexStart(threadId);
      const started = await innerRequest(inner, 'thread/start', { ...template, threadId, options: sessionOptions });
      const id = rec(started.result).providerThreadId;
      if (started.error || typeof id !== 'string') throw new Error(`${to}: новая сессия не открылась — ${String(rec(started.error).message ?? 'нет providerThreadId')}`);
      nativeId = id;
    }

    const leaving = state.sessions[active];
    const next: NativeSessions = {
      outerId: state.outerId,
      active: target,
      sessions: {
        ...state.sessions,
        // Уходящая сессия видела тред до текущего запроса.
        ...(leaving ? { [active]: { nativeId: leaving.nativeId, coveredSeq: Math.max(leaving.coveredSeq, handoff.throughSeq) } } : {}),
        [target]: { nativeId, coveredSeq: handoff.throughSeq },
      },
    };
    remember(threadId, next);
    threadInner.set(threadId, inner);
    void server.call('nativeSessions', { threadId, sessions: next }).catch(error => log(`nativeSessions save ${threadId}: ${String(error)}`));
    if (notes.length) emitNotes(threadId, notes);
    log(`switch ${threadId} ${active}→${target} session=${nativeId} through=${handoff.throughSeq}${existing ? ' (resume)' : ''}`);

    const input = Array.isArray(params.input) ? params.input as unknown[] : [];
    return {
      provider: target,
      params: {
        ...params,
        providerThreadId: nativeId,
        options: optionsFor(params.options, target, target === 'codex' ? peek?.modelId ?? null : null),
        input: handoff.text ? [{ type: 'text', text: handoff.text }, ...input] : input,
      },
    };
  }

  async function routeThreadCommand(message: Json, line: string): Promise<void> {
    const params = rec(message.params);
    const method = String(message.method);
    const threadId = typeof params.threadId === 'string' ? params.threadId : null;
    const { provider: requested, digests, forceIncompatible } = cascadeOptions(params);
    if (threadId && (method === 'thread/start' || method === 'thread/resume')) {
      threadTemplate.set(threadId, sessionTemplate(params));
      if (method === 'thread/resume' && typeof params.providerThreadId === 'string' && !threadOuter.has(threadId)) threadOuter.set(threadId, params.providerThreadId);
      if (method === 'thread/start' && message.id !== undefined) startRequests.set(JSON.stringify(message.id), threadId);
    }
    if (threadId && typeof params.providerThreadId === 'string' && !threadOuter.has(threadId) && method !== 'thread/start') threadOuter.set(threadId, params.providerThreadId);

    // Приёмка S13: тестовый переключатель — отказ сразу, до вызовов сервера и переключения сессий.
    if (forceIncompatible) {
      const err = new NativeLoadError('shape', requested ?? 'claude-code', 'тестовый переключатель S13: мост помечен несовместимым');
      const hint = nativeLoadHint(err);
      log(`refuse ${method}: ${err.message}`);
      if (message.id !== undefined) fail(message.id, hint, { recovery: { kind: 'restartRecommended', message: hint, retryable: false } });
      return;
    }
    const known = threadId ? threadInner.get(threadId) : undefined;
    // Активный провайдер треда (переход Claude ↔ Codex) главнее подсказки сервера.
    const state = threadId && method !== 'thread/start' ? await nativeOf(threadId) : null;
    let provider: NativeProviderId = state?.active ?? requested ?? known?.loaded.spec.providerId ?? 'claude-code';
    let outgoing = line;
    try {
      if (threadId && method === 'turn/start') {
        const switched = await prepareTurnStart(threadId, params, provider, digests);
        provider = switched.provider;
        outgoing = JSON.stringify({ ...message, params: switched.params });
      } else if (state && typeof params.providerThreadId === 'string') {
        const next = { ...params };
        toNative(next, state);
        if (next.providerThreadId !== params.providerThreadId) outgoing = JSON.stringify({ ...message, params: next });
      }
    } catch (error) {
      const text = error instanceof NativeLoadError ? nativeLoadHint(error) : error instanceof Error ? error.message : String(error);
      log(`refuse ${method}: ${text}`);
      if (message.id !== undefined) fail(message.id, `Каскад подписок: ${text}`, error instanceof NativeLoadError ? { recovery: { kind: 'restartRecommended', message: text, retryable: true } } : undefined);
      return;
    }
    const digest = digests[provider] ?? null;
    let inner: Inner;
    try {
      // Приёмка S13: тестовый переключатель делает мост «несовместимым» — тот же путь, что у смены формы моста.
      if (forceIncompatible) throw new NativeLoadError('shape', provider, 'тестовый переключатель S13: мост помечен несовместимым');
      const current = threadId ? threadInner.get(threadId) : undefined;
      if (current && current.loaded.spec.providerId === provider && (digest === null || current.loaded.digest === digest)) inner = current;
      else inner = await ensureInner(provider, digest);
    } catch (error) {
      const err = error instanceof NativeLoadError ? error : new NativeLoadError('import-failed', provider, String(error));
      const hint = nativeLoadHint(err);
      log(`refuse ${method}: ${err.code} ${err.message}`);
      if (message.id !== undefined) fail(message.id, hint, { recovery: { kind: 'restartRecommended', message: hint, retryable: err.code === 'artifact-missing' || err.code === 'digest-mismatch' } });
      return;
    }
    if (threadId) threadInner.set(threadId, inner);
    // Команда треда мосту Codex может поднять app-server (старт, возврат, ход после
    // выхода процесса): запускатель спросит мост, чей это процесс.
    if (threadId && provider === 'codex') noteCodexStart(threadId);
    inner.loaded.entry.handleLine(outgoing);
  }

  // Очередь входящих: импорт асинхронный, порядок строк сохраняем. Ответы
  // runtime на карточки каскада идут мимо очереди: ход ждёт их внутри неё.
  let chain: Promise<void> = Promise.resolve();
  function handleLine(line: string): void {
    if (answerAsk(line)) return;
    chain = chain.then(() => handleOne(line)).catch(error => log(`handleLine: ${String(error)}`));
  }

  function answerAsk(line: string): boolean {
    if (pendingAsks.size === 0 || !line.includes('cascade-ask-')) return false;
    let message: Json;
    try { message = JSON.parse(line) as Json; } catch { return false; }
    if (message.method !== undefined || typeof message.id !== 'string') return false;
    const pending = pendingAsks.get(message.id);
    if (!pending) return false;
    pendingAsks.delete(message.id);
    if (message.error !== undefined) pending.reject(new Error(String(rec(message.error).message ?? 'runtime отклонил карточку')));
    else pending.resolve(message.result);
    return true;
  }

  async function handleOne(line: string): Promise<void> {
    let message: Json;
    try { message = JSON.parse(line) as Json; } catch { inners.get('claude-code')?.loaded.entry.handleLine(line); return; }
    learnServerUrl(rec(message.params));
    const method = typeof message.method === 'string' ? message.method : null;
    const id = message.id;
    if (method === null) {
      // Ответ runtime на запрос штатного моста.
      const key = JSON.stringify(id);
      const inner = pendingInnerRequests.get(key) ?? inners.get('claude-code') ?? [...inners.values()][0];
      pendingInnerRequests.delete(key);
      inner?.loaded.entry.handleLine(line);
      return;
    }
    if (method === 'initialize') {
      initParams = message.params ?? {};
      try {
        const inner = await ensureInner('claude-code', null);
        inner.initialized = true;
        inner.loaded.entry.handleLine(line);
      } catch (error) {
        loadError = error instanceof NativeLoadError ? error : new NativeLoadError('import-failed', 'claude-code', String(error));
        log(`initialize without native bridge: ${loadError.code} ${loadError.message}`);
        reply(id, fallbackInitialize());
      }
      return;
    }
    if (method === 'model/list') {
      reply(id, { models: catalogFrom(rec(message.params).providerOptions), selectedOnlyModels: [] });
      return;
    }
    if (method === 'initialized' && id === undefined) {
      for (const inner of inners.values()) inner.loaded.entry.handleLine(line);
      return;
    }
    const params = rec(message.params);
    if (typeof params.threadId === 'string' || method.startsWith('thread/') || method.startsWith('turn/')) {
      await routeThreadCommand(message, line);
      return;
    }
    // Прочие запросы (provider/health, commands/list, skills/configure …) — мосту Claude.
    const inner = inners.get('claude-code');
    if (inner) { inner.loaded.entry.handleLine(line); return; }
    if (id !== undefined) fail(id, loadError ? nativeLoadHint(loadError) : `Каскад подписок: штатный мост не загружен (${method})`);
  }

  return {
    experimental_apiVersion: 1,
    start(ctx) {
      context = ctx;
      installTap();
      startFeed();
      writeLaunchers(ctx);
      for (const inner of inners.values()) if (!inner.started) { inner.loaded.entry.start?.(ctx); inner.started = true; }
      log(`start plugin=${ctx.pluginId} feed=${feedPath ?? '-'}`);
    },
    handleLine,
    onClose() { for (const inner of inners.values()) inner.loaded.entry.onClose?.(); void closeFeed(); },
    onSigterm() { for (const inner of inners.values()) inner.loaded.entry.onSigterm?.(); void closeFeed(); },
    onSigint() { for (const inner of inners.values()) inner.loaded.entry.onSigint?.(); void closeFeed(); },
    async close() { await chain; await closeFeed(); },
    /** Вывод штатного моста (в процессе приходит через перехват stdout). */
    ingestInnerOutput: onInnerOutput,
  };

  function closeFeed(): Promise<void> {
    for (const [id, pending] of pendingAsks) { pendingAsks.delete(id); pending.reject(new Error('мост закрывается')); }
    const server = feedServer;
    feedServer = null;
    if (!server) return Promise.resolve();
    return new Promise(resolve => server.close(() => { if (feedPath) rmSync(feedPath, { force: true }); resolve(); }));
  }
}
