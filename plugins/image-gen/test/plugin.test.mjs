// End-to-end test of the BUILT plugin (dist/server.js + dist/host.js) against a fake BB:
// two machines, KV, terminals that really spawn the runner, and a fake Codex. No real generation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = join(root, 'runner', 'fake_codex.py');
const plugin = (await import(join(root, 'dist', 'server.js'))).default;
const hostEntry = (await import(join(root, 'dist', 'host.js'))).default;
const handlers = hostEntry.handlers ?? hostEntry.definition?.handlers ?? hostEntry;
const sha = p => createHash('sha256').update(readFileSync(p)).digest('hex');

function world({ machines = ['hub', 'mac'], codexOn = machines, settings = {}, kvStore = new Map(), mode = 'ok', delaySec = 0, reuse = null } = {}) {
  const base = reuse?.base ?? mkdtempSync(join(tmpdir(), 'imagegen-e2e-'));
  const calls = join(base, 'codex-calls.txt');
  const dirs = reuse?.dirs ?? Object.fromEntries(machines.map(m => [m, { data: join(base, m, 'host-data'), codexHome: join(base, m, 'codex-home'), work: join(base, m, 'project') }]));
  for (const d of Object.values(dirs)) Object.values(d).forEach(p => mkdirSync(p, { recursive: true }));
  const threads = { t_claude: { providerId: 'claude-code', environmentId: 'env_hub' }, t_codex: { providerId: 'codex', environmentId: 'env_hub' },
    t_mac: { providerId: 'claude-code', environmentId: 'env_mac' } };
  const sent = [], terminals = reuse?.terminals ?? new Map(), tools = {}, services = [];
  let rpc, instructions, cli;
  const values = { accountGroups: '{}', workerHosts: '[]', maxTier: 0, executorModel: '', openaiApiKey: '', apiModel: 'gpt-image-1', keepDays: 30, leaseSeconds: 120, ...settings };
  const env = { mode, delaySec };
  const call = async (method, input, { hostId }) => {
    if (!dirs[hostId]) throw new Error('unknown host ' + hostId);
    process.env.IMAGEGEN_CODEX_BIN = codexOn.includes(hostId) ? FAKE : '/nonexistent/codex'; // read synchronously by the handler
    const fn = handlers[method]; if (!fn) throw new Error('no host handler ' + method);
    return fn(input, { experimental_paths: { dataDir: dirs[hostId].data }, signal: new AbortController().signal });
  };
  const bb = {
    settings: { define: () => ({ get: async () => values, experimental_set: async v => Object.assign(values, v) }) },
    hosts: { experimental_client: () => ({ call }) },
    storage: { kv: { get: async k => structuredClone(kvStore.get(k)), set: async (k, v) => void kvStore.set(k, structuredClone(v)),
      delete: async k => void kvStore.delete(k), list: async (p = '') => [...kvStore.keys()].filter(k => k.startsWith(p)) } },
    sdk: {
      threads: {
        get: async ({ threadId }) => ({ thread: { id: threadId, ...threads[threadId] } }),
        list: async () => ({ threads: Object.entries(threads).map(([id, t]) => ({ id, ...t })) }),
        send: async m => { sent.push(m); return { ok: true, delivery: 'queued' }; },
        queuedMessages: { list: async () => [] }, timeline: async () => ({ rows: [] }),
      },
      environments: { get: async ({ environmentId }) => ({ hostId: environmentId.replace('env_', '') }) },
      hosts: { list: async () => machines.map(id => ({ id, name: id.toUpperCase(), status: 'connected' })) },
      terminals: {
        create: async ({ id, scope, start }) => {
          const [cmd, ...args] = start.argv;
          const child = spawn(cmd, args, { cwd: scope.cwd, stdio: 'ignore', env: { ...process.env, CODEX_HOME: dirs[scope.hostId].codexHome,
            FAKE_CODEX_MODE: env.mode, FAKE_CODEX_DELAY: String(env.delaySec), FAKE_CODEX_CALLS: calls } });
          const t = { id, status: 'running', exitCode: null, child }; child.on('exit', c => { t.status = 'exited'; t.exitCode = c; });
          terminals.set(id, t); return { id };
        },
        get: async ({ terminalId }) => { const t = terminals.get(terminalId); if (!t) throw new Error('not found'); return { id: t.id, status: t.status, exitCode: t.exitCode }; },
        close: async ({ terminalId }) => { terminals.get(terminalId)?.child.kill('SIGKILL'); },
      },
    },
    rpc: { register: (_c, h) => { rpc = h; } },
    agents: { registerTool: t => { tools[t.name] = t; }, contributeInstructions: f => { instructions = f; } },
    cli: { register: r => { cli = r; } },
    background: { service: (name, s) => services.push(s) },
    log: { info() {}, warn() {}, error: m => console.error('[plugin]', m), debug() {} },
  };
  plugin(bb);
  const ac = new AbortController();
  services.forEach(s => s.start(ac.signal));
  const codexRuns = () => existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  const tool = async (name, input, threadId = 't_claude') => JSON.parse(await tools[name].execute(input, { threadId, projectId: 'p', signal: new AbortController().signal }));
  return { base, dirs, terminals, halt: () => ac.abort(), sent, tools, tool, rpc: () => rpc, instructions: () => instructions, cli: () => cli, kvStore, env, codexRuns, values,
    stop: () => { ac.abort(); terminals.forEach(t => t.child.kill('SIGKILL')); } };
}

test('Claude thread: generate returns the file inline, with provenance, without threads', async () => {
  const w = world();
  try {
    const out = join(w.dirs.hub.work, 'img');
    const r = await w.tool('image_generate', { prompt: 'blue circle', outputDir: out });
    assert.equal(r.state, 'completed', JSON.stringify(r));
    assert.equal(r.files.length, 1);
    assert.equal(sha(r.files[0].path), r.files[0].sha256);
    const meta = JSON.parse(readFileSync(r.files[0].provenance, 'utf8'));
    assert.equal(meta.jobId, r.jobId); assert.equal(meta.prompt, 'blue circle'); assert.equal(meta.sourceThreadId, 't_claude');
    assert.equal(r.executor, 'hub:codex');
    const again = await w.tool('image_generate', { prompt: 'blue circle', outputDir: out });
    assert.equal(again.jobId, r.jobId); assert.equal(w.codexRuns().length, 1, 'repeat must not generate again');
    await delay(6000);
    assert.equal(w.sent.length, 0, 'inline result must not also send a notification');
  } finally { w.stop(); }
});

test('cross-machine: caller on Mac, executor pinned to Hub, file lands on Mac', async () => {
  const w = world();
  try {
    const out = join(w.dirs.mac.work, 'img');
    const r = await w.tool('image_generate', { prompt: 'x', outputDir: out, executor: 'HUB' }, 't_mac');
    assert.equal(r.state, 'completed', JSON.stringify(r));
    assert.equal(r.executor, 'hub:codex');
    assert.ok(r.files[0].path.startsWith(out));
    assert.equal(readdirSync(join(w.dirs.hub.codexHome, 'generated_images')).length, 0, 'executor cleans Codex originals');
  } finally { w.stop(); }
});

test('image_edit sends the image as reference in edit mode, original untouched', async () => {
  const w = world();
  try {
    const src = join(w.dirs.mac.work, 'photo.png'); writeFileSync(src, Buffer.from('89504e470d0a1a0a', 'hex'));
    const before = sha(src);
    const r = await w.tool('image_edit', { image: src, instruction: 'remove background', outputDir: join(w.dirs.mac.work, 'out') }, 't_mac');
    assert.equal(r.state, 'completed', JSON.stringify(r));
    const argv = w.codexRuns()[0];
    assert.ok(argv.includes('-i'));
    assert.match(argv.at(-1), /Edit the first attached image/);
    assert.equal(sha(src), before);
  } finally { w.stop(); }
});

test('nobody has Codex and no API key: clear failure with what to install', async () => {
  const w = world({ codexOn: [] });
  try {
    const r = await w.tool('image_generate', { prompt: 'x', outputDir: join(w.dirs.hub.work, 'o') });
    assert.equal(r.state, 'failed');
    assert.match(r.error, /codex login/); assert.match(r.error, /maxTier=1/);
    const svc = await w.tool('image_services', {});
    assert.ok(svc.every(s => !s.ready));
    const again = await w.tool('image_generate', { prompt: 'x', outputDir: join(w.dirs.hub.work, 'o') });
    assert.notEqual(again.jobId, r.jobId, 'a known failure must not block a new request');
  } finally { w.stop(); }
});

test('caller machine without Codex: another machine generates, file returns to caller', async () => {
  const w = world({ codexOn: ['hub'] });
  try {
    const r = await w.tool('image_generate', { prompt: 'x', outputDir: join(w.dirs.mac.work, 'o') }, 't_mac');
    assert.equal(r.state, 'completed', JSON.stringify(r)); assert.equal(r.executor, 'hub:codex');
  } finally { w.stop(); }
});

test('no Codex anywhere but paid API enabled: generated through OpenAI API (fake fetch)', async () => {
  const realFetch = globalThis.fetch; let requests = 0;
  globalThis.fetch = async (url, init) => { requests++; assert.match(String(url), /images\/generations$/); assert.match(init.headers.Authorization, /^Bearer test-key$/);
    return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('fakepng').toString('base64') }] }), { status: 200 }); };
  const w = world({ codexOn: [], settings: { maxTier: 1, openaiApiKey: 'test-key' } });
  try {
    const r = await w.tool('image_generate', { prompt: 'x', outputDir: join(w.dirs.hub.work, 'o') });
    assert.equal(r.state, 'completed', JSON.stringify(r)); assert.equal(r.executor, 'server:openai'); assert.equal(requests, 1);
    assert.equal(readFileSync(r.files[0].path, 'utf8'), 'fakepng');
  } finally { w.stop(); globalThis.fetch = realFetch; }
});

test('limit on a shared account stops; a different account group takes over', async () => {
  const w = world({ mode: 'limit' });
  try {
    const r = await w.tool('image_generate', { prompt: 'x', outputDir: join(w.dirs.hub.work, 'o') });
    assert.equal(r.state, 'limited', JSON.stringify(r)); assert.match(r.resetHint ?? '', /6:40/);
    assert.equal(w.codexRuns().length, 1, 'same account on Mac must not be tried');
  } finally { w.stop(); }
  const w2 = world({ mode: 'limit', settings: { accountGroups: JSON.stringify({ mac: 'second-account' }) } });
  try {
    const r = await w2.tool('image_generate', { prompt: 'x', outputDir: join(w2.dirs.hub.work, 'o'), waitSeconds: 25 });
    assert.equal(w2.codexRuns().length, 2, JSON.stringify(r)); // hub (limited) -> mac (other account; fake still limited)
    assert.equal(r.state, 'limited');
  } finally { w2.stop(); }
});

test('async path: jobId now, exactly one notification later', async () => {
  const w = world({ delaySec: 3 });
  try {
    const r = await w.tool('image_generate', { prompt: 'x', outputDir: join(w.dirs.hub.work, 'o'), waitSeconds: 0 });
    assert.ok(['queued', 'starting', 'running'].includes(r.state)); assert.match(r.wait, /Заверши ход/);
    for (let i = 0; i < 30 && !w.sent.length; i++) await delay(1000);
    await delay(6000);
    assert.equal(w.sent.length, 1); assert.match(w.sent[0].input[0].text, new RegExp(`\\[image-gen:${r.jobId}:completed\\]`));
    assert.equal(w.sent[0].mode, 'queue-if-active');
  } finally { w.stop(); }
});

test('cancel kills the run, no fallback, no notification', async () => {
  const w = world({ mode: 'hang' });
  try {
    const r = await w.tool('image_generate', { prompt: 'x', outputDir: join(w.dirs.hub.work, 'o'), waitSeconds: 0 });
    for (let i = 0; i < 20 && !w.codexRuns().length; i++) await delay(500);
    const c = await w.tool('image_cancel', { jobId: r.jobId });
    assert.equal(c.state, 'cancelled');
    await delay(7000);
    assert.equal(w.sent.length, 0); assert.equal(w.codexRuns().length, 1);
  } finally { w.stop(); }
});

test('BB server restart during generation: finishes without a second generation', async () => {
  const kvStore = new Map();
  const w = world({ kvStore, delaySec: 5 });
  const r = await w.tool('image_generate', { prompt: 'x', outputDir: join(w.dirs.hub.work, 'o'), waitSeconds: 0 });
  for (let i = 0; i < 20 && !w.codexRuns().length; i++) await delay(500);
  w.halt(); // server stops; the runner process on the machine keeps going
  const w2 = world({ kvStore, reuse: w }); // server starts again with the same KV
  try {
    let s; for (let i = 0; i < 30; i++) { s = await w2.tool('image_status', { jobId: r.jobId }); if (s.state === 'completed') break; await delay(1000); }
    assert.equal(s.state, 'completed', JSON.stringify(s));
    assert.equal(w2.codexRuns().length, 1, 'no second generation after restart');
  } finally { w2.stop(); }
});

test('instructions: Codex thread generates itself, Claude thread uses image_generate/image_edit', async () => {
  const w = world();
  try {
    await delay(5500); // provider cache refresh
    assert.match(w.instructions()({ threadId: 't_codex' }), /встроенным image_gen/);
    assert.match(w.instructions()({ threadId: 't_claude' }), /image_edit/);
    assert.doesNotMatch(w.instructions()({ threadId: 't_claude' }), /генерируй сам/);
  } finally { w.stop(); }
});

test('CLI: bb image-gen services / generate', async () => {
  const w = world();
  try {
    const s = await w.cli().run(['services'], { threadId: 't_claude' });
    assert.equal(s.exitCode, 0); assert.ok(JSON.parse(s.stdout).some(x => x.ready));
    const g = await w.cli().run(['generate', '--prompt', 'x', '--out', join(w.dirs.hub.work, 'cli')], { threadId: 't_claude' });
    assert.equal(g.exitCode, 0, g.stderr); assert.equal(JSON.parse(g.stdout).state, 'completed');
    const h = await w.cli().run([], {}); assert.match(h.stdout, /bb image-gen edit/);
  } finally { w.stop(); }
});
