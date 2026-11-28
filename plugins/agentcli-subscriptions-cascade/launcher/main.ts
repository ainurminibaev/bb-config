// Запускатель: его путь штатный мост получает вместо CLI
// (BB_CLAUDE_CODE_EXECUTABLE; для Codex — BB_CODEX_BRIDGE_APP_SERVER_COMMAND).
// На каждый запуск CLI:
//   1. спрашивает сервер каскада (routeTurn): на какой ступени и с какой моделью;
//   2. пишет события для ленты в сокет моста (строки переключения и синхронизации);
//   3. запускает нативный CLI — здесь же или на машине ступени через терминал BB;
//   4. переносит файл сессии для --resume туда и обратно (у каждой машины свой ~/.claude);
//   5. сообщает итог (finishTurn): события лимита, сбой канала, синхронизация после хода.
// Если сервер каскада не ответил — ход НЕ запускается (код 75, понятный текст):
// штатный CLI этой машины мог бы молча уйти на исчерпанную ступень. Штатно
// (без каскада) запускаются только служебные вызовы CLI и запуск вне треда.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname } from 'node:path';
import {
  answerConfirmationOutputSchema, routeNoteSchema, routeTurnOutputSchema,
  type ConfirmPrompt, type LimitObservation, type NativeProvider, type RouteNote, type RouteTurnOutput, type RoutedTurn,
} from '../bridge/route-contract.ts';
import { parseBridgeAnswer, resolveRoute, type BridgeAnswer } from './confirm.ts';
import { SANDBOX_ARGS, startCodexRelay } from './codex-relay.ts';
import { claudeSessionInfo, claudeSessionPath, flagValue, probeArgs, remoteArgs, remoteEnv, replaceModel, resumeOrStart } from './cli-args.ts';
import { spawn } from 'node:child_process';
import { resolveRealExecutable, runLocal } from './local.ts';
import { RemoteRunError, runRemote } from './remote.ts';
import { lineSink, runSessionRelay, syntheticRefusal, type StageChild } from './session-relay.ts';
import { httpTerminalApi } from './terminal-api.ts';

export const LAUNCHER_ENV = {
  main: 'CASCADE_LAUNCHER_MAIN',
  provider: 'CASCADE_LAUNCHER_PROVIDER',
  self: 'CASCADE_LAUNCHER_SELF',
  feed: 'CASCADE_FEED_SOCKET',
  log: 'CASCADE_LAUNCHER_LOG',
  pluginId: 'CASCADE_PLUGIN_ID',
} as const;

/**
 * Сколько ждать решения сервера перед ходом. Решение включает синхронизацию
 * файлов: первая синхронизация проекта на машине ступени идёт минутами.
 */
export const ROUTE_TIMEOUT_MS = 20 * 60_000;

/** Текст отказа, когда сервер каскада не ответил: ход не запущен. */
export function serverDownMessage(error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  return `Ход не запущен: Каскад подписок → маршрут: сервер каскада не ответил (${reason.slice(0, 200)}) — ход не запущен, чтобы не уйти на ступень без проверки лимита. Повторите ход; если повторяется — проверьте, что плагин «Каскад подписок» включён (bb plugin list).`;
}

export interface LauncherIo {
  env: NodeJS.ProcessEnv;
  argv: string[];
  cwd: string;
  fetch: typeof fetch;
  stdin: NodeJS.ReadableStream;
  stdout: { write(data: Buffer | string): unknown };
  stderr: { write(data: Buffer | string): unknown };
  now(): number;
  /** Остановка запускателя (SIGTERM от штатного моста): CLI ступени останавливается и там. */
  signal?: AbortSignal;
}

function logLine(io: LauncherIo, message: string): void {
  const file = io.env[LAUNCHER_ENV.log];
  if (!file) return;
  try { writeFileSync(file, `${new Date(io.now()).toISOString()} pid=${process.pid} ${message}\n`, { flag: 'a' }); } catch { /* лог не обязателен */ }
}

async function callServer<T>(io: LauncherIo, method: string, input: unknown, timeoutMs: number): Promise<T> {
  const base = io.env.BB_SERVER_URL;
  if (!base) throw new Error('нет BB_SERVER_URL в окружении сессии');
  const pluginId = io.env[LAUNCHER_ENV.pluginId] || 'agentcli-subscriptions-cascade';
  const response = await io.fetch(`${base.replace(/\/+$/u, '')}/api/v1/plugins/${pluginId}/rpc/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await response.json().catch(() => null) as { ok?: boolean; result?: T; error?: { message?: string } } | null;
  if (!response.ok || !json?.ok) throw new Error(json?.error?.message ?? `HTTP ${response.status}`);
  return json.result as T;
}

/**
 * Решение сервера перед ходом с прогрессом подготовки: пока ждём routeTurn,
 * раз в `pollMs` спрашиваем turnProgress и шлём заметку `prep` в ленту —
 * строка перехода обновляется на месте (синхронизация идёт минутами).
 */
export async function routeWithProgress(io: LauncherIo, threadId: string, input: unknown, pollMs = 1_500): Promise<RouteTurnOutput> {
  const route = callServer<unknown>(io, 'routeTurn', input, ROUTE_TIMEOUT_MS).then(r => routeTurnOutputSchema.parse(r));
  let settled = false;
  void route.finally(() => { settled = true; }).catch(() => undefined);
  let last = '';
  const poll = async () => {
    while (!settled) {
      await Promise.race([new Promise(resolve => { const t = setTimeout(resolve, pollMs); (t as { unref?: () => void }).unref?.(); }), route.catch(() => undefined)]);
      if (settled) break;
      const progress = await callServer<{ note: unknown }>(io, 'turnProgress', { threadId }, 5_000).catch(() => null);
      const parsed = progress?.note ? routeNoteSchema.safeParse(progress.note) : null;
      if (!parsed?.success || settled) continue;
      const key = JSON.stringify(parsed.data);
      if (key === last) continue;
      last = key;
      await sendFeed(io, threadId, [parsed.data]);
    }
  };
  const poller = poll();
  try { return await route; } finally { settled = true; await poller.catch(() => undefined); }
}

/** Чей это app-server Codex: спросить мост каскада (сокет ленты), запасной путь — CASCADE_THREAD_ID. */
export type BridgeWho = ({ threadId: string } | { maintenance: true } | { error: string }) & { serverUrl?: string | null };

export function askBridgeThread(io: Pick<LauncherIo, 'env'>, timeoutMs = 5_000): Promise<BridgeWho> {
  const path = io.env[LAUNCHER_ENV.feed];
  const fallbackThread = io.env.CASCADE_THREAD_ID;
  const fallbackServer = io.env.CASCADE_SERVER_URL ?? null;
  const fallback = (error: string): BridgeWho => (fallbackThread ? { threadId: fallbackThread, serverUrl: fallbackServer } : { error, serverUrl: fallbackServer });
  if (!path) return Promise.resolve(fallback('нет сокета моста'));
  return new Promise(resolve => {
    let buffer = '';
    let settled = false;
    const finish = (value: BridgeWho) => { if (settled) return; settled = true; socket.destroy(); resolve(value); };
    const socket = connect(path);
    socket.setEncoding('utf8');
    socket.setTimeout(timeoutMs, () => finish(fallback('мост не ответил')));
    socket.on('error', error => finish(fallback(error.message)));
    socket.on('data', chunk => {
      buffer += chunk;
      const nl = buffer.indexOf('\n');
      if (nl === -1) return;
      try {
        const answer = JSON.parse(buffer.slice(0, nl)) as { threadId?: unknown; maintenance?: unknown; serverUrl?: unknown };
        const serverUrl = typeof answer.serverUrl === 'string' && answer.serverUrl ? answer.serverUrl : fallbackServer;
        if (typeof answer.threadId === 'string') finish({ threadId: answer.threadId, serverUrl });
        else if (answer.maintenance === true) finish({ maintenance: true, serverUrl });
        else finish({ error: 'непонятный ответ моста' });
      } catch { finish({ error: 'непонятный ответ моста' }); }
    });
    socket.on('connect', () => socket.write(`${JSON.stringify({ whoami: 'codex' })}\n`));
  });
}

/** События для ленты: в сокет моста; моста нет — молча пропускаем. */
function sendFeed(io: LauncherIo, threadId: string, notes: readonly RouteNote[]): Promise<void> {
  const path = io.env[LAUNCHER_ENV.feed];
  if (!path || notes.length === 0) return Promise.resolve();
  return new Promise(resolve => {
    const socket = connect(path);
    const done = () => { socket.destroy(); resolve(); };
    socket.setTimeout(2_000, done);
    socket.on('error', done);
    socket.on('connect', () => socket.end(`${JSON.stringify({ threadId, notes })}\n`, done));
  });
}

/**
 * Карточка подтверждения: запрос мосту через тот же сокет, ответ — строкой
 * обратно. Таймаута нет: ход ждёт владельца. Нет сокета или он закрылся без
 * ответа — unavailable (ход не идёт, тред цел).
 */
export function askBridge(io: Pick<LauncherIo, 'env'>, threadId: string, prompt: ConfirmPrompt, turnKey: string): Promise<BridgeAnswer> {
  const path = io.env[LAUNCHER_ENV.feed];
  if (!path) return Promise.resolve({ action: 'unavailable', reason: 'мост каскада не дал сокет для карточки' });
  return new Promise(resolve => {
    let settled = false;
    let buffer = '';
    const finish = (answer: BridgeAnswer) => { if (settled) return; settled = true; socket.destroy(); resolve(answer); };
    const socket = connect(path);
    socket.setEncoding('utf8');
    socket.on('error', error => finish({ action: 'unavailable', reason: `сокет моста: ${error.message}` }));
    socket.on('close', () => finish({ action: 'unavailable', reason: 'мост закрыл карточку без ответа' }));
    socket.on('data', chunk => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      let value: unknown = null;
      try { value = JSON.parse(buffer.slice(0, newline)); } catch { /* ниже — unavailable */ }
      finish(parseBridgeAnswer(value));
    });
    socket.on('connect', () => socket.write(`${JSON.stringify({ threadId, turnKey, confirm: prompt })}\n`));
  });
}

/** Решение хода с карточками подтверждения (launcher/confirm.ts). */
function routeWithConfirm(io: LauncherIo, threadId: string, input: { provider: NativeProvider; requestedModel: string | null; probe: boolean }): Promise<RoutedTurn> {
  const projectId = io.env.BB_PROJECT_ID ?? null;
  const turnKey = `turn-${randomUUID()}`;
  return resolveRoute({
    // Решение с прогрессом подготовки в ленте и таймаутом ROUTE_TIMEOUT_MS (синхронизация идёт минутами).
    routeTurn: key => routeWithProgress(io, threadId, {
      threadId, projectId, provider: input.provider, requestedModel: input.requestedModel, probe: input.probe, cwd: io.cwd, turnKey: key,
    }),
    ask: (prompt, key) => askBridge(io, threadId, prompt, key),
    answer: async a => answerConfirmationOutputSchema.parse(await callServer(io, 'answerConfirmation', { threadId, projectId, ...a }, 60_000)),
    feed: notes => sendFeed(io, threadId, notes),
    log: line => logLine(io, line),
  }, turnKey);
}

/** Лимит из строки stream-json Claude (`rate_limit_event`). */
/** Текст ошибки исчерпания в `result` Claude Code (без rate_limit_event). */
const LIMIT_TEXT = /hit your (?:weekly |session |5-hour |daily |opus |usage )*limit|usage limit reached|(?:weekly|session) limit (?:reached|exceeded)/iu;

export function limitFromClaudeLine(line: string): LimitObservation | null {
  if (line.includes('"result"') && LIMIT_TEXT.test(line)) {
    try {
      const message = JSON.parse(line) as Record<string, unknown>;
      if (message.type === 'result' && message.is_error === true) return { status: 'rejected', resetsAt: null, windowType: 'result-text', raw: { status: 'rejected' } };
    } catch { /* не JSON */ }
  }
  if (!line.includes('rate_limit')) return null;
  let message: Record<string, unknown>;
  try { message = JSON.parse(line) as Record<string, unknown>; } catch { return null; }
  if (message.type !== 'rate_limit_event') return null;
  const info = (message.rate_limit_info ?? {}) as Record<string, unknown>;
  const status = info.status === 'allowed' || info.status === 'allowed_warning' || info.status === 'rejected' ? info.status : 'unknown';
  const resetsAt = typeof info.resetsAt === 'number' && Number.isFinite(info.resetsAt) ? info.resetsAt * 1000 : null;
  return { status, resetsAt, windowType: typeof info.rateLimitType === 'string' ? info.rateLimitType : null, raw: info };
}

/**
 * Файл сессии Claude на машине моста: под папкой моста или папкой ступени
 * (локальная ступень с синхронизацией работает в общем пути). null — сессии нет.
 */
export function localSessionFile(io: Pick<LauncherIo, 'cwd' | 'env'>, sessionId: string, stageCwd: string | null): string | null {
  for (const cwd of [io.cwd, ...(stageCwd && stageCwd !== io.cwd ? [stageCwd] : [])]) {
    const path = claudeSessionPath(cwd, sessionId, io.env);
    if (existsSync(path)) return path;
  }
  return null;
}

/** Окружение для локального CLI: без служебных переменных запускателя. */
function childEnv(env: NodeJS.ProcessEnv, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) if (!key.startsWith('CASCADE_')) out[key] = value;
  return { ...out, ...extra };
}

function realCommand(io: LauncherIo, provider: NativeProvider): string | null {
  const name = provider === 'codex' ? 'codex' : 'claude';
  const self = io.env[LAUNCHER_ENV.self];
  return resolveRealExecutable(name, io.env, self ? [self] : []);
}

/** Сервер каскада не ответил: отказ с понятной строкой в ленте, без запуска CLI. */
async function refuseServerDown(io: LauncherIo, threadId: string, error: unknown): Promise<number> {
  const text = error instanceof Error ? error.message : String(error);
  if (/generation \S+ is retired|stale API handle|was reloaded or disabled/iu.test(text)) {
    // Плагин переустановлен: штатный автоповтор (как перегрузка) уже на новой версии.
    const message = 'Плагин «Каскад подписок» обновился — ход повторится автоматически на новой версии.';
    logLine(io, `refuse (overload, плагин обновился): ${text}`);
    await sendFeed(io, threadId, [{ kind: 'problem', message }]);
    for (const line of syntheticRefusal('overload', message, claudeSessionInfo(io.argv).sessionId, io.now())) io.stdout.write(`${line}\n`);
    return 0;
  }
  const message = serverDownMessage(error);
  logLine(io, `refuse: ${message}`);
  await sendFeed(io, threadId, [{ kind: 'problem', message: message.slice(0, 300), note: 'Что сделать: повторите ход · проверьте плагин: bb plugin list' }]);
  io.stderr.write(`${message}\n`);
  return 75;
}

/** Запуск без каскада: штатный CLI этой машины, профиль каскада из аргументов убран. */
async function runFallback(io: LauncherIo, provider: NativeProvider, args: string[], reason: string): Promise<number> {
  logLine(io, `fallback: ${reason}`);
  const command = realCommand(io, provider);
  if (!command) { io.stderr.write(`cascade: не найден ${provider === 'codex' ? 'codex' : 'claude'} на этой машине\n`); return 127; }
  const result = await runLocal({ command, args: provider === 'claude-code' ? replaceModel(args, null) : args, env: childEnv(io.env) });
  return result.code;
}

export async function runLauncher(io: LauncherIo): Promise<number> {
  const provider: NativeProvider = io.env[LAUNCHER_ENV.provider] === 'codex' ? 'codex' : 'claude-code';
  const args = io.argv;
  const threadId = io.env.BB_THREAD_ID ?? null;
  logLine(io, `start provider=${provider} thread=${threadId ?? '-'} cwd=${io.cwd} args=${JSON.stringify(args).slice(0, 600)}`);

  // Служебные вызовы CLI (версия, вход) и запуск вне треда — штатно.
  const service = args.includes('--version') || args[0] === 'auth' || args[0] === 'login' || args[0] === 'logout';
  if (provider === 'codex' && !service) {
    // App-server Codex: штатный мост поднимает его на тред, но без BB_THREAD_ID —
    // тред сообщает мост каскада. Без треда ход не идёт штатным путём (S3 на 0.2.4
    // ушёл в Codex на машине треда мимо маршрута).
    // Ни треда, ни адреса сервера у app-server нет: оба — от моста каскада.
    const who: BridgeWho = threadId && io.env.BB_SERVER_URL ? { threadId } : await askBridgeThread(io);
    const serverUrl = io.env.BB_SERVER_URL || who.serverUrl || null;
    const codexIo: LauncherIo = serverUrl && serverUrl !== io.env.BB_SERVER_URL ? { ...io, env: { ...io.env, BB_SERVER_URL: serverUrl } } : io;
    const thread = threadId ?? ('threadId' in who ? who.threadId : null);
    if (thread && !serverUrl) {
      const message = 'Ход не запущен: Каскад подписок → Codex: мост не сообщил адрес сервера BB — Codex не запущен мимо каскада. Повторите ход.';
      logLine(io, `refuse: ${message}`);
      io.stderr.write(`${message}\n`);
      return 75;
    }
    if (thread) return runCodex(codexIo, args, thread);
    if ('maintenance' in who) return runFallback(io, provider, args, 'служебный app-server без треда');
    const message = `Ход не запущен: Каскад подписок → Codex: запускатель не узнал тред (${'error' in who ? who.error : 'нет ответа моста'}) — Codex не запущен мимо каскада. Повторите ход.`;
    logLine(io, `refuse: ${message}`);
    io.stderr.write(`${message}\n`);
    return 75;
  }
  if (!threadId || service) {
    return runFallback(io, provider, args, threadId ? 'служебный вызов' : 'нет BB_THREAD_ID');
  }

  const session = claudeSessionInfo(args);
  const probe = session.ephemeral;
  const requestedModel = flagValue(args, '--model');
  const streamSession = flagValue(args, '--input-format') === 'stream-json' && session.sessionId !== null && !probe;
  if (streamSession && threadId) {
    // Сессия stream-json стартует на thread.start, до сообщения пользователя: ступень
    // (и карточку подтверждения) выбираем на первом сообщении, когда ход уже идёт.
    return runStreamSession(io, provider, args, threadId, session.sessionId!, requestedModel, null, true);
  }
  let route: RoutedTurn;
  try {
    route = await routeWithConfirm(io, threadId, { provider, requestedModel, probe });
  } catch (error) {
    return refuseServerDown(io, threadId, error);
  }
  await sendFeed(io, threadId, route.notes);
  if (route.action === 'refuse' && route.retryAs) {
    // Штатный автоповтор BB: отказ в форме вывода CLI (лимит или перегрузка).
    logLine(io, `refuse (${route.retryAs}, автоповтор): ${route.message}`);
    for (const line of syntheticRefusal(route.retryAs, route.message, claudeSessionInfo(args).sessionId, io.now())) io.stdout.write(`${line}\n`);
    return 0;
  } else if (route.action === 'refuse') {
    logLine(io, `refuse: ${route.message}`);
    io.stderr.write(`${route.message}\n`);
    return route.retryable ? 75 : 1;
  }

  // Сессия считается созданной, только если CLI её записал: ход, упавший до
  // запуска CLI, оставляет штатному мосту `--resume` на несуществующую сессию.
  // Файлы сессий возвращаются на машину моста после каждого хода на чужой машине.
  const sessionArgs = probe ? probeArgs(args, id => localSessionFile(io, id, null) !== null) : resumeOrStart(args, id => localSessionFile(io, id, route.action === 'run' ? route.cwd : null) !== null);
  if (sessionArgs.join('\0') !== args.join('\0')) logLine(io, `сессии ${session.sessionId} ещё нет — старт с --session-id вместо --resume`);


  const startedAt = io.now();
  const limits: LimitObservation[] = [];
  const onLine = (line: string) => { const l = limitFromClaudeLine(line); if (l) limits.push(l); };
  const turnArgs = replaceModel(sessionArgs, route.modelId);
  let exitCode: number | null = null;
  let transportError: string | null = null;

  if (route.local) {
    const command = realCommand(io, provider);
    if (!command) { io.stderr.write('cascade: не найден claude на этой машине\n'); return 127; }
    logLine(io, `local ${command} model=${route.modelId ?? '-'}`);
    const result = await runLocal({ command, args: turnArgs, env: childEnv(io.env, route.env), cwd: route.cwd ?? undefined, onStdoutLine: onLine, stdout: io.stdout as { write(data: Buffer): unknown } });
    exitCode = result.code;
  } else {
    const remoteCwd = route.cwd ?? io.cwd;
    const localSession = session.sessionId ? claudeSessionPath(io.cwd, session.sessionId, io.env) : null;
    const found = session.sessionId ? localSessionFile(io, session.sessionId, route.cwd) : null;
    const put = claudeSessionInfo(turnArgs).resumes && found ? readFileSync(found) : null;
    const { args: filtered, dropped } = remoteArgs(turnArgs);
    if (dropped.length > 0) logLine(io, `remote: dropped local-only flags ${dropped.join(',')}`);
    const api = httpTerminalApi(io.env.BB_SERVER_URL ?? '', io.fetch);
    const stdoutSplit = { rest: '' };
    try {
      const result = await runRemote({
        api, hostId: route.hostId, cwd: remoteCwd, command: 'claude', args: filtered,
        env: { ...remoteEnv(io.env), ...route.env },
        session: session.sessionId ? { id: session.sessionId, put, get: !session.ephemeral } : null,
        ...(io.signal ? { signal: io.signal } : {}),
        stdin: io.stdin,
        stdout: { write(data: Buffer) {
          io.stdout.write(data);
          stdoutSplit.rest += data.toString('utf8');
          const lines = stdoutSplit.rest.split('\n');
          stdoutSplit.rest = lines.pop() ?? '';
          for (const line of lines) onLine(line);
        } },
        stderr: io.stderr,
        onSession: data => {
          if (!localSession) return;
          mkdirSync(dirname(localSession), { recursive: true });
          const tmp = `${localSession}.cascade-${process.pid}`;
          writeFileSync(tmp, data, { mode: 0o600 });
          renameSync(tmp, localSession);
        },
        log: line => logLine(io, line),
      });
      exitCode = result.code;
      logLine(io, `remote exit ${result.code} via ${result.terminalId}`);
    } catch (error) {
      transportError = error instanceof Error ? error.message : String(error);
      logLine(io, `remote failed: ${transportError}`);
      io.stderr.write(`Каскад подписок: ход на ${route.stage.machine} прерван — ${transportError}\n`);
      exitCode = error instanceof RemoteRunError && error.kind === 'start' ? 75 : 1;
    }
  }

  try {
    const finish = await callServer<{ notes: RouteNote[] }>(io, 'finishTurn', {
      threadId, projectId: io.env.BB_PROJECT_ID ?? null, stepId: route.stepId, hostId: route.hostId, probe,
      exitCode, durationMs: io.now() - startedAt, limits: limits.slice(-20), transportError,
    }, 120_000);
    await sendFeed(io, threadId, finish.notes);
  } catch (error) {
    logLine(io, `finishTurn failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return exitCode ?? 1;
}

/**
 * Сессия stream-json Claude: один процесс CLI на сессию, ступень — на каждый ход.
 * Процесс стартует на thread.start (хода ещё нет): сначала — CLI машины моста только
 * для начала сессии (без сообщения лимит не тратится), ступень и карточка
 * подтверждения — на первом сообщении пользователя, как у следующих ходов.
 */
async function runStreamSession(io: LauncherIo, provider: NativeProvider, args: string[], threadId: string, sessionId: string, requestedModel: string | null,
  pendingRefusal: { kind: 'limit' | 'overload'; message: string } | null, routeFirst: boolean): Promise<number> {
  const idle: RunRoute = { action: 'run', stepId: '', hostId: '', providerId: provider, modelId: null, local: true, cwd: null, env: {}, stage: { machine: 'начало сессии' }, notes: [] };
  const sessionArgs = resumeOrStart(args, id => localSessionFile(io, id, null) !== null);
  if (sessionArgs.join('\0') !== args.join('\0')) logLine(io, `сессии ${sessionId} ещё нет — старт с --session-id вместо --resume`);
  const finishInfo = (r: RunRoute) => ({ threadId, projectId: io.env.BB_PROJECT_ID ?? null, stepId: r.stepId, hostId: r.hostId, probe: false });
  return runSessionRelay(idle, sessionArgs, sessionId, {
    start: (r, childArgs, onLine) => stopWith(io, startStageChild(io, provider, r, childArgs, onLine)),
    sessionExists: r => localSessionFile(io, sessionId, r.cwd) !== null,
    // Каждое новое сообщение пользователя — новый ход со своим turnKey.
    routeTurn: () => routeWithConfirm(io, threadId, { provider, requestedModel, probe: false }),
    // Лимит в ходе — отметка до ответа мосту: provider-retry сразу увидит свободную ступень.
    markLimits: async (r, limits) => { await callServer(io, 'turnLimits', { threadId, stepId: r.stepId, limits: limits.slice(-20) }, 10_000); },
    markModelUnavailable: async (r, reason) => { await callServer(io, 'turnModelUnavailable', { threadId, stepId: r.stepId, modelId: r.modelId, reason }, 10_000); },
    finishTurn: async (r, info) => {
      if (!r.stepId) return; // CLI начала сессии: хода не было
      const finish = await callServer<{ notes: RouteNote[] }>(io, 'finishTurn', { ...finishInfo(r), ...info, limits: info.limits.slice(-20) }, 120_000);
      await sendFeed(io, threadId, finish.notes);
    },
    feed: notes => sendFeed(io, threadId, notes),
    limitFromLine: limitFromClaudeLine,
    stdin: io.stdin,
    stdout: io.stdout,
    stderr: io.stderr,
    now: io.now,
    log: line => logLine(io, line),
  }, { pendingRefusal, routeFirst });
}

type RunRoute = Extract<RoutedTurn, { action: 'run' }>;

/** CLI ступени останавливается вместе с запускателем (S17): kill доходит до машины ступени. */
export function stopWith(io: Pick<LauncherIo, 'signal'>, child: StageChild): StageChild {
  const signal = io.signal;
  if (!signal) return child;
  const onAbort = () => child.kill();
  if (signal.aborted) child.kill();
  else signal.addEventListener('abort', onAbort, { once: true });
  void child.done.finally(() => signal.removeEventListener('abort', onAbort));
  return child;
}

/**
 * Процесс CLI ступени с построчным stdin/stdout: здесь же (pipe) или на машине
 * ступени через терминал BB. Для удалённой ступени файл сессии уезжает туда
 * при --resume и возвращается при выходе процесса.
 */
export function startStageChild(io: LauncherIo, provider: NativeProvider, route: RunRoute, args: string[], onLine: (line: string) => void): StageChild {
  const split = () => {
    let rest = '';
    return {
      push(data: Buffer | string) {
        rest += typeof data === 'string' ? data : data.toString('utf8');
        const lines = rest.split('\n');
        rest = lines.pop() ?? '';
        for (const line of lines) onLine(line);
      },
      flush() { if (rest) { onLine(rest); rest = ''; } },
    };
  };
  if (route.local) {
    const command = realCommand(io, provider);
    if (!command) {
      io.stderr.write(`cascade: не найден ${provider === 'codex' ? 'codex' : 'claude'} на этой машине\n`);
      return { write() {}, end() {}, kill() {}, done: Promise.resolve({ code: 127, transportError: null }) };
    }
    logLine(io, `local ${command} model=${route.modelId ?? '-'} args=${JSON.stringify(args).slice(0, 300)}`);
    const child = spawn(command, args, { env: childEnv(io.env, route.env), cwd: route.cwd ?? undefined, stdio: ['pipe', 'pipe', 'inherit'] });
    const out = split();
    child.stdout!.on('data', (d: Buffer) => out.push(d));
    child.stdin!.on('error', () => {});
    const done = new Promise<{ code: number; transportError: string | null }>(resolve => {
      child.on('error', error => resolve({ code: 127, transportError: error.message }));
      child.on('close', (code, signal) => { out.flush(); resolve({ code: code ?? (signal ? 1 : 0), transportError: null }); });
    });
    return {
      write: line => { if (!child.stdin!.writableEnded) child.stdin!.write(line.endsWith('\n') ? line : `${line}\n`); },
      end: () => { if (!child.stdin!.writableEnded) child.stdin!.end(); },
      kill: () => { child.kill('SIGTERM'); },
      done,
    };
  }
  const session = claudeSessionInfo(args);
  const localSession = provider === 'claude-code' && session.sessionId ? claudeSessionPath(io.cwd, session.sessionId, io.env) : null;
  const found = provider === 'claude-code' && session.sessionId ? localSessionFile(io, session.sessionId, route.cwd) : null;
  const put = session.resumes && found ? readFileSync(found) : null;
  const { args: filtered, dropped } = remoteArgs(args);
  if (dropped.length > 0) logLine(io, `remote: dropped local-only flags ${dropped.join(',')}`);
  const sink = lineSink();
  const out = split();
  const controller = new AbortController();
  logLine(io, `remote ${route.hostId} cwd=${route.cwd ?? io.cwd} put=${put ? put.length : 0}B`);
  const done = runRemote({
    api: httpTerminalApi(io.env.BB_SERVER_URL ?? '', io.fetch), hostId: route.hostId, cwd: route.cwd ?? io.cwd,
    command: provider === 'codex' ? 'codex' : 'claude', args: filtered, env: { ...remoteEnv(io.env), ...route.env },
    session: session.sessionId ? { id: session.sessionId, put, get: !session.ephemeral } : null,
    stdin: sink.stream, stdout: { write: (d: Buffer) => out.push(d) }, stderr: io.stderr,
    onSession: data => {
      if (!localSession) return;
      // То же правило на машине моста: более длинное продолжение не затираем.
      try {
        const current = readFileSync(localSession);
        if (current.length > data.length && current.subarray(0, data.length).equals(data)) return;
      } catch { /* файла нет */ }
      mkdirSync(dirname(localSession), { recursive: true });
      const tmp = `${localSession}.cascade-${process.pid}`;
      writeFileSync(tmp, data, { mode: 0o600 });
      renameSync(tmp, localSession);
      logLine(io, `session back ${data.length}B → ${localSession}`);
    },
    signal: controller.signal,
    log: line => logLine(io, line),
  }).then(result => { out.flush(); logLine(io, `remote exit ${result.code} via ${result.terminalId}`); return { code: result.code, transportError: null }; }, error => {
    out.flush();
    const message = error instanceof Error ? error.message : String(error);
    logLine(io, `remote failed: ${message}`);
    io.stderr.write(`Каскад подписок: ход на ${route.stage.machine} прерван — ${message}\n`);
    return { code: error instanceof RemoteRunError && error.kind === 'start' ? 75 : 1, transportError: message };
  });
  return { write: sink.write, end: sink.end, kill: () => controller.abort(), done };
}

/** Codex: app-server на всё время runtime. Ступень — на старте процесса. */
/** Аргументы codex для режима моста: без подкоманды codex стартует TUI и требует терминал. */
export function codexAppServerArgs(args: readonly string[]): string[] {
  return args.includes('app-server') ? [...args] : ['app-server', ...args];
}

async function runCodex(io: LauncherIo, rawArgs: string[], threadId: string): Promise<number> {
  // Песочница ступени — и в конфиге app-server (сеть выключена, только workspace-write).
  const args = [...codexAppServerArgs(rawArgs), ...SANDBOX_ARGS];
  // Старт app-server — это открытие сессии, а не ход: карточку BB здесь не покажет.
  // Согласие на Codex даётся раньше, в ходе (мост открывает сессию Codex только после «Да»).
  let decided: RouteTurnOutput;
  try {
    decided = await routeWithProgress(io, threadId, {
      threadId, projectId: io.env.BB_PROJECT_ID ?? null, provider: 'codex', requestedModel: null, probe: false, cwd: io.cwd, turnKey: `session-${randomUUID()}`,
    });
  } catch (error) {
    return refuseServerDown(io, threadId, error);
  }
  const route: RoutedTurn = decided.action === 'confirm'
    ? { action: 'refuse', retryable: true, message: `Ход не запущен: Каскад подписок → подтверждение: ступень ${decided.prompt.to.machine} · Codex ещё не подтверждена — ответьте в карточке хода.`, notes: [] }
    : decided;
  await sendFeed(io, threadId, route.notes);
  if (route.action === 'refuse') { io.stderr.write(`${route.message}\n`); return route.retryable ? 75 : 1; }
  // Реле JSON-RPC: пути машины треда → путь ступени, синхронизация на каждый ход.
  const stageCwd = route.cwd;
  const runRoute = route;
  const out = splitLines(line => relay.onChildLine(line));
  const sink = lineSink();
  const relay = startCodexRelay({
    stdin: io.stdin,
    toChild: line => sink.write(line),
    endChild: () => sink.end(),
    toBridge: line => { io.stdout.write(`${line}\n`); },
    bridgeCwd: io.cwd,
    stageCwd: stageCwd && stageCwd !== io.cwd ? stageCwd : null,
    sandboxRoot: stageCwd ?? io.cwd,
    prepare: async () => {
      const r = await callServer<{ ok: boolean; message: string; notes: RouteNote[] }>(io, 'syncTurn', { threadId, stepId: runRoute.stepId, hostId: runRoute.hostId, phase: 'prepare' }, ROUTE_TIMEOUT_MS);
      await sendFeed(io, threadId, r.notes);
      return r;
    },
    finish: async () => {
      const r = await callServer<{ notes: RouteNote[] }>(io, 'syncTurn', { threadId, stepId: runRoute.stepId, hostId: runRoute.hostId, phase: 'finish' }, 120_000);
      await sendFeed(io, threadId, r.notes);
    },
    log: line => logLine(io, line),
  });
  logLine(io, `codex ${route.local ? 'local' : `remote ${route.hostId}`} cwd=${stageCwd ?? io.cwd}`);
  if (route.local) {
    const command = realCommand(io, 'codex');
    if (!command) return 127;
    const child = spawn(command, args, { env: childEnv(io.env, route.env), cwd: stageCwd ?? undefined, stdio: ['pipe', 'pipe', 'inherit'] });
    sink.stream.pipe(child.stdin!);
    child.stdin!.on('error', () => {});
    child.stdout!.on('data', (d: Buffer) => out.push(d));
    if (io.signal) io.signal.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });
    const code = await new Promise<number>(resolve => {
      child.on('error', () => resolve(127));
      child.on('close', (c, sig) => { out.flush(); resolve(c ?? (sig ? 1 : 0)); });
    });
    return code;
  }
  const api = httpTerminalApi(io.env.BB_SERVER_URL ?? '', io.fetch);
  try {
    const result = await runRemote({
      api, hostId: route.hostId, cwd: stageCwd ?? io.cwd, command: 'codex', args,
      env: { ...remoteEnv(io.env), ...route.env }, session: null,
      ...(io.signal ? { signal: io.signal } : {}),
      stdin: sink.stream, stdout: { write: (d: Buffer) => out.push(d) }, stderr: io.stderr, log: line => logLine(io, line),
      // app-server живёт долго: сторожевой таймер шире.
      watchdogMs: 300_000,
    });
    out.flush();
    return result.code;
  } catch (error) {
    out.flush();
    io.stderr.write(`Каскад подписок: Codex на ${route.stage.machine} прерван — ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

/** Построчный разбор потока (кадры приходят кусками). */
function splitLines(onLine: (line: string) => void): { push(d: Buffer | string): void; flush(): void } {
  let rest = '';
  return {
    push(d) { rest += typeof d === 'string' ? d : d.toString('utf8'); const lines = rest.split('\n'); rest = lines.pop() ?? ''; for (const l of lines) onLine(l); },
    flush() { if (rest) { onLine(rest); rest = ''; } },
  };
}

/** Вход процесса запускателя (host.ts вызывает его при CASCADE_LAUNCHER_MAIN=1). */
export async function launcherMain(): Promise<never> {
  // Штатный мост останавливает ход сигналом процессу CLI (у нас — запускателю):
  // сигнал гасит CLI ступени (локально или на чужой машине через терминал BB).
  const stop = new AbortController();
  for (const name of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.on(name, () => {
      if (stop.signal.aborted) return;
      stop.abort();
      setTimeout(() => process.exit(143), 15_000).unref();
    });
  }
  const code = await runLauncher({
    env: process.env, argv: process.argv.slice(2), cwd: process.cwd(), fetch,
    stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, now: Date.now, signal: stop.signal,
  }).catch(error => {
    process.stderr.write(`Каскад подписок: сбой запускателя — ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    return 1;
  });
  process.exit(code);
}
