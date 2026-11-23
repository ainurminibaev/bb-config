import { experimental_defineHostEntry } from '@get-bb/plugin-sdk/host';
import { hostContract } from './contract.js';
import { runnerBundle } from './runtime.generated.js';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, mkdir, stat, readFile, writeFile, rename, rm, access, link, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
const exec = promisify(execFile);

function absolute(path: string) { if (!isAbsolute(path) || path.split('/').includes('..')) throw new Error('Absolute path without .. required'); return path; }
async function sha(path: string) { const h = createHash('sha256'); for await (const c of createReadStream(path)) h.update(c); return h.digest('hex'); }

// The host daemon may run without the login-shell PATH (e.g. macOS launchd): check common places.
async function firstExisting(names: string[]) { for (const n of names) { try { await access(n); return n; } catch {} } return null; }
async function findCodex() {
  const forced = process.env.IMAGEGEN_CODEX_BIN; // explicit override (tests, unusual installs); read synchronously
  if (forced) return firstExisting([forced]);
  try { const { stdout } = await exec('/bin/sh', ['-lc', 'command -v codex'], { timeout: 10000 }); if (stdout.trim()) return stdout.trim(); } catch {}
  const home = homedir();
  return firstExisting([join(home, '.local/bin/codex'), '/opt/homebrew/bin/codex', '/usr/local/bin/codex', '/usr/bin/codex', join(home, '.npm-global/bin/codex')]);
}
async function findPython() {
  for (const p of ['python3', '/usr/bin/python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3']) {
    try { await exec(p, ['-c', 'import sys;assert sys.version_info>=(3,9)'], { timeout: 10000 }); return p; } catch {}
  }
  return null;
}

// Account identity through Codex's own app-server API (account/read): no auth files are read.
// Only a short hash of the e-mail leaves the machine, plus a masked label for humans.
let accountCache: { at: number, codex: string, value: any } | null = null;
async function codexAccount(codex: string) {
  if (accountCache && accountCache.codex === codex && Date.now() - accountCache.at < 600000) return accountCache.value;
  const value = await new Promise<any>(resolve => {
    const child = spawn(codex, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
    const done = (v: any) => { clearTimeout(timer); child.kill(); resolve(v); };
    const timer = setTimeout(() => done(null), 15000);
    child.on('error', () => done(null));
    createInterface({ input: child.stdout! }).on('line', line => {
      try {
        const msg = JSON.parse(line);
        if (msg.id !== 2) return;
        const a = msg.result?.account; const email = String(a?.email ?? '');
        done(email ? { accountId: createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 12),
          accountLabel: email.slice(0, 2) + '***@' + email.split('@')[1], plan: a.planType ?? null } : null);
      } catch {}
    });
    const send = (o: any) => child.stdin!.write(JSON.stringify(o) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'bb-image-gen', version: '1' } } });
    send({ jsonrpc: '2.0', method: 'initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'account/read', params: {} });
  });
  if (value) accountCache = { at: Date.now(), codex, value };
  return value;
}

async function materialize(dataDir: string) {
  const runtime = join(dataDir, 'runtimes', runnerBundle.sha256.slice(0, 16));
  const runner = join(runtime, 'imagegen_runner.py');
  const code = Buffer.from(runnerBundle.runner, 'base64');
  if (createHash('sha256').update(code).digest('hex') !== runnerBundle.sha256) throw new Error('Runner checksum mismatch');
  try { await access(runner); } catch {
    await mkdir(runtime, { recursive: true });
    const tmp = runner + '.' + randomUUID();
    await writeFile(tmp, code, { mode: 0o700, flag: 'wx' }); await rename(tmp, runner);
  }
  return runner;
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    // Readiness only: binary, version, feature flag and login MODE. Never reads auth files.
    async probe(_input, context) {
      const missing: string[] = [];
      const codexPath = await findCodex();
      // Codex prints some statuses (e.g. `login status`) to stderr: read both streams.
      const run = async (args: string[]) => { const r = await exec(codexPath!, args, { timeout: 15000, signal: context.signal, maxBuffer: 1 << 20 }); return r.stdout + r.stderr; };
      let version = null, login = null, feature = false;
      if (!codexPath) missing.push('Codex CLI не установлен: установите @openai/codex и выполните `codex login` (подписка ChatGPT Plus/Pro/Business)');
      else {
        try { version = (await run(['--version'])).trim(); } catch (e) { missing.push('codex does not start: ' + String(e).slice(0, 160)); }
        try { login = (await run(['login', 'status'])).split('\n').find(l => l.trim())?.trim() ?? ''; } catch (e) { login = String(e).slice(0, 200); }
        if (!/ChatGPT/i.test(login ?? '')) missing.push('Codex не вошёл через ChatGPT: выполните `codex login` (встроенный image_gen работает на подписке)');
        try { feature = /^image_generation\s+\S+\s+true/m.test(await run(['features', 'list'])); } catch {}
        if (!feature) missing.push('image_generation выключен или неизвестен этой версии Codex: обновите Codex');
      }
      const python = await findPython();
      if (!python) missing.push('python3 >= 3.9 не найден');
      const account = codexPath && !missing.length ? await codexAccount(codexPath) : null;
      return { ready: missing.length === 0, missing, version, login, codexPath, python, platform: process.platform, ...(account ?? {}) };
    },
    async jobDir({ jobId }, context) {
      const jobDir = join(context.experimental_paths.dataDir, 'jobs', jobId);
      await mkdir(jobDir, { recursive: true, mode: 0o700 }); return { jobDir };
    },
    async prepareJob({ jobId, request }, context) {
      const dataDir = context.experimental_paths.dataDir;
      const runner = await materialize(dataDir);
      const jobDir = join(dataDir, 'jobs', jobId);
      await mkdir(jobDir, { recursive: true, mode: 0o700 });
      const target = join(jobDir, 'request.json');
      try { await writeFile(target, JSON.stringify(request), { flag: 'wx', mode: 0o600 }); }
      catch (e: any) { if (e.code !== 'EEXIST') throw e; } // idempotent: never rewrite an accepted request
      return { jobDir, runner, python: (await findPython()) ?? 'python3' };
    },
    async readResult({ jobDir }) {
      absolute(jobDir);
      const read = async (n: string) => { try { return JSON.parse(await readFile(join(jobDir, n), 'utf8')); } catch { return null; } };
      return { result: await read('result.json'), attempt: await read('attempt.json') };
    },
    async lease({ path, token, expiresAt, create }) {
      absolute(path); if (!path.endsWith('/.lease.json')) throw new Error('Invalid lease path');
      const data = JSON.stringify({ token, expiresAt });
      if (create) { await writeFile(path, data, { flag: 'wx', mode: 0o600 }); return true; }
      const current = JSON.parse(await readFile(path, 'utf8'));
      if (current.token !== token || current.expiresAt <= Date.now()) return false;
      const tmp = path + '.' + randomUUID(); await writeFile(tmp, data, { flag: 'wx', mode: 0o600 }); await rename(tmp, path); return true;
    },
    async info({ path }) { absolute(path); return { size: (await stat(path)).size, sha256: await sha(path) }; },
    async read({ path, offset, size }) {
      absolute(path); const f = await open(path, 'r');
      try { const b = Buffer.alloc(size); const { bytesRead } = await f.read(b, 0, size, offset); return b.subarray(0, bytesRead).toString('base64'); }
      finally { await f.close(); }
    },
    // Chunked write to <path>.part; final chunk verifies sha256 and links without overwriting.
    async write({ path, transferId, offset, data, sha256, final }) {
      absolute(path); await mkdir(dirname(path), { recursive: true });
      // One temp file per transfer: concurrent deliveries cannot corrupt each other.
      const part = path + '.part-' + transferId; const f = await open(part, offset === 0 ? 'w' : 'r+', 0o600);
      try { await f.write(Buffer.from(data, 'base64'), 0, undefined, offset); } finally { await f.close(); }
      if (!final) return { ok: true };
      if (sha256 && await sha(part) !== sha256) { await unlink(part); throw new Error('Checksum mismatch after transfer'); }
      try { await link(part, path); } catch (e: any) {
        if (e.code === 'EEXIST' && sha256 && await sha(path) === sha256) { await unlink(part); return { ok: true, path, existed: true }; }
        throw e;
      }
      await unlink(part); return { ok: true, path };
    },
    async cleanup({ jobDir }, context) {
      absolute(jobDir);
      if (!jobDir.startsWith(join(context.experimental_paths.dataDir, 'jobs') + '/')) throw new Error('Refusing to clean outside jobs root');
      await rm(jobDir, { recursive: true, force: true }); return true;
    },
  },
});
