// 0.3.2: фоновые задачи CLI (субагенты, фоновый Bash) доживают между ходами на чужой ступени.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { runSessionRelay } from './session-relay.ts';

const SID = '11111111-2222-3333-4444-555555555555';
type Route = { action: 'run'; stepId: string; hostId: string; providerId: string; modelId: string | null; local: boolean; cwd: string | null; env: Record<string, string>; stage: { machine: string }; notes: never[] };
const remote: Route = { action: 'run', stepId: 's', hostId: 'host_itab', providerId: 'claude-code', modelId: null, local: false, cwd: '/opt/bbfs/p', env: {}, stage: { machine: 'iTAB' }, notes: [] };
const tick = (ms: number) => new Promise(r => setTimeout(r, ms));

function harness(releaseAfterMs: number) {
  const received: string[] = [];
  const toBridge: Record<string, unknown>[] = [];
  let emit!: (o: unknown) => void;
  let ended = false; // у текущего (последнего запущенного) процесса
  let finished = 0;
  const stdin = new PassThrough();
  const relay = runSessionRelay({ ...remote, stepId: '' }, ['--input-format', 'stream-json', `--session-id=${SID}`], SID, {
    start(_r, _args, onLine) {
      emit = o => onLine(JSON.stringify(o));
      ended = false;
      let mine = false;
      let resolveDone!: (v: { code: number; transportError: null }) => void;
      const done = new Promise<{ code: number; transportError: null }>(r => { resolveDone = r; });
      return {
        write(line) { if (!mine) received.push(line); },
        end() { mine = true; ended = true; resolveDone({ code: 0, transportError: null }); },
        kill() { mine = true; ended = true; resolveDone({ code: 1, transportError: null }); },
        done,
      };
    },
    sessionExists: () => true,
    routeTurn: async () => remote,
    finishTurn: async () => { finished += 1; }, feed: async () => {}, limitFromLine: () => null,
    stdin, stdout: { write: (d: string) => { toBridge.push(JSON.parse(d) as Record<string, unknown>); } }, stderr: { write() {} }, now: Date.now, log() {},
  }, { routeFirst: true, releaseAfterMs });
  return { relay, stdin, received, toBridge, emit: (o: unknown) => emit(o), ended: () => ended, finished: () => finished };
}

test('фоновый субагент заканчивается после конца хода: CLI не отпущен, запрос разрешения и handback доходят, потом CLI отпускается', async () => {
  const h = harness(40);
  h.stdin.write('{"type":"user","message":{"content":"запусти двух субагентов в фоне"}}\n');
  await tick(10);
  h.emit({ type: 'system', subtype: 'task_started', task_id: 'a1', is_backgrounded: true, task_type: 'local_agent' });
  h.emit({ type: 'system', subtype: 'task_started', task_id: 'a2', is_backgrounded: true, task_type: 'local_agent' });
  h.emit({ type: 'result', subtype: 'success', is_error: false });
  await tick(120); // втрое дольше простоя — субагенты ещё работают
  assert.equal(h.ended(), false, 'CLI не отпущен, пока идут фоновые задачи');
  // Субагент спрашивает разрешение вне хода — запрос уходит мосту, ответ моста доходит до CLI.
  h.emit({ type: 'control_request', request_id: 'perm-1', request: { subtype: 'can_use_tool', tool_name: 'SubagentHandback' } });
  await tick(5);
  assert.ok(h.toBridge.some(m => m.type === 'control_request' && m.request_id === 'perm-1'), 'запрос разрешения — мосту');
  h.stdin.write('{"type":"control_response","response":{"request_id":"perm-1","subtype":"success","response":{"behavior":"allow"}}}\n');
  await tick(5);
  assert.ok(h.received.some(l => l.includes('perm-1') && l.includes('allow')), 'разрешение дошло до CLI');
  h.emit({ type: 'system', subtype: 'task_notification', task_id: 'a1', status: 'completed' });
  await tick(80);
  assert.equal(h.ended(), false, 'вторая задача ещё идёт');
  // Вторая задача закончилась — CLI сам ведёт ход с итогом (handback), он доходит до моста.
  h.emit({ type: 'system', subtype: 'task_notification', task_id: 'a2', status: 'completed' });
  h.emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'итог субагента a2' }] } });
  await tick(80);
  assert.equal(h.ended(), false, 'ход CLI по уведомлению не обрывается');
  h.emit({ type: 'result', subtype: 'success', is_error: false });
  assert.ok(h.toBridge.some(m => m.type === 'assistant' && JSON.stringify(m).includes('итог субагента a2')), 'handback — в тред');
  await tick(100);
  assert.equal(h.ended(), true, 'после всех фоновых задач — обычное отпускание');
  assert.equal(h.finished(), 1, 'ход CLI по уведомлению не считается ходом моста');
  h.stdin.end();
  await h.relay;
});

test('сообщение пользователя во время хода CLI по фоновой задаче ждёт его конца и идёт тому же процессу', async () => {
  const h = harness(40);
  h.stdin.write('{"type":"user","message":{"content":"ход 1"}}\n');
  await tick(10);
  h.emit({ type: 'system', subtype: 'task_started', task_id: 'b1', is_backgrounded: true });
  h.emit({ type: 'result', subtype: 'success', is_error: false });
  await tick(10);
  h.emit({ type: 'system', subtype: 'task_notification', task_id: 'b1', status: 'completed' });
  h.emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'по уведомлению' }] } });
  h.stdin.write('{"type":"user","message":{"content":"ход 2"}}\n');
  await tick(20);
  assert.ok(!h.received.some(l => l.includes('ход 2')), 'ждёт конца хода CLI');
  h.emit({ type: 'result', subtype: 'success', is_error: false });
  await tick(20);
  assert.ok(h.received.some(l => l.includes('ход 2')), 'после него — тому же процессу');
  assert.equal(h.ended(), false);
  h.emit({ type: 'result', subtype: 'success', is_error: false });
  h.stdin.end();
  await h.relay;
  assert.equal(h.finished(), 2);
});

test('без фоновых задач CLI на чужой ступени отпускается как прежде', async () => {
  const h = harness(30);
  h.stdin.write('{"type":"user","message":{"content":"ход"}}\n');
  await tick(10);
  h.emit({ type: 'result', subtype: 'success', is_error: false });
  await tick(80);
  assert.equal(h.ended(), true);
  h.stdin.end();
  await h.relay;
});
