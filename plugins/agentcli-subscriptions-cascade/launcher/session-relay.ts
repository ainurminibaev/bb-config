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
import type { LimitObservation, RouteNote, RoutedTurn } from '../bridge/route-contract.ts';
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
  start(route: Extract<RoutedTurn, { action: 'run' }>, args: string[], onLine: (line: string) => void): StageChild;
  routeTurn(): Promise<RoutedTurn>;
  /** Записал ли CLI файл сессии (для `--resume` на новой ступени). Нет порта — считается записанным. */
  sessionExists?(route: Extract<RoutedTurn, { action: 'run' }>): boolean;
  /** Лимит исчерпан в ходе: отметить ступень до того, как мост увидит конец хода. */
  markLimits?(route: Extract<RoutedTurn, { action: 'run' }>, limits: LimitObservation[]): Promise<void>;
  /** Модель недоступна на аккаунте ступени: снять попытку до того, как мост увидит конец хода. */
  markModelUnavailable?(route: Extract<RoutedTurn, { action: 'run' }>, reason: string): Promise<void>;
  finishTurn(route: Extract<RoutedTurn, { action: 'run' }>, info: { exitCode: number | null; limits: LimitObservation[]; transportError: string | null; durationMs: number }): Promise<void>;
  feed(notes: readonly RouteNote[]): Promise<void>;
  limitFromLine(line: string): LimitObservation | null;
  stdin: NodeJS.ReadableStream;
  stdout: { write(data: string): unknown };
  stderr: { write(data: string): unknown };
  now(): number;
  log(line: string): void;
}

type RunRoute = Extract<RoutedTurn, { action: 'run' }>;

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

/**
 * Отказ каскада в форме штатного вывода Claude Code, чтобы сработал штатный
 * автоповтор BB (provider-retry): `limit` — событие лимита и result с 429
 * (provider-retry спросит доступность каскада и повторит ход на другой
 * ступени/провайдере); `overload` — result с 529 (повтор через секунды).
 */
export function syntheticRefusal(kind: 'limit' | 'overload', message: string, sessionId: string | null, now: number): string[] {
  const base = { type: 'result', subtype: 'error_during_execution', is_error: true, result: message, errors: [message], duration_ms: 0, num_turns: 0, ...(sessionId ? { session_id: sessionId } : {}) };
  if (kind === 'overload') return [JSON.stringify({ ...base, api_error_status: 529 })];
  return [
    JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: Math.round(now / 1000) + 60, rateLimitType: 'five_hour' }, ...(sessionId ? { session_id: sessionId } : {}) }),
    JSON.stringify({ ...base, api_error_status: 429 }),
  ];
}

/** Ошибка «модель недоступна на этом аккаунте или тарифе» в result Claude Code. */
export const MODEL_UNAVAILABLE = /requires (?:usage )?credits|not available (?:on|for) (?:your|this) (?:plan|account|subscription)|(?:do(?:es)? not|don't) have access to (?:the )?(?:model|claude|fable|opus|sonnet)|model[^.]{0,40}(?:not found|not supported|is not available|unavailable)|model_not_found|invalid model/iu;

export async function runSessionRelay(first: RunRoute, baseArgs: string[], sessionId: string, ports: RelayPorts, options: {
  pendingRefusal?: { kind: 'limit' | 'overload'; message: string } | null;
  /**
   * Ступень первого хода выбирается на первом сообщении, а не при старте процесса
   * (старт — это thread.start: хода ещё нет, карточку подтверждения BB не покажет).
   * `first` тогда — процесс машины моста только для начала сессии.
   */
  routeFirst?: boolean;
  /** Сторож хода: нет событий от CLI столько — ход завершается ошибкой с автоповтором. По умолчанию 10 мин. */
  idleTimeoutMs?: number;
} = {}): Promise<number> {
  let route = first;
  let routeFirst = options.routeFirst ?? false;
  let pendingRefusal = options.pendingRefusal ?? null;
  const preamble: string[] = [];
  const swallow = new Set<string>();
  let sawUser = false;
  let turnActive = false;
  let turnStartedAt = ports.now();
  let limits: LimitObservation[] = [];
  let finishing: Promise<void> = Promise.resolve();
  let switching: Promise<void> = Promise.resolve();
  const idleMs = options.idleTimeoutMs ?? 10 * 60_000;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const clearIdle = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } };
  const armIdle = () => {
    clearIdle();
    if (!turnActive) return;
    idleTimer = setTimeout(() => {
      ports.log(`watchdog: нет событий от CLI ${Math.round(idleMs / 1000)} с — ход прерван`);
      abortTurn(`нет событий от CLI ступени ${route.stage.machine} ${Math.round(idleMs / 60_000) || 1} мин`);
      child.kill();
    }, idleMs);
    (idleTimer as { unref?: () => void }).unref?.();
  };

  /**
   * Ход не может закончиться сам (CLI ступени умер, канал оборвался, сторож): мост
   * получает ошибку хода в штатной форме (перегрузка → автоповтор provider-retry),
   * сервер — итог с причиной. Следующий ход поднимет CLI заново (`--resume`).
   */
  function abortTurn(reason: string): void {
    if (!turnActive) return;
    turnActive = false;
    clearIdle();
    const message = `Ход прерван: Каскад подписок → ${route.stage.machine}: ${reason}. Ход повторится автоматически.`;
    const lines = syntheticRefusal('overload', message, sessionId, ports.now());
    out = out.then(() => { for (const l of lines) ports.stdout.write(`${l}\n`); });
    const done = { exitCode: null, limits, transportError: reason, durationMs: ports.now() - turnStartedAt };
    limits = [];
    const current = route;
    finishing = finishing.then(() => ports.finishTurn(current, done)).catch(error => ports.log(`finishTurn: ${String(error)}`));
  }

  // Вывод мосту идёт по цепочке: конец хода с исчерпанным лимитом задерживается,
  // пока сервер не отметит ступень (иначе provider-retry повторит ход на ней же).
  let out: Promise<void> = Promise.resolve();
  const onLine = (line: string) => {
    armIdle();
    const message = parse(line);
    if (message?.type === 'control_response') {
      const id = requestIdOf(message);
      if (id && swallow.has(id)) { swallow.delete(id); return; }
    }
    const limit = ports.limitFromLine(line);
    if (limit) limits.push(limit);
    // Модель недоступна на аккаунте ступени: попытка снимается, ход уходит мосту как лимит —
    // provider-retry повторит его на следующей попытке профиля.
    if (message?.type === 'result' && turnActive && message.is_error === true && ports.markModelUnavailable && MODEL_UNAVAILABLE.test(JSON.stringify(message.result ?? message.errors ?? ''))) {
      const reason = String(message.result ?? '').slice(0, 200) || 'модель недоступна на этом аккаунте';
      const mark = ports.markModelUnavailable(route, reason);
      const timeout = new Promise<void>(resolve => { const t = setTimeout(resolve, 10_000); (t as { unref?: () => void }).unref?.(); });
      const lines = syntheticRefusal('limit', `Модель недоступна на ${route.stage.machine}: ${reason} — ход повторится на следующей ступени.`, typeof message.session_id === 'string' ? message.session_id : null, ports.now());
      out = out.then(() => Promise.race([mark.catch(error => ports.log(`markModelUnavailable: ${String(error)}`)), timeout])).then(() => { for (const l of lines) ports.stdout.write(`${l}\n`); });
    } else if (message?.type === 'result' && turnActive && ports.markLimits && limits.some(l => l.status === 'rejected')) {
      const mark = ports.markLimits(route, [...limits]);
      const timeout = new Promise<void>(resolve => { const t = setTimeout(resolve, 10_000); (t as { unref?: () => void }).unref?.(); });
      out = out.then(() => Promise.race([mark.catch(error => ports.log(`markLimits: ${String(error)}`)), timeout])).then(() => { ports.stdout.write(`${line}\n`); });
    } else {
      out = out.then(() => { ports.stdout.write(`${line}\n`); });
    }
    if (message?.type === 'result' && turnActive) {
      turnActive = false;
      clearIdle();
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
  const watchChild = (c: StageChild) => {
    void c.done.then(result => {
      if (c !== child) return;
      childExit = result;
      ports.log(`stage CLI exited code=${result.code}${result.transportError ? ` (${result.transportError})` : ''}`);
      // Посреди хода — ход завершается ошибкой сразу, а не висит.
      abortTurn(result.transportError ? `связь с машиной ступени: ${result.transportError}` : `CLI ступени завершился (код ${result.code})`);
    });
  };
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
    if (isUser && !turnActive && pendingRefusal) {
      // Первое сообщение: каскад уже ответил отказом с автоповтором (процесс CLI здесь — только для начала сессии).
      const lines = syntheticRefusal(pendingRefusal.kind, pendingRefusal.message, sessionId, ports.now());
      pendingRefusal = null;
      sawUser = true;
      out = out.then(() => { for (const l of lines) ports.stdout.write(`${l}\n`); });
      continue;
    }
    if (isUser && !turnActive) {
      if (sawUser || routeFirst) {
        routeFirst = false;
        // Новый ход: решение каскада. Пока решаем — следующие строки ждут.
        await switching;
        let next: RoutedTurn;
        try { next = await ports.routeTurn(); } catch (error) {
          // Без решения сервера ход не идёт: прежняя ступень могла исчерпаться.
          ports.log(`routeTurn failed, refuse: ${String(error)}`);
          const message = `Ход не запущен: Каскад подписок → маршрут: сервер каскада не ответил перед ходом (${error instanceof Error ? error.message : String(error)}). Повторите ход.`;
          next = { action: 'refuse', retryable: true, message, notes: [{ kind: 'problem', message: message.slice(0, 300) }] };
        }
        await ports.feed(next.notes);
        if (next.action === 'refuse' && next.retryAs) {
          // Штатный автоповтор: ответ мосту на это сообщение без запуска хода, сессия живёт.
          const lines = syntheticRefusal(next.retryAs, next.message, sessionId, ports.now());
          out = out.then(() => { for (const l of lines) ports.stdout.write(`${l}\n`); });
          continue;
        }
        if (next.action === 'refuse') {
          ports.stderr.write(`${next.message}\n`);
          child.end();
          await child.done;
          return next.retryable ? 75 : 1;
        }
        if (!sameStage(route, next) || childExit) {
          // Другая ступень или процесс прежней умер — новый процесс продолжает сессию (--resume).
          if (childExit) ports.log(`stage CLI is gone — restarting on ${next.hostId}/${next.stepId}`);
          switching = switchTo(next).then(() => undefined);
          await switching;
        } else route = next;
      } else if (childExit) {
        ports.log('stage CLI is gone — restarting');
        switching = switchTo(route).then(() => undefined);
        await switching;
      }
      sawUser = true;
      turnActive = true;
      turnStartedAt = ports.now();
      armIdle();
    }
    if (childExit) {
      // Процесса нет (служебная строка между ходами): строку некому отдать.
      ports.log(`drop line for dead stage CLI: ${line.slice(0, 120)}`);
      continue;
    }
    child.write(line);
  }
  clearIdle();
  child.end();
  const result = childExit ?? await child.done;
  await out;
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
