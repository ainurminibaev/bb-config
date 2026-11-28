// Сверка с каскадом подписок (контракт видимости лимитов, 0.3.5): на общих образцах
// ответов источников (fixtures/limits-samples.json — та же копия, что у
// plugins/agentcli-subscriptions-cascade) Thread Account Usage видит те же статус и
// проценты, что ожидает каскад. Разошлись — падает здесь и в каскаде.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { usageWindows, vclaudeUsedPercent } from './logic.ts';
import { parseVClaudeUsage } from './vclaude.ts';

const S = JSON.parse(readFileSync(new URL('./fixtures/limits-samples.json', import.meta.url), 'utf8')) as {
  receivedAt: string;
  usageLimits: Record<string, { response: unknown; expected: { status: string; windows: Record<string, number> } }>;
  vclaude: { cabinet: unknown; rpc: { usage: { limitUnits: number; remainingUnits: number } }; expected: { status: string; usedPercent: number; remainingUnits: number } };
};

test('usageLimits: статус и проценты окон по каждому провайдеру — как ожидает каскад', () => {
  for (const [provider, sample] of Object.entries(S.usageLimits)) {
    const parsed = usageWindows(sample.response);
    assert.equal(parsed.ok ? 'ok' : 'unavailable', sample.expected.status, provider);
    assert.deepEqual(Object.fromEntries(parsed.windows.map(w => [w.label, w.usedPercent])), sample.expected.windows, provider);
  }
});

test('vclaude: разбор кабинета даёт тот же пакет, что получает каскад по RPC, и тот же процент', () => {
  const usage = parseVClaudeUsage(S.vclaude.cabinet, S.receivedAt);
  assert.equal(usage.limitUnits, S.vclaude.rpc.usage.limitUnits);
  assert.equal(usage.remainingUnits, S.vclaude.rpc.usage.remainingUnits);
  assert.equal(usage.remainingUnits, S.vclaude.expected.remainingUnits);
  assert.equal(Math.round(vclaudeUsedPercent(usage)), S.vclaude.expected.usedPercent);
});
