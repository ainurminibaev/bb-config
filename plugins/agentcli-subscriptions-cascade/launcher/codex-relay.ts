// Реле JSON-RPC между штатным мостом Codex и app-server на машине ступени.
//
// - Пути: мост шлёт пути машины треда (cwd worktree на опоре); на машине ступени
//   проект лежит в общем пути (`/opt/bbfs/<единица>`). Все строки JSON, содержащие
//   путь моста, переписываются на путь ступени, ответы — обратно.
// - Синхронизация на каждый ход: app-server живёт долго, а файлы между ходами
//   возвращаются на опору. Перед `turn/start` (кроме первого, его подготовил
//   маршрут) — подготовка файлов; после `turn/completed` — возврат на опору.
//   Подготовка не удалась — мост получает ошибку на этот `turn/start`.
// - Песочница и сеть: как у штатного треда Codex — параметры моста не меняются.
import { createInterface } from 'node:readline';
import type { LimitObservation } from '../bridge/route-contract.ts';

type Json = Record<string, unknown>;

/** Заменить путь `from` на `to` во всех строках JSON (ключи не трогаются). */
export function rewritePaths(value: unknown, from: string, to: string): unknown {
  if (typeof value === 'string') return value.includes(from) ? value.split(from).join(to) : value;
  if (Array.isArray(value)) return value.map(v => rewritePaths(v, from, to));
  if (value !== null && typeof value === 'object') {
    const out: Json = {};
    for (const [k, v] of Object.entries(value as Json)) out[k] = rewritePaths(v, from, to);
    return out;
  }
  return value;
}

/** Строка JSON-RPC с переписанными путями; не JSON — как есть. */
export function rewriteLine(line: string, from: string | null, to: string | null): string {
  if (!from || !to || from === to || !line.includes(from)) return line;
  try { return JSON.stringify(rewritePaths(JSON.parse(line), from, to)); } catch { return line.split(from).join(to); }
}

export interface CodexRelayPorts {
  /** Строки от штатного моста (stdin запускателя). */
  stdin: NodeJS.ReadableStream;
  toChild(line: string): void;
  endChild(): void;
  toBridge(line: string): void;
  /** Путь проекта у моста и на машине ступени; null или одинаковые — без перевода. */
  bridgeCwd: string;
  stageCwd: string | null;
  /** Подготовка файлов к ходу (не первому). */
  prepare(): Promise<{ ok: boolean; message: string }>;
  /** Возврат файлов на опору после хода. */
  finish(): Promise<void>;
  /**
   * 0.3.5: лимит из хода (`account/rateLimits/updated` app-server) → монитор каскада.
   * До 0.3.5 лимит Codex из хода в каскад не попадал: исчерпание узнавалось только
   * опросом usageLimits, а квота без опроса оставалась «неизвестной».
   */
  limits?(observation: LimitObservation): void;
  /** 0.4.1: строка «где я выполняюсь» — в конец ввода каждого turn/start (ступень не на машине треда). */
  whereNote?: string | null;
  log(line: string): void;
}

export function startCodexRelay(ports: CodexRelayPorts): { onChildLine(line: string): void; pump: Promise<void> } {
  let prepared = true; // первый ход подготовил маршрут при старте app-server
  let finishing: Promise<void> = Promise.resolve();
  // Песочница и сеть — ровно как прислал штатный мост BB (0.3.0); меняются только пути.
  const toStage = (line: string) => rewriteLine(line, ports.bridgeCwd, ports.stageCwd);
  const toBridge = (line: string) => rewriteLine(line, ports.stageCwd, ports.bridgeCwd);

  const pump = (async () => {
    const input = createInterface({ input: ports.stdin, crlfDelay: Infinity });
    for await (const line of input) {
      let message: Json | null = null;
      try { message = JSON.parse(line) as Json; } catch { /* не JSON */ }
      if (message?.method === 'turn/start') {
        await finishing; // прежний ход вернул файлы
        if (!prepared) {
          const ready = await ports.prepare().catch(error => ({ ok: false, message: error instanceof Error ? error.message : String(error) }));
          if (!ready.ok) {
            ports.log(`codex turn refused: ${ready.message}`);
            if (message.id !== undefined) ports.toBridge(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: ready.message } }));
            continue;
          }
          prepared = true;
        }
      }
      if (message?.method === 'turn/start' && ports.whereNote) {
        const params = (message.params ?? {}) as Json;
        const input = Array.isArray(params.input) ? params.input as unknown[] : [];
        ports.toChild(toStage(JSON.stringify({ ...message, params: { ...params, input: [...input, { type: 'text', text: ports.whereNote }] } })));
        continue;
      }
      ports.toChild(toStage(line));
    }
    ports.endChild();
  })();

  return {
    pump,
    onChildLine(line: string) {
      ports.toBridge(toBridge(line));
      const limit = ports.limits ? limitFromCodexLine(line) : null;
      if (limit) ports.limits!(limit);
      if (!line.includes('turn/completed')) return;
      try {
        if ((JSON.parse(line) as Json).method !== 'turn/completed') return;
      } catch { return; }
      prepared = false;
      finishing = finishing.then(() => ports.finish()).catch(error => ports.log(`codex finish: ${String(error)}`));
    },
  };
}

/**
 * `account/rateLimits/updated` app-server Codex → наблюдение лимита (0.3.5).
 * Окно с usedPercent ≥ 100 — `rejected` до самого позднего его сброса; иначе
 * `allowed`. `raw` — само уведомление: сервер отдаёт его адаптеру Codex.
 */
export function limitFromCodexLine(line: string): LimitObservation | null {
  if (!line.includes('account/rateLimits/updated')) return null;
  let message: Json;
  try { message = JSON.parse(line) as Json; } catch { return null; }
  if (message.method !== 'account/rateLimits/updated') return null;
  const params = (message.params ?? {}) as Json;
  const limits = (params.rateLimits ?? {}) as Json;
  const windows = ['primary', 'secondary'].map(slot => (limits[slot] ?? null) as Json | null).filter((w): w is Json => w !== null && typeof w.usedPercent === 'number');
  if (windows.length === 0) return null;
  const full = windows.filter(w => (w.usedPercent as number) >= 100);
  const resets = full.map(w => (typeof w.resetsAt === 'number' ? w.resetsAt * 1000 : null)).filter((t): t is number => t !== null);
  return {
    status: full.length > 0 ? 'rejected' : 'allowed',
    resetsAt: full.length > 0 && resets.length > 0 ? Math.max(...resets) : null,
    windowType: full.length > 0 ? 'codex-rate-limits' : null,
    raw: { method: 'account/rateLimits/updated', params: { rateLimits: limits } },
  };
}
