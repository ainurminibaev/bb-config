import assert from 'node:assert/strict';
import { test } from 'node:test';
import { waitForThreadListBundle } from '../lib/thread-list-bundle.ts';

const bundle = { compatible: true, jsUrl: '/native.js' };
const plugin = (status, appBundle = null, enabled = true) => ({
  id: 'thread-list',
  enabled,
  status,
  app: { bundle: appBundle },
});

test('waits for Thread List to finish starting and publish its bundle', async () => {
  const responses = [
    [],
    [plugin('starting')],
    [plugin('starting', { compatible: false })],
    [plugin('starting', bundle)],
    [plugin('running')],
    [plugin('running', bundle)],
  ];
  const load = () => Promise.resolve({ plugins: responses.shift() });
  assert.equal(await waitForThreadListBundle(load, new AbortController().signal, 1), bundle);
  assert.equal(responses.length, 0);
});

test('reports disabled and incompatible states without retrying', async () => {
  for (const [entry, expected] of [
    [plugin('disabled', null, false), /Enable bb’s Thread list plugin/],
    [plugin('incompatible'), /is incompatible/],
    [plugin('running', { compatible: false }), /is incompatible/],
  ]) {
    let calls = 0;
    const load = async () => {
      calls++;
      return { plugins: [entry] };
    };
    await assert.rejects(waitForThreadListBundle(load, new AbortController().signal, 1), expected);
    assert.equal(calls, 1);
  }
});

test('stops waiting as soon as the sidebar unmounts', async () => {
  const controller = new AbortController();
  let calls = 0;
  const pending = waitForThreadListBundle(async () => {
    calls++;
    return { plugins: [plugin('starting')] };
  }, controller.signal);
  await Promise.resolve();
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(calls, 1);
});
