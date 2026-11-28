// Согласия, мастер, мост-заглушка, разбор событий, служебные строки, конфигурация.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClaudeFrame, parseCodexFrame } from './adapters.ts';
import { handleBridgeMessage, NOT_READY_MESSAGE } from './bridge-stub.ts';
import { bindingEpoch, normalizeConfig, syncIgnores, syncModeFor } from './config.ts';
import { consentCovers, grant, pruneConsents, type ConsentContext } from './consent.ts';
import type { Machine, WizardMachineState } from './contract.ts';
import { config, MAC, NOW } from './fixtures.ts';
import { emptyWizardState, isSafeUnixPath, nextStep, runWizard, wizardPlan, type WizardDeps } from './wizard.ts';

const ctx: ConsentContext = { stepId: 's', bindingEpoch: 'e', threadId: 'thr_1', turnId: 't1', projectId: 'p1', now: NOW };

test('согласия: ход, тред до сброса, навсегда; подтред не наследует', () => {
  const turn = grant('turn', ctx, null);
  assert.equal(consentCovers(turn, ctx), true);
  assert.equal(consentCovers(turn, { ...ctx, turnId: 't2' }), false);
  const thread = grant('thread', ctx, NOW + 3_600_000);
  assert.equal(consentCovers(thread, { ...ctx, turnId: 't2' }), true);
  assert.equal(consentCovers(thread, { ...ctx, now: NOW + 3_600_000 }), false, 'сброс гасит тредовое согласие');
  assert.equal(consentCovers(thread, { ...ctx, threadId: 'thr_sub' }), false, 'подтред — свой тред');
  const forever = grant('forever', ctx, null);
  assert.equal(consentCovers(forever, { ...ctx, threadId: 'thr_sub', turnId: 'x' }), true);
  assert.equal(consentCovers(forever, { ...ctx, projectId: 'p2' }), false);
  assert.equal(consentCovers(forever, { ...ctx, bindingEpoch: 'e2' }), false);
  assert.deepEqual(pruneConsents([turn, thread], new Map([['s', 'e']]), NOW + 3_600_000), [turn]);
});

test('bindingEpoch меняется при смене профиля, шлюза и источника квоты', () => {
  const step = config().steps[1]!;
  const base = bindingEpoch(step);
  assert.equal(bindingEpoch({ ...step }), base);
  assert.notEqual(bindingEpoch({ ...step, profileRef: 'work' }), base);
  assert.notEqual(bindingEpoch({ ...step, authority: 'subscription' }), base);
  assert.notEqual(bindingEpoch({ ...step, quotaSource: 'provider' }), base);
});

test('normalizeConfig: дубликаты, ступени на неизвестных машинах, одна опора, битый ввод', () => {
  const c = config();
  const messy = { ...c, machines: [...c.machines, { ...c.machines[0]! }].map(m => ({ ...m, anchor: true })), steps: [...c.steps, { ...c.steps[0]!, id: 'x', hostId: 'gone' }] };
  const n = normalizeConfig(messy);
  assert.equal(n.machines.length, 3, 'Tru, Mac, UA без дубликата');
  assert.equal(n.machines.filter(m => m.anchor).length, 1);
  assert.ok(!n.steps.some(s => s.hostId === 'gone'));
  assert.deepEqual(normalizeConfig('мусор').steps, []);
});

test('файлы: ленивый по умолчанию, режим проекта, .env по настройке', () => {
  const c = config();
  assert.equal(syncModeFor(c, 'p1'), 'lazy');
  c.files.projectSyncModes.p1 = 'warm';
  assert.equal(syncModeFor(c, 'p1'), 'warm');
  assert.ok(syncIgnores(c).includes('node_modules') && !syncIgnores(c).includes('.env'));
  c.files.syncEnv = false;
  assert.ok(syncIgnores(c).includes('.env'));
});

test('план мастера по платформам', () => {
  const mac = wizardPlan({ sharedPath: '/opt/bbfs' }, { platform: 'macos', isRoot: false });
  const folder = mac.find(s => s.id === 'folder')!;
  assert.equal(folder.privilege, 'macos-dialog');
  assert.equal(folder.apply, `u="$(id -un)"; osascript -e "do shell script \\"mkdir -p '/opt/bbfs' && chown $u '/opt/bbfs'\\" with administrator privileges"`);
  const root = wizardPlan({ sharedPath: '/opt/bbfs' }, { platform: 'linux', isRoot: true });
  assert.equal(root.find(s => s.id === 'folder')!.apply, "mkdir -p '/opt/bbfs'");
  assert.ok(!root.some(s => s.apply?.includes('sudo')));
  const user = wizardPlan({ sharedPath: '/opt/bbfs' }, { platform: 'wsl', isRoot: false });
  assert.match(user.find(s => s.id === 'folder')!.apply!, /^sudo -n mkdir/);
  const win = wizardPlan({ sharedPath: 'C:\\bbfs' }, { platform: 'windows', isRoot: false });
  assert.equal(win.find(s => s.id === 'mutagen')!.privilege, 'manual');
  assert.equal(isSafeUnixPath('/opt/bb fs'), false);
  assert.equal(wizardPlan({ sharedPath: '/opt/$(rm)' }, { platform: 'linux', isRoot: true }).find(s => s.id === 'folder')!.privilege, 'manual');
});

function deps(log: string[], failFolder = false): WizardDeps & { saved: WizardMachineState[] } {
  const saved: WizardMachineState[] = [];
  const done = new Set<string>();
  return {
    saved,
    probe: async () => ({ platform: 'linux', isRoot: true, user: 'root', sharedPathExists: false, sharedPathWritable: false, mutagenVersion: null }),
    exec: async (_m, _p, command) => {
      log.push(command);
      if (command.startsWith('test -d')) return { exitCode: done.has('folder') ? 0 : 1, output: '' };
      if (command.startsWith('mkdir')) { if (failFolder) return { exitCode: 1, output: 'нет места' }; done.add('folder'); return { exitCode: 0, output: '' }; }
      if (command.startsWith('for b in')) return { exitCode: done.has('mutagen') ? 0 : 1, output: '0.18.1' };
      if (command.startsWith('set -e')) { done.add('mutagen'); return { exitCode: 0, output: '' }; }
      if (command.startsWith('test -w')) return { exitCode: 0, output: '0.18.1' };
      return { exitCode: 1, output: '?' };
    },
    writeProbe: async () => true,
    save: async s => { saved.push(structuredClone(s)); },
    now: () => '2026-11-27T12:00:00Z',
  };
}

const machine: Machine = { hostId: MAC, label: 'Tru', enabled: true, platform: 'linux', sharedPath: '/opt/bbfs', pathTranslation: false, anchor: true, anchorSsh: null, sshAddress: null };

test('мастер: проходит шаги, повтор безопасен, ошибка останавливает машину', async () => {
  const log: string[] = [];
  const [state] = await runWizard([machine], new Map(), deps(log), false);
  assert.equal(nextStep(state!), null);
  assert.deepEqual(Object.fromEntries(Object.entries(state!.steps).map(([k, v]) => [k, v.status])), { probe: 'done', folder: 'done', mutagen: 'done', ssh: 'skipped', verify: 'done' }, 'опора — SSH не нужен');
  const failed = await runWizard([machine], new Map(), deps([], true), false);
  assert.equal(failed[0]!.steps.folder!.status, 'failed');
  assert.equal(failed[0]!.steps.mutagen!.status, 'pending', 'после ошибки дальше не идёт');
  assert.equal(nextStep(failed[0]!), 'folder', 'следующий запуск продолжит с папки');
});

test('мастер: предпросмотр ничего не выполняет на машине', async () => {
  const log: string[] = [];
  const d = deps(log);
  const [state] = await runWizard([machine], new Map([[MAC, emptyWizardState(MAC)]]), d, true);
  assert.deepEqual(log, []);
  assert.deepEqual(d.saved, []);
  assert.equal(state!.steps.folder!.message, 'будет выполнено');
});

test('мост-заглушка: initialize, model/list из каталога, ход — понятная ошибка', () => {
  const init = handleBridgeMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 2 } })[0]!;
  assert.equal((init.result as { protocolVersion: number }).protocolVersion, 2);
  const catalog = [{ id: 'auto', displayName: 'Авто' }];
  const list = handleBridgeMessage({ jsonrpc: '2.0', id: 2, method: 'model/list', params: { providerOptions: { catalog } } })[0]!;
  assert.deepEqual(list.result, { models: catalog, selectedOnlyModels: [] });
  const turn = handleBridgeMessage({ jsonrpc: '2.0', id: 3, method: 'turn/start', params: {} })[0]!;
  assert.equal(turn.error?.message, NOT_READY_MESSAGE);
  assert.equal(handleBridgeMessage({ jsonrpc: '2.0', id: 4, method: 'x/y' })[0]!.error?.code, -32601);
  assert.deepEqual(handleBridgeMessage({ jsonrpc: '2.0', method: 'initialized' }), []);
});

test('разбор событий Claude stream-json', () => {
  assert.deepEqual(parseClaudeFrame('{"type":"system","subtype":"init","session_id":"s-1"}'), [{ kind: 'session', nativeId: 's-1' }]);
  assert.deepEqual(parseClaudeFrame({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Привет' }, { type: 'tool_use', id: 'tu1' }] } }),
    [{ kind: 'text', item: 'm1:0', text: 'Привет', mode: 'replace' }, { kind: 'tool', call: 'tu1', state: 'inFlight' }]);
  assert.deepEqual(parseClaudeFrame({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1' }] } }), [{ kind: 'tool', call: 'tu1', state: 'done' }]);
  assert.deepEqual(parseClaudeFrame({ type: 'result', subtype: 'success', is_error: false }), [{ kind: 'end', status: 'completed' }]);
  assert.deepEqual(parseClaudeFrame('не json'), [{ kind: 'diagnostic', code: 'claude:unparsed' }]);
});

test('разбор событий Codex app-server', () => {
  assert.deepEqual(parseCodexFrame({ method: 'thread/started', params: { thread: { id: 'th-1' } } }), [{ kind: 'session', nativeId: 'th-1' }]);
  assert.deepEqual(parseCodexFrame({ method: 'item/agentMessage/delta', params: { itemId: 'i1', delta: 'при' } }), [{ kind: 'text', item: 'i1', text: 'при', mode: 'append' }]);
  assert.deepEqual(parseCodexFrame({ id: 7, method: 'item/commandExecution/requestApproval', params: { itemId: 'c1', reason: 'npm test' } }), [{ kind: 'approval', request: '7', call: 'c1', summary: 'npm test' }]);
  assert.deepEqual(parseCodexFrame({ method: 'turn/completed', params: { turn: { status: 'interrupted' } } }), [{ kind: 'end', status: 'interrupted' }]);
});
