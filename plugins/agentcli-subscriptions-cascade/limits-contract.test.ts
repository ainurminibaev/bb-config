// 0.3.5: контракт видимости лимитов. Новый провайдер или источник квоты не может
// тихо дать «unknown»: у каждого адаптера реестра и у каждого источника квоты есть
// образец ответа (fixtures/limits-samples.json), и на нём квота известна. Ожидаемые
// состояние и проценты — те же, что проверяет Thread Account Usage на копии файла
// (plugins/thread-account-usage/limits-contract.test.ts): разошлись — падают оба.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { Stage } from './adapter.ts';
import { defaultRegistry } from './adapters.ts';
import { seedConfig } from './config.ts';
import { policiesSchema, stepSchema } from './contract.ts';
import { healthFromReading, type StepHealth } from './limits.ts';

const SAMPLES_URL = new URL('./fixtures/limits-samples.json', import.meta.url);
const S = JSON.parse(readFileSync(SAMPLES_URL, 'utf8')) as {
  receivedAt: string;
  usageLimits: Record<string, { response: unknown; expected: { state: string; status: string; windows: Record<string, number> } }>;
  vclaude: { rpc: unknown; expected: { state: string; usedPercent: number; remainingUnits: number } };
  [source: string]: unknown;
};
const NOW = Date.parse(S.receivedAt);
const policies = policiesSchema.parse({});

const registry = defaultRegistry({
  usageLimits: async () => Object.fromEntries(Object.entries(S.usageLimits).map(([id, s]) => [id, s.response])),
  vclaudeUsage: async () => S.vclaude.rpc,
  now: () => NOW,
});

const stateOf = (h: StepHealth) => (!h.available ? 'unavailable' : h.exhausted ? 'exhausted' : h.unknown ? 'unknown' : 'available');
const stage = (provider: string, extra: Partial<Stage> = {}): Stage => ({ hostId: 'host_sample', provider, profileRef: 'default', authority: 'subscription', quotaSource: 'provider', bindingEpoch: 'e', ...extra } as Stage);

test('полнота: у каждого провайдера ступеней и каждого источника квоты есть адаптер и образец ответа', () => {
  const adapters = registry.list().map(a => a.id);
  const seeded = seedConfig([{ id: 'h1', name: 'Tru', platform: 'linux' }, { id: 'h2', name: 'Mac', platform: 'macos' }, { id: 'h3', name: 'UA', platform: 'linux' }]).steps.map(s => s.providerId);
  for (const provider of new Set([...adapters, ...seeded])) {
    assert.ok(adapters.includes(provider), `нет адаптера лимитов для ${provider}: добавьте его в defaultRegistry (adapters.ts)`);
    assert.ok(S.usageLimits[provider], `добавьте образец ответа для ${provider} в fixtures/limits-samples.json (usageLimits.${provider})`);
  }
  for (const source of stepSchema.shape.quotaSource.unwrap().options) {
    if (source === 'provider') continue;
    assert.ok(S[source], `добавьте образец ответа для источника квоты ${source} в fixtures/limits-samples.json`);
  }
});

test('каждый адаптер на образце даёт известную квоту (не unknown) с процентами окон', async () => {
  for (const adapter of registry.list()) {
    const sample = S.usageLimits[adapter.id]!;
    const st = stage(adapter.id);
    assert.ok(adapter.limits.supports(st).poll, `${adapter.id}: адаптер не опрашивает источник`);
    const reading = await adapter.limits.read(st, new AbortController().signal);
    const health = healthFromReading(reading, null, { connected: true, now: NOW, policies });
    assert.notEqual(stateOf(health), 'unknown', `${adapter.id}: квота неизвестна на образце — ${health.reason}`);
    assert.equal(stateOf(health), sample.expected.state, `${adapter.id}: состояние`);
    assert.ok(reading.kind === 'sample');
    const percents = Object.fromEntries(reading.windows.map(w => [w.windowId.split(':').slice(1).join(':'), w.usedPercent]));
    assert.deepEqual(percents, sample.expected.windows, `${adapter.id}: проценты окон — как у Thread Account Usage`);
  }
});

test('шлюз vclaude: пакет из кабинета (кэш Thread Account Usage до 2 мин) — квота известна, остаток и процент', async () => {
  const claude = registry.get('claude-code')!;
  const st = stage('claude-code', { authority: 'gateway', quotaSource: 'vclaude' });
  const reading = await claude.limits.read(st, new AbortController().signal);
  const health = healthFromReading(reading, null, { connected: true, now: NOW, policies });
  assert.equal(stateOf(health), S.vclaude.expected.state, `vclaude: ${health.reason}`);
  assert.ok(reading.kind === 'sample');
  const w = reading.windows[0]!;
  assert.equal(Math.round(w.usedPercent!), S.vclaude.expected.usedPercent);
  assert.equal(w.remaining?.amount, S.vclaude.expected.remainingUnits);
});

const TAU_SAMPLES_URL = new URL('../thread-account-usage/fixtures/limits-samples.json', import.meta.url);

test('образцы у каскада и Thread Account Usage — один и тот же файл', { skip: !existsSync(TAU_SAMPLES_URL) && 'нет соседнего плагина (установленная копия)' }, () => {
  const own = readFileSync(SAMPLES_URL);
  const tau = readFileSync(TAU_SAMPLES_URL);
  const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
  assert.equal(hash(own), hash(tau), 'fixtures/limits-samples.json разошёлся с копией в thread-account-usage — обновите обе');
});
