import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forCascade, runtimeOf } from './cascade-logic.ts';
import { parsePassport, CASCADE_PROVIDER_ID } from './cascade-passport.ts';
import type { Assessment } from './logic.ts';

const SUPPORTED = new Set(['claude-code', 'codex']);
const finish: Assessment = { mode: 'finish', driver: null, windows: [], reason: null };
const passport = (kind: string, providerId = 'codex') => parsePassport({ cascade: true, step: { hostId: 'mac', providerId, kind } });

test('без каскада всё как раньше: провайдер и машина окружения, «финиш» остаётся «финишем»', () => {
  assert.deepEqual(runtimeOf({ providerId: 'claude-code', environmentHostId: 'tru' }, null, SUPPORTED),
    { providerId: 'claude-code', hostId: 'tru', cascade: false, gateway: false });
  assert.equal(runtimeOf({ providerId: 'claude-code', environmentHostId: null }, null, SUPPORTED), null);
  assert.equal(runtimeOf({ providerId: 'acp-x', environmentHostId: 'tru' }, null, SUPPORTED), null);
  // Паспорт у обычного треда не учитывается, даже если он вдруг передан.
  assert.equal(runtimeOf({ providerId: 'codex', environmentHostId: 'tru' }, passport('subscription'), SUPPORTED)!.hostId, 'tru');
  assert.equal(forCascade(finish, false), finish);
});

test('тред каскада: лимиты текущей ступени; без паспорта — пропуск, как раньше', () => {
  const row = { providerId: CASCADE_PROVIDER_ID, environmentHostId: 'tru' };
  assert.deepEqual(runtimeOf(row, passport('subscription'), SUPPORTED), { providerId: 'codex', hostId: 'mac', cascade: true, gateway: false });
  assert.equal(runtimeOf(row, passport('gateway', 'claude-code'), SUPPORTED)!.gateway, true);
  assert.equal(runtimeOf(row, null, SUPPORTED), null);
  assert.equal(runtimeOf(row, parsePassport({ cascade: true, step: null }), SUPPORTED), null);
});

test('тред каскада не уходит в «финиш»: экономный режим с пояснением', () => {
  const a = forCascade(finish, true);
  assert.equal(a.mode, 'economy');
  assert.match(a.reason!, /каскад/);
  const economy: Assessment = { ...finish, mode: 'economy' };
  assert.equal(forCascade(economy, true), economy);
});
