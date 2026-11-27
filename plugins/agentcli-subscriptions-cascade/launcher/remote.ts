// Запуск нативного CLI на другой машине через терминал BB.
//
// Надёжность:
// - терминал живёт на демоне машины ступени и не зависит от связи с нами;
//   его вывод хранится в прокрутке с номерами (seq), поэтому после обрыва
//   опрос продолжается с последнего seq без потерь;
// - сбой опроса повторяется с паузой до `reconnectMs` суммарно; дальше — авария
//   (ход завершается ошибкой, повтор автоматически не делаем: правило «Mac
//   пропал посреди хода — ждём или спрашиваем владельца»);
// - усечённая прокрутка (`truncated`) — авария, а не повод отдать испорченный поток;
// - кадры O нумеруются агентом: пропуск номера — авария;
// - агент сам останавливает CLI, если от нас нет сердцебиения `watchdogMs`.
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { agentArgv } from './agent-source.ts';
import { AGENT_PROTOCOL_VERSION, LineSplitter, beginFrame, chunkFrames, encodeClientFrame, parseAgentLine, type BeginHeader } from './protocol.ts';
import { newTerminalId, TerminalApiError, type TerminalApi } from './terminal-api.ts';

export interface RemoteRunOptions {
  api: TerminalApi;
  hostId: string;
  /** Папка на машине ступени (общий путь проекта). */
  cwd: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Файл сессии с машины треда для --resume (уже прочитанный) и куда вернуть итог. */
  session: { id: string; put: Buffer | null; get: boolean } | null;
  stdin: NodeJS.ReadableStream;
  stdout: { write(data: Buffer): unknown };
  stderr: { write(data: Buffer | string): unknown };
  /** Принять файл сессии после хода. */
  onSession?(data: Buffer): void | Promise<void>;
  signal?: AbortSignal;
  pollMs?: number;
  idlePollMs?: number;
  reconnectMs?: number;
  readyTimeoutMs?: number;
  watchdogMs?: number;
  sleep?(ms: number): Promise<void>;
  now?(): number;
  log?(line: string): void;
  terminalId?: string;
}

export interface RemoteRunResult { code: number; signal: string | null; terminalId: string }

export class RemoteRunError extends Error {
  readonly terminalId: string | null;
  readonly kind: 'start' | 'transport' | 'agent' | 'protocol';
  constructor(kind: RemoteRunError['kind'], message: string, terminalId: string | null) {
    super(message);
    this.kind = kind;
    this.terminalId = terminalId;
  }
}

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export async function runRemote(options: RemoteRunOptions): Promise<RemoteRunResult> {
  const { api } = options;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const pollMs = options.pollMs ?? 120;
  const idlePollMs = options.idlePollMs ?? 600;
  const reconnectMs = options.reconnectMs ?? 90_000;
  const readyTimeoutMs = options.readyTimeoutMs ?? 60_000;
  const terminalId = options.terminalId ?? newTerminalId();

  try {
    await api.create({ id: terminalId, hostId: options.hostId, cwd: options.cwd, argv: agentArgv(), title: `cascade · ${options.command}` });
  } catch (error) {
    throw new RemoteRunError('start', `не удалось открыть терминал на машине ступени: ${error instanceof Error ? error.message : String(error)}`, null);
  }
  log(`terminal ${terminalId} on ${options.hostId}`);

  // Очередь ввода: строго по порядку, с повтором при временном сбое.
  let sendChain: Promise<void> = Promise.resolve();
  let sendError: Error | null = null;
  const send = (frames: string[]) => {
    if (frames.length === 0) return sendChain;
    // Склеиваем кадры в пачки до ~48 КиБ: меньше запросов на большой ввод.
    const batches: string[] = [];
    let current = '';
    for (const frame of frames) {
      if (current.length + frame.length > 48_000 && current) { batches.push(current); current = ''; }
      current += frame;
    }
    if (current) batches.push(current);
    sendChain = sendChain.then(async () => {
      for (const batch of batches) await withRetry(() => api.input(terminalId, Buffer.from(batch, 'latin1')));
    }).catch(error => { sendError = error instanceof Error ? error : new Error(String(error)); });
    return sendChain;
  };

  async function withRetry<T>(op: () => Promise<T>): Promise<T> {
    const started = now();
    let delay = 250;
    for (;;) {
      try { return await op(); } catch (error) {
        const transient = !(error instanceof TerminalApiError) || error.transient;
        if (!transient || now() - started > reconnectMs) throw error;
        log(`retry after ${error instanceof Error ? error.message : String(error)}`);
        await sleep(delay);
        delay = Math.min(delay * 2, 5_000);
      }
    }
  }

  const splitter = new LineSplitter();
  let seq = 0;
  let expectedO = 0;
  let ready = false;
  let exit: RemoteRunResult | null = null;
  const sessionParts: Buffer[] = [];
  let sessionDone = false;
  const startedAt = now();
  let lastHeartbeatSent = 0;
  let stdinClosed = false;

  const onStdin = (chunk: Buffer | string) => {
    const data = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    if (ready) void send(chunkFrames('I', data));
    else pendingInput.push(data);
  };
  const onStdinEnd = () => { stdinClosed = true; if (ready) void send([encodeClientFrame('C')]); };
  const pendingInput: Buffer[] = [];
  options.stdin.on('data', onStdin);
  options.stdin.on('end', onStdinEnd);
  const onAbort = () => { void send([encodeClientFrame('K', 'SIGTERM')]); };
  options.signal?.addEventListener('abort', onAbort);

  async function handleFrameLine(line: string): Promise<void> {
    const frame = parseAgentLine(line);
    if (!frame) return;
    switch (frame.type) {
      case 'R': {
        if (frame.version !== AGENT_PROTOCOL_VERSION) throw new RemoteRunError('protocol', `версия агента ${frame.version}, ожидалась ${AGENT_PROTOCOL_VERSION}`, terminalId);
        ready = true;
        const session = options.session;
        const header: BeginHeader = {
          args: options.args, cwd: options.cwd, env: options.env, command: options.command,
          sessionId: session?.id ?? null,
          sessionPut: session?.put ? { bytes: session.put.length, sha256: createHash('sha256').update(session.put).digest('hex') } : null,
          sessionGet: session?.get ?? false,
          watchdogMs: options.watchdogMs ?? 120_000,
        };
        const frames = [beginFrame(header)];
        if (session?.put) frames.push(...chunkFrames('P', gzipSync(session.put)));
        frames.push(encodeClientFrame('G'));
        for (const data of pendingInput.splice(0)) frames.push(...chunkFrames('I', data));
        if (stdinClosed) frames.push(encodeClientFrame('C'));
        await send(frames);
        return;
      }
      case 'O':
        if (frame.seq !== expectedO) throw new RemoteRunError('protocol', `пропуск в потоке CLI: ожидался кадр ${expectedO}, пришёл ${frame.seq}`, terminalId);
        expectedO += 1;
        options.stdout.write(frame.data);
        return;
      case 'E': options.stderr.write(frame.data); return;
      case 'S': sessionParts.push(frame.data); return;
      case 'SE': {
        sessionDone = true;
        if (frame.sha256 && options.onSession) {
          const data = gunzipSync(Buffer.concat(sessionParts));
          if (createHash('sha256').update(data).digest('hex') !== frame.sha256) {
            options.stderr.write('cascade: файл сессии повреждён при возврате, локальная копия не обновлена\n');
          } else await options.onSession(data);
        }
        return;
      }
      case 'X': exit = { code: frame.code ?? (frame.signal ? 1 : 0), signal: frame.signal, terminalId }; return;
      case 'F': throw new RemoteRunError('agent', frame.message, terminalId);
      case 'H': return;
    }
  }

  let failureStarted: number | null = null;
  try {
    while (!exit) {
      if (sendError) throw new RemoteRunError('transport', `ввод не доставлен: ${(sendError as Error).message}`, terminalId);
      if (!ready && now() - startedAt > readyTimeoutMs) throw new RemoteRunError('start', 'агент на машине ступени не ответил (нет node или машина не отвечает)', terminalId);
      if (now() - lastHeartbeatSent > 5_000 && ready) { lastHeartbeatSent = now(); void send([encodeClientFrame('H')]); }
      let batch;
      try {
        batch = await api.output(terminalId, seq, AbortSignal.timeout(30_000));
        failureStarted = null;
      } catch (error) {
        const transient = !(error instanceof TerminalApiError) || error.transient;
        failureStarted ??= now();
        if (!transient || now() - failureStarted > reconnectMs) throw new RemoteRunError('transport', `поток с машины ступени прервался: ${error instanceof Error ? error.message : String(error)}`, terminalId);
        log(`poll retry: ${error instanceof Error ? error.message : String(error)}`);
        await sleep(Math.min(5_000, 250 * 2 ** Math.min(5, Math.floor((now() - failureStarted) / 1_000))));
        continue;
      }
      if (batch.truncated) throw new RemoteRunError('transport', 'прокрутка терминала усечена — часть вывода CLI потеряна', terminalId);
      for (const chunk of batch.chunks) {
        if (chunk.seq < seq) continue;
        for (const line of splitter.push(Buffer.from(chunk.dataBase64, 'base64'))) {
          await handleFrameLine(line);
          if (exit) break;
        }
        if (exit) break;
      }
      seq = Math.max(seq, batch.nextSeq);
      if (exit) break;
      if (batch.status === 'exited' && batch.chunks.length === 0) {
        throw new RemoteRunError('agent', `агент завершился без кода выхода CLI (код терминала ${batch.exitCode ?? '—'})`, terminalId);
      }
      await sleep(batch.chunks.length > 0 ? pollMs : idlePollMs);
    }
    // Кадры S/SE идут до X, поэтому файл сессии уже принят.
    if (options.session?.get && !sessionDone) options.stderr.write('cascade: файл сессии не вернулся с машины ступени\n');
    return exit as unknown as RemoteRunResult;
  } catch (error) {
    // Авария: просим агента остановить CLI, терминал закрываем.
    await send([encodeClientFrame('K', 'SIGTERM')]).catch(() => {});
    throw error instanceof RemoteRunError ? error : new RemoteRunError('protocol', error instanceof Error ? error.message : String(error), terminalId);
  } finally {
    options.stdin.off('data', onStdin);
    options.stdin.off('end', onStdinEnd);
    options.signal?.removeEventListener('abort', onAbort);
    await sendChain.catch(() => {});
    await api.close(terminalId).catch(() => {});
  }
}
