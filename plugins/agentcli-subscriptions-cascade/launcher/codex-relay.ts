// Реле JSON-RPC между штатным мостом Codex и app-server на машине ступени.
//
// - Пути: мост шлёт пути машины треда (cwd worktree на опоре); на машине ступени
//   проект лежит в общем пути (`/opt/bbfs/<единица>`). Все строки JSON, содержащие
//   путь моста, переписываются на путь ступени, ответы — обратно.
// - Синхронизация на каждый ход: app-server живёт долго, а файлы между ходами
//   возвращаются на опору. Перед `turn/start` (кроме первого, его подготовил
//   маршрут) — подготовка файлов; после `turn/completed` — возврат на опору.
//   Подготовка не удалась — мост получает ошибку на этот `turn/start`.
import { createInterface } from 'node:readline';

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

/**
 * Песочница Codex на ступени каскада (строже штатной: у BB для «workspace»
 * сеть открыта, «full» — без песочницы): `workspace-write`, сеть выключена,
 * запись — только в папку ступени. Применяется к `sandbox`/`sandboxPolicy`
 * в параметрах thread/start, thread/resume и turn/start.
 */
export function confineSandbox(message: Json, stageRoot: string): Json {
  const method = message.method;
  if (method !== 'thread/start' && method !== 'thread/resume' && method !== 'turn/start') return message;
  const params = { ...(message.params as Json | undefined ?? {}) };
  params.sandbox = 'workspace-write';
  const policy = (params.sandboxPolicy && typeof params.sandboxPolicy === 'object' ? params.sandboxPolicy : {}) as Json;
  const roots = Array.isArray(policy.writableRoots) ? (policy.writableRoots as unknown[]).filter((r): r is string => typeof r === 'string' && (r === stageRoot || r.startsWith(`${stageRoot}/`))) : [];
  params.sandboxPolicy = {
    ...policy, type: 'workspaceWrite', writableRoots: [...new Set([stageRoot, ...roots])], networkAccess: false,
  };
  if (method === 'thread/start' || method === 'thread/resume') {
    // Конфиг сессии тоже: тот же режим, сеть выключена.
    const config = (params.config && typeof params.config === 'object' ? params.config : {}) as Json;
    params.config = { ...config, sandbox_mode: 'workspace-write', 'sandbox_workspace_write.network_access': false };
  }
  return { ...message, params };
}

/** Аргументы app-server: та же песочница через конфиг codex (на случай, если параметры её не несут). */
export const SANDBOX_ARGS: readonly string[] = ['-c', 'sandbox_mode="workspace-write"', '-c', 'sandbox_workspace_write.network_access=false'];

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
  /** Папка ступени для песочницы (корень записи); null — песочница не меняется. */
  sandboxRoot: string | null;
  /** Подготовка файлов к ходу (не первому). */
  prepare(): Promise<{ ok: boolean; message: string }>;
  /** Возврат файлов на опору после хода. */
  finish(): Promise<void>;
  log(line: string): void;
}

export function startCodexRelay(ports: CodexRelayPorts): { onChildLine(line: string): void; pump: Promise<void> } {
  let prepared = true; // первый ход подготовил маршрут при старте app-server
  let finishing: Promise<void> = Promise.resolve();
  const toStage = (line: string) => {
    const moved = rewriteLine(line, ports.bridgeCwd, ports.stageCwd);
    if (!ports.sandboxRoot || !moved.includes('"method"')) return moved;
    try { return JSON.stringify(confineSandbox(JSON.parse(moved) as Json, ports.sandboxRoot)); } catch { return moved; }
  };
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
      ports.toChild(toStage(line));
    }
    ports.endChild();
  })();

  return {
    pump,
    onChildLine(line: string) {
      ports.toBridge(toBridge(line));
      if (!line.includes('turn/completed')) return;
      try {
        if ((JSON.parse(line) as Json).method !== 'turn/completed') return;
      } catch { return; }
      prepared = false;
      finishing = finishing.then(() => ports.finish()).catch(error => ports.log(`codex finish: ${String(error)}`));
    },
  };
}
