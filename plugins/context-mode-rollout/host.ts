// Runs on each enrolled machine as the user that runs Claude Code and Codex there.
// Installs the pinned context-mode npm package when it is missing or older, and runs its own
// setup for the CLIs found in PATH. Never uses sudo and never touches accounts or auth.
import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { experimental_defineHostEntry } from '@get-bb/plugin-sdk/host';
import { hostContract, type EnsureResult } from './contract.ts';
import { AGENTS, agentsNeedingSetup, chooseCandidate, packageIsCurrent, parseAgents, satisfiesNode, type AgentState } from './logic.ts';

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
    ensure: async ({ candidates, apply, verify }, ctx): Promise<EnsureResult> => {
      const signal = ctx.signal;
      const env: NodeJS.ProcessEnv = { ...process.env, PATH: await loginPath(signal), NO_COLOR: '1', CI: '1' };
      const result: EnsureResult = {
        platform: process.platform, state: 'ok', message: '', pinned: candidates[0]!.version, offered: candidates[0]!.version,
        nodeVersion: null, failedVersion: null, versionBefore: null, versionAfter: null, clis: [], actions: [], agents: [],
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

      // context-mode runs on the `node` in PATH (bin shebang; setup records that binary for MCP).
      const nodeBin = await which('node', env.PATH!);
      const nodeRun = nodeBin ? await run(nodeBin, ['--version'], env, 30_000, signal) : null;
      result.nodeVersion = nodeRun?.code === 0 ? nodeRun.stdout.trim() : null;
      if (!result.nodeVersion) return fail('node не найден в PATH: context-mode нужен Node.js');
      const chosen = chooseCandidate(candidates, result.nodeVersion);
      if (!chosen) {
        // Nothing this Node can run: keep whatever works now, never install an incompatible package.
        const need = candidates.map(c => c.node).filter(Boolean)[0] ?? '?';
        return fail(`Node ${result.nodeVersion} слишком старый для context-mode (нужен ${need}); ${result.versionBefore ? `текущая установка ${result.versionBefore} не тронута` : 'context-mode не ставлю'} — обновите Node`);
      }
      const version = chosen.version;
      result.pinned = version;
      const installedOk = result.versionBefore === null || satisfiesNode(result.nodeVersion, candidates.find(c => c.version === result.versionBefore)?.node ?? null);
      const npm = await which('npm', env.PATH!);
      const install = async (v: string) => {
        const r = await run(npm!, ['install', '-g', `context-mode@${v}`, '--no-fund', '--no-audit', '--engine-strict'], env, 10 * 60_000, signal);
        const prefix = await run(npm!, ['prefix', '-g'], env, 30_000, signal);
        if (prefix.code === 0 && prefix.stdout.trim()) env.PATH = [...new Set([WIN ? prefix.stdout.trim() : join(prefix.stdout.trim(), 'bin'), ...env.PATH!.split(delimiter)])].join(delimiter);
        return r;
      };

      // Install when missing or older than the chosen release, or when the installed release needs a newer Node than this host has.
      if (!packageIsCurrent(result.versionBefore, version) || (result.versionBefore !== version && !installedOk)) {
        if (!npm) return fail('npm не найден рядом с node: установить context-mode нечем');
        result.actions.push(`npm install -g context-mode@${version}`);
        if (!apply) return { ...result, state: 'planned', message: `будет установлен context-mode ${version} (Node ${result.nodeVersion}) и выполнен setup для ${result.clis.join(', ')}` };
        const r = await install(version);
        if (r.code !== 0) return fail(`npm install не удался (без sudo не ставлю; прежняя версия ${result.versionBefore ?? '—'} остаётся): ${tail(r.stderr || r.stdout)}`);
        result.versionAfter = await version_();
        if (!packageIsCurrent(result.versionAfter, version)) return fail(`после установки context-mode --version = ${result.versionAfter ?? 'нет'}`);
      }

      /** After a failed upgrade put the previous working version back and set it up again. */
      const rollback = async (why: string): Promise<EnsureResult> => {
        const prev = result.versionBefore;
        if (!apply || !prev || prev === result.versionAfter || !npm) return fail(why);
        result.failedVersion = result.versionAfter;
        result.actions.push(`откат: npm install -g context-mode@${prev}`);
        const r = await install(prev);
        const b = await which('context-mode', env.PATH!);
        const s = r.code === 0 && b ? await run(b, ['setup', '--yes', '--no-input', '--agents', result.clis.join(','), '--json'], env, 15 * 60_000, signal) : null;
        result.versionAfter = await version_();
        const back = s?.code === 0 && result.versionAfter === prev;
        return fail(`${why}; ${back ? `откатил на ${prev}, она работает` : `откат на ${prev} не удался — нужна ручная проверка`}`);
      };

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
        if (r.code !== 0) return rollback(`context-mode setup завершился с кодом ${r.code}: ${tail(r.stderr || r.stdout)}`);
        result.state = 'installed';
      }

      if (verify || result.state === 'installed') {
        const r = await run(bin, ['doctor', '--no-input', '--agents', agentsArg, '--json'], env, 10 * 60_000, signal);
        const agents = parseAgents(r.stdout);
        if (agents) result.agents = agents;
        const bad = (agents ?? []).filter(a => a.status !== 'PASS').map(a => `${a.id}=${a.status}`);
        if (r.code !== 0 || !agents || bad.length) return rollback(`context-mode doctor: ${bad.join(', ') || tail(r.stderr || r.stdout) || `код ${r.code}`}`);
      }

      result.message = result.state === 'installed'
        ? `установлено/настроено (${result.clis.join(', ')}); новые сессии CLI подхватят MCP и хуки`
        : `context-mode ${result.versionAfter} настроен для ${result.clis.join(', ')}`;
      if (version !== candidates[0]!.version) result.message += ` (новее ${candidates[0]!.version} требует Node ${candidates[0]!.node ?? '?'}, здесь ${result.nodeVersion})`;
      return result;
    },
  },
});
