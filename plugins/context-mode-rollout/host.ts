// Runs on each enrolled machine as the user that runs Claude Code and Codex there.
// Installs the pinned context-mode npm package when it is missing or older, and runs its own
// setup for the CLIs found in PATH. Never uses sudo and never touches accounts or auth.
import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { experimental_defineHostEntry } from '@get-bb/plugin-sdk/host';
import { hostContract, type EnsureResult } from './contract.ts';
import { AGENTS, agentsNeedingSetup, packageIsCurrent, parseAgents, type AgentState } from './logic.ts';

const WIN = process.platform === 'win32';
const CLI_BIN: Record<string, string> = { 'claude-code': 'claude', codex: 'codex' };

interface Run { code: number; stdout: string; stderr: string }

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number, signal: AbortSignal): Promise<Run> {
  return new Promise(resolve => {
    execFile(cmd, args, { env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, signal, shell: WIN, windowsHide: true },
      (error, stdout, stderr) => {
        const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr || (error && !stdout ? error.message : '')) });
      });
  });
}

/** PATH of a login shell: the host daemon may start with a minimal one (launchd on macOS). */
async function loginPath(signal: AbortSignal): Promise<string> {
  const home = homedir();
  // Usual user-level bin dirs; on macOS also Homebrew, which launchd's PATH lacks.
  const extra = [join(home, '.local', 'bin'), join(home, '.npm-global', 'bin'), ...(process.platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin'] : [])];
  const parts = (process.env.PATH ?? '').split(delimiter);
  if (!WIN) {
    const shell = process.env.SHELL || '/bin/sh';
    const r = await run(shell, ['-lc', 'printf "__BBPATH__%s__BBPATH__" "$PATH"'], process.env, 15_000, signal);
    const m = /__BBPATH__(.*)__BBPATH__/s.exec(r.stdout);
    if (m?.[1]) parts.unshift(...m[1].split(delimiter));
  }
  if (!WIN) parts.push(...extra);
  return [...new Set(parts.filter(Boolean))].join(delimiter);
}

async function which(name: string, path: string): Promise<string | null> {
  const exts = WIN ? ['.cmd', '.exe', ''] : [''];
  for (const dir of path.split(delimiter)) {
    for (const ext of exts) {
      const full = join(dir, name + ext);
      try { await access(full, constants.X_OK); return full; } catch { /* next */ }
    }
  }
  return null;
}

const tail = (text: string) => text.trim().split('\n').slice(-3).join(' ').slice(0, 400);

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    ensure: async ({ version, apply, verify }, ctx): Promise<EnsureResult> => {
      const signal = ctx.signal;
      const env: NodeJS.ProcessEnv = { ...process.env, PATH: await loginPath(signal), NO_COLOR: '1', CI: '1' };
      const result: EnsureResult = {
        platform: process.platform, state: 'ok', message: '', pinned: version,
        versionBefore: null, versionAfter: null, clis: [], actions: [], agents: [],
      };
      const fail = (message: string): EnsureResult => ({ ...result, state: 'error', message });

      for (const id of AGENTS) if (await which(CLI_BIN[id]!, env.PATH!)) result.clis.push(id);
      if (!result.clis.length) return { ...result, state: 'no-cli', message: 'Claude Code и Codex CLI не найдены в PATH: ставить некуда' };

      const version_ = async () => {
        const bin = await which('context-mode', env.PATH!);
        if (!bin) return null;
        const r = await run(bin, ['--version'], env, 30_000, signal);
        return r.code === 0 ? (r.stdout.trim().split(/\s+/).pop() ?? null) : null;
      };
      result.versionBefore = await version_();
      result.versionAfter = result.versionBefore;

      if (!packageIsCurrent(result.versionBefore, version)) {
        const npm = await which('npm', env.PATH!);
        if (!npm) return fail('npm не найден: нужен Node.js с node:sqlite (Node 22.5+)');
        result.actions.push(`npm install -g context-mode@${version}`);
        if (!apply) return { ...result, state: 'planned', message: `будет установлен context-mode ${version} и выполнен setup для ${result.clis.join(', ')}` };
        const r = await run(npm, ['install', '-g', `context-mode@${version}`, '--no-fund', '--no-audit'], env, 10 * 60_000, signal);
        if (r.code !== 0) return fail(`npm install не удался (без sudo не ставлю): ${tail(r.stderr || r.stdout)}`);
        const prefix = await run(npm, ['prefix', '-g'], env, 30_000, signal);
        if (prefix.code === 0 && prefix.stdout.trim()) env.PATH = [WIN ? prefix.stdout.trim() : join(prefix.stdout.trim(), 'bin'), env.PATH].join(delimiter);
        result.versionAfter = await version_();
        if (!packageIsCurrent(result.versionAfter, version)) return fail(`после установки context-mode --version = ${result.versionAfter ?? 'нет'}`);
      }

      const bin = (await which('context-mode', env.PATH!))!;
      const agentsArg = result.clis.join(',');
      const dry = await run(bin, ['setup', '--dry-run', '--no-input', '--agents', agentsArg, '--json'], env, 5 * 60_000, signal);
      const planned: AgentState[] | null = parseAgents(dry.stdout);
      const todo = result.versionBefore === result.versionAfter ? agentsNeedingSetup(result.clis, planned) : [...result.clis];
      result.agents = planned ?? [];

      if (todo.length) {
        result.actions.push(`context-mode setup --yes --agents ${todo.join(',')}`);
        if (!apply) return { ...result, state: 'planned', message: `нужен setup для ${todo.join(', ')}` };
        const r = await run(bin, ['setup', '--yes', '--no-input', '--agents', todo.join(','), '--json'], env, 15 * 60_000, signal);
        const agents = parseAgents(r.stdout);
        if (agents) result.agents = [...result.agents.filter(a => !todo.includes(a.id)), ...agents];
        if (r.code !== 0) return fail(`context-mode setup завершился с кодом ${r.code}: ${tail(r.stderr || r.stdout)}`);
        result.state = 'installed';
      }

      if (verify || result.state === 'installed') {
        const r = await run(bin, ['doctor', '--no-input', '--agents', agentsArg, '--json'], env, 10 * 60_000, signal);
        const agents = parseAgents(r.stdout);
        if (agents) result.agents = agents;
        const bad = (agents ?? []).filter(a => a.status !== 'PASS').map(a => `${a.id}=${a.status}`);
        if (r.code !== 0 || !agents || bad.length) return fail(`context-mode doctor: ${bad.join(', ') || tail(r.stderr || r.stdout) || `код ${r.code}`}`);
      }

      result.message = result.state === 'installed'
        ? `установлено/настроено (${result.clis.join(', ')}); новые сессии CLI подхватят MCP и хуки`
        : `context-mode ${result.versionAfter} настроен для ${result.clis.join(', ')}`;
      return result;
    },
  },
});
