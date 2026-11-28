// Реле app-server Codex: пути машины треда → путь ступени и обратно, синхронизация на каждый ход.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { rewriteLine, startCodexRelay } from './codex-relay.ts';

const BRIDGE = '/root/.bb-machines/x/worktrees/thr_s3-1/bb-config';
const STAGE = '/opt/bbfs/bb-config-w1a2b3c4d';

test('пути: initialize, thread/start, turn/start → путь ступени; ответы — обратно', () => {
  const start = JSON.parse(rewriteLine(JSON.stringify({ id: 1, method: 'thread/start', params: { cwd: BRIDGE, sandbox: { writableRoots: [`${BRIDGE}/.git`] } } }), BRIDGE, STAGE));
  assert.equal(start.params.cwd, STAGE);
  assert.deepEqual(start.params.sandbox.writableRoots, [`${STAGE}/.git`]);
  const back = JSON.parse(rewriteLine(JSON.stringify({ method: 'item/completed', params: { item: { command: `cat ${STAGE}/README.md`, cwd: STAGE } } }), STAGE, BRIDGE));
  assert.equal(back.params.item.cwd, BRIDGE);
  assert.equal(back.params.item.command, `cat ${BRIDGE}/README.md`);
  assert.equal(rewriteLine('{"a":1}', null, STAGE), '{"a":1}');
});

test('реле: первый ход подготовлен маршрутом; после turn/completed — возврат на опору; следующий turn/start — подготовка; отказ подготовки — ошибка мосту', async () => {
  const stdin = new PassThrough();
  const toChild: string[] = [];
  const toBridge: string[] = [];
  const order: string[] = [];
  let prepareOk = true;
  const relay = startCodexRelay({
    stdin, toChild: l => { toChild.push(l); order.push(`child:${JSON.parse(l).method ?? JSON.parse(l).id}`); }, endChild: () => {}, toBridge: l => { toBridge.push(l); },
    bridgeCwd: BRIDGE, stageCwd: STAGE,
    prepare: async () => { order.push('prepare'); return prepareOk ? { ok: true, message: '' } : { ok: false, message: 'Ход не запущен: синхронизация Mac: конфликт' }; },
    finish: async () => { order.push('finish'); },
    log() {},
  });
  const send = (m: unknown) => stdin.write(`${JSON.stringify(m)}\n`);
  const tick = () => new Promise(r => setTimeout(r, 15));
  send({ id: 1, method: 'thread/start', params: { cwd: BRIDGE } }); await tick();
  send({ id: 2, method: 'turn/start', params: { cwd: BRIDGE } }); await tick();
  assert.equal(JSON.parse(toChild[0]!).params.cwd, STAGE);
  relay.onChildLine(JSON.stringify({ method: 'turn/completed', params: { cwd: STAGE } })); await tick();
  assert.equal(JSON.parse(toBridge.at(-1)!).params.cwd, BRIDGE);
  send({ id: 3, method: 'turn/start', params: {} }); await tick();
  relay.onChildLine(JSON.stringify({ method: 'turn/completed', params: {} })); await tick();
  prepareOk = false;
  send({ id: 4, method: 'turn/start', params: {} }); await tick();
  stdin.end();
  await relay.pump;
  assert.deepEqual(order, ['child:thread/start', 'child:turn/start', 'finish', 'prepare', 'child:turn/start', 'finish', 'prepare']);
  const refused = JSON.parse(toBridge.at(-1)!);
  assert.equal(refused.id, 4);
  assert.match(refused.error.message, /конфликт/u);
});
