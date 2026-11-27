// Состояние экрана настроек для стенда: настоящий server.ts на фейковом хосте SDK
// (как server.test.ts) — три машины, лимиты как у владельца на скриншоте v1.
// Запуск: node settings-preview/state.ts <файл.json>. Реальные машины не трогаются.
import { writeFileSync } from 'node:fs';
import { createFakePluginHost, makeHostResponse } from '@get-bb/plugin-sdk/testing';
import plugin from '../server.ts';

const now = Date.now();
const at = (hours: number) => new Date(now + hours * 3_600_000).toISOString();
const fake = createFakePluginHost({
  pluginId: 'agentcli-subscriptions-cascade',
  experimental_callHostRpc: call => ({ platform: call.hostId === 'host_mac' ? 'macos' : 'linux', isRoot: call.hostId !== 'host_mac', user: 'u', sharedPathExists: false, sharedPathWritable: false, mutagenVersion: null }),
  sdk: {
    hosts: {
      list: async () => [makeHostResponse({ id: 'host_tru', name: 'Tru', status: 'connected' }), makeHostResponse({ id: 'host_mac', name: 'Mac', status: 'connected' }), makeHostResponse({ id: 'host_ua', name: 'UA', status: 'connected' })],
      providerCliStatus: async () => ({ 'claude-code': { installed: true }, codex: { installed: true } }) as never,
    },
    system: {
      usageLimits: (async ({ hostId }: { hostId: string }) => hostId === 'host_tru'
        ? { 'claude-code': { status: 'ok', windows: [{ kind: 'weekly', label: 'Weekly', usedPercent: 100, resetsAt: at(80) }] }, codex: { status: 'unauthenticated' } }
        : hostId === 'host_ua'
        ? { 'claude-code': { status: 'ok', windows: [{ kind: 'five_hour', label: '5h', usedPercent: 40, resetsAt: at(3) }, { kind: 'weekly', label: 'Weekly', usedPercent: 56, resetsAt: at(70) }] }, codex: { status: 'ok', windows: [{ kind: 'weekly', label: 'Weekly', usedPercent: 99, resetsAt: at(60) }] } }
        : { 'claude-code': { status: 'unauthenticated' }, codex: { status: 'ok', windows: [{ kind: 'weekly', label: 'Weekly', usedPercent: 51, resetsAt: at(100) }] } }) as never,
    },
    providers: {
      models: (async ({ hostId, providerId }: { hostId: string; providerId: string }) => ({
        modelLoadError: null,
        models: providerId === 'codex' ? [{ id: 'gpt-6.2-sol', displayName: 'GPT-6.2 Sol' }]
          : hostId === 'host_tru' ? [{ id: 'claude-opus-5-5', displayName: 'Opus 5.5' }, { id: 'claude-fable-5-2', displayName: 'Fable 5.2' }]
          : hostId === 'host_ua' ? [{ id: 'claude-opus-5-5', displayName: 'Opus 5.5' }, { id: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5' }]
          : [{ id: 'opus55', displayName: 'opus55' }, { id: 'fable52', displayName: 'fable52' }],
      })) as never,
    },
    plugins: {
      callRpc: (async () => ({ usage: { fetchedAt: new Date(now).toISOString(), limitUnits: 405_000_000, remainingUnits: 380_730_000, endsAt: at(24 * 30) }, error: null })) as never,
    },
    projects: { list: async () => [] },
  },
});
plugin(fake.bb);
const state = await fake.harness.callRpc('state', { refresh: true });
writeFileSync(process.argv[2] ?? 'state.json', JSON.stringify({ state, now }, null, 1));
console.log(`состояние: ${process.argv[2] ?? 'state.json'}`);
