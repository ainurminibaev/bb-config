// Запускатель: кадры, аргументы CLI, агент и удалённый запуск через фальшивый
// терминал (агент — настоящий node-процесс, CLI — node-скрипт), запуск целиком
// с фальшивым сервером каскада.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { AGENT_SOURCE } from './agent-source.ts';
import { claudeSessionInfo, claudeSessionPath, encodeClaudeProjectDir, remoteArgs, remoteEnv, replaceModel } from './cli-args.ts';
import { limitFromClaudeLine, runLauncher } from './main.ts';
import { chunkFrames, encodeClientFrame, LineSplitter, parseAgentLine } from './protocol.ts';
import { RemoteRunError, runRemote } from './remote.ts';
import { TerminalApiError, type TerminalApi, type TerminalOutput } from './terminal-api.ts';

const SID = '34dcc236-1111-4222-8333-444455556666';

test('кадры: разбор с \\r, мусор PTY, base64, порядок кусков', () => {
  assert.deepEqual(parseAgentLine('@@CX R 1\r'), { type: 'R', version: 1 });
  const o = parseAgentLine(`login banner @@CX O 5 ${Buffer.from('{"a":1}\n').toString('base64')}\r`);
  assert.equal(o?.type, 'O');
  assert.equal(o?.type === 'O' && o.data.toString(), '{"a":1}\n');
  assert.equal(parseAgentLine('просто строка оболочки'), null);
  assert.equal(parseAgentLine('@@CX O x !!!'), null);
  assert.deepEqual(parseAgentLine('@@CX X 3 -'), { type: 'X', code: 3, signal: null });
  assert.deepEqual(parseAgentLine('@@CX X - SIGTERM'), { type: 'X', code: null, signal: 'SIGTERM' });
  const frames = chunkFrames('I', Buffer.alloc(7000, 97), 3000);
  assert.equal(frames.length, 3);
  assert.ok(frames.every(f => f.startsWith('@@CX I ') && f.endsWith('\n')));
  const split = new LineSplitter();
  assert.deepEqual(split.push('ab'), []);
  assert.deepEqual(split.push('c\r\nde\n'), ['abc\r', 'de']);
  assert.equal(encodeClientFrame('C'), '@@CX C\n');
});

test('аргументы Claude: сессия, модель ступени, локальные флаги и окружение не уезжают', () => {
  assert.deepEqual(claudeSessionInfo(['-p', `--resume=${SID}`, '--permission-mode=default']), { sessionId: SID, resumes: true, ephemeral: false });
  assert.deepEqual(claudeSessionInfo(['--session-id', SID]), { sessionId: SID, resumes: false, ephemeral: false });
  assert.equal(claudeSessionInfo(['--resume', SID, '--fork-session', '--no-session-persistence']).ephemeral, true);
  assert.equal(encodeClaudeProjectDir('/opt/bbfs/my.proj'), '-opt-bbfs-my-proj');
  assert.equal(claudeSessionPath('/opt/bbfs/p', SID, { HOME: '/root' }), `/root/.claude/projects/-opt-bbfs-p/${SID}.jsonl`);
  assert.equal(claudeSessionPath('/opt/bbfs/p', SID, { CLAUDE_CONFIG_DIR: '/c' }), `/c/projects/-opt-bbfs-p/${SID}.jsonl`);
  // «auto» — ID профиля каскада, CLI его не знает: заменяется моделью ступени или убирается.
  assert.deepEqual(replaceModel(['-p', '--model', 'auto', '--verbose'], 'opus55'), ['-p', '--verbose', '--model', 'opus55']);
  assert.deepEqual(replaceModel(['--model=auto'], null), []);
  const { args, dropped } = remoteArgs(['-p', '--mcp-config', '/tmp/x.json', '--settings={"a":1}', '--strict-mcp-config', '--model', 'm']);
  assert.deepEqual(args, ['-p', '--model', 'm']);
  assert.deepEqual(dropped, ['--mcp-config', '--settings', '--strict-mcp-config']);
  const env = remoteEnv({ CLAUDE_CODE_ENTRYPOINT: 'sdk', CLAUDE_CODE_OAUTH_TOKEN: 'secret', ANTHROPIC_BASE_URL: 'https://gw', MAX_THINKING_TOKENS: '100', HOME: '/x', BB_THREAD_ID: 't' });
  assert.deepEqual(env, { CLAUDE_CODE_ENTRYPOINT: 'sdk', MAX_THINKING_TOKENS: '100' });
});

test('событие лимита Claude: rejected со сбросом в мс', () => {
  const line = JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1_800_000_000, rateLimitType: 'five_hour' } });
  assert.deepEqual({ ...limitFromClaudeLine(line), raw: undefined }, { status: 'rejected', resetsAt: 1_800_000_000_000, windowType: 'five_hour', raw: undefined });
  assert.equal(limitFromClaudeLine('{"type":"assistant"}'), null);
});

// ---- Фальшивый терминал BB: агент — настоящий процесс node, вывод — куски с seq ----

interface FakeTerminal { child: ChildProcess; chunks: Buffer[]; exited: boolean; exitCode: number | null }

function fakeTerminalApi(env: NodeJS.ProcessEnv, faults: { failOutput?: number; truncate?: boolean } = {}): TerminalApi & { terminals: Map<string, FakeTerminal>; created: string[] } {
  const terminals = new Map<string, FakeTerminal>();
  const created: string[] = [];
  let failures = faults.failOutput ?? 0;
  return {
    terminals, created,
    async create({ id, cwd, argv }) {
      created.push(id);
      assert.equal(argv[0], 'sh');
      // Как в PTY, но без него: node -e <агент>, stdout — куски по мере записи.
      const child = spawn(process.execPath, ['-e', AGENT_SOURCE], { cwd: existsSync(cwd) ? cwd : undefined, env, stdio: ['pipe', 'pipe', 'inherit'] });
      const t: FakeTerminal = { child, chunks: [], exited: false, exitCode: null };
      child.stdout!.on('data', (d: Buffer) => t.chunks.push(d));
      child.on('exit', code => { t.exited = true; t.exitCode = code; });
      terminals.set(id, t);
      return { id };
    },
    async input(id, data) { terminals.get(id)!.child.stdin!.write(data); },
    async output(id, sinceSeq): Promise<TerminalOutput> {
      if (failures > 0) { failures -= 1; throw new TerminalApiError('HTTP 504', 504, null); }
      const t = terminals.get(id)!;
      const chunks = t.chunks.slice(sinceSeq).map((d, i) => ({ seq: sinceSeq + i, dataBase64: d.toString('base64') }));
      return { chunks, nextSeq: t.chunks.length, truncated: Boolean(faults.truncate), status: t.exited ? 'exited' : 'running', exitCode: t.exitCode };
    },
    async close(id) { const t = terminals.get(id); if (t && !t.exited) t.child.kill(); },
  };
}

/** Фальшивый claude: эхо stdin, дописывает строку в файл сессии, код выхода 3. */
function fakeClaude(dir: string): string {
  const path = join(dir, 'claude');
  writeFileSync(path, `#!/bin/sh\nexec '${process.execPath}' '${join(dir, 'claude.cjs')}' "$@"\n`);
  writeFileSync(join(dir, 'claude.cjs'), `const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2);
const sid = (args.find(a => a.startsWith('--resume=')) || '').slice(9);
const file = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'), sid + '.jsonl');
let input = '';
process.stdin.on('data', d => { input += d; if (input.includes('\\n')) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  fs.writeFileSync(file, before + JSON.stringify({ turn: input.trim() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'result', echo: input.trim(), args, model: args[args.indexOf('--model') + 1] ?? null, sawEnv: process.env.CLAUDE_CODE_ENTRYPOINT ?? null }) + '\\n');
  process.stderr.write('warn\\n');
  process.exit(3);
} });
`);
  chmodSync(path, 0o755);
  return path;
}

function remoteFixture() {
  // Реальный путь: Claude видит cwd без symlink (/tmp → /private/tmp на macOS).
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cascade-remote-')));
  const bin = join(root, 'bin');
  const cwd = join(root, 'proj');
  const remoteConfig = join(root, 'remote-claude');
  mkdirSync(bin); mkdirSync(cwd);
  fakeClaude(bin);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CLAUDE_CONFIG_DIR: remoteConfig, BB_THREAD_ID: 'должна-исчезнуть' };
  return { root, cwd, remoteConfig, env };
}

const collect = () => { const parts: Buffer[] = []; return { parts, write(d: Buffer | string) { parts.push(Buffer.from(d)); }, text: () => Buffer.concat(parts).toString() }; };

test('удалённый запуск: поток stdout/stderr, код выхода, файл сессии туда и обратно, обрыв опроса', async () => {
  const fx = remoteFixture();
  const api = fakeTerminalApi(fx.env, { failOutput: 2 });
  const stdin = new PassThrough();
  const stdout = collect();
  const stderr = collect();
  let returned: Buffer | null = null;
  const put = Buffer.from('{"turn":"ранее на Tru"}\n');
  setTimeout(() => stdin.write('привет\n'), 50);
  const result = await runRemote({
    api, hostId: 'host_ua', cwd: fx.cwd, command: 'claude', args: [`--resume=${SID}`, '--model', 'claude-opus-5-5'],
    env: { CLAUDE_CODE_ENTRYPOINT: 'cascade' }, session: { id: SID, put, get: true },
    stdin, stdout, stderr, onSession: data => { returned = data; }, pollMs: 10, idlePollMs: 20, sleep: ms => new Promise(r => setTimeout(r, Math.min(ms, 20))),
  });
  assert.equal(result.code, 3, stderr.text());
  const line = JSON.parse(stdout.text().trim()) as { echo: string; model: string; sawEnv: string };
  assert.equal(line.echo, 'привет');
  assert.equal(line.model, 'claude-opus-5-5');
  assert.equal(line.sawEnv, 'cascade');
  assert.match(stderr.text(), /warn/u);
  // На машине ступени файл сессии лёг по пути её ~/.claude, после хода вернулся дополненным.
  const remoteFile = claudeSessionPath(fx.cwd, SID, { CLAUDE_CONFIG_DIR: fx.remoteConfig });
  assert.ok(readFileSync(remoteFile, 'utf8').startsWith('{"turn":"ранее на Tru"}'));
  assert.equal(String(returned), readFileSync(remoteFile, 'utf8'));
  assert.equal(String(returned).trim().split('\n').length, 2);
});

test('удалённый запуск: нет папки на машине ступени — авария агента, усечённая прокрутка — авария канала', async () => {
  const fx = remoteFixture();
  await assert.rejects(runRemote({
    api: fakeTerminalApi(fx.env), hostId: 'h', cwd: join(fx.root, 'нет-такой'), command: 'claude', args: [], env: {}, session: null,
    stdin: new PassThrough(), stdout: collect(), stderr: collect(), pollMs: 10, idlePollMs: 20,
  }), (error: unknown) => error instanceof RemoteRunError && error.kind === 'agent' && /нет папки/u.test(error.message));
  await assert.rejects(runRemote({
    api: fakeTerminalApi(fx.env, { truncate: true }), hostId: 'h', cwd: fx.cwd, command: 'claude', args: [], env: {}, session: null,
    stdin: new PassThrough(), stdout: collect(), stderr: collect(), pollMs: 10, idlePollMs: 20,
  }), (error: unknown) => error instanceof RemoteRunError && error.kind === 'transport');
});

// ---- Запускатель целиком: фальшивый сервер каскада, локальная ступень ----

function fakeServer(route: unknown) {
  const calls: { method: string; input: Record<string, unknown> }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const method = String(url).split('/rpc/')[1]!;
    const input = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ method, input });
    const result = method === 'routeTurn' ? route : { notes: [] };
    return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

test('запускатель: локальная ступень — модель ступени, итог с событием лимита', async () => {
  const fx = remoteFixture();
  const bin = join(fx.root, 'bin2');
  mkdirSync(bin);
  writeFileSync(join(bin, 'claude'), `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({type:'rate_limit_event',rate_limit_info:{status:'rejected',resetsAt:1800000000}})+'\\n'+JSON.stringify({args:process.argv.slice(2), cascade: Object.keys(process.env).filter(k=>k.startsWith('CASCADE_'))})+'\\n');\n`);
  chmodSync(join(bin, 'claude'), 0o755);
  const server = fakeServer({ action: 'run', stepId: 's1', hostId: 'host_tru', providerId: 'claude-code', modelId: 'claude-opus-5-5', local: true, cwd: null, env: {}, stage: { machine: 'Tru' }, notes: [] });
  const out = collect();
  const code = await runLauncher({
      env: { PATH: `${bin}:/usr/bin:/bin`, BB_THREAD_ID: 'thr_x', BB_PROJECT_ID: 'proj_1', BB_SERVER_URL: 'http://bb.test', CASCADE_LAUNCHER_PROVIDER: 'claude-code' },
      argv: ['-p', '--model', 'auto', '--output-format', 'stream-json'], cwd: fx.cwd, fetch: server.fetchImpl,
      stdin: new PassThrough(), stdout: out, stderr: collect(), now: Date.now,
  });
  assert.equal(code, 0);
  const printed = out.text().trim().split('\n').map(l => JSON.parse(l) as { args?: string[]; cascade?: string[] });
  assert.deepEqual(printed[1]!.args, ['-p', '--output-format', 'stream-json', '--model', 'claude-opus-5-5']);
  assert.deepEqual(printed[1]!.cascade, []);
  assert.deepEqual(server.calls.map(c => c.method), ['routeTurn', 'finishTurn']);
  assert.equal(server.calls[0]!.input.requestedModel, 'auto');
  const limits = server.calls[1]!.input.limits as { status: string; resetsAt: number }[];
  assert.equal(limits[0]!.status, 'rejected');
  assert.equal(limits[0]!.resetsAt, 1_800_000_000_000);
});

test('запускатель: отказ каскада — понятный текст и код 75 для повторяемого', async () => {
  const server = fakeServer({ action: 'refuse', message: 'Лимиты исчерпаны на всех ступенях — жду сброса.', retryable: true, notes: [] });
  const err = collect();
  const code = await runLauncher({
    env: { BB_THREAD_ID: 'thr_x', BB_SERVER_URL: 'http://bb.test', PATH: '/usr/bin' }, argv: ['-p'], cwd: tmpdir(), fetch: server.fetchImpl,
    stdin: new PassThrough(), stdout: collect(), stderr: err, now: Date.now,
  });
  assert.equal(code, 75);
  assert.match(err.text(), /Каскад подписок: Лимиты исчерпаны/u);
});

// ---- Сессия stream-json: ступень между ходами ----

test('реле сессии: смена ступени между ходами, --resume, повтор начала сессии без лишних ответов мосту', async () => {
  const { runSessionRelay, resumeArgs } = await import('./session-relay.ts');
  assert.deepEqual(resumeArgs(['-p', `--session-id=${SID}`, '--model=auto'], SID), ['-p', '--model=auto', `--resume=${SID}`]);
  type Route = { action: 'run'; stepId: string; hostId: string; providerId: string; modelId: string | null; local: boolean; cwd: string | null; env: Record<string, string>; stage: { machine: string }; notes: never[] };
  const mk = (stepId: string, hostId: string, modelId: string | null): Route => ({ action: 'run', stepId, hostId, providerId: 'claude-code', modelId, local: hostId === 'mac', cwd: null, env: {}, stage: { machine: hostId }, notes: [] });
  const routes = [mk('ua', 'ua', 'claude-sonnet-5-5')];
  const children: { args: string[]; lines: string[]; ended: boolean; host: string }[] = [];
  const finished: string[] = [];
  const stdin = new PassThrough();
  const out: string[] = [];
  const relay = runSessionRelay(mk('mac', 'mac', null), ['--input-format', 'stream-json', `--session-id=${SID}`, '--model=auto'], SID, {
    start(route, args, onLine) {
      const record = { args, lines: [] as string[], ended: false, host: route.hostId };
      children.push(record);
      let resolveDone!: (v: { code: number; transportError: null }) => void;
      const done = new Promise<{ code: number; transportError: null }>(r => { resolveDone = r; });
      return {
        write(line) {
          record.lines.push(line);
          const m = JSON.parse(line) as { type: string; request_id?: string };
          if (m.type === 'control_request') onLine(JSON.stringify({ type: 'control_response', response: { request_id: m.request_id, subtype: 'success' } }));
          if (m.type === 'user') setTimeout(() => onLine(JSON.stringify({ type: 'result', on: route.hostId })), 5);
        },
        end() { record.ended = true; resolveDone({ code: 0, transportError: null }); },
        kill() { resolveDone({ code: 1, transportError: null }); },
        done,
      };
    },
    routeTurn: async () => routes.shift() ?? mk('ua', 'ua', 'claude-sonnet-5-5'),
    finishTurn: async route => { finished.push(route.hostId); },
    feed: async () => {},
    limitFromLine: () => null,
    stdin, stdout: { write: (d: string) => { out.push(d); } }, stderr: { write() {} }, now: Date.now, log() {},
  });
  stdin.write(`${JSON.stringify({ type: 'control_request', request_id: 'init-1', request: { subtype: 'initialize' } })}\n`);
  stdin.write(`${JSON.stringify({ type: 'user', message: { content: 'ход 1' } })}\n`);
  await new Promise(r => setTimeout(r, 40));
  stdin.write(`${JSON.stringify({ type: 'user', message: { content: 'ход 2' } })}\n`);
  await new Promise(r => setTimeout(r, 40));
  stdin.end();
  assert.equal(await relay, 0);
  assert.equal(children.length, 2);
  assert.equal(children[0]!.host, 'mac');
  assert.ok(children[0]!.ended);
  // Вторая ступень: продолжение той же сессии, модель ступени, повтор initialize.
  assert.deepEqual(children[1]!.args, ['--input-format', 'stream-json', `--resume=${SID}`, '--model', 'claude-sonnet-5-5']);
  assert.match(children[1]!.lines[0]!, /init-1/u);
  assert.match(children[1]!.lines[1]!, /ход 2/u);
  // Мост получил ровно один ответ на initialize и два result.
  const toBridge = out.map(l => JSON.parse(l) as { type: string; on?: string });
  assert.equal(toBridge.filter(m => m.type === 'control_response').length, 1);
  assert.deepEqual(toBridge.filter(m => m.type === 'result').map(m => m.on), ['mac', 'ua']);
  assert.deepEqual(finished, ['mac', 'ua']);
});

test('ID терминала — в алфавите BB (без 0, 1, l, o)', async () => {
  const { newTerminalId } = await import('./terminal-api.ts');
  for (let i = 0; i < 200; i += 1) assert.match(newTerminalId(), /^term_[23456789abcdefghijkmnpqrstuvwxyz]{10}$/u);
});

test('файл сессии: проба со старой копией не затирает продолжение на машине ступени', async () => {
  const fx = remoteFixture();
  const put = Buffer.from('{"turn":"ранее на Tru"}\n');
  const remoteFile = claudeSessionPath(fx.cwd, SID, { CLAUDE_CONFIG_DIR: fx.remoteConfig });
  mkdirSync(join(remoteFile, '..'), { recursive: true });
  writeFileSync(remoteFile, `${put}{"turn":"ход на UA"}\n`);
  const stdin = new PassThrough();
  setTimeout(() => stdin.write('проба\n'), 50);
  await runRemote({
    api: fakeTerminalApi(fx.env), hostId: 'h', cwd: fx.cwd, command: 'claude', args: [`--resume=${SID}`], env: {},
    session: { id: SID, put, get: false }, stdin, stdout: collect(), stderr: collect(), pollMs: 10, idlePollMs: 20,
  });
  const lines = readFileSync(remoteFile, 'utf8').trim().split('\n');
  assert.deepEqual(lines.slice(0, 2), ['{"turn":"ранее на Tru"}', '{"turn":"ход на UA"}']);
});
