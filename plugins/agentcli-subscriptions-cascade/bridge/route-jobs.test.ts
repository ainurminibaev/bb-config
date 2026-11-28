// 0.3.0 п.10: решение перед ходом по билету — подготовка дольше 300 с не рвёт запрос.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRouteJobs } from './route-jobs.ts';
import { routeByTicket } from '../launcher/main.ts';

test('билет: долгое решение — сначала pending, потом результат; ошибка и неизвестный билет — наружу', async () => {
  let n = 0;
  const jobs = createRouteJobs(async (ms: number) => { await new Promise(r => setTimeout(r, ms)); return { action: 'run', n: ++n }; }, { waitMs: 10, id: () => `t${n}` });
  const first = await jobs.start(60);
  assert.deepEqual(first, { action: 'pending', ticket: 't0' });
  assert.equal(jobs.size(), 1);
  let reply = await jobs.result('t0');
  while ('ticket' in reply) reply = await jobs.result(reply.ticket);
  assert.deepEqual(reply, { action: 'run', n: 1 });
  await assert.rejects(jobs.result('t0'), /неизвестно/u, 'забранный билет удалён');
  assert.deepEqual(await jobs.start(0), { action: 'run', n: 2 }, 'быстрое решение — сразу');
  const failing = createRouteJobs(async () => { throw new Error('синхронизация упала'); }, { waitMs: 50 });
  await assert.rejects(failing.start(null), /синхронизация упала/u);
});

test('запускатель: подготовка 6 минут (> 300 с undici) — опрос по билету, каждый запрос короткий, ход получает решение', async () => {
  let clock = 0;
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const run = { action: 'run', stepId: 's', hostId: 'h', providerId: 'claude-code', modelId: null, local: true, cwd: null, env: {}, stage: { machine: 'Mac' }, notes: [] };
  const fetchImpl = (async (url: string, init: { body: string }) => {
    const method = String(url).split('/').pop()!;
    calls.push({ method, body: JSON.parse(init.body) as Record<string, unknown> });
    clock += 60_000; // каждый запрос ждёт решения минуту
    const result = clock < 6 * 60_000 ? { action: 'pending', ticket: 'tk' } : run;
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  }) as unknown as typeof fetch;
  const io = { env: { BB_SERVER_URL: 'http://bb.test' }, fetch: fetchImpl, now: () => clock } as never;
  const route = await routeByTicket(io, { threadId: 'thr_1', cwd: '/p', provider: 'claude-code' });
  assert.equal(route.action, 'run');
  assert.equal(calls[0]!.method, 'routeTurn');
  assert.equal(calls[0]!.body.async, true);
  assert.ok(calls.slice(1).every(c => c.method === 'routeTurnResult' && c.body.ticket === 'tk'));
  assert.ok(clock >= 6 * 60_000, 'решение пришло позже 300 с');
  // Старый сервер флага не знает — отвечает решением сразу.
  const old = { env: { BB_SERVER_URL: 'http://bb.test' }, fetch: (async () => new Response(JSON.stringify({ ok: true, result: run }), { status: 200 })) as unknown as typeof fetch, now: () => 0 } as never;
  assert.equal((await routeByTicket(old, {})).action, 'run');
});
