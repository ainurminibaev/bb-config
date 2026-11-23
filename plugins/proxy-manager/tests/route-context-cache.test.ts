import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost, makeHostResponse, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import plugin from '../server.ts';

test('route_context reuses thread, environment and machine, and reports turns by event', async () => {
  let status: 'active' | 'idle' = 'active';
  const { bb, harness } = createFakePluginHost({ pluginId: 'proxy-manager', settings: { vault: '[]' }, sdk: {
    threads: { get: async () => makeThreadResponse({ id: 'thr', providerId: 'codex', environmentId: 'env', status }) },
    environments: { get: async () => ({ hostId: 'host', path: '/test/project' }) },
    hosts: { get: async () => makeHostResponse({ id: 'host', status: 'connected' }) },
  } } as any);
  try {
    await plugin(bb);
    const input = { threadId: 'thr', hostId: null, environmentId: null, providerId: null };
    const first = await harness.behavior.callRpc('route_context', input) as any;
    assert.equal(first.hostId, 'host');
    assert.equal(first.busy, true, 'thread status is read on the first lookup');
    status = 'idle';
    await harness.behavior.callRpc('route_context', input);
    for (const method of ['threads.get', 'environments.get', 'hosts.get']) assert.equal(harness.inspection.sdk.callsTo(method).length, 1, method);

    await harness.behavior.emitThreadEvent('thread.idle', { thread: makeThreadResponse({ id: 'thr', status: 'idle' }), lastAssistantText: null });
    assert.equal((await harness.behavior.callRpc('route_context', input) as any).busy, false);
    await harness.behavior.emitThreadEvent('thread.active', { thread: makeThreadResponse({ id: 'thr', status: 'active' }) });
    assert.equal((await harness.behavior.callRpc('route_context', input) as any).busy, true);
    const signals = harness.inspection.realtimeSignals.filter(s => s.channel === 'thread-activity');
    assert.deepEqual(signals.map(s => s.payload), [{ threadId: 'thr', busy: false }, { threadId: 'thr', busy: true }]);

    const newThread = await harness.behavior.callRpc('route_context', { threadId: null, hostId: 'host', environmentId: null, providerId: 'codex' }) as any;
    assert.equal('busy' in newThread, false);
  } finally { await harness.lifecycle.dispose(); }
});
