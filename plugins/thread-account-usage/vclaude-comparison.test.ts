import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { estimateComparison, priceEvent, readWeeklySamples } from './vclaude-comparison.ts';

const hour = 3_600_000;
const end = Date.parse('2026-12-01T21:00:00Z');
const start = end - 7 * 24 * hour;
const opus = { input: 800_000, output: 4_000_000, cacheRead: 80_000, cacheWrite5m: 1_000_000, cacheWrite1h: 1_600_000 };
const example = (at: number, id = 'm') => ({
  at, key: id, model: 'claude-opus-5-5',
  usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 0 },
});

test('Opus cached input uses the directly published Anthropic rate', () => {
  const result = priceEvent(example(start), new Map([['opus-5-5', opus]]));
  assert.equal(result.units, 80_000);
  assert.equal(result.apiUsd, 0.20);
});

test('weekly estimate omits the capped 100% segment and uses a rolling day', () => {
  const samples = [0, 5, 10, 15, 100].map((p, i) => ({ sampled_at: start + i * hour, used_percent: p }));
  const events = [0, 1, 2, 4].map((i) => example(start + i * hour + 1, String(i)));
  const estimate = estimateComparison(samples, events, { 'anthropic-claude-opus-5-5': opus }, start + 5 * hour, end);
  assert.equal(estimate?.segments, 3);
  assert.equal(estimate?.unitsPerPercent, 16_000);
  assert.equal(estimate?.usdPerPercent, 0.04);
  assert.equal(estimate?.dailyUnits, 320_000);
  assert.equal(estimate?.weekProgress, 100);
});

test('unknown rates are counted and do not quietly reduce the weekly estimate', () => {
  const samples = [0, 5, 10, 15].map((p, i) => ({ sampled_at: start + i * hour, used_percent: p }));
  const events = [0, 1, 2].map(i => ({ ...example(start + i * hour + 1, String(i)), model: i ? 'claude-opus-5-5' : 'future-model' }));
  const estimate = estimateComparison(samples, events, { 'anthropic-claude-opus-5-5': opus }, start + 4 * hour, end);
  assert.equal(estimate?.unpricedRequests, 1);
  assert.equal(estimate?.segments, 2);
  assert.equal(estimate?.unitsPerPercent, null);
});

test('Tokenomics samples from distinct account keys are never combined', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'test-vclaude-limit-'));
  const file = join(directory, 'plugin.db');
  try {
    const db = new DatabaseSync(file);
    try {
      db.exec('create table limit_samples(provider_id, label, resets_at, sampled_at, used_percent, account_key)');
      const add = db.prepare("insert into limit_samples values('claude-code', 'Weekly limit', ?, ?, ?, ?)");
      add.run(end, start+10, 3, 'first');
      add.run(end-dayForTest(), start+20, 12, 'other');
      assert.equal(readWeeklySamples(file, end).length, 1);
      add.run(end, start+30, 5, 'other');
      assert.deepEqual(readWeeklySamples(file, end), []);
    } finally { db.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

function dayForTest() { return 24 * hour; }
