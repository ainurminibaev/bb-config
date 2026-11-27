// Мост провайдера «Каскад подписок» поверх импортированных штатных мостов.
//
// - initialize: грузим штатный мост Claude Code (свежую версию из кэша демона)
//   и отдаём его ответ; моста нет — отвечаем сами, ход потом откажет с подсказкой.
// - model/list: каталог профилей каскада (providerOptions.catalog), штатный не спрашиваем.
// - thread/* и turn/*: мост ступени треда (`providerOptions.cascade.provider`) ровно
//   той версии, что посчитал сервер (`providerOptions.cascade.digests`).
// - CLI подменяется запускателем: BB_CLAUDE_CODE_EXECUTABLE и
//   BB_CODEX_BRIDGE_APP_SERVER_COMMAND указывают на скрипты в dataDir.
// - Мост → runtime: перехват process.stdout.write. providerId в событиях лимита
//   переписывается на наш, provider-turn запоминается для строк ленты.
// - Запускатель шлёт события ленты в локальный сокет моста; мост превращает их
//   в thread/delta.
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LAUNCHER_ENV } from '../launcher/main.ts';
import type { RouteNote } from './route-contract.ts';
import { catalogFrom } from './static-catalog.ts';
import {
  loadNativeBridge, NativeLoadError, nativeLoadHint, NATIVE_BRIDGES,
  type BridgeContext, type BridgeEntry, type LoadDeps, type LoadedNativeBridge, type NativeProviderId,
} from './native.ts';

export const BRIDGE_PROTOCOL_VERSION = 2;

type Json = Record<string, unknown>;
const rec = (v: unknown): Json => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Json : {};

/** Перевод событий ленты в thread/delta (реализация — timeline/, здесь только порт). */
export interface FeedRenderer {
  render(threadId: string, notes: readonly RouteNote[], providerTurnId: string | undefined): unknown[];
}

export interface CascadeBridgeOptions {
  providerId: string;
  ownArtifactUrl: string;
  loadDeps: LoadDeps;
  feed?: FeedRenderer;
  /** node, которым запускать запускатель (тот же, что у моста). */
  nodePath?: string;
  /** Запись в stdout в обход перехвата (для тестов — своя). */
  write?(line: string): void;
  log?(line: string): void;
  socketDir?: string;
}

interface Inner { loaded: LoadedNativeBridge; started: boolean; initialized: boolean }

const shellQuote = (value: string) => `'${value.replace(/'/gu, `'\\''`)}'`;

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

export function createCascadeBridge(options: CascadeBridgeOptions): BridgeEntry & { close(): Promise<void>; ingestInnerOutput(text: string): void } {
  const log = options.log ?? (() => {});
  let rawWrite: (line: string) => void = options.write ?? (line => { process.stdout.write(line); });
  const inners = new Map<NativeProviderId, Inner>();
  const threadInner = new Map<string, Inner>();
  const threadTurn = new Map<string, string>();
  const pendingInnerRequests = new Map<string, Inner>();
  const swallowIds = new Set<string>();
  let initParams: unknown = null;
  let context: BridgeContext | null = null;
  let loadError: NativeLoadError | null = null;
  let feedServer: Server | null = null;
  let feedPath: string | null = null;
  let internalId = 0;

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
    if (message.method === undefined && (typeof id === 'string' || typeof id === 'number') && swallowIds.has(String(id))) {
      swallowIds.delete(String(id));
      return null;
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

  // ---- Сокет ленты для запускателя ----
  function startFeed(): void {
    if (!options.feed || process.platform === 'win32') return;
    const dir = options.socketDir ?? tmpdir();
    feedPath = join(dir, `cxf-${process.pid}.sock`);
    try { rmSync(feedPath, { force: true }); } catch { /* нет файла */ }
    feedServer = createServer(socket => {
      let buffer = '';
      socket.setEncoding('utf8');
      socket.on('data', chunk => {
        buffer += chunk;
        if (buffer.length > 1 << 20) { socket.destroy(); return; }
      });
      socket.on('end', () => {
        for (const line of buffer.split('\n')) {
          if (!line.trim()) continue;
          try {
            const message = JSON.parse(line) as { threadId?: unknown; notes?: unknown };
            if (typeof message.threadId !== 'string' || !Array.isArray(message.notes)) continue;
            emitNotes(message.threadId, message.notes as RouteNote[]);
          } catch (error) { log(`feed: ${String(error)}`); }
        }
      });
      socket.on('error', () => {});
    });
    feedServer.on('error', error => log(`feed server: ${error.message}`));
    feedServer.listen(feedPath);
  }

  function emitNotes(threadId: string, notes: readonly RouteNote[]): void {
    if (!options.feed) return;
    let deltas: unknown[];
    try { deltas = options.feed.render(threadId, notes, threadTurn.get(threadId)); } catch (error) { log(`feed render: ${String(error)}`); return; }
    if (deltas.length > 0) send({ jsonrpc: '2.0', method: 'thread/delta', params: { threadId, deltas } });
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

  function cascadeOptions(params: Json): { provider: NativeProviderId | null; digests: Record<string, string>; forceIncompatible: boolean } {
    const cascade = rec(rec(rec(params.options).providerOptions).cascade);
    const provider = cascade.provider === 'codex' || cascade.provider === 'claude-code' ? cascade.provider : null;
    const digests = Object.fromEntries(Object.entries(rec(cascade.digests)).filter((e): e is [string, string] => typeof e[1] === 'string'));
    return { provider, digests, forceIncompatible: cascade.testBridgeIncompatible === true };
  }

  async function routeThreadCommand(message: Json, line: string): Promise<void> {
    const params = rec(message.params);
    const threadId = typeof params.threadId === 'string' ? params.threadId : null;
    const { provider: requested, digests, forceIncompatible } = cascadeOptions(params);
    const known = threadId ? threadInner.get(threadId) : undefined;
    const provider: NativeProviderId = requested ?? known?.loaded.spec.providerId ?? 'claude-code';
    const digest = digests[provider] ?? null;
    let inner: Inner;
    try {
      // Приёмка S13: тестовый переключатель делает мост «несовместимым» — тот же путь, что у смены формы моста.
      if (forceIncompatible) throw new NativeLoadError('shape', provider, 'тестовый переключатель S13: мост помечен несовместимым');
      if (known && known.loaded.spec.providerId === provider && (digest === null || known.loaded.digest === digest)) inner = known;
      else inner = await ensureInner(provider, digest);
    } catch (error) {
      const err = error instanceof NativeLoadError ? error : new NativeLoadError('import-failed', provider, String(error));
      const hint = nativeLoadHint(err);
      log(`refuse ${String(message.method)}: ${err.code} ${err.message}`);
      if (message.id !== undefined) fail(message.id, hint, { recovery: { kind: 'restartRecommended', message: hint, retryable: err.code === 'artifact-missing' || err.code === 'digest-mismatch' } });
      return;
    }
    if (threadId) threadInner.set(threadId, inner);
    inner.loaded.entry.handleLine(line);
  }

  // Очередь входящих: импорт асинхронный, порядок строк сохраняем.
  let chain: Promise<void> = Promise.resolve();
  function handleLine(line: string): void {
    chain = chain.then(() => handleOne(line)).catch(error => log(`handleLine: ${String(error)}`));
  }

  async function handleOne(line: string): Promise<void> {
    let message: Json;
    try { message = JSON.parse(line) as Json; } catch { inners.get('claude-code')?.loaded.entry.handleLine(line); return; }
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
    const server = feedServer;
    feedServer = null;
    if (!server) return Promise.resolve();
    return new Promise(resolve => server.close(() => { if (feedPath) rmSync(feedPath, { force: true }); resolve(); }));
  }
}
