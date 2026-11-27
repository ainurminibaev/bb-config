import { expect, test } from 'vitest';
import { buildMachines, withExtraRoots } from './directory';
import { asThreadFolder } from './folder-target';
import { cascadeFolder, parsePassport, readPassport } from './cascade-passport';

const hosts = [{ id: 'tru', name: 'Tru' }, { id: 'mac', name: 'Mac' }];
const envs = [{ hostId: 'tru', path: '/srv/p' }];

test('без каскада всё как раньше: папки те же, ответа сервера нет — папка окружения', async () => {
  expect(withExtraRoots(envs, {})).toBe(envs);
  expect(buildMachines(hosts, [], withExtraRoots(envs, {}), new Map())).toEqual(buildMachines(hosts, [], envs, new Map()));
  expect(asThreadFolder(null)).toBeNull();
  expect(asThreadFolder({ hostId: 'mac' })).toBeNull();
  expect(asThreadFolder({ hostId: 'mac', path: 'relative' })).toBeNull();
  // Обычный тред: каскад не спрашивается.
  let calls = 0;
  expect(await readPassport(async () => { calls++; return {}; }, { id: 't', providerId: 'claude-code' })).toBeNull();
  expect(calls).toBe(0);
});

test('тред каскада: свежая копия по общему пути, папка попадает в список обработчика Finder', () => {
  const folder = cascadeFolder(parsePassport({ cascade: true, path: '/opt/bbfs/p', anchorHostId: 'tru', freshCopyHostId: 'mac' }));
  expect(folder).toEqual({ hostId: 'mac', path: '/opt/bbfs/p' });
  expect(asThreadFolder(folder)).toEqual(folder);
  const machines = buildMachines(hosts, [], withExtraRoots(envs, { mac: ['/opt/bbfs/p'] }), new Map());
  expect(machines.mac!.roots).toEqual(['/opt/bbfs/p']);
  expect(machines.tru!.roots).toEqual(['/srv/p']);
});
