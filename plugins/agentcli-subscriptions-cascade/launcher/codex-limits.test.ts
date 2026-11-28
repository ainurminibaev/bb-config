// 0.3.5: лимит Codex из хода (`account/rateLimits/updated` app-server) доходит до каскада.
// До 0.3.5 реле Codex его не передавало: квота Codex без опроса оставалась «неизвестной».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { limitFromCodexLine, startCodexRelay } from './codex-relay.ts';
import type { LimitObservation } from '../bridge/route-contract.ts';
import { codexEventReading } from '../adapters.ts';

const event = (primary: number, secondary: number, resetsAt = 1_800_000_000) => JSON.stringify({
  jsonrpc: '2.0', method: 'account/rateLimits/updated',
  params: { rateLimits: { primary: { usedPercent: primary, windowDurationMins: 300, resetsAt }, secondary: { usedPercent: secondary, windowDurationMins: 10_080, resetsAt: resetsAt + 100 } } },
});

test('разбор уведомления: окно ≥ 100 % — rejected до сброса этого окна; иначе allowed; чужие строки — null', () => {
  assert.deepEqual(limitFromCodexLine(event(40, 100)), {
    status: 'rejected', resetsAt: 1_800_000_100_000, windowType: 'codex-rate-limits',
    raw: { method: 'account/rateLimits/updated', params: { rateLimits: JSON.parse(event(40, 100)).params.rateLimits } },
  });
  assert.equal(limitFromCodexLine(event(10, 20))?.status, 'allowed');
  assert.equal(limitFromCodexLine('{"method":"turn/completed"}'), null);
  assert.equal(limitFromCodexLine('не json account/rateLimits/updated'), null);
  // raw понимает адаптер Codex монитора лимитов.
  const reading = codexEventReading({ hostId: 'h', provider: 'codex', profileRef: '*', bindingEpoch: 'e' } as never, limitFromCodexLine(event(40, 100))!.raw, 1);
  assert.equal(reading?.kind, 'sample');
});

test('реле передаёт лимит из потока app-server в порт limits и не меняет строку для моста', () => {
  const seen: LimitObservation[] = [];
  const toBridge: string[] = [];
  const relay = startCodexRelay({
    stdin: new PassThrough(), toChild: () => {}, endChild: () => {}, toBridge: line => toBridge.push(line),
    bridgeCwd: '/a', stageCwd: null, prepare: async () => ({ ok: true, message: '' }), finish: async () => {}, log: () => {},
    limits: o => seen.push(o),
  });
  relay.onChildLine(event(100, 50));
  relay.onChildLine('{"method":"item/agentMessage/delta","params":{}}');
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.status, 'rejected');
  assert.equal(toBridge[0], event(100, 50));
});
