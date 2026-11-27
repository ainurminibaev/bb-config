// Сервер на фейковом хосте SDK: регистрация провайдера, обнаружение, сохранение,
// мастер в режиме предпросмотра. Реальные машины и аккаунты не трогаются.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost, makeHostResponse } from '@get-bb/plugin-sdk/testing';
import plugin from './server.ts';

const NOW_ISO = new Date().toISOString();
const inHour = new Date(Date.now() + 3_600_000).toISOString();

function setup() {
  const fake = createFakePluginHost({
    pluginId: 'agentcli-subscriptions-cascade',
    experimental_callHostRpc: call => ({ platform: call.hostId === 'host_mac' ? 'macos' : 'linux', isRoot: call.hostId !== 'host_mac', user: 'u', sharedPathExists: false, sharedPathWritable: false, mutagenVersion: null }),
    sdk: {
      hosts: {
        list: async () => [makeHostResponse({ id: 'host_tru', name: 'Tru', status: 'connected' }), makeHostResponse({ id: 'host_mac', name: 'MacBook', status: 'connected' }), makeHostResponse({ id: 'host_ua', name: 'UA', status: 'connected' })],
        providerCliStatus: async () => ({ 'claude-code': { installed: true }, codex: { installed: true } }) as never,
      },
      system: {
        usageLimits: (async ({ hostId }: { hostId: string }) => hostId === 'host_tru'
          ? { 'claude-code': { status: 'ok', windows: [{ kind: 'weekly', label: 'Weekly', usedPercent: 20, resetsAt: inHour }] }, codex: { status: 'unauthenticated' } }
          : hostId === 'host_ua'
          ? { 'claude-code': { status: 'ok', windows: [{ kind: 'five_hour', label: '5h', usedPercent: 40, resetsAt: inHour }, { kind: 'weekly', label: 'Weekly', usedPercent: 56, resetsAt: inHour }] }, codex: { status: 'ok', windows: [{ kind: 'weekly', label: 'Weekly', usedPercent: 99, resetsAt: inHour }] } }
          : { 'claude-code': { status: 'unauthenticated' }, codex: { status: 'ok', windows: [{ kind: 'five_hour', label: '5h', usedPercent: 10, resetsAt: inHour }] } }) as never,
      },
      providers: {
        models: (async ({ hostId, providerId }: { hostId: string; providerId: string }) => ({
          modelLoadError: null,
          models: providerId === 'codex' ? [{ id: 'gpt-6.2-sol', displayName: 'GPT-6.2 Sol' }]
            : hostId === 'host_tru' ? [{ id: 'claude-opus-5-5', displayName: 'Opus 5.5' }, { id: 'claude-fable-5-2', displayName: 'Fable 5.2' }]
            : hostId === 'host_ua' ? [{ id: 'claude-opus-5-5', displayName: 'Opus 5.5' }, { id: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5' }]
            : [{ id: 'fable52', displayName: 'fable52' }],
        })) as never,
      },
      plugins: {
        callRpc: (async () => ({ usage: { fetchedAt: NOW_ISO, limitUnits: 405_000_000, remainingUnits: 380_730_000, endsAt: '2026-12-27T00:00:00Z' }, error: null })) as never,
      },
      projects: { list: async () => [] },
    },
  });
  plugin(fake.bb);
  return fake;
}

test('сервер: состояние, провайдер с каталогом, лимиты ступеней', async () => {
  const { harness } = setup();
  const state = await harness.callRpc('state', { refresh: true }) as {
    config: { steps: { id: string; authority: string }[] }; cells: Record<string, Record<string, { status: string; modelId: string | null }>>;
    stepLimits: Record<string, { state: string; text: string }>; issues: string[];
  };
  assert.deepEqual(state.config.steps.map(s => [s.id, s.authority]), [
    ['host_tru:claude-code:*', 'subscription'], ['host_mac:claude-code:*', 'gateway'], ['host_ua:claude-code:*', 'subscription'],
    ['host_mac:codex:*', 'subscription'], ['host_ua:codex:*', 'subscription'],
  ], 'UA обнаружена и встала в каскад третьей');
  assert.equal(state.cells['opus-5.5']!['host_ua']!.modelId, 'claude-opus-5-5');
  assert.equal(state.stepLimits['host_ua:claude-code:*']!.state, 'available');
  assert.equal(state.cells['fable-5.2']!['host_mac']!.modelId, 'fable52');
  assert.equal(state.cells['opus-5.5']!['host_mac']!.status, 'unmatched');
  assert.equal(state.stepLimits['host_tru:claude-code:*']!.state, 'available');
  assert.match(state.stepLimits['host_mac:claude-code:*']!.text, /^осталось 380,73 млн из 405 млн ед\./);
  const provider = harness.registrations.providerRegistrations.find(p => p.id === 'subscriptions-cascade');
  assert.ok(provider, 'провайдер зарегистрирован');
  const ids = (provider!.models?.fallback ?? []).map(m => m.id);
  assert.deepEqual(ids, ['auto', 'auto-no-codex', 'opus-then-auto', 'fable-then-auto', 'only-opus-5.5', 'only-fable-5.2'], 'список моделей = профили');
  assert.match(provider!.models!.fallback![0]!.description ?? '', /^Старт: Opus · Tru/);
});

test('сервер: «Добавить найденное», сохранение и предпросмотр мастера', async () => {
  const { harness } = setup();
  const adopted = await harness.callRpc('adoptDiscovered', null) as { config: { steps: { id: string }[]; models: { key: string }[] } };
  assert.equal(adopted.config.steps.at(-1)!.id, 'host_tru:codex:*', 'Codex на Tru добавлен в конец');
  assert.ok(adopted.config.models.some(m => m.key === 'gpt-6.2-sol'));
  const run = await harness.callRpc('wizardRun', { dryRun: true }) as { wizard: { hostId: string; steps: Record<string, { status: string }> }[] };
  assert.equal(run.wizard.length, 3);
  assert.ok(run.wizard.every(w => w.steps.folder!.status === 'pending'));
  assert.equal(harness.sdk.callsTo('terminals.create').length, 0, 'предпросмотр не запускает команд');
  const plan = await harness.callRpc('wizardPlan', { hostId: 'host_mac' }) as { steps: { id: string; privilege: string }[] };
  assert.equal(plan.steps.find(s => s.id === 'folder')!.privilege, 'macos-dialog');
});
