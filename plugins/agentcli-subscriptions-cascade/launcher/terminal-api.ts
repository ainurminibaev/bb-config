// Канал до машины ступени — терминалы BB (REST сервера BB, тот же, что у
// `bb terminal`). Запускателю доступен BB_SERVER_URL из окружения сессии.
// Процесс `bb` на каждый опрос не запускаем: это 1,2 с и ~0,2 с процессора.
// Веб-сокет терминала через локальный прокси Mac не открывается (проверено:
// 400), поэтому поток — опрос `output?sinceSeq` с короткой паузой.

export interface TerminalChunk { seq: number; dataBase64: string }
export interface TerminalOutput {
  chunks: TerminalChunk[];
  nextSeq: number;
  truncated: boolean;
  status: string;
  exitCode: number | null;
}

export interface TerminalApi {
  create(args: { id: string; hostId: string; cwd: string; argv: string[]; title: string }): Promise<{ id: string }>;
  input(id: string, data: Buffer): Promise<void>;
  output(id: string, sinceSeq: number, signal?: AbortSignal): Promise<TerminalOutput>;
  close(id: string): Promise<void>;
}

export class TerminalApiError extends Error {
  readonly status: number | null;
  readonly code: string | null;
  constructor(message: string, status: number | null, code: string | null) {
    super(message);
    this.status = status;
    this.code = code;
  }
  /** Повтор имеет смысл: сеть, 5xx, 429. */
  get transient(): boolean { return this.status === null || this.status >= 500 || this.status === 429; }
}

/** Формат ID терминала BB: term_ и 10 символов без похожих (0, 1, l, o). */
const TERMINAL_ID = /^term_[23456789abcdefghijkmnpqrstuvwxyz]{10}$/u;

export function newTerminalId(random: () => number = Math.random): string {
  const alphabet = '23456789abcdefghijkmnpqrstuvwxyz';
  let id = 'term_';
  for (let i = 0; i < 10; i += 1) id += alphabet[Math.floor(random() * alphabet.length)];
  return id;
}

export function httpTerminalApi(baseUrl: string, fetchImpl: typeof fetch = fetch): TerminalApi {
  const root = baseUrl.replace(/\/+$/u, '');
  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    let response: Response;
    try {
      response = await fetchImpl(`${root}${path}`, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal ?? AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new TerminalApiError(`сервер BB недоступен: ${error instanceof Error ? error.message : String(error)}`, null, null);
    }
    const text = await response.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* не JSON */ }
    if (!response.ok) {
      const err = (json as { error?: { code?: string; message?: string }; code?: string; message?: string } | null);
      const code = err?.error?.code ?? err?.code ?? null;
      const message = err?.error?.message ?? err?.message ?? `HTTP ${response.status}`;
      throw new TerminalApiError(message, response.status, code);
    }
    return json as T;
  }
  return {
    async create({ id, hostId, cwd, argv, title }) {
      if (!TERMINAL_ID.test(id)) throw new TerminalApiError(`неверный ID терминала ${id}`, 400, 'invalid_id');
      try {
        const created = await call<{ id: string }>('POST', '/api/v1/terminals', {
          cols: 200, rows: 50, id, title, start: { mode: 'argv', argv }, target: { kind: 'host_path', hostId, cwd },
        });
        return { id: created.id };
      } catch (error) {
        // Повтор создания после обрыва: терминал уже есть — продолжаем с ним.
        if (error instanceof TerminalApiError && error.code === 'terminal_id_conflict') return { id };
        throw error;
      }
    },
    async input(id, data) {
      await call('POST', `/api/v1/terminals/${encodeURIComponent(id)}/input`, { dataBase64: data.toString('base64') });
    },
    output(id, sinceSeq, signal) {
      return call<TerminalOutput>('GET', `/api/v1/terminals/${encodeURIComponent(id)}/output?sinceSeq=${sinceSeq}`, undefined, signal);
    },
    async close(id) {
      await call('POST', `/api/v1/terminals/${encodeURIComponent(id)}/close`, { mode: 'force', reason: 'user' }).catch(() => {});
    },
  };
}
