// S4 на 0.2.9: пробы моста уходили на чужую ступень (ENOENT), процесс сессии умер,
// следующий ход ушёл в мёртвый поток и висел 30+ минут.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { probeArgs } from './cli-args.ts';
import { runSessionRelay, type StageChild } from './session-relay.ts';

const SID = '34dcc236-1111-4222-8333-444455556666';
type Route = { action: 'run'; stepId: string; hostId: string; providerId: string; modelId: string | null; local: boolean; cwd: string | null; env: Record<string, string>; stage: { machine: string }; notes: never[] };
const mk = (h: string): Route => ({ action: 'run', stepId: h, hostId: h, providerId: 'claude-code', modelId: null, local: false, cwd: '/opt/bbfs/p', env: {}, stage: { machine: h }, notes: [] });
const user = (t: string) => `${JSON.stringify({ type: 'user', message: { content: t } })}\n`;
const tick = (ms = 25) => new Promise(r => setTimeout(r, ms));

test('проба моста: файла сессии на машине моста нет — без --resume и --fork-session; есть — как есть', () => {
  const args = ['-p', '--resume', SID, '--fork-session', '--no-session-persistence', '--model', 'auto'];
  assert.deepEqual(probeArgs(args, () => false), ['-p', '--no-session-persistence', '--model', 'auto']);
  assert.deepEqual(probeArgs(args, () => true), args);
});

function relay(opts: { die?: 'mid' | 'between'; silent?: boolean; idleTimeoutMs?: number }) {
  const started: { args: string[]; host: string; killed: boolean }[] = [];
  const out: string[] = [];
  const finished: (string | null)[] = [];
  const stdin = new PassThrough();
  const done = runSessionRelay(mk('mac'), ['--input-format', 'stream-json', `--session-id=${SID}`], SID, {
    start(route, args, onLine): StageChild {
      const rec = { args, host: route.hostId, killed: false };
      started.push(rec);
      let resolveDone!: (v: { code: number; transportError: string | null }) => void;
      const finishedP = new Promise<{ code: number; transportError: string | null }>(r => { resolveDone = r; });
      const n = started.length;
      return {
        write(line) {
          if (JSON.parse(line).type !== 'user') return;
          if (opts.die === 'mid' && n === 1) { setTimeout(() => resolveDone({ code: 1, transportError: 'Terminal output is unavailable because the session is not running' }), 5); return; }
          if (opts.silent && n === 1) return; // CLI молчит
          setTimeout(() => {
            onLine(JSON.stringify({ type: 'result', n }));
            if (opts.die === 'between' && n === 1) setTimeout(() => resolveDone({ code: 1, transportError: 'session is not running' }), 5);
          }, 5);
        },
        end() { resolveDone({ code: 0, transportError: null }); },
        kill() { rec.killed = true; resolveDone({ code: 143, transportError: null }); },
        done: finishedP,
      };
    },
    routeTurn: async () => mk('mac'),
    sessionExists: () => true,
    finishTurn: async (_r, info) => { finished.push(info.transportError); },
    feed: async () => {}, limitFromLine: () => null,
    stdin, stdout: { write: (d: string) => { out.push(d.trim()); } }, stderr: { write() {} }, now: Date.now, log() {},
  }, { idleTimeoutMs: opts.idleTimeoutMs ?? 60_000 });
  return { started, out, finished, stdin, done };
}

test('процесс сессии умер между ходами — следующий ход поднимает его заново с --resume, а не пишет в мёртвый поток', async () => {
  const r = relay({ die: 'between' });
  r.stdin.write(user('ход 1')); await tick(60);
  r.stdin.write(user('ход 2')); await tick(60);
  r.stdin.end();
  await r.done;
  assert.equal(r.started.length, 2, 'процесс поднят заново');
  assert.ok(r.started[1]!.args.includes(`--resume=${SID}`), r.started[1]!.args.join(' '));
  assert.deepEqual(r.out.map(l => JSON.parse(l)).filter(m => m.type === 'result').map(m => m.n), [1, 2], 'ход 2 получил ответ');
});

test('процесс умер посреди хода — ход сразу завершается ошибкой (автоповтор), следующий ход — новый процесс', async () => {
  const r = relay({ die: 'mid' });
  r.stdin.write(user('ход 1')); await tick(40);
  const failed = r.out.map(l => JSON.parse(l)).find(m => m.type === 'result');
  assert.equal(failed?.api_error_status, 529, 'мост получил ошибку хода в форме перегрузки');
  assert.match(failed?.result ?? '', /session is not running/u);
  assert.match(String(r.finished[0]), /связь с машиной ступени/u);
  r.stdin.write(user('повтор')); await tick(40);
  r.stdin.end();
  await r.done;
  assert.equal(r.started.length, 2);
});

test('сторож хода: CLI молчит дольше порога — процесс остановлен, ход завершён ошибкой с причиной', async () => {
  const r = relay({ silent: true, idleTimeoutMs: 40 });
  r.stdin.write(user('ход 1')); await tick(120);
  assert.equal(r.started[0]!.killed, true, 'CLI остановлен');
  const failed = r.out.map(l => JSON.parse(l)).find(m => m.type === 'result');
  assert.equal(failed?.api_error_status, 529);
  assert.match(failed?.result ?? '', /нет событий от CLI ступени mac/u);
  assert.match(String(r.finished[0]), /нет событий/u);
  r.stdin.end();
  await r.done;
});
