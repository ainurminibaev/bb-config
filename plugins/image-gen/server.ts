// Image Gen BB plugin — server part (runs once, inside the BB server process).
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { basename, extname, join } from 'node:path';
import { z } from 'zod';
import { hostContract, rpcContract, generateSchema, editSchema } from './contract.js';
import { candidates, afterAttempt, requestKey, instructionsFor, notifyJob, retentionExpired, missingHint, ACTIVE, TERMINAL } from './core/jobs.mjs';
import { openaiImages } from './core/api.mjs';

const CHUNK = 1024 * 1024;
const ALPHABET = '23456789abcdefghijkmnpqrstuvwxyz';
const API_EXECUTOR = 'server:openai';

export default function plugin(bb: any) {
  const settings = bb.settings.define({
    accountGroups: { type: 'string', label: 'Codex account group per machine ID (JSON object). Same group = shared limit.', default: '{}' },
    workerHosts: { type: 'string', label: 'Allowed executor machine IDs (JSON array; empty = all connected)', default: '[]' },
    maxTier: { type: 'number', label: 'Highest backend tier: 0 = Codex subscription only, 1 = also paid OpenAI API', default: 0, experimental_schema: z.number().int().min(0).max(1) },
    executorModel: { type: 'string', label: 'Codex model for executor runs (empty = Codex default on that machine)', default: '' },
    openaiApiKey: { type: 'string', label: 'OpenAI API key for the paid fallback (only used when maxTier >= 1)', secret: true, default: '' },
    apiModel: { type: 'string', label: 'OpenAI image model for the paid fallback', default: 'gpt-image-1' },
    keepDays: { type: 'number', label: 'Keep job records and executor folders (days)', default: 30, experimental_schema: z.number().int().min(1).max(365) },
    leaseSeconds: { type: 'number', label: 'Executor lease timeout (seconds)', default: 120, experimental_schema: z.number().int().min(30).max(240) },
  });
  const host = bb.hosts.experimental_client({ contract: hostContract });
  const kv = bb.storage.kv;
  const providerCache = new Map<string, string>();
  const runningApi = new Set<string>();
  const save = async (job: any) => { job.updatedAt = Date.now(); await kv.set('job:' + job.id, job); return job; };
  const jobs = async () => (await Promise.all((await kv.list('job:')).map((k: string) => kv.get(k)))).filter(Boolean) as any[];
  const hostOf = (executorId: string) => executorId.split(':')[0];

  async function callerOf(threadId?: string) {
    if (!threadId) return { hostId: null, providerId: null };
    const d = await bb.sdk.threads.get({ threadId }); const t = d.thread ?? d;
    if (t.providerId) providerCache.set(threadId, t.providerId);
    const env = t.environmentId ? await bb.sdk.environments.get({ environmentId: t.environmentId }) : null;
    return { hostId: env?.hostId ?? env?.environment?.hostId ?? null, providerId: t.providerId ?? null };
  }

  async function services() {
    const cfg = await settings.get();
    const allowed: string[] = JSON.parse(cfg.workerHosts || '[]'); const groups = JSON.parse(cfg.accountGroups || '{}');
    const running = (await jobs()).filter(j => ['starting', 'running'].includes(j.state)).map(j => j.executorId);
    const listed = await bb.sdk.hosts.list(); const machines = (listed.hosts ?? listed).filter((m: any) => !allowed.length || allowed.includes(m.id));
    const codex = await Promise.all(machines.map(async (m: any) => {
      const online = m.status ? m.status === 'connected' : m.connected !== false;
      const probe = !online ? { ready: false, missing: ['machine offline'] }
        : await host.call('probe', {}, { hostId: m.id }).catch((e: any) => ({ ready: false, missing: ['probe failed: ' + String(e).slice(0, 200)] }));
      const id = m.id + ':codex';
      return { id, hostId: m.id, name: m.name, backend: 'codex', tier: 0, busy: running.includes(id), ...probe,
        // Same Codex account = shared limit. Detected automatically; the setting only overrides.
        accountGroup: groups[m.id] ?? probe.accountId ?? 'default' };
    }));
    const apiMissing = [!cfg.openaiApiKey && 'OpenAI API key is not set', cfg.maxTier < 1 && 'paid fallback disabled (maxTier=0)'].filter(Boolean);
    const api = { id: API_EXECUTOR, hostId: null, name: 'OpenAI API (paid)', backend: 'api:openai', tier: 1, accountGroup: 'openai-api',
      busy: running.includes(API_EXECUTOR), ready: apiMissing.length === 0, missing: apiMissing };
    return [...codex, api];
  }

  async function submit(input: any, ctx: any) {
    const threadId = ctx.threadId ?? input.threadId;
    const caller = await callerOf(threadId);
    const callerHostId = caller.hostId ?? input.callerHostId;
    if (!callerHostId) throw new Error('Run from a BB thread or pass callerHostId (the machine of outputDir)');
    const key = 'req:' + createHash('sha256').update(requestKey({ threadId, ...input })).digest('hex');
    const existing = await kv.get(key);
    if (existing) { // dedupe running/finished/unknown jobs; a known failure may be requested again
      const job = await kv.get('job:' + existing);
      if (job && (ACTIVE.has(job.state) || ['completed', 'unknown', 'return_failed'].includes(job.state))) return job;
    }
    const all = await services(); const cfg = await settings.get();
    const exclude = input.excludeCurrentAccount ? [all.find(s => s.hostId === callerHostId)?.accountGroup ?? 'default'] : [];
    const plan = candidates(all, { callerHostId, preferred: input.executor, excludeAccounts: exclude, maxTier: cfg.maxTier });
    const id = 'img_' + randomUUID().replace(/-/g, '').slice(0, 16);
    const job = await save({ id, v: 1, state: plan.length ? 'queued' : 'failed', createdAt: Date.now(), threadId: threadId ?? null,
      callerHostId, callerProvider: caller.providerId, input, plan, executorId: plan[0] ?? null, attempts: [], notify: !!threadId,
      // While the caller still waits synchronously, the result goes inline and no notification is sent.
      inlineWaitUntil: input.waitSeconds > 0 ? Date.now() + input.waitSeconds * 1000 + 5000 : 0,
      error: plan.length ? null : missingHint(all) });
    await kv.set(key, id);
    return job;
  }

  async function waitFor(job: any, seconds: number, signal?: AbortSignal) {
    const deadline = Date.now() + seconds * 1000; let current = job;
    while (ACTIVE.has(current.state) && Date.now() < deadline && !signal?.aborted) { await delay(1500); current = await kv.get('job:' + job.id); }
    if (current.state === 'completed' && !current.deliveredInline && seconds > 0) { current.deliveredInline = true; await save(current); }
    return current;
  }

  async function generate(raw: any, ctx: any = {}) {
    const input = generateSchema.parse(raw);
    return view(await waitFor(await submit(input, ctx), input.waitSeconds, ctx.signal), 'generate');
  }
  async function edit(raw: any, ctx: any = {}) {
    const e = editSchema.parse(raw);
    const input = generateSchema.parse({ prompt: e.instruction, outputDir: e.outputDir, references: [e.image, ...e.references], count: e.count,
      size: e.size, transparent: e.transparent, executor: e.executor, clientKey: e.clientKey, reason: e.reason,
      excludeCurrentAccount: e.excludeCurrentAccount, waitSeconds: e.waitSeconds, mode: 'edit', callerHostId: e.callerHostId });
    return view(await waitFor(await submit(input, ctx), input.waitSeconds, ctx.signal), 'edit');
  }

  function view(job: any, origin: string) {
    const base = { jobId: job.id, state: job.state, origin, executor: job.executorId, error: job.error ?? null, resetHint: job.resetHint ?? null,
      files: (job.returned ?? []).map((r: any) => ({ path: r.path, sha256: r.sha256, bytes: r.bytes, provenance: r.provenance })) };
    if (ACTIVE.has(job.state)) return { ...base, wait: 'Заверши ход: результат придёт одним уведомлением в этот тред. Не вызывай повторно и не опрашивай в цикле.' };
    return base;
  }

  async function writeBytes(hostId: string, target: string, bytes: Buffer) {
    const sha256 = createHash('sha256').update(bytes).digest('hex'); const transferId = randomUUID();
    for (let offset = 0; ; offset += CHUNK) {
      const final = offset + CHUNK >= bytes.length;
      await host.call('write', { path: target, transferId, offset, data: bytes.subarray(offset, offset + CHUNK).toString('base64'), final, sha256: final ? sha256 : undefined }, { hostId });
      if (final) break;
    }
    return { path: target, bytes: bytes.length, sha256 };
  }
  async function transfer(fromHost: string, path: string, toHost: string, target: string) {
    const info = await host.call('info', { path }, { hostId: fromHost }); const transferId = randomUUID();
    for (let offset = 0; ; offset += CHUNK) {
      const data = await host.call('read', { path, offset, size: CHUNK }, { hostId: fromHost });
      const final = offset + CHUNK >= info.size;
      await host.call('write', { path: target, transferId, offset, data, final, sha256: final ? info.sha256 : undefined }, { hostId: toHost });
      if (final) break;
    }
    return { path: target, bytes: info.size, sha256: info.sha256 };
  }

  async function deliver(job: any, sources: { name: string, copy: (target: string) => Promise<any> }[]) {
    job.returned = job.returned ?? [];
    for (const src of sources.slice(job.returned.length)) {
      const target = join(job.input.outputDir, `${job.id}-${src.name}`); // unique per job, never overwrites user files
      const copied = await src.copy(target);
      const meta = Buffer.from(JSON.stringify({ ...(job.result?.provenance ?? {}), jobId: job.id, file: basename(target), sha256: copied.sha256,
        executor: job.executorId, prompt: job.input.prompt, mode: job.input.mode ?? 'generate', references: job.input.references,
        sourceThreadId: job.threadId, createdAt: job.createdAt }, null, 2));
      await writeBytes(job.callerHostId, target + '.json', meta);
      job.returned.push({ ...copied, provenance: target + '.json' }); await save(job);
    }
    job.state = 'completed'; await save(job);
  }

  async function runApi(job: any) {
    const cfg = await settings.get();
    job.state = 'running'; job.apiStartedAt = Date.now(); await save(job); // a restart from here is "unknown", never a silent repeat
    const result: any = await openaiImages({ apiKey: cfg.openaiApiKey, model: cfg.apiModel, prompt: job.input.prompt, count: job.input.count,
      size: job.input.size, transparent: job.input.transparent, mode: job.input.mode, references: job.input.references,
      readFile: async (path: string) => {
        const info = await host.call('info', { path }, { hostId: job.callerHostId }); const parts: Buffer[] = [];
        for (let o = 0; o < info.size; o += CHUNK) parts.push(Buffer.from(await host.call('read', { path, offset: o, size: CHUNK }, { hostId: job.callerHostId }), 'base64'));
        const ext = extname(path).toLowerCase();
        return { bytes: Buffer.concat(parts), name: basename(path), mime: ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png' };
      } });
    if (result.status !== 'completed') return finish(job, result);
    job.attempts.push({ executorId: job.executorId, at: Date.now(), status: 'completed' });
    job.result = { status: 'completed', provenance: { generator: 'openai images api', model: result.model } };
    job.state = 'returning'; await save(job);
    try {
      await deliver(job, result.images.map((img: any, i: number) => ({ name: `image-${i + 1}.png`, copy: (t: string) => writeBytes(job.callerHostId, t, img.bytes) })));
    } catch (error) { job.state = 'return_failed'; job.error = String(error) + ' (API images are not kept; retry regenerates)'; await save(job); }
  }

  async function tick(job: any) {
    if (job.executorId === API_EXECUTOR) {
      if (job.state === 'queued') return runApi(job);
      if (job.state === 'running' && !runningApi.has(job.id)) return finish(job, { status: 'unknown', error: 'Server restarted during a paid API request' });
      return;
    }
    const hostId = hostOf(job.executorId);
    if (job.state === 'queued') {
      const attemptNo = job.attempts.length;
      try {
        const service: any = (await services()).find(s => s.id === job.executorId);
        if (!service?.ready) return finish(job, { status: 'not_started', error: 'Executor not ready: ' + (service?.missing ?? []).join('; ') });
        const request: any = { jobId: job.id, prompt: job.input.prompt, count: job.input.count, size: job.input.size, mode: job.input.mode,
          transparent: job.input.transparent, sourceThreadId: job.threadId, references: [] };
        const dirId = `${job.id}_${attemptNo}`;
        const { jobDir } = await host.call('jobDir', { jobId: dirId }, { hostId });
        for (const [i, ref] of job.input.references.entries()) // references travel to the executor, verified by SHA-256
          request.references.push((await transfer(job.callerHostId, ref, hostId, join(jobDir, 'refs', `ref-${i + 1}${extname(ref) || '.png'}`))).path);
        const prep = await host.call('prepareJob', { jobId: dirId, request }, { hostId });
        job.jobDir = prep.jobDir; job.leaseToken = randomUUID(); job.leasePath = prep.jobDir + '/.lease.json';
        job.leaseExpiresAt = Date.now() + (await settings.get()).leaseSeconds * 1000; job.lastHeartbeatAt = Date.now();
        await host.call('lease', { path: job.leasePath, token: job.leaseToken, expiresAt: job.leaseExpiresAt, create: true }, { hostId });
        const hash = createHash('sha256').update(job.id + ':' + attemptNo).digest();
        job.terminalId = 'term_' + [...hash.subarray(0, 10)].map(b => ALPHABET[b % ALPHABET.length]).join('');
        if ((await kv.get('job:' + job.id))?.state === 'cancelled') return;
        job.state = 'starting'; await save(job);
        const model = (await settings.get()).executorModel;
        const argv = [prep.python ?? 'python3', '-I', prep.runner, '--job-dir', prep.jobDir, '--codex', service.codexPath ?? 'codex',
          '--lease-file', job.leasePath, '--lease-token', job.leaseToken, ...(model ? ['--model', model] : [])];
        const terminal = await bb.sdk.terminals.create({ id: job.terminalId, scope: { kind: 'host_path', hostId, cwd: prep.jobDir },
          cols: 160, rows: 40, title: 'Image Gen ' + job.id, start: { mode: 'argv', argv } });
        job.terminalId = terminal?.id ?? job.terminalId; job.state = 'running'; return void await save(job);
      } catch (error) {
        if (job.state === 'starting') { // ambiguous create: keep the identity, the process may already run
          const terminal = await bb.sdk.terminals.get({ terminalId: job.terminalId }).catch(() => null);
          if (terminal) { job.state = 'running'; return void await save(job); }
        }
        return finish(job, { status: 'not_started', error: String(error) });
      }
    }
    if (job.state === 'running' || job.state === 'starting') {
      const seen = await host.call('readResult', { jobDir: job.jobDir }, { hostId }).catch(() => null);
      if (seen?.result?.status && seen.result.status !== 'unknown_pending') {
        if (seen.result.status === 'completed') {
          job.result = seen.result; job.attempts.push({ executorId: job.executorId, at: Date.now(), status: 'completed' });
          job.state = 'returning'; await save(job); return tick(job);
        }
        return finish(job, seen.result);
      }
      const terminal = await bb.sdk.terminals.get({ terminalId: job.terminalId }).catch(() => null);
      const t = terminal?.terminal ?? terminal;
      if (seen && (t?.status === 'exited' || (!t && Date.now() > job.leaseExpiresAt + 10000)))
        return finish(job, { status: seen.attempt ? 'unknown' : 'not_started', error: 'Executor stopped without result' });
      if (Date.now() - (job.lastHeartbeatAt ?? 0) >= 15000) {
        const expiresAt = Date.now() + (await settings.get()).leaseSeconds * 1000;
        if (await host.call('lease', { path: job.leasePath, token: job.leaseToken, expiresAt, create: false }, { hostId }).catch(() => false)) {
          job.leaseExpiresAt = expiresAt; job.lastHeartbeatAt = Date.now(); await save(job);
        }
      }
      return;
    }
    if (job.state === 'returning') {
      try {
        await deliver(job, job.result.images.map((img: any) => ({ name: img.name, copy: (t: string) => transfer(hostId, img.path, job.callerHostId, t) })));
      } catch (error) { job.state = 'return_failed'; job.error = String(error); await save(job); } // retry delivers again, never regenerates
    }
  }

  async function finish(job: any, result: any) {
    job.attempts.push({ executorId: job.executorId, at: Date.now(), status: result.status, error: result.error ?? null });
    const next = afterAttempt(job, result, await services());
    Object.assign(job, { state: next.state, error: next.error ?? null, resetHint: next.resetHint ?? null });
    if (next.executorId) job.executorId = next.executorId;
    await save(job);
  }

  async function status({ jobId }: any) { const job = await kv.get('job:' + jobId); if (!job) throw new Error('Unknown job'); return view(job, 'status'); }
  async function cancel({ jobId }: any) {
    const job = await kv.get('job:' + jobId); if (!job) throw new Error('Unknown job');
    if (TERMINAL.has(job.state)) return view(job, 'status');
    if (job.terminalId) await bb.sdk.terminals.close({ terminalId: job.terminalId, mode: 'force' }).catch(() => null);
    job.state = 'cancelled'; await save(job); return view(job, 'status');
  }
  async function retry({ jobId, confirmUnknown }: any) {
    const job = await kv.get('job:' + jobId); if (!job) throw new Error('Unknown job');
    if (job.state === 'return_failed' && job.executorId !== API_EXECUTOR) { job.state = 'returning'; await save(job); return view(job, 'retry-delivery'); }
    if (job.state === 'unknown' && !confirmUnknown) throw new Error('Outcome unknown: a retry may spend another generation. Ask the user, then pass confirmUnknown=true.');
    if (!['unknown', 'failed', 'limited', 'return_failed'].includes(job.state)) throw new Error('Nothing to retry in state ' + job.state);
    const plan = candidates(await services(), { callerHostId: job.callerHostId, preferred: job.input.executor, maxTier: (await settings.get()).maxTier });
    if (!plan.length) throw new Error('No ready executor');
    Object.assign(job, { state: 'queued', plan, executorId: plan[0], error: null, returned: [], deliveredInline: false });
    await save(job); return view(job, 'retry');
  }

  bb.rpc.register(rpcContract, { services: () => services(), generate, edit, status, cancel, retry }, {
    experimental_discoverable: true,
    experimental_description: 'Image generation/editing for any BB agent: Codex built-in image_gen on enrolled machines, optional paid OpenAI API fallback.',
  });

  const tools: [string, string, any, (i: any, c: any) => any][] = [
    ['image_generate', 'Generate image(s) and save them to outputDir on your machine (Codex built-in image_gen on the best machine; paid API only if enabled). Waits up to waitSeconds; otherwise returns jobId and one notification arrives later. Never call again for the same request.', generateSchema, generate],
    ['image_edit', 'Edit an existing image by instruction (background, objects, style, lighting); extra references optional. Result is a new file in outputDir; the original is never overwritten.', editSchema, edit],
    ['image_status', 'Read an image job once (on user request or after its notification). Never poll in a loop.', rpcContract.status.input, status],
    ['image_cancel', 'Cancel an image job; no fallback is started.', rpcContract.cancel.input, cancel],
    ['image_retry', 'Retry delivery (return_failed) or, only after explicit user consent, regeneration of an unknown/failed/limited job.', rpcContract.retry.input, retry],
    ['image_services', 'List executors that can generate images, readiness and what is missing on each machine.', z.object({}).strict(), () => services()],
  ];
  for (const [name, description, parameters, execute] of tools)
    bb.agents.registerTool({ name, description, parameters, async execute(input: any, ctx: any) { return JSON.stringify(await execute(input, ctx)); } });

  bb.agents.contributeInstructions(({ threadId }: any) => instructionsFor(providerCache.get(threadId) ?? null));

  const usage = 'bb image-gen generate --prompt "..." [--out <dir>] [--ref <file>]... [--count N] [--size WxH]\n' +
    'bb image-gen edit --image <file> --prompt "..." [--out <dir>]\nbb image-gen status|cancel <jobId>\nbb image-gen services';
  bb.cli.register({
    name: 'image-gen', summary: 'Generate or edit images (Codex image_gen on enrolled machines)',
    commands: [
      { name: 'generate', summary: 'Generate image(s)', usage: 'bb image-gen generate --prompt "..." [--out <dir>] [--ref <file>]...' },
      { name: 'edit', summary: 'Edit an image', usage: 'bb image-gen edit --image <file> --prompt "..." [--out <dir>]' },
      { name: 'status', summary: 'Show a job', usage: 'bb image-gen status <jobId>' },
      { name: 'cancel', summary: 'Cancel a job', usage: 'bb image-gen cancel <jobId>' },
      { name: 'services', summary: 'Show executors and readiness', usage: 'bb image-gen services' },
    ],
    async run(argv: string[], ctx: any) {
      const [cmd, ...rest] = argv; const opt = (k: string) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : undefined; };
      const all = (k: string) => rest.flatMap((v, i) => rest[i - 1] === k ? [v] : []);
      const common: any = { outputDir: opt('--out') ?? ctx.cwd, count: Number(opt('--count') ?? 1), waitSeconds: Number(opt('--wait') ?? 120) };
      if (opt('--size')) common.size = opt('--size'); if (opt('--executor')) common.executor = opt('--executor');
      if (opt('--caller-host')) common.callerHostId = opt('--caller-host');
      try {
        const out = cmd === 'services' ? await services()
          : cmd === 'status' ? await status({ jobId: rest[0] })
          : cmd === 'cancel' ? await cancel({ jobId: rest[0] })
          : cmd === 'generate' ? await generate({ prompt: opt('--prompt'), references: all('--ref'), ...common }, ctx)
          : cmd === 'edit' ? await edit({ image: opt('--image'), instruction: opt('--prompt'), references: all('--ref'), ...common }, ctx)
          : null;
        if (!out) return { exitCode: cmd && !['help', '--help', '-h'].includes(cmd) ? 2 : 0, stdout: usage + '\n' };
        return { exitCode: 0, stdout: JSON.stringify(out, null, 2) + '\n' };
      } catch (error) { return { exitCode: 1, stderr: String(error) + '\n' }; }
    },
  });

  bb.background.service('image-jobs', { async start(signal: AbortSignal) {
    const inFlight = new Set<string>();
    while (!signal.aborted) {
      try {
        const active = (await jobs()).filter(j => ACTIVE.has(j.state)).sort((a, b) => a.createdAt - b.createdAt);
        const busy = new Set(active.filter(j => ['starting', 'running'].includes(j.state)).map(j => j.executorId));
        for (const job of active) {
          if (inFlight.has(job.id)) continue;
          if (job.state === 'queued' && busy.has(job.executorId)) continue; // one generation per executor at a time
          busy.add(job.executorId); inFlight.add(job.id);
          const isApi = job.executorId === API_EXECUTOR && job.state === 'queued';
          if (isApi) runningApi.add(job.id);
          const work = tick(job).catch((e: any) => bb.log.error(job.id + ': ' + String(e)))
            .finally(() => { inFlight.delete(job.id); runningApi.delete(job.id); });
          if (!isApi) await work; // paid API calls are long: do not block the Codex queue
        }
      } catch (error) { bb.log.error(String(error)); }
      try { await delay(1500, undefined, { signal }); } catch { break; }
    }
  } });

  bb.background.service('image-notices-and-retention', { async start(signal: AbortSignal) {
    while (!signal.aborted) {
      try {
        const cfg = await settings.get(); const now = Date.now();
        for (const job of await jobs()) {
          if (TERMINAL.has(job.state)) await notifyJob({ kv, threads: bb.sdk.threads, job, alreadyAccepted }).catch((e: any) => bb.log.warn(String(e)));
          if (retentionExpired(job, now, { keepDays: cfg.keepDays })) {
            if (job.jobDir && job.executorId !== API_EXECUTOR) await host.call('cleanup', { jobDir: job.jobDir }, { hostId: hostOf(job.executorId) }).catch(() => null);
            await kv.delete('job:' + job.id);
          }
        }
        const list = await bb.sdk.threads.list({ limit: 200 }).catch(() => null);
        for (const t of list?.threads ?? list?.items ?? (Array.isArray(list) ? list : [])) if (t?.id && t.providerId) providerCache.set(t.id, t.providerId);
      } catch (error) { bb.log.warn(String(error)); }
      try { await delay(5000, undefined, { signal }); } catch { break; }
    }
  } });

  async function alreadyAccepted(threads: any, threadId: string, marker: string) {
    if (JSON.stringify(await threads.queuedMessages.list({ threadId })).includes(marker)) return true;
    const page = await threads.timeline({ threadId, segmentLimit: '100', deferContent: 'false' });
    return JSON.stringify(page.rows).includes(marker);
  }
}
