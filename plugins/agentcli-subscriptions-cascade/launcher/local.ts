// Локальный запуск нативного CLI: та же машина, что и мост.
// stdio наследуется (байт в байт, без кадров), сигналы пересылаются.
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';

export interface LocalRunOptions {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
  /** Перехват stdout (строки stream-json) — для чтения событий лимита. */
  onStdoutLine?(line: string): void;
  /** Куда отдавать stdout при перехвате (по умолчанию stdout процесса). */
  stdout?: { write(data: Buffer): unknown };
}

export function runLocal(options: LocalRunOptions): Promise<{ code: number; signal: string | null }> {
  return new Promise((resolvePromise, reject) => {
    const tap = options.onStdoutLine;
    const child = spawn(options.command, options.args, {
      env: options.env, cwd: options.cwd, stdio: ['inherit', tap ? 'pipe' : 'inherit', 'inherit'],
    });
    if (tap && child.stdout) {
      let rest = '';
      child.stdout.on('data', (chunk: Buffer) => {
        (options.stdout ?? process.stdout).write(chunk);
        rest += chunk.toString('utf8');
        const lines = rest.split('\n');
        rest = lines.pop() ?? '';
        if (rest.length > 4 << 20) rest = '';
        for (const line of lines) { try { tap(line); } catch { /* разбор не мешает ходу */ } }
      });
    }
    const forward = (signal: NodeJS.Signals) => () => { child.kill(signal); };
    const handlers = (['SIGTERM', 'SIGINT', 'SIGHUP'] as const).map(signal => [signal, forward(signal)] as const);
    for (const [signal, handler] of handlers) process.on(signal, handler);
    child.on('error', reject);
    child.on('close', (code, signal) => {
      for (const [sig, handler] of handlers) process.off(sig, handler);
      resolvePromise({ code: code ?? (signal ? 1 : 0), signal });
    });
  });
}

const isFile = (path: string) => { try { return statSync(path).isFile(); } catch { return false; } };

/**
 * Настоящий CLI на этой машине: PATH и известные места, кроме самого
 * запускателя (он стоит в BB_CLAUDE_CODE_EXECUTABLE, но не в PATH).
 */
export function resolveRealExecutable(name: string, env: NodeJS.ProcessEnv, exclude: readonly string[] = []): string | null {
  const skip = new Set(exclude.map(p => resolve(p)));
  const home = env.HOME ?? '';
  const candidates = [
    ...(env.PATH ?? '').split(delimiter).filter(Boolean).map(dir => join(dir, name)),
    join(home, '.local/bin', name), join(home, `.${name}/local/${name}`), `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`, `/usr/bin/${name}`,
  ];
  for (const candidate of candidates) if (!skip.has(resolve(candidate)) && isFile(candidate)) return candidate;
  return null;
}
