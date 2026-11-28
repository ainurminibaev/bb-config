import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileOrigin } from './cascade-origin.ts';
import { parsePassport } from './cascade-passport.ts';

const env = { envHostId: 'tru', envPath: '/root/p' };
const passport = parsePassport({ cascade: true, path: '/opt/bbfs/p', anchorHostId: 'tru', freshCopyHostId: 'mac', step: { hostId: 'mac', providerId: 'claude-code', kind: 'subscription' } });

test('без каскада всё как раньше: машина и папка окружения, явная машина главнее', () => {
  assert.deepEqual(fileOrigin({ kind: 'workspace', ...env, passport: null }), { hostId: 'tru', root: '/root/p' });
  assert.deepEqual(fileOrigin({ kind: 'workspace', explicitHostId: 'h2', ...env, passport: null }), { hostId: 'h2', root: '/root/p' });
  assert.deepEqual(fileOrigin({ kind: 'thread-storage', ...env, passport: null }), { hostId: 'tru', root: '/root/p' });
});

test('тред каскада: свежая копия и общий путь; хранилище треда и явная машина не меняются', () => {
  assert.deepEqual(fileOrigin({ kind: 'workspace', ...env, passport }), { hostId: 'mac', root: '/opt/bbfs/p' });
  assert.deepEqual(fileOrigin({ kind: 'thread-storage', ...env, passport }), { hostId: 'tru', root: '/root/p' });
  assert.deepEqual(fileOrigin({ kind: 'workspace', explicitHostId: 'h2', ...env, passport }), { hostId: 'h2', root: '/root/p' });
});
