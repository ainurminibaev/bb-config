// Агент на машине ступени. Запускается в терминале BB как
//   sh -lc 'exec node -e "$1"' cascade-agent <AGENT_SOURCE>
// Логин-оболочка даёт PATH пользователя (claude, codex). Агент запускает
// нативный CLI под логином этой машины, сам ничего не знает об аккаунтах.
// Протокол кадров — launcher/protocol.ts. Код — обычный JS без зависимостей:
// на машине ступени есть только node.

export const AGENT_SOURCE = String.raw`
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const P = '@@CX ';
const CHUNK = 3000;
const out = line => process.stdout.write(P + line + '\n');
const b64 = buf => Buffer.from(buf).toString('base64');
let child = null, header = null, putParts = [], lastSeen = Date.now(), seq = 0, exiting = false;
const fail = msg => { out('F ' + b64(String(msg).slice(0, 2000))); finish(70); };
function finish(code) {
  if (exiting) return; exiting = true;
  process.stdout.write('', () => process.exit(code));
  setTimeout(() => process.exit(code), 2000).unref();
}
process.on('uncaughtException', e => fail('agent: ' + (e && e.message || e)));
if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(true);
function sessionFile(cwd, id) {
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(base, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), id + '.jsonl');
}
// Под root Claude не принимает --dangerously-skip-permissions. Штатный мост BB
// на такой машине сам ставит permission-mode default (разрешения тогда идут
// через can_use_tool и одобряются мостом) — делаем так же.
function rootSafeArgs(args) {
  if (!(process.getuid && process.getuid() === 0) || process.env.IS_SANDBOX) return args;
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--allow-dangerously-skip-permissions' || a === '--dangerously-skip-permissions') continue;
    if (a === '--permission-mode=bypassPermissions') { out.push('--permission-mode=default'); continue; }
    if (a === '--permission-mode' && args[i + 1] === 'bypassPermissions') { out.push(a, 'default'); i += 1; continue; }
    out.push(a);
  }
  return out;
}
// Окружение CLI ступени: из окружения терминала BB этой машины остаются только
// её собственный адрес сервера и путь bb (BB_SERVER_URL, BB_CLI,
// BB_HOST_DAEMON_PORT); тред (BB_THREAD_ID, BB_PROJECT_ID, BB_ENVIRONMENT_ID)
// приходит от запускателя. Хранилище треда — папка этой машины:
// <данные BB>/thread-storage/<тред> (данные BB — по пути bb, иначе ~/.bb).
const MACHINE_BB = new Set(['BB_SERVER_URL', 'BB_CLI', 'BB_HOST_DAEMON_PORT']);
function bbDataDir(env) {
  const m = /^(.*)[\/]npm[\/]lib[\/]node_modules[\/]/.exec(env.BB_CLI || '');
  return m ? m[1] : path.join(os.homedir(), '.bb');
}
function stageEnv(base, extra) {
  const env = {};
  for (const [k, v] of Object.entries(base)) if (!/^(BB_|CASCADE_)/.test(k) || MACHINE_BB.has(k)) env[k] = v;
  for (const [k, v] of Object.entries(extra)) if (!MACHINE_BB.has(k)) env[k] = v;
  delete env.BB_THREAD_STORAGE;
  if (env.BB_THREAD_ID && /^thr_[a-z0-9]+$/.test(env.BB_THREAD_ID)) {
    const dir = path.join(bbDataDir(env), 'thread-storage', env.BB_THREAD_ID);
    try { fs.mkdirSync(dir, { recursive: true }); env.BB_THREAD_STORAGE = dir; } catch {}
  }
  return env;
}
function start() {
  const h = header;
  if (!fs.existsSync(h.cwd)) return fail('нет папки ' + h.cwd + ' на этой машине');
  if (h.sessionPut && h.sessionId) {
    const data = zlib.gunzipSync(Buffer.concat(putParts));
    const sha = crypto.createHash('sha256').update(data).digest('hex');
    if (sha !== h.sessionPut.sha256) return fail('файл сессии повреждён при передаче');
    const file = sessionFile(h.cwd, h.sessionId);
    // Файл сессии только дописывается. Если здесь уже лежит его продолжение
    // (идёт ход этой же сессии, а пришла проба моста со старой копией) — не трогаем.
    let current = null;
    try { current = fs.readFileSync(file); } catch {}
    const extendsPut = current && current.length >= data.length && current.subarray(0, data.length).equals(data);
    if (!extendsPut) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.cascade-' + process.pid;
      fs.writeFileSync(tmp, data, { mode: 0o600 });
      fs.renameSync(tmp, file);
    }
  }
  putParts = [];
  child = spawn(h.command, rootSafeArgs(h.args), { cwd: h.cwd, env: stageEnv(process.env, h.env || {}), stdio: ['pipe', 'pipe', 'pipe'] });
  child.on('error', e => fail('не удалось запустить ' + h.command + ': ' + e.message));
  child.stdout.on('data', d => { for (let i = 0; i < d.length; i += CHUNK) out('O ' + (seq++) + ' ' + b64(d.subarray(i, i + CHUNK))); });
  child.stderr.on('data', d => { for (let i = 0; i < d.length; i += CHUNK) out('E ' + b64(d.subarray(i, i + CHUNK))); });
  child.stdin.on('error', () => {});
  child.on('close', (code, signal) => {
    if (h.sessionGet && h.sessionId) {
      const file = sessionFile(h.cwd, h.sessionId);
      let data = null;
      try { data = fs.readFileSync(file); } catch {}
      if (data) {
        const z = zlib.gzipSync(data);
        for (let i = 0; i < z.length; i += CHUNK) out('S ' + b64(z.subarray(i, i + CHUNK)));
        out('SE ' + crypto.createHash('sha256').update(data).digest('hex'));
      } else out('SE none');
    }
    out('X ' + (code === null ? '-' : code) + ' ' + (signal || '-'));
    finish(0);
  });
}
let rest = '';
process.stdin.on('data', chunk => {
  lastSeen = Date.now();
  rest += chunk.toString('latin1');
  const lines = rest.split(/\r?\n|\r/);
  rest = lines.pop();
  for (const raw of lines) {
    const i = raw.indexOf(P);
    if (i === -1) continue;
    const [type, a] = raw.slice(i + P.length).split(' ');
    if (type === 'B') { header = JSON.parse(Buffer.from(a, 'base64').toString('utf8')); }
    else if (type === 'P') putParts.push(Buffer.from(a, 'base64'));
    else if (type === 'G') { if (header && !child) start(); }
    else if (type === 'I') { if (child) child.stdin.write(Buffer.from(a, 'base64')); }
    else if (type === 'C') { if (child) child.stdin.end(); }
    else if (type === 'K') { if (child) child.kill(a || 'SIGTERM'); else finish(0); }
  }
});
process.stdin.on('end', () => { if (child) child.kill('SIGTERM'); else finish(0); });
setInterval(() => {
  out('H');
  const limit = header && header.watchdogMs || 120000;
  if (Date.now() - lastSeen > limit) {
    if (child) { child.kill('SIGTERM'); setTimeout(() => child && child.kill('SIGKILL'), 5000).unref(); }
    else fail('запускатель пропал');
  }
}, 5000);
out('R 1');
`;

/** argv терминала BB для запуска агента в логин-оболочке машины ступени. */
export function agentArgv(): string[] {
  return ['sh', '-lc', 'exec node -e "$1"', 'cascade-agent', AGENT_SOURCE];
}
