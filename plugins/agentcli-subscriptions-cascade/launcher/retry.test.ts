// Отказ каскада в штатной форме CLI: автоповтор BB вместо «напишите ещё раз» (S3, S7),
// модель недоступна на тарифе (S7 Fable) — попытка снимается, ход повторяется дальше.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { MODEL_UNAVAILABLE, runSessionRelay, syntheticRefusal } from './session-relay.ts';
import { limitFromClaudeLine } from './main.ts';

const SID = '34dcc236-1111-4222-8333-444455556666';
type Route = { action: 'run'; stepId: string; hostId: string; providerId: string; modelId: string | null; local: boolean; cwd: string | null; env: Record<string, string>; stage: { machine: string }; notes: never[] };
const mk = (id: string, modelId: string | null = null): Route => ({ action: 'run', stepId: id, hostId: id, providerId: 'claude-code', modelId, local: true, cwd: null, env: {}, stage: { machine: id }, notes: [] });

test('синтетический отказ: limit — rate_limit_event + result 429 (provider-retry спросит доступность), overload — result 529', () => {
  const limit = syntheticRefusal('limit', 'Переход на Codex', SID, 1_000_000).map(l => JSON.parse(l));
  assert.equal(limit[0].type, 'rate_limit_event');
  assert.equal(limit[0].rate_limit_info.status, 'rejected');
  assert.deepEqual([limit[1].type, limit[1].is_error, limit[1].api_error_status, limit[1].session_id], ['result', true, 429, SID]);
  const over = syntheticRefusal('overload', 'Плагин обновился', null, 0).map(l => JSON.parse(l));
  assert.deepEqual([over.length, over[0].api_error_status], [1, 529]);
});

function relay(opts: { route: () => Promise<unknown>; first?: Route; pendingRefusal?: { kind: 'limit' | 'overload'; message: string }; reply?: (line: string, onLine: (l: string) => void) => void; markModel?: (r: Route, reason: string) => Promise<void> }) {
  const out: string[] = [];
  const toChild: string[] = [];
  const stdin = new PassThrough();
  const done = runSessionRelay(opts.first ?? mk('tru'), ['--input-format', 'stream-json', `--session-id=${SID}`], SID, {
    start(_r, _a, onLine) {
      let resolveDone!: (v: { code: number; transportError: null }) => void;
      const finished = new Promise<{ code: number; transportError: null }>(r => { resolveDone = r; });
      return { write(line) { toChild.push(line); opts.reply?.(line, onLine); }, end() { resolveDone({ code: 0, transportError: null }); }, kill() {}, done: finished };
    },
    routeTurn: opts.route as never,
    finishTurn: async () => {}, feed: async () => {}, limitFromLine: limitFromClaudeLine,
    ...(opts.markModel ? { markModelUnavailable: opts.markModel as never } : {}),
    stdin, stdout: { write: (d: string) => { out.push(d.trim()); } }, stderr: { write() {} }, now: () => 1_000_000, log() {},
  }, { pendingRefusal: opts.pendingRefusal ?? null });
  return { out, toChild, stdin, done };
}
const user = (text: string) => `${JSON.stringify({ type: 'user', message: { content: text } })}\n`;
const tick = () => new Promise(r => setTimeout(r, 25));

test('S3: «Да» → ступень Codex в ходе Claude — штатный автоповтор, сессия живёт, CLI сообщение не получает', async () => {
  const r = relay({
    route: async () => ({ action: 'refuse', retryable: true, retryAs: 'limit', message: 'Переход на Codex · Mac: ход повторится автоматически уже на Codex.', notes: [] }),
    reply: (line, onLine) => { if (JSON.parse(line).type === 'user') setTimeout(() => onLine(JSON.stringify({ type: 'result' })), 5); },
  });
  r.stdin.write(user('ход 1')); await tick();
  r.stdin.write(user('ход 2')); await tick();
  r.stdin.end();
  assert.equal(await r.done, 0, 'процесс не падает с 75');
  assert.equal(r.toChild.filter(l => l.includes('ход 2')).length, 0, 'сообщение не ушло в CLI Claude');
  const tail = r.out.slice(-2).map(l => JSON.parse(l));
  assert.deepEqual([tail[0].type, tail[1].api_error_status], ['rate_limit_event', 429]);
});

test('первое сообщение с отказом-автоповтором (плагин обновился) — штатный ответ, следующее идёт по каскаду', async () => {
  const r = relay({
    first: mk(''), pendingRefusal: { kind: 'overload', message: 'Плагин «Каскад подписок» обновился — ход повторится автоматически на новой версии.' },
    route: async () => mk(''), reply: (line, onLine) => { if (JSON.parse(line).type === 'user') setTimeout(() => onLine(JSON.stringify({ type: 'result' })), 5); },
  });
  r.stdin.write(user('ход 1')); await tick();
  r.stdin.write(user('повтор')); await tick();
  r.stdin.end();
  await r.done;
  assert.equal(JSON.parse(r.out[0]!).api_error_status, 529);
  assert.ok(r.toChild.some(l => l.includes('повтор')), 'повтор пошёл в CLI');
  assert.equal(r.toChild.some(l => l.includes('ход 1')), false);
});

test('S7: «Fable 5.2 requires usage credits» — попытка снята до ответа мосту, ход отдан как лимит', async () => {
  assert.ok(MODEL_UNAVAILABLE.test('Fable 5.2 requires usage credits. Add credits to continue.'));
  assert.ok(MODEL_UNAVAILABLE.test("You don't have access to the model claude-fable-5-2"));
  assert.equal(MODEL_UNAVAILABLE.test('weekly limit reached'), false);
  const order: string[] = [];
  const r = relay({
    first: mk('ua', 'claude-fable-5-2'),
    route: async () => mk('ua', 'claude-fable-5-2'),
    reply: (line, onLine) => { if (JSON.parse(line).type === 'user') setTimeout(() => onLine(JSON.stringify({ type: 'result', is_error: true, result: 'Fable 5.2 requires usage credits' })), 5); },
    markModel: async (route, reason) => { await tick(); order.push(`mark:${route.modelId}:${reason.slice(0, 20)}`); },
  });
  r.stdin.write(user('ход')); await new Promise(res => setTimeout(res, 80));
  r.stdin.end();
  await r.done;
  assert.deepEqual(order, ['mark:claude-fable-5-2:Fable 5.2 requires u']);
  const last = r.out.slice(-2).map(l => JSON.parse(l));
  assert.deepEqual([last[0].type, last[1].api_error_status], ['rate_limit_event', 429]);
});

test('S7 (vclaude): «API Error: 402 … доступен только в тарифе VClaude Ultra 200» — модель недоступна, ход отдан как лимит', async () => {
  const gw = 'API Error: 402 Claude Fable доступен только в тарифе VClaude Ultra 200. Смените тариф или выберите другую модель.';
  assert.ok(MODEL_UNAVAILABLE.test(gw));
  assert.ok(MODEL_UNAVAILABLE.test('Модель недоступна на вашем тарифе'));
  assert.equal(MODEL_UNAVAILABLE.test('API Error: 429 rate limit'), false, 'лимит окна — не «недоступна»');
  assert.equal(MODEL_UNAVAILABLE.test('API Error: 4021 something'), false);
  const order: string[] = [];
  const r = relay({
    first: mk('mac', 'claude-fable-5-1'),
    route: async () => mk('mac', 'claude-fable-5-1'),
    reply: (line, onLine) => { if (JSON.parse(line).type === 'user') setTimeout(() => onLine(JSON.stringify({ type: 'result', is_error: true, result: gw })), 5); },
    markModel: async (route, reason) => { await tick(); order.push(`mark:${route.modelId}:${reason.slice(0, 14)}`); },
  });
  r.stdin.write(user('ход')); await new Promise(res => setTimeout(res, 80));
  r.stdin.end();
  await r.done;
  assert.deepEqual(order, ['mark:claude-fable-5-1:API Error: 402']);
  const last = r.out.slice(-2).map(l => JSON.parse(l));
  assert.deepEqual([last[0].type, last[1].api_error_status], ['rate_limit_event', 429]);
});

test('Codex: запускатель всегда отдаёт codex подкоманду app-server (без неё — TUI, «stdin is not a terminal»)', async () => {
  const { codexAppServerArgs } = await import('./main.ts');
  assert.deepEqual(codexAppServerArgs([]), ['app-server']);
  assert.deepEqual(codexAppServerArgs(['-c', 'x=1']), ['app-server', '-c', 'x=1']);
  assert.deepEqual(codexAppServerArgs(['app-server', '--listen', 'stdio://']), ['app-server', '--listen', 'stdio://']);
});

test('S3 на новом треде: ступень и карточка — на первом сообщении (ход идёт), а не при старте процесса (thread.start)', async () => {
  let routed = 0;
  const started: string[] = [];
  const stdin = new PassThrough();
  const done = runSessionRelay(mk(''), ['--input-format', 'stream-json', `--session-id=${SID}`], SID, {
    start(r, _a, onLine) {
      started.push(r.hostId || 'начало сессии');
      let resolveDone!: (v: { code: number; transportError: null }) => void;
      const finished = new Promise<{ code: number; transportError: null }>(res => { resolveDone = res; });
      return { write(line) { const m = JSON.parse(line); if (m.type === 'control_request') onLine(JSON.stringify({ type: 'control_response', response: { request_id: m.request_id } })); if (m.type === 'user') setTimeout(() => onLine(JSON.stringify({ type: 'result' })), 5); }, end() { resolveDone({ code: 0, transportError: null }); }, kill() {}, done: finished };
    },
    routeTurn: async () => { routed += 1; return mk('ua'); },
    finishTurn: async () => {}, feed: async () => {}, limitFromLine: () => null,
    stdin, stdout: { write() {} }, stderr: { write() {} }, now: () => 0, log() {},
  }, { routeFirst: true });
  stdin.write(`${JSON.stringify({ type: 'control_request', request_id: 'init', request: { subtype: 'initialize' } })}\n`);
  await tick();
  assert.equal(routed, 0, 'при старте сессии ступень не выбирается');
  stdin.write(user('первый ход')); await tick();
  stdin.end();
  await done;
  assert.equal(routed, 1, 'выбор — на первом сообщении');
  assert.deepEqual(started, ['начало сессии', 'ua']);
});
