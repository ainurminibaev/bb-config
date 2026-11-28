// Решение перед ходом по билету (0.3.0). Подготовка хода идёт до 20 минут
// (ожидание рабочей папки, первая синхронизация), а один HTTP-запрос дольше
// 300 с рвёт undici у запускателя («TypeError: fetch failed»). Поэтому
// routeTurn с `async` отвечает не позже чем через `waitMs`: решением или
// билетом; запускатель спрашивает routeTurnResult, пока решение не готово.
// Билет живёт в памяти сервера: после перезагрузки плагина он неизвестен —
// запускатель получает ошибку и отказывает ход с автоповтором, как раньше.
import { randomUUID } from 'node:crypto';

export type Pending = { action: 'pending'; ticket: string };

interface Job<T> { done: boolean; result?: T; error?: unknown; finishedAt: number | null; promise: Promise<void> }

export interface RouteJobs<I, T> {
  start(input: I): Promise<T | Pending>;
  result(ticket: string): Promise<T | Pending>;
  /** Сколько решений ещё готовится (для тестов и диагностики). */
  size(): number;
}

export function createRouteJobs<I, T>(run: (input: I) => Promise<T>, options: { waitMs?: number; keepMs?: number; now?: () => number; id?: () => string } = {}): RouteJobs<I, T> {
  const waitMs = options.waitMs ?? 20_000;
  const keepMs = options.keepMs ?? 30 * 60_000;
  const now = options.now ?? Date.now;
  const id = options.id ?? randomUUID;
  const jobs = new Map<string, Job<T>>();

  const prune = () => {
    for (const [ticket, job] of jobs) if (job.done && job.finishedAt !== null && now() - job.finishedAt > keepMs) jobs.delete(ticket);
  };

  async function wait(ticket: string): Promise<T | Pending> {
    const job = jobs.get(ticket);
    if (!job) throw new Error(`решение хода ${ticket} неизвестно (плагин перезагружен?) — повторите ход`);
    if (!job.done) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([job.promise, new Promise<void>(resolve => { timer = setTimeout(resolve, waitMs); })]);
      clearTimeout(timer);
    }
    if (!job.done) return { action: 'pending', ticket };
    jobs.delete(ticket);
    if (job.error !== undefined) throw job.error;
    return job.result as T;
  }

  return {
    start(input) {
      prune();
      const ticket = id();
      const job: Job<T> = { done: false, finishedAt: null, promise: Promise.resolve() };
      job.promise = run(input).then(result => { job.result = result; }, error => { job.error = error; }).finally(() => { job.done = true; job.finishedAt = now(); });
      jobs.set(ticket, job);
      return wait(ticket);
    },
    result: wait,
    size: () => [...jobs.values()].filter(j => !j.done).length,
  };
}
