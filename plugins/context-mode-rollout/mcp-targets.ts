// Agents that context-mode's own `setup` does not support (it lists Antigravity and Cursor as
// unsupported hosts) but that load stdio MCP servers from a user-level config. For them only the
// MCP server is registered: its tools work, context-mode hooks (auto-indexing) do not exist there.
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, rename, stat, writeFile, copyFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface McpServer { command: string; args: string[] }

export interface McpTarget {
  id: string;
  /** MCP clientInfo name the agent sends; used for the verification handshake. */
  clientName: string;
  detect(ctx: TargetCtx): Promise<boolean>;
  read(ctx: TargetCtx): Promise<McpServer | null | 'unreadable'>;
  write(ctx: TargetCtx, server: McpServer): Promise<void>;
}

export interface TargetCtx {
  home: string;
  which(name: string): Promise<string | null>;
  run(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
}

const exists = async (path: string) => { try { await access(path); return true; } catch { return false; } };

/** A JSON file with a top-level `mcpServers` map (Antigravity IDE, Cursor). Other keys are kept. */
function jsonFileTarget(id: string, clientName: string, dirParts: string[], file: string): McpTarget {
  const dir = (ctx: TargetCtx) => join(ctx.home, ...dirParts);
  const path = (ctx: TargetCtx) => join(dir(ctx), file);
  const load = async (ctx: TargetCtx): Promise<Record<string, unknown> | 'unreadable'> => {
    let text: string;
    try { text = await readFile(path(ctx), 'utf8'); } catch { return {}; }
    if (!text.trim()) return {};
    try {
      const data = JSON.parse(text) as unknown;
      return data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : 'unreadable';
    } catch { return 'unreadable'; }
  };
  return {
    id, clientName,
    detect: async ctx => exists(dir(ctx)),
    async read(ctx) {
      const data = await load(ctx);
      if (data === 'unreadable') return 'unreadable';
      const entry = (data.mcpServers as Record<string, unknown> | undefined)?.['context-mode'] as { command?: unknown; args?: unknown } | undefined;
      if (!entry || typeof entry.command !== 'string' || !Array.isArray(entry.args)) return null;
      return { command: entry.command, args: entry.args.map(String) };
    },
    async write(ctx, server) {
      const data = await load(ctx);
      if (data === 'unreadable') throw new Error(`${path(ctx)} не JSON — не трогаю`);
      const servers = (data.mcpServers && typeof data.mcpServers === 'object' ? data.mcpServers : {}) as Record<string, unknown>;
      const prev = (servers['context-mode'] ?? {}) as Record<string, unknown>;
      const next = { ...data, mcpServers: { ...servers, 'context-mode': { ...prev, command: server.command, args: server.args } } };
      const target = path(ctx);
      await mkdir(dirname(target), { recursive: true });
      // One backup of the user's file before the first change.
      if ((await exists(target)) && !(await exists(target + '.before-context-mode'))) await copyFile(target, target + '.before-context-mode');
      const mode = (await stat(target).catch(() => null))?.mode;
      const tmp = `${target}.tmp-${process.pid}`;
      await writeFile(tmp, JSON.stringify(next, null, 2) + '\n', mode ? { mode: mode & 0o777 } : undefined);
      await rename(tmp, target);
    },
  };
}

/** Antigravity CLI: managed through its own `agy mcp` commands (user profile ~/.gemini/config). */
const antigravityCli: McpTarget = {
  id: 'antigravity-cli', clientName: 'agy',
  detect: async ctx => (await ctx.which('agy')) !== null,
  async read(ctx) {
    const agy = (await ctx.which('agy'))!;
    const r = await ctx.run(agy, ['mcp', 'list']);
    if (r.code !== 0) return 'unreadable';
    const line = r.stdout.split('\n').find(l => /^context-mode\s/.test(l));
    if (!line) return null;
    const m = /^context-mode\s+stdio\s+(\S+)\s+(.*)$/.exec(line.trim());
    if (!m || m[1] !== 'enabled') return { command: '', args: [] };
    const [command, ...args] = m[2]!.trim().split(/\s+/);
    return { command: command ?? '', args };
  },
  async write(ctx, server) {
    const agy = (await ctx.which('agy'))!;
    const r = await ctx.run(agy, ['mcp', 'add', 'context-mode', '--', server.command, ...server.args]);
    if (r.code !== 0) throw new Error(`agy mcp add: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
    const e = await ctx.run(agy, ['mcp', 'enable', 'context-mode']);
    if (e.code !== 0 && !/already/i.test(e.stderr + e.stdout)) throw new Error(`agy mcp enable: ${(e.stderr || e.stdout).trim().slice(0, 300)}`);
  },
};

export const MCP_TARGETS: McpTarget[] = [
  antigravityCli,
  jsonFileTarget('antigravity-ide', 'antigravity', ['.gemini', 'antigravity'], 'mcp_config.json'),
  jsonFileTarget('cursor', 'cursor-vscode', ['.cursor'], 'mcp.json'),
];

export const sameServer = (a: McpServer | null | 'unreadable', b: McpServer) =>
  a !== null && a !== 'unreadable' && a.command === b.command && a.args.join('\0') === b.args.join('\0');

/** MCP initialize + tools/list against the server as `clientName`; returns the tool count or throws. */
export function probeMcp(server: McpServer, clientName: string, env: NodeJS.ProcessEnv, cwd: string, timeoutMs = 30_000): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(server.command, server.args, { env, cwd, stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '';
    const done = (fn: () => void) => { clearTimeout(timer); child.kill(); fn(); };
    const timer = setTimeout(() => done(() => reject(new Error('MCP не ответил за 30 с'))), timeoutMs);
    const send = (o: unknown) => child.stdin.write(JSON.stringify(o) + '\n');
    child.on('error', error => done(() => reject(error)));
    child.on('exit', code => done(() => reject(new Error(`MCP-сервер завершился (${code})`))));
    child.stdout.on('data', chunk => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m: { id?: number; result?: { tools?: unknown[] }; error?: { message?: string } };
        try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1) { send({ jsonrpc: '2.0', method: 'notifications/initialized' }); send({ jsonrpc: '2.0', id: 2, method: 'tools/list' }); }
        if (m.id === 2) {
          const n = Array.isArray(m.result?.tools) ? m.result!.tools!.length : 0;
          child.removeAllListeners('exit');
          done(() => (n > 0 ? resolve(n) : reject(new Error(m.error?.message ?? 'tools/list пуст'))));
        }
      }
    });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: clientName, version: '0' } } });
  });
}

export const defaultHome = () => homedir();
