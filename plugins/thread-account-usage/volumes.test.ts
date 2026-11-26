import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodexVolumeReader, tokenCountEvent } from './codex-volume.ts';
import { googleComparison, volumeFor } from './volumes.ts';
import type { Account } from './contract.ts';

const event = (used: number, input: number, cached: number, output: number, reset = 1796103196) => JSON.stringify({ type: 'event_msg', payload: {
  type: 'token_count', info: { last_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } },
  rate_limits: { plan_type: 'promax', primary: { used_percent: used, window_minutes: 10080, resets_at: reset } } } });

test('Codex: tokens per point of the weekly window from session logs', async () => {
  assert.equal(tokenCountEvent('{"type":"response_item"}'), null);
  assert.equal(tokenCountEvent(event(1, 10, 5, 1))?.input, 5, 'cached input is not counted twice');
  const root = await mkdtemp(join(tmpdir(), 'tau-cx-'));
  await mkdir(join(root, '2026', '11', '25'), { recursive: true });
  await writeFile(join(root, '2026', '11', '25', 'a.jsonl'), [event(10, 2_000_000, 1_000_000, 10_000), 'noise', event(20, 2_000_000, 1_000_000, 10_000, 1796103197)].join('\n'));
  const [v] = await createCodexVolumeReader(root, () => Date.parse('2026-11-26T00:00:00Z'))();
  assert.equal(v!.percentSpan, 10);
  assert.equal(v!.input, 2_000_000);
  assert.equal(v!.samples, 2);
});

const account = (over: Partial<Account>): Account => ({ key: 'k', providerId: 'codex', providerName: 'Codex', hostIds: ['h'], hostNames: ['Tru'],
  email: 'a@b', plan: 'Promax', status: 'ok', message: null, fetchedAt: null, windows: [], resetCount: null, ...over });

test('volumes: measured, estimated and unknown stay labelled', () => {
  const inputs = { usdRub: 100, claude: { usdPerPercent: 20, unitsPerPercent: 8e6, segments: 16, email: 'max@x' },
    codex: new Map([['h', [{ plan: 'promax', resetsAt: '', samples: 400, percentSpan: 20, input: 4e6, cached: 200e6, output: 0.2e6 }]]]) };
  const codex = volumeFor(account({}), inputs)!;
  assert.equal(codex.confidence, 'measured');
  assert.equal(Math.round(codex.tokens! / 1e6), 1021);
  const max = volumeFor(account({ providerId: 'claude-code', plan: 'Max 20x', email: 'max@x' }), inputs)!;
  assert.equal(max.confidence, 'measured'); assert.equal(max.usd, 2000); assert.equal(max.tokens, 1e9);
  const pro = volumeFor(account({ providerId: 'claude-code', plan: 'Pro', email: 'other@x' }), inputs)!;
  assert.equal(pro.confidence, 'estimate'); assert.equal(pro.usd, 100);
  const google = volumeFor(account({ providerId: 'acp-antigravity-acp', plan: 'Google AI Pro' }), inputs)!;
  assert.equal(google.confidence, 'none'); assert.equal(google.tokens, null);
  const antig = volumeFor(account({ providerId: 'acp-gemini-antig', plan: 'Пакет 1 ч', meter: { total: 3600, left: 3585, tokensPerUnit: 6700 } }), inputs)!;
  assert.equal(antig.confidence, 'measured'); assert.equal(Math.round(antig.tokens! / 1e6), 24);
  assert.equal(antig.pricePerMTokens!.toFixed(2), (5 / 24.12).toFixed(2));
  assert.match(googleComparison([{ ...account({}), volume: codex }]), /замер копится/);
});
