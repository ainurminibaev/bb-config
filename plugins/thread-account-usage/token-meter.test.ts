import test from 'node:test';
import assert from 'node:assert/strict';
import { fields, generation, groupOf, type GroupTotals } from './agy-tokens.ts';
import { accumulate, windowVolume, type MeterReading } from './token-meter.ts';

// Minimal protobuf writer for the test rows.
const v = (n: number) => { const out: number[] = []; do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 128; out.push(b); } while (n); return out; };
const int = (f: number, n: number) => [...v(f * 8), ...v(n)];
const bytes = (f: number, b: number[] | Uint8Array) => [...v(f * 8 + 2), ...v(b.length), ...b];
const str = (f: number, s: string) => bytes(f, [...new TextEncoder().encode(s)]);

test('gen_metadata row: model and usage (input, output, cache read/write)', () => {
  const usage = [...int(1, 1526), ...int(2, 39370), ...int(3, 559), ...int(5, 1000), ...int(6, 24), ...int(9, 431), ...int(10, 128)];
  const gen = [...int(3, 1526), ...bytes(4, usage), ...str(19, 'gemini-4-hydrogen'), ...str(21, 'Gemini 4 Hydrogen (Medium)')];
  const row = new Uint8Array([...str(4, 'id'), ...bytes(1, gen)]);
  assert.deepEqual(generation(row), { model: 'gemini-4-hydrogen', input: 39370, output: 559, cacheWrite: 0, cacheRead: 1000 });
  assert.equal(generation(new Uint8Array([0xff, 0xff])), null);
  assert.equal(fields(new Uint8Array([0x0a, 0x05, 1])), null, 'truncated length');
  assert.equal(groupOf('claude-opus-4-6-thinking'), 'claude-gpt');
  assert.equal(groupOf('gpt-oss-120b-medium'), 'claude-gpt');
  assert.equal(groupOf('gemini-4-neon'), 'gemini');
});

const totals = (gemini: number, other = 0): GroupTotals => ({
  gemini: { input: gemini, cacheRead: 0, cacheWrite: 0, output: 0, generations: 1 },
  'claude-gpt': { input: other, cacheRead: 0, cacheWrite: 0, output: 0, generations: 1 } });
const reading = (at: string, used: number, tru: number, ua: number, reset = '2026-11-26T12:00:00Z'): MeterReading => ({
  at: Date.parse(at), hosts: { tru: totals(tru), ua: totals(ua) },
  windows: { 'Gemini · 5 ч': { used, resetsAt: reset, group: 'gemini' } } });

test('meter: tokens of all machines against the window percent; resets and deletions dropped', () => {
  let sums = accumulate(null, reading('2026-11-26T08:00:00Z', 0, 0, 0), {});
  sums = accumulate(reading('2026-11-26T08:00:00Z', 0, 0, 0), reading('2026-11-26T08:15:00Z', 1, 3e6, 1e6), sums);
  sums = accumulate(reading('2026-11-26T08:15:00Z', 1, 3e6, 1e6), reading('2026-11-26T08:30:00Z', 2, 6e6, 2e6), sums);
  assert.deepEqual(sums['Gemini · 5 ч'], { tokens: 8e6, percent: 2, samples: 2 });
  assert.equal(windowVolume(sums['Gemini · 5 ч']), 400e6);
  const afterReset = accumulate(reading('2026-11-26T11:50:00Z', 90, 6e6, 2e6), reading('2026-11-26T12:05:00Z', 1, 7e6, 2e6, '2026-11-26T17:00:00Z'), sums);
  assert.deepEqual(afterReset, sums, 'window reset in between');
  const deleted = accumulate(reading('2026-11-26T08:30:00Z', 2, 6e6, 2e6), reading('2026-11-26T08:45:00Z', 3, 1e6, 2e6), sums);
  assert.deepEqual(deleted, sums, 'a conversation was deleted');
  const missing = accumulate(reading('2026-11-26T08:30:00Z', 2, 6e6, 2e6), { ...reading('2026-11-26T08:45:00Z', 3, 7e6, 2e6), hosts: { tru: totals(7e6) } }, sums);
  assert.deepEqual(missing, sums, 'a machine did not answer');
  assert.equal(windowVolume({ tokens: 1e6, percent: 1, samples: 3 }), null, 'too little spent to say');
});
