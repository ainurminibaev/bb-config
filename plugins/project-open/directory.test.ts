import { expect, test } from 'vitest';
import { buildMachines, keepKnownKeys, publicKeys } from './directory';

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB000000000000';

test('roots come from project sources and workspaces of that machine only', () => {
  const machines = buildMachines([{ id: 'a', name: 'A' }, { id: 'b' }],
    [{ sources: [{ hostId: 'a', path: '/srv/p' }, { hostId: 'b', path: 'C:/p' }, { hostId: 'a', path: '/' }, { hostId: 'a', path: '/root' }, { hostId: 'a', path: '/home/me/' }, { hostId: 'a', path: '/root/p' }] }, {}],
    [{ hostId: 'a', path: '/srv/w' }, { hostId: 'a', path: '/srv/../etc' }, { hostId: null, path: '/x' }, { hostId: 'b', path: null }],
    new Map([['a', { platform: 'linux', hostKeys: [KEY], user: 'root' }]]));
  expect(machines).toEqual({ a: { name: 'A', platform: 'linux', roots: ['/root/p', '/srv/p', '/srv/w'], hostKeys: [KEY], user: 'root' },
    b: { name: 'b', platform: null, roots: [], hostKeys: [] } });
});

test('only public keys are taken, without comments', () => {
  expect(publicKeys([KEY + ' root@host\n', '-----BEGIN something else-----', ''])).toEqual([KEY]);
});

test('an offline machine keeps its earlier keys; an online one does not', () => {
  const next = { version: 1 as const, self: 'm', machines: {
    off: { name: 'o', platform: null, roots: [], hostKeys: [] }, on: { name: 'n', platform: 'linux', roots: [], hostKeys: [] } } };
  const old = { machines: { off: { platform: 'linux', hostKeys: [KEY], user: 'root' }, on: { platform: 'linux', hostKeys: [KEY] } } };
  expect(keepKnownKeys(next, old).machines.off).toMatchObject({ platform: 'linux', hostKeys: [KEY], user: 'root' });
  expect(keepKnownKeys(next, old).machines.on!.hostKeys).toEqual([]);
  expect(keepKnownKeys(next, 'garbage')).toBe(next);
});
