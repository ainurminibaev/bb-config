// Сессия Claude в режиме stream-json: штатный мост держит ОДИН процесс CLI на
// всю сессию и шлёт ходы сообщениями `{"type":"user"}` в stdin (проверено
// живым прогоном). Поэтому ступень выбирается здесь, между ходами:
//   - сообщение пользователя при простое CLI → routeTurn;
//   - ступень та же → сообщение уходит текущему процессу;
//   - ступень другая → текущий процесс закрывается (файл сессии возвращается),
//     новый стартует на новой ступени с `--resume <id>`; служебные запросы
//     начала сессии (control_request initialize …) повторяются ему, а ответы
//     на них не доходят до моста — мост их уже получил;
//   - каждый `result` (конец хода) → finishTurn: события лимита, синхронизация.
// Во время хода (после user до result) ступень не меняется никогда.
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import type { LimitObservation, RouteNote, RouteTurnOutput } from '../bridge/route-contract.ts';
import { replaceModel, resumeOrStart } from './cli-args.ts';

export interface StageChild {
  write(line: string): void;
  end(): void;
  kill(): void;
  /** Завершение процесса CLI (вместе с возвратом файла сессии для удалённой ступени). */
  done: Promise<{ code: number; transportError: string | null }>;
}

export interface RelayPorts {
  /** Запустить CLI ступени: строки stdout — в onLine. */
  start(route: Extract<RouteTurnOutput, { action: 'run' }>, args: string[], onLine: (line: string) => void): StageChild;
  routeTurn(): Promise<RouteTurnOutput>;
  /** Записал ли CLI файл сессии (для `--resume` на новой ступени). Нет порта — считается записанным. */
  sessionExists?(route: Extract<RouteTurnOutput, { action: 'run' }>): boolean;
  finishTurn(route: Extract<RouteTurnOutput, { action: 'run' }>, info: { exitCode: number | null; limits: LimitObservation[]; transportError: string | null; durationMs: number }): Promise<void>;
  feed(notes: readonly RouteNote[]): Promise<void>;
  limitFromLine(line: string): LimitObservation | null;
  stdin: NodeJS.ReadableStream;
  stdout: { write(data: string): unknown };
  stderr: { write(data: string): unknown };
  now(): number;
  log(line: string): void;
}

type RunRoute = Extract<RouteTurnOutput, { action: 'run' }>;

/** Аргументы для продолжения той же сессии новым процессом: --session-id → --resume. */
export function resumeArgs(args: readonly string[], sessionId: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '--session-id' || arg === '--resume') { i += 1; continue; }
    if (arg.startsWith('--session-id=') || arg.startsWith('--resume=')) continue;
    out.push(arg);
  }
  return [...out, `--resume=${sessionId}`];
}

const sameStage = (a: RunRoute, b: RunRoute) => a.stepId === b.stepId && a.hostId === b.hostId && a.modelId === b.modelId;

function parse(line: string): Record<string, unknown> | null {
  if (!line.startsWith('{')) return null;
  try { return JSON.parse(line) as Record<string, unknown>; } catch { return null; }
}

function requestIdOf(message: Record<string, unknown>): string | null {
  if (typeof message.request_id === 'string') return message.request_id;
  const response = message.response as Record<string, unknown> | undefined;
  return typeof response?.request_id === 'string' ? response.request_id : null;
}

export async function runSessionRelay(first: RunRoute, baseArgs: string[], sessionId: string, ports: RelayPorts): Promise<number> {
  let route = first;
  const preamble: string[] = [];
  const swallow = new Set<string>();
  let sawUser = false;
  let turnActive = false;
  let turnStartedAt = ports.now();
  let limits: LimitObservation[] = [];
  let finishing: Promise<void> = Promise.resolve();
  let switching: Promise<void> = Promise.resolve();

  const onLine = (line: string) => {
    const message = parse(line);
    if (message?.type === 'control_response') {
      const id = requestIdOf(message);
      if (id && swallow.has(id)) { swallow.delete(id); return; }
    }
    ports.stdout.write(`${line}\n`);
    const limit = ports.limitFromLine(line);
    if (limit) limits.push(limit);
    if (message?.type === 'result' && turnActive) {
      turnActive = false;
      const done = { exitCode: 0, limits, transportError: null, durationMs: ports.now() - turnStartedAt };
      limits = [];
      const current = route;
      finishing = finishing.then(() => ports.finishTurn(current, done)).catch(error => ports.log(`finishTurn: ${String(error)}`));
    }
  };

  // Новый процесс на другой ступени продолжает сессию через --resume, только если
  // прежний процесс её записал; иначе — тот же ID как новая сессия.
  const argsFor = (r: RunRoute, resume: boolean) => {
    const withResume = resume ? resumeArgs(baseArgs, sessionId) : baseArgs;
    const fixed = resume && ports.sessionExists ? resumeOrStart(withResume, () => ports.sessionExists!(r)) : withResume;
    return replaceModel(fixed, r.modelId);
  };
  let child = ports.start(route, argsFor(route, false), onLine);
  let childExit: { code: number; transportError: string | null } | null = null;
  const watchChild = (c: StageChild) => { void c.done.then(result => { if (c === child) childExit = result; }); };
  watchChild(child);

  async function switchTo(next: RunRoute): Promise<boolean> {
    ports.log(`switch ${route.hostId}/${route.stepId} → ${next.hostId}/${next.stepId}`);
    const old = child;
    old.end();
    const timer = setTimeout(() => old.kill(), 15_000);
    const result = await old.done;
    clearTimeout(timer);
    if (result.transportError) ports.log(`old stage closed with: ${result.transportError}`);
    await finishing;
    route = next;
    childExit = null;
    child = ports.start(route, argsFor(route, true), onLine);
    watchChild(child);
    // Начало сессии для нового процесса: те же служебные запросы, ответы — не мосту.
    for (const line of preamble) {
      const id = requestIdOf(parse(line) ?? {});
      if (id) swallow.add(id);
      child.write(line);
    }
    return true;
  }

  const input = createInterface({ input: ports.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    const message = parse(line);
    const isUser = message?.type === 'user';
    if (!sawUser && !isUser) { preamble.push(line); child.write(line); continue; }
    if (isUser && !turnActive) {
      if (sawUser) {
        // Новый ход: решение каскада. Пока решаем — следующие строки ждут.
        await switching;
        let next: RouteTurnOutput;
        try { next = await ports.routeTurn(); } catch (error) {
          ports.log(`routeTurn failed, staying: ${String(error)}`);
          next = route;
        }
        await ports.feed(next.notes);
        if (next.action === 'refuse') {
          ports.stderr.write(`Каскад подписок: ${next.message}\n`);
          child.end();
          await child.done;
          return next.retryable ? 75 : 1;
        }
        if (!sameStage(route, next)) {
          switching = switchTo(next).then(() => undefined);
          await switching;
        } else route = next;
      }
      sawUser = true;
      turnActive = true;
      turnStartedAt = ports.now();
    }
    if (childExit) {
      // CLI ступени завершился сам (сбой, обрыв канала): мост увидит выход процесса.
      break;
    }
    child.write(line);
  }
  child.end();
  const result = childExit ?? await child.done;
  await finishing;
  if (turnActive || result.transportError) {
    await ports.finishTurn(route, { exitCode: result.code, limits, transportError: result.transportError, durationMs: ports.now() - turnStartedAt }).catch(() => {});
  }
  return result.code;
}

/** Поток stdin для дочернего процесса из построчной записи. */
export function lineSink(): { stream: PassThrough; write(line: string): void; end(): void } {
  const stream = new PassThrough();
  return {
    stream,
    write: line => { if (!stream.writableEnded) stream.write(line.endsWith('\n') ? line : `${line}\n`); },
    end: () => { if (!stream.writableEnded) stream.end(); },
  };
}
