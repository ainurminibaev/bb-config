// Запускатель: его путь штатный мост получает вместо CLI
// (BB_CLAUDE_CODE_EXECUTABLE; для Codex — BB_CODEX_BRIDGE_APP_SERVER_COMMAND).
// На каждый запуск CLI:
//   1. спрашивает сервер каскада (routeTurn): на какой ступени и с какой моделью;
//   2. пишет события для ленты в сокет моста (строки переключения и синхронизации);
//   3. запускает нативный CLI — здесь же или на машине ступени через терминал BB;
//   4. переносит файл сессии для --resume туда и обратно (у каждой машины свой ~/.claude);
//   5. сообщает итог (finishTurn): события лимита, сбой канала, синхронизация после хода.
// Если сервер каскада не ответил — работает как штатный CLI этой машины, с
// моделью по умолчанию: тред не ломается (S12).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname } from 'node:path';
import { routeTurnOutputSchema, type LimitObservation, type NativeProvider, type RouteNote, type RouteTurnOutput } from '../bridge/route-contract.ts';
import { claudeSessionInfo, claudeSessionPath, flagValue, remoteArgs, remoteEnv, replaceModel } from './cli-args.ts';
import { spawn } from 'node:child_process';
import { resolveRealExecutable, runLocal } from './local.ts';
import { RemoteRunError, runRemote } from './remote.ts';
import { lineSink, runSessionRelay, type StageChild } from './session-relay.ts';
import { httpTerminalApi } from './terminal-api.ts';

export const LAUNCHER_ENV = {
  main: 'CASCADE_LAUNCHER_MAIN',
  provider: 'CASCADE_LAUNCHER_PROVIDER',
  self: 'CASCADE_LAUNCHER_SELF',
  feed: 'CASCADE_FEED_SOCKET',
  log: 'CASCADE_LAUNCHER_LOG',
  pluginId: 'CASCADE_PLUGIN_ID',
} as const;

export interface LauncherIo {
  env: NodeJS.ProcessEnv;
  argv: string[];
  cwd: string;
  fetch: typeof fetch;
  stdin: NodeJS.ReadableStream;
  stdout: { write(data: Buffer | string): unknown };
  stderr: { write(data: Buffer | string): unknown };
  now(): number;
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

/** Лимит из строки stream-json Claude (`rate_limit_event`). */
export function limitFromClaudeLine(line: string): LimitObservation | null {
  if (!line.includes('rate_limit')) return null;
  let message: Record<string, unknown>;
  try { message = JSON.parse(line) as Record<string, unknown>; } catch { return null; }
  if (message.type !== 'rate_limit_event') return null;
  const info = (message.rate_limit_info ?? {}) as Record<string, unknown>;
  const status = info.status === 'allowed' || info.status === 'allowed_warning' || info.status === 'rejected' ? info.status : 'unknown';
  const resetsAt = typeof info.resetsAt === 'number' && Number.isFinite(info.resetsAt) ? info.resetsAt * 1000 : null;
  return { status, resetsAt, windowType: typeof info.rateLimitType === 'string' ? info.rateLimitType : null, raw: info };
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
  if (!threadId || args.includes('--version') || args[0] === 'auth' || args[0] === 'login' || args[0] === 'logout') {
    return runFallback(io, provider, args, threadId ? 'служебный вызов' : 'нет BB_THREAD_ID');
  }
  if (provider === 'codex') {
    // Codex app-server — долгоживущий процесс на весь runtime: ступень
    // выбирается при его старте, смена машины требует перезапуска runtime.
    return runCodex(io, args, threadId);
  }

  const session = claudeSessionInfo(args);
  const probe = session.ephemeral;
  const requestedModel = flagValue(args, '--model');
  let route: RouteTurnOutput;
  try {
    route = routeTurnOutputSchema.parse(await callServer(io, 'routeTurn', {
      threadId, projectId: io.env.BB_PROJECT_ID ?? null, provider, requestedModel, probe, cwd: io.cwd,
    }, 60_000));
  } catch (error) {
    return runFallback(io, provider, args, `сервер каскада не ответил: ${error instanceof Error ? error.message : String(error)}`);
  }
  await sendFeed(io, threadId, route.notes);
  if (route.action === 'refuse') {
    logLine(io, `refuse: ${route.message}`);
    io.stderr.write(`Каскад подписок: ${route.message}\n`);
    return route.retryable ? 75 : 1;
  }

  // Сессия stream-json: один процесс CLI на всю сессию, ступень — на каждый ход.
  if (flagValue(args, '--input-format') === 'stream-json' && session.sessionId && !probe) {
    const sessionId = session.sessionId;
    const finishInfo = (r: RunRoute) => ({ threadId, projectId: io.env.BB_PROJECT_ID ?? null, stepId: r.stepId, hostId: r.hostId, probe: false });
    return runSessionRelay(route, args, sessionId, {
      start: (r, childArgs, onLine) => startStageChild(io, provider, r, childArgs, onLine),
      routeTurn: async () => routeTurnOutputSchema.parse(await callServer(io, 'routeTurn', {
        threadId, projectId: io.env.BB_PROJECT_ID ?? null, provider, requestedModel, probe: false, cwd: io.cwd,
      }, 60_000)),
      finishTurn: async (r, info) => {
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
    });
  }

  const startedAt = io.now();
  const limits: LimitObservation[] = [];
  const onLine = (line: string) => { const l = limitFromClaudeLine(line); if (l) limits.push(l); };
  const turnArgs = replaceModel(args, route.modelId);
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
    const put = session.resumes && localSession && existsSync(localSession) ? readFileSync(localSession) : null;
    const { args: filtered, dropped } = remoteArgs(turnArgs);
    if (dropped.length > 0) logLine(io, `remote: dropped local-only flags ${dropped.join(',')}`);
    const api = httpTerminalApi(io.env.BB_SERVER_URL ?? '', io.fetch);
    const stdoutSplit = { rest: '' };
    try {
      const result = await runRemote({
        api, hostId: route.hostId, cwd: remoteCwd, command: 'claude', args: filtered,
        env: { ...remoteEnv(io.env), ...route.env },
        session: session.sessionId ? { id: session.sessionId, put, get: !session.ephemeral } : null,
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

type RunRoute = Extract<RouteTurnOutput, { action: 'run' }>;

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
  const put = session.resumes && localSession && existsSync(localSession) ? readFileSync(localSession) : null;
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
async function runCodex(io: LauncherIo, args: string[], threadId: string): Promise<number> {
  let route: RouteTurnOutput;
  try {
    route = routeTurnOutputSchema.parse(await callServer(io, 'routeTurn', {
      threadId, projectId: io.env.BB_PROJECT_ID ?? null, provider: 'codex', requestedModel: null, probe: false, cwd: io.cwd,
    }, 60_000));
  } catch (error) {
    return runFallback(io, 'codex', args, `сервер каскада не ответил: ${error instanceof Error ? error.message : String(error)}`);
  }
  await sendFeed(io, threadId, route.notes);
  if (route.action === 'refuse') { io.stderr.write(`Каскад подписок: ${route.message}\n`); return route.retryable ? 75 : 1; }
  if (route.local) {
    const command = realCommand(io, 'codex');
    if (!command) return 127;
    return (await runLocal({ command, args, env: childEnv(io.env, route.env) })).code;
  }
  const api = httpTerminalApi(io.env.BB_SERVER_URL ?? '', io.fetch);
  try {
    const result = await runRemote({
      api, hostId: route.hostId, cwd: route.cwd ?? io.cwd, command: 'codex', args,
      env: { ...remoteEnv(io.env), ...route.env }, session: null,
      stdin: io.stdin, stdout: io.stdout as { write(data: Buffer): unknown }, stderr: io.stderr, log: line => logLine(io, line),
      // app-server живёт долго: сторожевой таймер шире.
      watchdogMs: 300_000,
    });
    return result.code;
  } catch (error) {
    io.stderr.write(`Каскад подписок: Codex на ${route.stage.machine} прерван — ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

/** Вход процесса запускателя (host.ts вызывает его при CASCADE_LAUNCHER_MAIN=1). */
export async function launcherMain(): Promise<never> {
  const code = await runLauncher({
    env: process.env, argv: process.argv.slice(2), cwd: process.cwd(), fetch,
    stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, now: Date.now,
  }).catch(error => {
    process.stderr.write(`Каскад подписок: сбой запускателя — ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    return 1;
  });
  process.exit(code);
}
