// Мост и маршрутизатор: импорт штатного моста (digest, форма), обёртка
// (initialize, model/list, маршрут по треду, providerId в лимитах, сокет ленты),
// решение хода с синхронизацией, паспорт треда, перевод тредов в каскад.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { ACCOUNTS, MAC, MAC_CODEX, MAC_GW, TRU, TRU_MAX, UA, UA_CODEX, UA_PRO, config as baseConfig, exhausted, ok } from '../fixtures.ts';
import type { CascadeConfig } from '../contract.ts';
import { newThreadIdFrom, parseAdoptArgs, runAdopt, type AdoptPorts, type AdoptThread } from './adopt.ts';
import { digestMap, nativeBridgeStatus } from './digests.ts';
import { createTimelineFeed } from './feed.ts';
import { artifactCacheRoot, loadNativeBridge, NativeLoadError, nativeLoadHint } from './native.ts';
import { createRouteService, type RouteDeps, type StoredThreadState, type SyncOutcome } from './route-service.ts';
import { createCascadeBridge, launcherScript } from './wrapper.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
/** Тесты не ходят на настоящий сервер BB (BB_SERVER_URL в окружении треда). */
const NO_SERVER = { call: async () => { throw new Error('сервера в тесте нет'); } };

/** Фальшивый кэш артефактов демона: provider-claude-code/<digest>/host.mjs. */
function fakeCache(source: string, pluginId = 'provider-claude-code') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cascade-cache-')));
  const digest = sha(source);
  mkdirSync(join(root, pluginId, digest), { recursive: true });
  writeFileSync(join(root, pluginId, digest, 'host.mjs'), source);
  return { root, digest };
}

const GOOD_BRIDGE = `
export const experimental_providerBridge = {
  experimental_apiVersion: 1,
  start(ctx) { globalThis.__started = ctx.pluginId; },
  handleLine(line) { (globalThis.__lines ??= []).push(line); },
};
export default { contract: {} };
`;

test('импорт штатного моста: digest и форма как в Plugin Keeper', async () => {
  const { root, digest } = fakeCache(GOOD_BRIDGE);
  const loaded = await loadNativeBridge('claude-code', digest, { cacheRoot: root });
  assert.equal(loaded.digest, digest);
  assert.equal(typeof loaded.entry.handleLine, 'function');
  // Версия неизвестна (initialize) — берётся самая свежая.
  assert.equal((await loadNativeBridge('claude-code', null, { cacheRoot: root })).digest, digest);
  // Сервер ждёт другую версию: артефакта нет — понятная подсказка.
  const missing = await loadNativeBridge('claude-code', sha('другая'), { cacheRoot: root }).catch(e => e);
  assert.ok(missing instanceof NativeLoadError && missing.code === 'artifact-missing');
  assert.match(nativeLoadHint(missing), /Запустите один короткий ход штатного Claude Code/u);
  // Файл подменён: sha256 не совпал.
  const tampered = await loadNativeBridge('claude-code', digest, { cacheRoot: root, hash: () => sha('x') }).catch(e => e);
  assert.equal(tampered.code, 'digest-mismatch');
  // BB изменил форму экспорта.
  const bad = fakeCache('export const experimental_providerBridge = { experimental_apiVersion: 2, handleLine() {} };');
  const shape = await loadNativeBridge('claude-code', bad.digest, { cacheRoot: bad.root }).catch(e => e);
  assert.equal(shape.code, 'shape');
  assert.match(nativeLoadHint(shape), /Треды на штатных провайдерах работают как раньше/u);
  // Корень кэша — два уровня над каталогом своего артефакта.
  assert.equal(artifactCacheRoot(pathToFileURL('/d/plugin-host-artifacts/agentcli-subscriptions-cascade/abc/host.mjs').href), '/d/plugin-host-artifacts');
});

test('digest на сервере = sha256(<rootDir>/dist/host.js); нет плагина — причина', async () => {
  const statuses = await nativeBridgeStatus(
    async () => [{ id: 'provider-claude-code', rootDir: '/p/claude', enabled: true, version: '0.50.1' }, { id: 'provider-codex', rootDir: '/p/codex', enabled: false }],
    async path => { assert.equal(path, '/p/claude/dist/host.js'); return Buffer.from('artifact'); },
  );
  assert.equal(statuses[0]!.digest, sha('artifact'));
  assert.equal(statuses[1]!.digest, null);
  assert.match(statuses[1]!.problem!, /выключен/u);
  assert.deepEqual(digestMap(statuses), { 'claude-code': sha('artifact') });
});

/** Обёртка с фальшивым штатным мостом: его вывод идёт через ingestInnerOutput. */
function wrapperFixture(options: { missing?: boolean } = {}) {
  const out: Record<string, unknown>[] = [];
  const innerLines: string[] = [];
  const digest = sha('claude-v1');
  let bridge: ReturnType<typeof createCascadeBridge>;
  const inner = {
    experimental_apiVersion: 1 as const,
    handleLine(line: string) {
      innerLines.push(line);
      const m = JSON.parse(line) as { id?: unknown; method?: string; params?: { threadId?: string } };
      if (m.method === 'initialize') bridge.ingestInnerOutput(`${JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { ok: true, protocolVersion: 2, capabilities: { sessionRestore: true } } })}\n`);
      if (m.method === 'turn/start') {
        bridge.ingestInnerOutput(`${JSON.stringify({ jsonrpc: '2.0', method: 'thread/delta', params: { threadId: m.params!.threadId, deltas: [{ kind: 'turn.open', providerTurnId: 'pt-1' }, { kind: 'provider.rateLimits', rateLimits: { providerId: 'claude-code', status: 'blocked' } }] } })}\n`);
        bridge.ingestInnerOutput(`${JSON.stringify({ jsonrpc: '2.0', id: 'q1', method: 'interaction/request', params: { threadId: m.params!.threadId } })}\n`);
      }
    },
  };
  const socketDir = realpathSync(mkdtempSync(join(tmpdir(), 'cxs-')));
  bridge = createCascadeBridge({
    providerId: 'subscriptions-cascade',
    ownArtifactUrl: pathToFileURL('/x/plugin-host-artifacts/agentcli-subscriptions-cascade/d/host.mjs').href,
    loadDeps: {
      cacheRoot: '/cache',
      hash: () => digest,
      importModule: async () => { if (options.missing) throw new Error('нет'); return { experimental_providerBridge: inner }; },
    },
    feed: createTimelineFeed({ now: () => 1_000 }),
    server: NO_SERVER,
    write: line => { out.push(JSON.parse(line) as Record<string, unknown>); },
    socketDir,
  });
  return { bridge, out, innerLines, digest, socketDir };
}

test('обёртка: initialize — ответ штатного моста, model/list — профили каскада, ход — мост нужной версии', async () => {
  const fx = wrapperFixture();
  // Корень кэша фальшивый, но существование файла проверяется до импорта: подменим через digest null-путь.
  // Вместо файловой системы — существование host.mjs обходим, создав кэш.
  const cache = fakeCache('claude-v1');
  (fx.bridge as unknown as { close(): Promise<void> });
  const bridge = createCascadeBridge({
    providerId: 'subscriptions-cascade',
    ownArtifactUrl: pathToFileURL('/x/a/b/host.mjs').href,
    loadDeps: { cacheRoot: cache.root, importModule: async () => ({ experimental_providerBridge: { experimental_apiVersion: 1, handleLine: (l: string) => {
      fx.innerLines.push(l);
      const m = JSON.parse(l) as { id?: unknown; method?: string; params?: { threadId?: string } };
      if (m.method === 'initialize') bridge.ingestInnerOutput(`${JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { ok: true, capabilities: { sessionRestore: true } } })}\n`);
      if (m.method === 'turn/start') {
        bridge.ingestInnerOutput(`${JSON.stringify({ jsonrpc: '2.0', method: 'thread/delta', params: { threadId: m.params!.threadId, deltas: [{ kind: 'turn.open', providerTurnId: 'pt-1' }, { kind: 'provider.rateLimits', rateLimits: { providerId: 'claude-code' } }] } })}\n`);
        bridge.ingestInnerOutput(`${JSON.stringify({ jsonrpc: '2.0', id: 'q1', method: 'interaction/request', params: { threadId: m.params!.threadId } })}\n`);
      }
    } } }) },
    feed: createTimelineFeed({ now: () => 1_000 }),
    server: NO_SERVER,
    write: line => { fx.out.push(JSON.parse(line) as Record<string, unknown>); },
    socketDir: fx.socketDir,
  });
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'cxd-')));
  const before = process.env.BB_CLAUDE_CODE_EXECUTABLE;
  bridge.start!({ pluginId: 'agentcli-subscriptions-cascade', dataDir, tempDir: dataDir });
  try {
    assert.equal(process.env.BB_CLAUDE_CODE_EXECUTABLE, join(dataDir, 'launcher', 'claude-code.sh'));
    assert.match(readFileSync(join(dataDir, 'launcher', 'claude-code.sh'), 'utf8'), /CASCADE_LAUNCHER_PROVIDER=claude-code/u);
    bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 2, client: { name: 'bb', version: '1' } } }));
    bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'model/list', params: { providerOptions: { catalog: [{ id: 'auto' }] } } }));
    bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'turn/start', params: { threadId: 'thr_1', options: { providerOptions: { cascade: { provider: 'claude-code', digests: { 'claude-code': cache.digest } } } } } }));
    bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 'q1', result: { decision: 'allow_once' } }));
    // Другая версия моста, которой на машине нет — ход отклонён с подсказкой, тред цел.
    bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'turn/start', params: { threadId: 'thr_2', options: { providerOptions: { cascade: { provider: 'claude-code', digests: { 'claude-code': sha('новая версия') } } } } } }));
    await bridge.close();
    // Сокет ленты: события запускателя → thread/delta этого треда.
    // (сокет закрыт в close — проверяем строку до закрытия отдельным тестом ниже)
    const byId = (id: unknown) => fx.out.find(m => m.id === id) as { result?: Record<string, unknown>; error?: { message: string } } | undefined;
    assert.equal((byId(1)!.result!.capabilities as { sessionRestore: boolean }).sessionRestore, true);
    assert.deepEqual(byId(2)!.result, { models: [{ id: 'auto' }], selectedOnlyModels: [] });
    assert.match(byId(4)!.error!.message, /штатного Claude Code/u);
    // model/list штатному мосту не уходил, ответ на interaction/request вернулся ему.
    assert.ok(!fx.innerLines.some(l => l.includes('model/list')));
    assert.ok(fx.innerLines.some(l => l.includes('"q1"') && l.includes('allow_once')));
    const delta = fx.out.find(m => m.method === 'thread/delta') as { params: { deltas: { rateLimits?: { providerId: string } }[] } };
    assert.equal(delta.params.deltas[1]!.rateLimits!.providerId, 'subscriptions-cascade');
  } finally {
    if (before === undefined) delete process.env.BB_CLAUDE_CODE_EXECUTABLE; else process.env.BB_CLAUDE_CODE_EXECUTABLE = before;
    delete process.env.BB_CODEX_BRIDGE_APP_SERVER_COMMAND;
  }
});

test('обёртка: нет штатного моста — initialize отвечает сама, ход отклоняется с подсказкой', async () => {
  const fx = wrapperFixture({ missing: true });
  fx.bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
  fx.bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'thread/start', params: { threadId: 't', options: { providerOptions: { cascade: { provider: 'claude-code', digests: {} } } } } }));
  await fx.bridge.close();
  const init = fx.out.find(m => m.id === 1) as { result: { protocolVersion: number } };
  assert.equal(init.result.protocolVersion, 2);
  const start = fx.out.find(m => m.id === 2) as { error: { message: string; data: { recovery: { kind: string } } } };
  assert.equal(start.error.data.recovery.kind, 'restartRecommended');
});

/** Песочница агента запрещает unix-сокеты (EPERM) — там тест пропускается. */
async function canListenUnix(): Promise<boolean> {
  const { createServer } = await import('node:net');
  const path = join(realpathSync(mkdtempSync(join(tmpdir(), 'cxp-'))), 's.sock');
  return new Promise(resolve => {
    const server = createServer();
    server.on('error', () => resolve(false));
    server.listen(path, () => server.close(() => resolve(true)));
  });
}

test('обёртка: события запускателя через сокет → строки ленты треда', async t => {
  if (!(await canListenUnix())) { t.skip('unix-сокеты недоступны в этой среде'); return; }
  const fx = wrapperFixture();
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'cxd-')));
  fx.bridge.start!({ pluginId: 'p', dataDir, tempDir: dataDir });
  await new Promise(r => setTimeout(r, 50));  // сокет слушает асинхронно
  const socket = process.env.BB_CLAUDE_CODE_EXECUTABLE ? readFileSync(process.env.BB_CLAUDE_CODE_EXECUTABLE, 'utf8').match(/CASCADE_FEED_SOCKET='([^']+)'/u)?.[1] : undefined;
  assert.ok(socket);
  await new Promise<void>((resolve, reject) => {
    const c = connect(socket!);
    c.on('error', reject);
    c.on('connect', () => c.end(`${JSON.stringify({ threadId: 'thr_1', notes: [
      { kind: 'switch', reason: 'limit', from: { machine: 'Tru' }, to: { machine: 'Mac' }, stepId: 's' },
      { kind: 'sync', from: 'Tru', to: 'Mac', ms: 600, ok: true },
      { kind: 'run', stage: { machine: 'Mac', model: 'Opus' }, stepId: 's' },
    ] })}\n`, () => resolve()));
  });
  await new Promise(r => setTimeout(r, 50));
  await fx.bridge.close();
  delete process.env.BB_CLAUDE_CODE_EXECUTABLE;
  delete process.env.BB_CODEX_BRIDGE_APP_SERVER_COMMAND;
  const deltas = fx.out.filter(m => m.method === 'thread/delta').flatMap(m => (m.params as { threadId: string; deltas: { kind: string }[] }).deltas);
  assert.ok(deltas.length > 0);
  assert.ok(deltas.some(d => d.kind === 'item.open'));
  assert.equal((fx.out.find(m => m.method === 'thread/delta')!.params as { threadId: string }).threadId, 'thr_1');
});

test('скрипт запускателя: кавычки в путях не ломают оболочку', () => {
  const script = launcherScript({ nodePath: "/n o'de", artifact: '/a/host.mjs', provider: 'codex', self: '/s.sh', feed: null, log: '/l', pluginId: 'p' });
  assert.match(script, /exec '\/n o'\\''de' '\/a\/host\.mjs' "\$@"/u);
  assert.ok(!script.includes('CASCADE_FEED_SOCKET'));
});

// ---- Маршрутизатор ----

function cfg(mode: 'off' | 'provider' = 'provider'): CascadeConfig {
  const c = baseConfig();
  return { ...c, policies: { ...c.policies, executionMode: mode } };
}

function routeFixture(options: { health?: Record<string, ReturnType<typeof exhausted> | typeof ok>; sync?: Partial<Record<'prepare' | 'finish', SyncOutcome>>; mode?: 'off' | 'provider'; threadHost?: string } = {}) {
  const store = new Map<string, StoredThreadState>();
  const syncCalls: string[] = [];
  const observed: unknown[] = [];
  const okSync = (hostId: string): SyncOutcome => ({ ok: true, cwd: '/opt/bbfs/proj', env: { CASCADE_SYNC: '1' }, timings: [{ step: 'flush', hostId, from: TRU, to: hostId, seconds: 0.6, ok: true }], notices: [] });
  const deps: RouteDeps = {
    loadConfig: async () => cfg(options.mode),
    accounts: () => ACCOUNTS,
    health: () => stepId => options.health?.[stepId] ?? ok,
    refreshLimits: async () => {},
    observeLimit: (_c, step, o) => { observed.push([step.id, o.status]); },
    threadInfo: async () => ({ projectId: 'proj_1', hostId: options.threadHost ?? TRU, parentThreadId: null, providerId: 'subscriptions-cascade' }),
    load: async id => store.get(id),
    save: async (id, s) => { store.set(id, s); },
    sync: {
      prepareTurn: async (_t, s) => { syncCalls.push(`prepare:${s.hostId}`); return options.sync?.prepare ?? okSync(s.hostId); },
      finishTurn: async (_t, s) => { syncCalls.push(`finish:${s.hostId}`); return options.sync?.finish ?? okSync(s.hostId); },
      modeOf: () => 'lazy',
    },
    now: () => Date.parse('2026-11-27T12:00:00Z'),
  };
  return { routes: createRouteService(deps), store, syncCalls, observed };
}

const turn = { threadId: 'thr_1', projectId: 'proj_1', provider: 'claude-code' as const, requestedModel: 'auto', cwd: '/srv/projects/proj' };

test('маршрут: режим off — отказ с подсказкой; Tru свободен — ход здесь же без синхронизации', async () => {
  const off = routeFixture({ mode: 'off' });
  const r0 = await off.routes.routeTurn(turn);
  assert.equal(r0.action, 'refuse');
  const fx = routeFixture();
  const r = await fx.routes.routeTurn(turn);
  assert.equal(r.action, 'run');
  if (r.action !== 'run') return;
  assert.equal(r.stepId, TRU_MAX);
  assert.equal(r.local, true);
  assert.equal(r.cwd, null);
  assert.deepEqual(fx.syncCalls, []);
  assert.equal(fx.store.get('thr_1')!.lastRun!.hostId, TRU);
});

test('маршрут S1: Tru исчерпан — ход на Mac, строка перехода, синхронизация до и после хода', async () => {
  const fx = routeFixture({ health: { [TRU_MAX]: exhausted(Date.parse('2026-11-27T15:40:00Z')) } });
  const r = await fx.routes.routeTurn(turn);
  assert.equal(r.action, 'run');
  if (r.action !== 'run') return;
  assert.equal(r.hostId, MAC);
  assert.equal(r.stepId, MAC_GW);
  assert.equal(r.local, false);
  assert.equal(r.cwd, '/opt/bbfs/proj');
  assert.deepEqual(r.env, { CASCADE_SYNC: '1' });
  const kinds = r.notes.map(n => n.kind);
  assert.deepEqual(kinds, ['switch', 'sync', 'run', 'state']);
  const sw = r.notes[0]!;
  assert.ok(sw.kind === 'switch' && sw.reason === 'start' && sw.to.machine === cfg().machines.find(m => m.hostId === MAC)!.label);
  assert.deepEqual(fx.syncCalls, [`prepare:${MAC}`]);
  const done = await fx.routes.finishTurn({ threadId: 'thr_1', stepId: MAC_GW, hostId: MAC, exitCode: 0, limits: [{ status: 'rejected', resetsAt: 5, windowType: 'five_hour' }] });
  assert.deepEqual(fx.syncCalls, [`prepare:${MAC}`, `finish:${MAC}`]);
  assert.deepEqual(fx.observed, [[MAC_GW, 'rejected']]);
  assert.ok(done.notes.some(n => n.kind === 'problem' && /Лимит ступени исчерпан/u.test(n.message)));
  assert.equal(fx.store.get('thr_1')!.pendingFlushHostId, null);
  // Паспорт треда: ступень Mac, опора Tru, свежая копия — на опоре после flush.
  const status = await fx.routes.threadStatus('thr_1');
  assert.ok(status.cascade);
  if (!status.cascade) return;
  assert.equal(status.step!.hostId, MAC);
  assert.equal(status.anchorHostId, TRU);
  assert.equal(status.freshCopyHostId, TRU);
  assert.equal(status.syncMode, 'lazy');
});

test('маршрут S9: конфликт файлов — ход не передан, ступень не меняется', async () => {
  const fx = routeFixture({
    health: { [TRU_MAX]: exhausted(null) },
    sync: { prepare: { ok: false, reason: 'conflict', message: 'конфликт: src/a.ts', conflicts: ['src/a.ts'], timings: [], notices: [] } },
  });
  const r = await fx.routes.routeTurn(turn);
  assert.equal(r.action, 'refuse');
  if (r.action !== 'refuse') return;
  assert.match(r.message, /конфликт: src\/a\.ts/u);
  assert.ok(r.notes.some(n => n.kind === 'problem'));
  assert.equal(fx.store.get('thr_1'), undefined);
});

test('маршрут: всё исчерпано — ожидание сброса; проба моста — там же, где прошлый ход', async () => {
  const all = { [TRU_MAX]: exhausted(Date.parse('2026-11-27T14:00:00Z')), [MAC_GW]: exhausted(null), [UA_PRO]: exhausted(null), [MAC_CODEX]: exhausted(null), [UA_CODEX]: exhausted(null) };
  const fx = routeFixture({ health: all });
  const r = await fx.routes.routeTurn(turn);
  assert.equal(r.action, 'refuse');
  if (r.action === 'refuse') { assert.equal(r.retryable, true); assert.equal(r.notes[0]!.kind, 'wait'); }
  const fx2 = routeFixture({ health: { [TRU_MAX]: exhausted(null), [MAC_GW]: exhausted(null) } });
  const first = await fx2.routes.routeTurn(turn);
  assert.ok(first.action === 'run' && first.hostId === UA);
  const probe = await fx2.routes.routeTurn({ ...turn, probe: true });
  assert.ok(probe.action === 'run' && probe.hostId === UA && probe.notes.length === 0);
  assert.deepEqual(fx2.syncCalls, [`prepare:${UA}`]);
});

// ---- Перевод в каскад ----

test('adopt: разбор аргументов, план, handoff и снятие автоповтора', async () => {
  assert.ok('error' in parseAdoptArgs([]));
  assert.ok('error' in parseAdoptArgs(['--stuck', '--thread', 't']));
  const parsed = parseAdoptArgs(['--project', 'proj_1', '--dry-run']);
  assert.ok(!('error' in parsed) && parsed.projectId === 'proj_1' && parsed.dryRun);
  assert.equal(newThreadIdFrom('Handed off thr_src → thr_newone1 (cascade)', 'thr_src'), 'thr_newone1');
  const threads: AdoptThread[] = [
    { id: 'thr_a', title: 'A', providerId: 'claude-code', projectId: 'p', archived: false, status: 'error' },
    { id: 'thr_b', title: 'B', providerId: 'subscriptions-cascade', projectId: 'p', archived: false, status: 'idle' },
    { id: 'thr_c', title: 'C', providerId: 'codex', projectId: 'p', archived: false, status: 'idle' },
    { id: 'thr_d', title: 'D', providerId: 'claude-code', projectId: 'p', archived: true, status: 'error' },
  ];
  const calls: string[][] = [];
  const ports: AdoptPorts = {
    listThreads: async () => threads,
    getThread: async id => threads.find(t => t.id === id) ?? null,
    pendingRetries: async () => ['thr_c'],
    runPluginCli: async (pluginId, argv) => { calls.push([pluginId, ...argv]); return { exitCode: 0, stdout: pluginId === 'handoff' ? `new thread thr_new${argv[0]!.slice(4)}xyz1` : '', stderr: '' }; },
  };
  const base = { stuck: true, threadId: null, projectId: null, dryRun: true, model: 'auto', providerId: 'subscriptions-cascade' };
  const plan = await runAdopt(ports, base);
  assert.deepEqual(plan.map(i => [i.threadId, i.action]), [['thr_a', 'handoff'], ['thr_c', 'handoff'], ['thr_d', 'skip']]);
  assert.deepEqual(calls.filter(c => c[0] === 'handoff'), []);
  const done = await runAdopt(ports, { ...base, dryRun: false });
  assert.deepEqual(calls, [
    ['handoff', 'thr_a', '--to', 'subscriptions-cascade', '--model', 'auto'], ['provider-retry', 'cancel', 'thr_a'],
    ['handoff', 'thr_c', '--to', 'subscriptions-cascade', '--model', 'auto'], ['provider-retry', 'cancel', 'thr_c'],
  ]);
  assert.equal(done[0]!.newThreadId, 'thr_newaxyz1');
  assert.equal(done[0]!.retryCancelled, true);
});

test('сводка для другого провайдера: справка, а не указания; как дочитать тред', async () => {
  const { crossProviderBrief, historyHint } = await import('./context-brief.ts');
  const brief = crossProviderBrief({ threadId: 'thr_abc', from: 'Claude · Tru', to: 'Codex · Mac', summary: 'Цель: …', throughSeq: 42, keyMessages: [{ seq: 7, label: 'решение владельца по .env' }] });
  assert.match(brief, /^<cascade-handoff from="Claude · Tru" to="Codex · Mac" through-seq="42">/u);
  assert.match(brief, /bb thread messages thr_abc --format minimal/u);
  assert.match(brief, /bb thread messages thr_abc --message <seq> --context 2/u);
  assert.match(brief, /решение владельца по \.env — `--message 7`/u);
  assert.doesNotMatch(historyHint('t'), /Ключевые/u);
});

test('маршрут: следующая ступень другого провайдера — понятный отказ, ступень не меняется', async () => {
  const all = { [TRU_MAX]: exhausted(null), [MAC_GW]: exhausted(null), [UA_PRO]: exhausted(null) };
  const fx = routeFixture({ health: all });
  const c = cfg();
  // Codex без подтверждения, чтобы движок выбрал его сразу.
  const steps = c.steps.map(s => ({ ...s, confirm: false }));
  const routes = createRouteService({
    loadConfig: async () => ({ ...c, steps }), accounts: () => ACCOUNTS, health: () => id => all[id as keyof typeof all] ?? ok,
    refreshLimits: async () => {}, observeLimit: () => {}, threadInfo: async () => ({ projectId: 'proj_1', hostId: TRU, parentThreadId: null, providerId: 'subscriptions-cascade' }),
    load: async () => undefined, save: async () => {}, sync: null, now: () => Date.parse('2026-11-27T12:00:00Z'),
  });
  const r = await routes.routeTurn(turn);
  assert.equal(r.action, 'refuse');
  if (r.action === 'refuse') assert.match(r.message, /переход между провайдерами/u);
  void fx;
});

test('обёртка: model/list без каталога от сервера — профили каскада по умолчанию, а не пустой список', async () => {
  const { bridge, out } = wrapperFixture({ missing: true });
  bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'model/list', params: { cwd: '/' } }));
  bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'model/list', params: { providerOptions: { catalog: [] } } }));
  bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'model/list', params: { providerOptions: { catalog: [{ id: 'mine', displayName: 'Мой' }] } } }));
  await bridge.close();
  const models = (id: number) => ((out.find(m => m.id === id)!.result as { models: { id: string; isDefault?: boolean }[] }).models);
  assert.deepEqual(models(7).map(m => m.id), ['auto', 'auto-no-codex', 'opus-then-auto', 'fable-then-auto', 'only-opus-5.5', 'only-fable-5.2']);
  assert.equal(models(7)[0]!.isDefault, true);
  assert.deepEqual(models(8).map(m => m.id), models(7).map(m => m.id), 'пустой каталог — тоже статический');
  assert.deepEqual(models(9).map(m => m.id), ['mine'], 'каталог сервера главнее');
});
