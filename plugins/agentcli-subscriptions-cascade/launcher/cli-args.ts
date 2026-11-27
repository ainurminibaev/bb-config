// Разбор и правка аргументов, с которыми штатный мост запускает CLI.
// Чистые функции: тестируются без процессов.
import { homedir } from 'node:os';
import { join } from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Значение флага в форме `--flag=value` или `--flag value`. */
export function flagValue(args: readonly string[], flag: string): string | null {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === flag) return args[i + 1] ?? null;
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  }
  return null;
}

export interface ClaudeSessionInfo {
  /** ID нативной сессии: --resume или --session-id. */
  sessionId: string | null;
  /** Продолжение существующей сессии (нужен её файл на машине ступени). */
  resumes: boolean;
  /** --no-session-persistence: сессию не сохранять и не возвращать. */
  ephemeral: boolean;
}

export function claudeSessionInfo(args: readonly string[]): ClaudeSessionInfo {
  const resume = flagValue(args, '--resume');
  const session = flagValue(args, '--session-id');
  const id = [resume, session].find(v => v !== null && UUID.test(v)) ?? null;
  return { sessionId: id, resumes: resume !== null && UUID.test(resume), ephemeral: args.includes('--no-session-persistence') };
}

/** Папка сессий Claude повторяет путь проекта: всё, кроме букв и цифр, — «-». */
export function encodeClaudeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/gu, '-');
}

export function claudeSessionPath(cwd: string, sessionId: string, env: NodeJS.ProcessEnv = process.env): string {
  const base = env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), '.claude');
  return join(base, 'projects', encodeClaudeProjectDir(cwd), `${sessionId}.jsonl`);
}

/**
 * Заменить модель в аргументах (`--model x` / `--model=x`) на ID модели
 * ступени. Штатный мост передаёт ID профиля каскада («auto»), CLI его не знает.
 * null — модель CLI по умолчанию: флаг убирается.
 */
export function replaceModel(args: readonly string[], model: string | null): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '--model') { i += 1; continue; }
    if (arg.startsWith('--model=')) continue;
    out.push(arg);
  }
  return model ? [...out, '--model', model] : out;
}

/**
 * Флаги с путями и адресами машины треда: на машине ступени их нет.
 * MCP моста BB (инструменты BB) и локальные настройки остаются на машине треда.
 */
const LOCAL_ONLY_WITH_VALUE = new Set(['--mcp-config', '--settings', '--plugin-dir', '--debug-file', '--append-system-prompt-file', '--system-prompt-file']);
const LOCAL_ONLY_FLAGS = new Set(['--strict-mcp-config']);

export function remoteArgs(args: readonly string[]): { args: string[]; dropped: string[] } {
  const out: string[] = [];
  const dropped: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    const name = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    if (LOCAL_ONLY_FLAGS.has(name)) { dropped.push(name); continue; }
    if (LOCAL_ONLY_WITH_VALUE.has(name)) {
      dropped.push(name);
      if (!arg.includes('=')) i += 1;
      continue;
    }
    out.push(arg);
  }
  return { args: out, dropped };
}

/**
 * Окружение CLI для машины ступени. Логин, ключи и маршрут (ANTHROPIC_*,
 * OAuth-токены) не переносятся: у машины свои. Переносятся только настройки
 * поведения CLI, которые выставил штатный мост.
 */
const REMOTE_ENV_ALLOW = /^(CLAUDE_CODE_|MAX_THINKING_TOKENS$|DISABLE_|BASH_DEFAULT_TIMEOUT_MS$|BASH_MAX_TIMEOUT_MS$|MCP_TIMEOUT$|CODEX_)/u;
const REMOTE_ENV_DENY = /(OAUTH|_TOKEN$|_KEY$|SECRET|PASSWORD|CREDENTIAL|_HOME$|CONFIG_DIR$|EXECUTABLE$|BASE_URL$)/u;

export function remoteEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (!REMOTE_ENV_ALLOW.test(key) || REMOTE_ENV_DENY.test(key)) continue;
    out[key] = value;
  }
  return out;
}
