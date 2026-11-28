// Мастер: SSH до опоры одной кнопкой, смена версии Mutagen, ленивая настройка при ходе.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Machine, WizardMachineState } from '../contract.ts';
import { revokeSsh, runWizard, type WizardDeps } from '../wizard.ts';
import { anchorAlias, authorizeCommand, configBlock, parseKeyOutput, revokeCommand, writeConfigCommand, removeLocalCommand } from './ssh-setup.ts';
import { mutagenVersionCheck } from './setup.ts';
import { specFingerprint } from './mutagen.ts';

const TRU: Machine = { hostId: 'host_tru', label: 'Tru', enabled: true, platform: 'linux', sharedPath: '/opt/bbfs', pathTranslation: false, anchor: true, anchorSsh: null, sshAddress: '203.0.113.7' };
const UA: Machine = { hostId: 'host_ua', label: 'UA', enabled: true, platform: 'linux', sharedPath: '/opt/bbfs', pathTranslation: false, anchor: false, anchorSsh: null, sshAddress: null };
const PUB = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOk0bbcascadetestkey0000000000000000000000000 bb-cascade:host_ua';

/** Фейковые машины: UA (исполнитель) и Tru (опора); ssh проходит, когда ключ и алиас на месте. */
function world() {
  const ran: { host: string; command: string }[] = [];
  const state = { key: false, authorized: false, alias: false };
  const deps: WizardDeps & { anchorSshSet: string[] } = {
    anchorSshSet: [],
    anchor: TRU,
    probe: async m => ({ platform: 'linux', isRoot: true, user: m.hostId === TRU.hostId ? 'root' : 'root', sharedPathExists: true, sharedPathWritable: true, mutagenVersion: '0.18.1' }),
    exec: async (m, _p, command) => {
      ran.push({ host: m.hostId, command });
      if (command.startsWith('ssh -o BatchMode=yes')) return state.authorized && state.alias && command.includes("'bb-tru'") ? { exitCode: 0, output: 'ssh-ok' } : { exitCode: 255, output: 'Permission denied (publickey)' };
      if (command.includes('ssh-keygen')) { state.key = true; return { exitCode: 0, output: `pub: ${PUB}\nfp: SHA256:abcDEF123` }; }
      if (command.includes('authorized_keys') && command.includes('echo authorized')) { state.authorized = true; return { exitCode: 0, output: 'authorized' }; }
      if (command.includes('echo configured')) { state.alias = true; return { exitCode: 0, output: 'configured' }; }
      if (command.includes('echo revoked')) { state.authorized = false; return { exitCode: 0, output: 'revoked' }; }
      if (command.includes('echo removed')) { state.alias = false; state.key = false; return { exitCode: 0, output: 'removed' }; }
      return { exitCode: 0, output: '0.18.1' }; // папка, Mutagen, проверка — готовы
    },
    writeProbe: async () => true,
    save: async () => {},
    now: () => '2026-11-28T00:00:00Z',
    setAnchorSsh: async (_h, target) => { deps.anchorSshSet.push(target); },
  };
  return { deps, ran, state };
}
const ssh = (s: WizardMachineState) => s.steps.ssh!;

test('SSH одной кнопкой: без разрешения — ключ создан, на опору не добавлен, показано что и куда; с разрешением — ключ, алиас bb-tru, вход', async () => {
  const w = world();
  const [first] = await runWizard([UA], new Map(), w.deps, { dryRun: false });
  assert.equal(ssh(first!).status, 'manual');
  assert.match(first!.pendingConsent!.text, /Разрешить машине UA входить на Tru по ключу SHA256:abcDEF123 .*authorized_keys пользователя root на Tru/u);
  assert.equal(w.state.key, true, 'ключ на исполнителе создан');
  assert.equal(w.ran.some(r => r.host === TRU.hostId), false, 'на опору без согласия ничего не выполнялось');
  assert.equal(first!.steps.verify!.status, 'pending', 'дальше не идём');

  const [second] = await runWizard([UA], new Map([[UA.hostId, first!]]), w.deps, { dryRun: false, allowSsh: new Set([UA.hostId]) });
  assert.equal(ssh(second!).status, 'done', ssh(second!).message ?? '');
  assert.equal(second!.pendingConsent, null);
  assert.deepEqual(w.deps.anchorSshSet, ['bb-tru'], '«SSH к опоре» UA = bb-tru');
  assert.ok(w.ran.some(r => r.host === TRU.hostId && r.command.includes('authorized_keys')), 'ключ добавлен на опору');
  assert.equal(second!.steps.verify!.status, 'done');

  // Повтор — проверка проходит сразу, ничего не добавляется.
  const before = w.ran.length;
  const [again] = await runWizard([{ ...UA, anchorSsh: 'bb-tru' }], new Map([[UA.hostId, second!]]), w.deps, { dryRun: false, recheck: true });
  assert.equal(ssh(again!).status, 'done');
  assert.equal(w.ran.slice(before).some(r => r.command.includes('authorized_keys')), false);

  // Выключение машины / «с нуля» — ключ снят с опоры, алиас и ключ убраны на UA.
  const notes = await revokeSsh(UA, w.deps);
  assert.equal(w.state.authorized, false);
  assert.equal(w.state.alias, false);
  assert.match(notes.join(' '), /ключ UA снят с Tru/u);
});

test('SSH: без адреса опоры — понятный ручной шаг', async () => {
  const w = world();
  w.deps.anchor = { ...TRU, sshAddress: null };
  const [st] = await runWizard([UA], new Map(), w.deps, { dryRun: false });
  assert.equal(ssh(st!).status, 'manual');
  assert.match(ssh(st!).message!, /Машины → Tru → «Адрес для SSH»/u);
});

test('ssh-setup: команды на настоящем sh — ключ без дублей, снятие по пометке, блок ~/.ssh/config заменяется', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'cxssh-')));
  const sh = (cmd: string) => execFileSync('/bin/sh', ['-c', cmd], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
  const key = parseKeyOutput(`pub: ${PUB}\nfp: SHA256:abcDEF123`)!;
  writeFileSync(join(home, 'seed'), '');
  sh('mkdir -p "$HOME/.ssh" && echo "ssh-ed25519 AAAAother owner@laptop" > "$HOME/.ssh/authorized_keys"');
  sh(authorizeCommand(key, 'host_ua'));
  sh(authorizeCommand(key, 'host_ua'));
  const keys = readFileSync(join(home, '.ssh/authorized_keys'), 'utf8').trim().split('\n');
  assert.equal(keys.length, 2, 'без дублей');
  assert.match(keys[1]!, / bb-cascade:host_ua$/u);
  sh(revokeCommand('host_ua'));
  assert.deepEqual(readFileSync(join(home, '.ssh/authorized_keys'), 'utf8').trim().split('\n'), ['ssh-ed25519 AAAAother owner@laptop'], 'чужие ключи на месте');

  sh('printf "Host gh\\n  HostName github.com\\n" > "$HOME/.ssh/config"');
  sh(writeConfigCommand('bb-tru', '203.0.113.7', 'root'));
  sh(writeConfigCommand('bb-tru', '203.0.113.8', 'root'));
  const config = readFileSync(join(home, '.ssh/config'), 'utf8');
  assert.equal((config.match(/Host bb-tru/gu) ?? []).length, 1, 'блок заменён, не продублирован');
  assert.match(config, /HostName 203\.0\.113\.8/u);
  assert.match(config, /Host gh/u, 'чужие записи не тронуты');
  assert.match(config, /IdentitiesOnly yes/u);
  sh(removeLocalCommand('bb-tru'));
  assert.doesNotMatch(readFileSync(join(home, '.ssh/config'), 'utf8'), /bb-tru/u);
  assert.equal(anchorAlias('Tru'), 'bb-tru');
  assert.throws(() => configBlock('bb-tru', 'evil; rm -rf /', null));
});

test('смена версии Mutagen: та же — готово; другая и сессий нет — обновить; идут сессии — отложить; сессии пересоздаются', () => {
  const bin = realpathSync(mkdtempSync(join(tmpdir(), 'cxmut-')));
  const fake = (version: string, sessions: string) => {
    writeFileSync(join(bin, 'mutagen'), `#!/bin/sh\nif [ "$1" = version ]; then echo ${version}; exit 0; fi\nif [ "$1" = sync ] && [ "$2" = list ]; then printf '${sessions}'; exit 0; fi\n`, { mode: 0o755 });
  };
  const run = (cmd: string) => { try { return { code: 0, out: execFileSync('/bin/sh', ['-c', cmd], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: bin }, encoding: 'utf8' }) }; } catch (e) { const err = e as { status: number; stdout: string }; return { code: err.status, out: err.stdout }; } };
  fake('0.18.1', '');
  assert.equal(run(mutagenVersionCheck('0.18.1')).code, 0);
  fake('0.18.1', '');
  assert.deepEqual(run(mutagenVersionCheck('0.19.0')), { code: 1, out: 'Mutagen 0.18.1 → 0.19.0\n' }, 'другая версия, сессий нет — обновить');
  fake('0.18.1', 'x');
  const deferred = run(mutagenVersionCheck('0.19.0'));
  assert.equal(deferred.code, 0);
  assert.match(deferred.out, /обновление до 0\.19\.0 отложено — идут сессии каскада/u);
  const spec = { role: 'w' as const, alpha: 'bb-tru:/opt/bbfs/app', beta: '/opt/bbfs/app', ignores: [] };
  assert.match(specFingerprint(spec), /^[0-9a-f]{10}$/u, 'версия Mutagen входит в отпечаток сессии');
});
