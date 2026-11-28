import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNTS, MAC, TRU, account, config } from './fixtures.ts';
import { applyAutoMatches, canonicalModelKey, matchCatalog, resolveCell, rowKeyFromModelId, suggestRows } from './models.ts';

const row = (key: string) => config().models.find(r => r.key === key)!;

test('канонический ключ убирает бренд, разделители и суффиксы', () => {
  assert.equal(canonicalModelKey('Fable 5.2'), 'fable52');
  assert.equal(canonicalModelKey('claude-fable-5-2'), 'fable52');
  assert.equal(canonicalModelKey('fable52'), 'fable52');
  assert.equal(canonicalModelKey('Claude Opus 5.5 [1m]'), 'opus55');
  assert.equal(canonicalModelKey('claude-sonnet-5-5-20261001'), 'sonnet55');
});

test('сопоставление: разные ID одной модели на Tru и Mac', () => {
  assert.deepEqual(matchCatalog(row('fable-5.2'), ACCOUNTS[0]!.models), ['claude-fable-5-2']);
  assert.deepEqual(matchCatalog(row('fable-5.2'), ACCOUNTS[1]!.models), ['fable52']);
});

test('неоднозначность: два кандидата без точного имени', () => {
  const models = [{ id: 'opus-5-5', displayName: 'opus-5-5' }, { id: 'claude-opus-5-5', displayName: 'Opus 5.5 (1M)' }];
  const cell = resolveCell(row('opus-5.5'), TRU, account(TRU, 'claude-code', models));
  assert.equal(cell.status, 'ambiguous');
  assert.deepEqual(cell.candidates.sort(), ['claude-opus-5-5', 'opus-5-5']);
});

test('статусы ячеек: auto, unmatched, manual, missing, no-cli, unknown', () => {
  const opus = row('opus-5.5');
  assert.deepEqual(resolveCell(opus, MAC, ACCOUNTS[1]), { status: 'auto', modelId: 'opus55', candidates: [] });
  const haiku = row('haiku-5.5');
  assert.equal(resolveCell(haiku, MAC, ACCOUNTS[1]).status, 'unmatched');
  const manual = { ...haiku, cells: { [MAC]: { modelId: 'fable52', source: 'manual' as const } } };
  assert.equal(resolveCell(manual, MAC, ACCOUNTS[1]).status, 'manual');
  const missing = { ...haiku, cells: { [MAC]: { modelId: 'haiku99', source: 'manual' as const } } };
  assert.equal(resolveCell(missing, MAC, ACCOUNTS[1]).status, 'missing');
  assert.equal(resolveCell(opus, MAC, account(MAC, 'claude-code', [], { installed: false })).status, 'no-cli');
  assert.equal(resolveCell(opus, MAC, undefined).status, 'unknown');
});

test('applyAutoMatches сохраняет ручные ячейки и пишет автоподбор', () => {
  const c = config();
  c.models = c.models.map(r => r.key === 'haiku-5.5' ? { ...r, cells: { [MAC]: { modelId: 'my-haiku', source: 'manual' } } } : r);
  const out = applyAutoMatches(c, ACCOUNTS);
  assert.deepEqual(out.models.find(r => r.key === 'fable-5.2')!.cells[MAC], { modelId: 'fable52', source: 'auto' });
  assert.deepEqual(out.models.find(r => r.key === 'haiku-5.5')!.cells[MAC], { modelId: 'my-haiku', source: 'manual' });
});

test('устаревший ID модели `m:<ключ>` → ключ строки', () => {
  assert.equal(rowKeyFromModelId('m:fable-5.2'), 'fable-5.2');
  assert.equal(rowKeyFromModelId('auto'), null);
});

test('suggestRows добавляет модели Codex, которых нет в таблице', () => {
  const rows = suggestRows(config(), ACCOUNTS);
  assert.deepEqual(rows.map(r => [r.displayName, r.providerId]), [['GPT-6.2 Sol', 'codex']]);
});
