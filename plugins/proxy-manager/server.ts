import { setTimeout as delay } from 'node:timers/promises';
import { createRouting } from './routing';
import { TtlCache, cachedLoad } from './lib/ttl-cache';
import { isBusyStatus, THREAD_ACTIVITY_CHANNEL } from './lib/route-poll';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { hostContract, rpcContract, storedProxy, bindingSchema, modelRouteChoice, modelRouteState, redact, parseProxyFile, type ClaudeRoute, type Check, type StoredProxy, type RouteContext, type RouteState, type ModelRouteState } from './contract';
export type { rpcContract } from './contract';
export default async function plugin(bb: BbPluginApi) {
  const secrets = bb.settings.define({ vault: { type: 'string', label: 'Хранилище учётных данных прокси', secret: true } });
  const routing = createRouting(bb, false);
  const host = bb.hosts.experimental_client({ contract: hostContract });
  const modelKey = (hostId: string, providerId: string) => `model-route:${hostId}:${providerId}`;
  async function modelRoutes(): Promise<ModelRouteState[]> {
    const result: ModelRouteState[] = [];
    for (const key of await bb.storage.kv.list('model-route:')) result.push(modelRouteState.parse(await bb.storage.kv.get(key)));
    return result;
  }
  type Env = { name: string; value: string; reason: string }[];
  // What the dispatch hook last prepared for a host and provider. The environment
  // resolver is fail-open in the SDK, so it must not depend on a second host call
  // succeeding: it reuses the hook's result for the same saved choice.
  const preparedEnv = new Map<string, { mode: string; at: number; env: Env }>();
  const PREPARE_MS = 8000, RETRY_MS = 30_000, FRESH_MS = 60_000;
  /** Bounded below the SDK's own time limit for a hook decision, so a hung machine becomes a wait with a retry. */
  async function prepareRoute(hostId: string, saved: ModelRouteState): Promise<Env> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const prepared = await Promise.race([
        host.call('prepare_model_route', { providerId: saved.providerId, mode: saved.mode }, { hostId }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Машина не ответила вовремя')), PREPARE_MS); }),
      ]);
      preparedEnv.set(modelKey(hostId, saved.providerId), { mode: saved.mode, at: Date.now(), env: prepared.env });
      return prepared.env;
    } finally { clearTimeout(timer); }
  }
  for (const providerId of ['codex', 'claude-code'] as const) {
    bb.providers.experimental_contributeEnv(providerId, async ctx => {
      const saved = await bb.storage.kv.get<ModelRouteState>(modelKey(ctx.hostId, providerId));
      if (!saved) return [];
      const known = preparedEnv.get(modelKey(ctx.hostId, providerId));
      if (known && known.mode === saved.mode && Date.now() - known.at < FRESH_MS) return known.env;
      try { return await prepareRoute(ctx.hostId, saved); }
      catch (error) {
        // Better the route prepared a moment ago than a start without the chosen route.
        if (known && known.mode === saved.mode) return known.env;
        throw error;
      }
    });
  }
  bb.experimental_hooks.on('message.dispatch', async ctx => {
    const native = await routing.guard(ctx);
    if (native.action === 'wait') return { action: 'wait', reason: native.reason! };
    if (!ctx.host || !['codex', 'claude-code'].includes(ctx.thread.providerId)) return { action: 'proceed' };
    const saved = await bb.storage.kv.get<ModelRouteState>(modelKey(ctx.host.id, ctx.thread.providerId));
    if (!saved) return { action: 'proceed' };
    try { await prepareRoute(ctx.host.id, saved); }
    // sendAt: the machine or the gateway may come back without any event reaching this plugin.
    catch { return { action: 'wait', reason: 'Не удалось подготовить выбранный маршрут модели. Проверьте Подключения → Маршрут моделей BB', sendAt: Date.now() + RETRY_MS }; }
    return { action: 'proceed' };
  });
  /** Stops an idle thread so its next turn starts with the new route; anything else is left marked for its idle event. */
  async function releaseRuntime(threadId: string) {
    await bb.storage.kv.set(`model-restart:${threadId}`, true);
    try {
      // Read again: between the listing and now the thread may have started a turn.
      const thread = await bb.sdk.threads.get({ threadId });
      if (thread.status !== 'idle' && thread.status !== 'error') return;
      await bb.sdk.threads.stop({ threadId });
      await bb.storage.kv.delete(`model-restart:${threadId}`);
    } catch { /* the mark stays: the next idle event retries */ }
  }
  async function setModelRoute(input: z.infer<typeof modelRouteChoice>) {
    return serialize(async () => {
      const machine = await bb.sdk.hosts.get({ hostId: input.hostId });
      if (machine.status !== 'connected') throw new Error('Машина недоступна');
      if (input.mode === 'opencodex') {
        const check = await host.call('inspect_gateway', { providerId: input.providerId, force: true }, { hostId: input.hostId });
        if (check.state !== 'available') throw new Error(check.message);
      }
      let state: ModelRouteState | null = null;
      if (input.mode === 'inherit') {
        // Back to whatever the CLI itself is configured for: no record, nothing contributed.
        await bb.storage.kv.delete(modelKey(input.hostId, input.providerId));
      } else {
        const prepared = await host.call('prepare_model_route', { providerId: input.providerId, mode: input.mode }, { hostId: input.hostId });
        state = { hostId: input.hostId, providerId: input.providerId, mode: input.mode, message: prepared.message, updatedAt: new Date().toISOString() };
        await bb.storage.kv.set(modelKey(input.hostId, input.providerId), state);
      }
      preparedEnv.delete(modelKey(input.hostId, input.providerId));
      // From here the choice is saved and in effect. Releasing runtimes cannot fail the
      // change any more: a thread that could not be stopped keeps its mark and is retried.
      for (let offset = 0; ; offset += 100) {
        const rows = await bb.sdk.threads.list({ hostId: input.hostId, includeHidden: true, limit: 100, offset });
        for (const thread of rows) if (thread.providerId === input.providerId) await releaseRuntime(thread.id);
        if (rows.length < 100) break;
      }
      bb.realtime.publish('changed', {});
      await bb.experimental_hooks.recheck('message.dispatch');
      return state;
    });
  }
  async function read(): Promise<StoredProxy[]> { const { vault } = await secrets.get(); return z.array(storedProxy).parse(JSON.parse(vault || '[]')); }
  let queue: Promise<unknown> = Promise.resolve();
  function serialize<T>(fn: () => Promise<T>): Promise<T> { const next = queue.then(fn); queue = next.catch(() => {}); return next; }
  async function add(input: Omit<StoredProxy, 'id'>) { return serialize(async () => {
    const proxies = await read();
    if (proxies.some(p => p.name.toLocaleLowerCase() === input.name.toLocaleLowerCase())) throw new Error('Прокси с таким именем уже существует');
    if (proxies.length >= 100) throw new Error('Можно добавить до 100 прокси');
    const p = { ...input, id: randomUUID() }; await secrets.experimental_set({ vault: JSON.stringify([...proxies, p]) });
    bb.realtime.publish('changed', {}); return redact(p);
  }); }
  async function remove(id: string) { return serialize(async () => {
    const proxies = await read(); const next = proxies.filter(p => p.id !== id);
    if (next.length === proxies.length) return { removed: false };
    if ((await bindings()).some(b => b.proxyId === id)) throw new Error('Прокси используется: сначала измените подключения CLI');
    await secrets.experimental_set({ vault: JSON.stringify(next) });
    bb.realtime.publish('changed', {}); return { removed: true };
  }); }
  const checksInFlight = new Map<string, Promise<Check>>();
  function check(hostId: string, proxyId: string | null, signal?: AbortSignal, heartbeat = false): Promise<Check> {
    const key = `${hostId}:${proxyId ?? 'direct'}`;
    const running = checksInFlight.get(key);
    if (running) return running;
    const task = performCheck(hostId, proxyId, signal, heartbeat).finally(() => checksInFlight.delete(key));
    checksInFlight.set(key, task);
    return task;
  }
  async function performCheck(hostId: string, proxyId: string | null, signal?: AbortSignal, heartbeat = false) {
    const proxy = proxyId === null ? null : (await read()).find(p => p.id === proxyId);
    if (proxy === undefined) throw new Error('Прокси не найден');
    const machine = await bb.sdk.hosts.get({ hostId });
    let result: Check;
    try {
      if (machine.status !== 'connected') throw new Error('Машина не подключена');
      const previous = heartbeat ? (await bb.storage.kv.get<Check>(`check:${hostId}:${proxyId ?? 'direct'}`)) ?? undefined : undefined;
      result = await host.call('check', { proxy, ...(previous ? { previous } : {}) }, { hostId, signal });
    }
    catch { result = { ok: false, ip: null, country: null, city: null, openaiStatus: null, message: 'Проверка на выбранной машине не выполнена', checkedAt: new Date().toISOString(), latencyMs: 0 }; }
    signal?.throwIfAborted();
    await bb.storage.kv.set(`check:${hostId}:${proxyId ?? 'direct'}`, result);
    bb.realtime.publish('changed', {}); return result;
  }
  async function list() {
    const checks: Record<string, Check> = {};
    const rows = await bb.storage.kv.list('check:');
    for (const key of rows) checks[key.slice(6)] = (await bb.storage.kv.get<Check>(key))!;
    const routes: Record<string, RouteState> = {};
    for (const key of await bb.storage.kv.list('route:')) routes[key.slice(6)] = (await bb.storage.kv.get<RouteState>(key))!;
    return { proxies: (await read()).map(redact), bindings: await bindings(), checks, routes };
  }
  async function bindings() { return z.array(bindingSchema).parse((await bb.storage.kv.get('bindings')) ?? []); }
  async function bind(input: z.infer<typeof bindingSchema>) { return serialize(async () => {
    const machine = await bb.sdk.hosts.get({ hostId: input.hostId });
    if (machine.status !== 'connected') throw new Error('Машина недоступна');
    const available = await providers(input.hostId, true);
    if (input.providerId !== 'codex' || !available.some(p => p.id === input.providerId && p.available)) throw new Error('CLI недоступен или пока не поддерживается');
    if (input.proxyId !== null && !(await read()).some(p => p.id === input.proxyId)) throw new Error('Прокси не найден');
    const proxy = input.proxyId === null ? null : (await read()).find(p => p.id === input.proxyId)!;
    await routing.apply(input.hostId, proxy);
    const next = (await bindings()).filter(b => b.hostId !== input.hostId || b.providerId !== input.providerId);
    await bb.storage.kv.set('bindings', [...next, input]); bb.realtime.publish('changed', {}); await bb.experimental_hooks.recheck('message.dispatch'); return input;
  }); }
  async function loadProviders(hostId: string) {
    const [catalog, installation] = await Promise.all([
      bb.sdk.providers.list({ hostId }), bb.sdk.hosts.providerCliStatus({ hostId }),
    ]);
    return catalog.map(p => {
      const cli = installation[p.id];
      const available = p.available && cli?.installed === true && !cli.versionUnsupported;
      const message = !cli ? 'Не удалось подтвердить наличие CLI' : !cli.installed ? 'CLI не установлен' : cli.versionUnsupported ? 'Версия CLI не поддерживается' : !p.available ? 'Провайдер недоступен' : 'CLI доступен';
      return { id: p.id, name: p.displayName, installed: cli?.installed === true, available, message };
    });
  }
  const providerCache = new Map<string, { entries: Awaited<ReturnType<typeof loadProviders>>; expiresAt: number }>();
  const providerRequests = new Map<string, Promise<Awaited<ReturnType<typeof loadProviders>>>>();
  async function providers(hostId: string, force = false) {
    const cached = providerCache.get(hostId);
    if (!force && cached && Date.now() < cached.expiresAt) return cached.entries;
    const running = providerRequests.get(hostId);
    if (running) return running;
    const request = loadProviders(hostId).then(entries => {
      providerCache.set(hostId, { entries, expiresAt: Date.now() + 60_000 });
      return entries;
    }).finally(() => providerRequests.delete(hostId));
    providerRequests.set(hostId, request);
    return request;
  }
  bb.background.service('connection-monitor', {
    async start(signal) {
      while (!signal.aborted) {
        const started = Date.now();
        for (const binding of await bindings()) {
          if (signal.aborted) return;
          if (binding.providerId !== 'codex') continue;
          const route = await routing.state(binding.hostId);
          if (route?.phase !== 'ready' || route.proxyId !== binding.proxyId) continue;
          try { await check(binding.hostId, binding.proxyId, signal, true); }
          catch { if (signal.aborted) return; }
        }
        try { await delay(Math.max(1000, 30_000 - (Date.now() - started)), undefined, { signal }); }
        catch { if (signal.aborted) return; throw new Error('Мониторинг подключения прерван'); }
      }
    },
  });
  const claudeChecks = new Map<string, { at: number; result: Promise<ClaudeRoute> }>();
  function inspectClaude(hostId: string, path: string | null, threadId: string | null): Promise<ClaudeRoute> {
    const key = JSON.stringify([hostId, path, threadId]);
    const cached = claudeChecks.get(key);
    if (cached && Date.now() - cached.at < 4000) return cached.result;
    const result = host.call('claude_route', { path, threadId }, { hostId, timeoutMs: 7000 })
      .catch((): ClaudeRoute => ({ state: 'unknown', message: 'Проверка процесса Claude недоступна.', checkedAt: new Date().toISOString() }));
    if (claudeChecks.size > 100) claudeChecks.clear();
    claudeChecks.set(key, { at: Date.now(), result });
    return result;
  }
  // The route badge asks route_context every few seconds. What a thread runs on
  // (provider, environment → machine and folder) does not change between turns,
  // so it is reused for a minute; the machine's name and connection only briefly,
  // because the badge shows when a machine goes offline.
  const threadInfo = new TtlCache<Promise<{ providerId: string; environmentId: string | null }>>(60_000, 200);
  const environmentInfo = new TtlCache<Promise<{ hostId: string; path: string }>>(60_000, 200);
  const machineInfo = new TtlCache<Promise<{ name: string; status: string }>>(10_000, 50);
  const machineOf = (hostId: string) => cachedLoad(machineInfo, hostId, () => bb.sdk.hosts.get({ hostId }).then(h => ({ name: h.name, status: h.status })));
  const environmentOf = (environmentId: string) => cachedLoad(environmentInfo, environmentId, () => bb.sdk.environments.get({ environmentId }).then(e => ({ hostId: e.hostId, path: e.path })));
  // Threads with a running turn, from thread.active/idle/failed and corrected by
  // the thread's status whenever it is read anyway. A restart forgets it; the
  // next read of the thread fills it in again.
  const busyThreads = new Set<string>();
  function markBusy(threadId: string, busy: boolean) {
    if (busy) { if (busyThreads.size >= 1000) busyThreads.clear(); busyThreads.add(threadId); }
    else busyThreads.delete(threadId);
  }
  const threadOf = (threadId: string) => cachedLoad(threadInfo, threadId, async () => {
    const thread = await bb.sdk.threads.get({ threadId });
    markBusy(threadId, isBusyStatus(thread.status));
    return { providerId: thread.providerId, environmentId: thread.environmentId ?? null };
  });
  function announceActivity(threadId: string, busy: boolean) {
    markBusy(threadId, busy);
    bb.realtime.publish(THREAD_ACTIVITY_CHANNEL, { threadId, busy });
  }
  bb.events.on('thread.active', ({ thread }) => { announceActivity(thread.id, true); });
  bb.events.on('thread.idle', ({ thread }) => { announceActivity(thread.id, false); });
  bb.events.on('thread.failed', ({ thread }) => { announceActivity(thread.id, false); });
  bb.events.on('thread.archived', ({ thread }) => { busyThreads.delete(thread.id); threadInfo.delete(thread.id); });
  bb.rpc.register(rpcContract, {
    route_context: async (input): Promise<RouteContext | null> => {
      let hostId = input.hostId, providerId = input.providerId;
      let path: string | null = null;
      if (input.threadId) {
        const thread = await threadOf(input.threadId);
        providerId = thread.providerId;
        if (thread.environmentId) {
          const environment = await environmentOf(thread.environmentId);
          hostId = environment.hostId; path = environment.path;
        }
      } else if (input.environmentId) {
        const environment = await environmentOf(input.environmentId);
        hostId = environment.hostId; path = environment.path;
      }
      if (!hostId || !providerId) return null;
      const machine = await machineOf(hostId);
      const modelMode = (await bb.storage.kv.get<ModelRouteState>(modelKey(hostId, providerId)))?.mode ?? null;
      const binding = (await bindings()).find(b => b.hostId === hostId && b.providerId === providerId);
      const proxyId = binding?.proxyId ?? null;
      const proxy = proxyId ? (await read()).find(p => p.id === proxyId) : null;
      const route = providerId === 'codex' ? await routing.state(hostId) : null;
      const applied = !!route && await routing.verify(hostId, route);
      const warning = route ? applied ? null : route.phase === 'ready' ? 'Файлы настроек изменены или машина недоступна' : route.message : binding?.proxyId ? 'Настройка ещё не применена' : null;
      const claudeRoute = providerId === 'claude-code' && machine.status === 'connected'
        ? await inspectClaude(hostId, path, input.threadId) : null;
      return { modelMode, claudeRoute, hostId, hostName: machine.name, providerId, proxyId, proxyName: proxyId ? proxy?.name ?? 'Прокси не найден' : null, connected: machine.status === 'connected', check: providerId === 'codex' ? (await bb.storage.kv.get<Check>(`check:${hostId}:${proxyId ?? 'direct'}`)) ?? null : null, applied, warning, ...(input.threadId ? { busy: busyThreads.has(input.threadId) } : {}) };
    },
    gateway_status: async input => {
      const machine = await bb.sdk.hosts.get({ hostId: input.hostId });
      if (machine.status !== 'connected') return { state: 'offline' as const, message: 'Машина офлайн — OpenCodex не проверен' };
      try { return await host.call('inspect_gateway', { providerId: input.providerId, force: input.force }, { hostId: input.hostId }); }
      catch { return { state: 'unknown' as const, message: 'Не удалось проверить OpenCodex на машине' }; }
    },
    model_routes: modelRoutes, set_model_route: setModelRoute,
    list, add, bind, remove: ({ id }) => remove(id), check: ({ hostId, proxyId }) => check(hostId, proxyId),
    machines: async () => (await bb.sdk.hosts.list()).map(h => ({ id: h.id, name: h.name, connected: h.status === 'connected' })),
    providers: ({ hostId, force }) => providers(hostId, force),
  });
  bb.events.on('thread.idle', async ({ thread }) => {
    if (await bb.storage.kv.get(`model-restart:${thread.id}`)) await releaseRuntime(thread.id);
    const armed = await bb.storage.kv.get<z.infer<typeof bindingSchema> & { threadId: string }>('armed');
    if (!armed || armed.threadId !== thread.id) return;
    await bb.storage.kv.delete('armed');
    try { await bind(armed); } catch { bb.log.warn('Автоматическое применение Codex не завершено'); }
  });
  bb.cli.register({
    name: 'proxy-manager', summary: 'Прокси: список, импорт и проверка с выбранной машины',
    commands: [
      { name: 'model-route', summary: 'Маршрут моделей только в BB; системный VPN сохраняется', usage: 'bb proxy-manager model-route [<host-id> <codex|claude-code> <direct|opencodex|inherit>]' },
      { name: 'prepare', summary: 'Проверить возможность применения без изменений', usage: 'bb proxy-manager prepare <host-id> <proxy-id|direct>' },
      { name: 'apply', summary: 'Применить маршрут Codex и остановить его треды на машине', usage: 'bb proxy-manager apply <host-id> <proxy-id|direct>' },
      { name: 'arm', summary: 'Первое применение после завершения указанного треда', usage: 'bb proxy-manager arm <thread-id> <host-id> <proxy-id|direct>' },
      { name: 'list', summary: 'Список без паролей', usage: 'bb proxy-manager list' },
      { name: 'import', summary: 'Импорт файла Host/Port/Username/Password', usage: 'bb proxy-manager import <name> <absolute-file>' },
      { name: 'check', summary: 'Проверка прокси или прямого подключения', usage: 'bb proxy-manager check <host-id> <proxy-id|direct>' },
      { name: 'remove', summary: 'Удаление прокси', usage: 'bb proxy-manager remove <proxy-id>' },
    ],
    async run(argv) {
      const [command, ...args] = argv.filter(a => a !== '--json');
      try {
        let output: unknown;
        if (command === 'model-route' && args.length === 0) output = await modelRoutes();
        else if (command === 'model-route' && args.length === 3) output = await setModelRoute(modelRouteChoice.parse({ hostId: args[0], providerId: args[1], mode: args[2] }));
        else if (command === 'prepare' && args.length === 2) {
          const proxy = args[1] === 'direct' ? null : (await read()).find(p => p.id === args[1]);
          if (proxy === undefined) throw new Error('Прокси не найден');
          output = await routing.prepare(args[0]!, proxy);
        }
        else if (command === 'apply' && args.length === 2) output = await bind({ hostId: args[0]!, providerId: 'codex', proxyId: args[1] === 'direct' ? null : args[1]! });
        else if (command === 'arm' && args.length === 3) {
          const [threadId, hostId, selected] = args as [string, string, string];
          const thread = await bb.sdk.threads.get({ threadId });
          if (!thread.environmentId || (await bb.sdk.environments.get({ environmentId: thread.environmentId })).hostId !== hostId || thread.providerId !== 'codex') throw new Error('Тред не соответствует машине Codex');
          if (!(await providers(hostId)).some(p => p.id === 'codex' && p.available)) throw new Error('Codex недоступен');
          const proxy = selected === 'direct' ? null : (await read()).find(p => p.id === selected);
          if (proxy === undefined) throw new Error('Прокси не найден');
          await routing.prepare(hostId, proxy);
          const input = { threadId, hostId, providerId: 'codex', proxyId: proxy?.id ?? null };
          await bb.storage.kv.set('armed', input);
          await routing.set(hostId, { phase: 'switching', proxyId: input.proxyId, message: 'Первое применение после завершения текущего ответа', updatedAt: new Date().toISOString() });
          output = { scheduled: true, threadId, hostId };
          if (thread.status === 'idle' || thread.status === 'error') { await bb.storage.kv.delete('armed'); output = await bind(input); }
        }
        else if (command === 'list' && args.length === 0) output = await list();
        else if (command === 'import' && args.length === 2) {
          const path = args[1]!; if (!path.startsWith('/') || !(await stat(path)).isFile() || (await stat(path)).size > 65536) throw new Error('Ожидается абсолютный путь к небольшому текстовому файлу');
          output = await add(parseProxyFile(await readFile(path, 'utf8'), args[0]!));
        } else if (command === 'check' && args.length === 2) output = await check(args[0]!, args[1] === 'direct' ? null : args[1]!);
        else if (command === 'remove' && args.length === 1) output = await remove(args[0]!);
        else return { exitCode: 1, stderr: 'Команды: list; import <name> <absolute-file>; check <host-id> <proxy-id|direct>; remove <proxy-id>' };
        return { exitCode: 0, stdout: JSON.stringify(output) };
      } catch { return { exitCode: 1, stderr: 'Операция не выполнена. Проверьте параметры, доступность машины и уникальность имени.' }; }
    },
  });
}
