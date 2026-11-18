import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { rpcContract, type Account, type Snapshot } from './contract';
import { classifyWindow, dedupeAccounts, riskyOverride } from './logic';
import { hostContract } from './host-contract';
const providers = [{ id: 'claude-code', name: 'Claude Code' }, { id: 'codex', name: 'Codex' }];
const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const string = (v: unknown): string | null => typeof v === 'string' && v.length > 0 ? v : null;

export default function plugin(bb: BbPluginApi) {
  const hostClient = bb.hosts.experimental_client({ contract: hostContract });
  bb.settings.define({ hideGlobalTokenomics: { type: 'boolean', label: 'Hide duplicate global Tokenomics indicator', default: true } });
  // Cache in memory only. No account identities or usage history persisted.
  const cache = new Map<string, { at: number; accounts: Account[] }>();
  const pending = new Map<string, Promise<Account[]>>();
  async function readHost(hostId: string, hostName: string, refresh: boolean): Promise<Account[]> {
    const saved = cache.get(hostId);
    if (!refresh && saved && Date.now() - saved.at < 120_000) return saved.accounts;
    const running = pending.get(hostId);
    if (running) return running;
    const job = (async () => {
      try {
        const [raw, resets] = await Promise.all([
          bb.sdk.system.usageLimits({ hostId, refresh: true, signal: AbortSignal.timeout(20_000) }),
          hostClient.call('codexResets', null, { hostId, signal: AbortSignal.timeout(15_000) }).catch(() => ({ email: null, count: null })),
        ]);
        const at = new Date().toISOString();
        const accounts = providers.map(provider => {
          const usage = record(raw[provider.id]);
          const old = saved?.accounts.find(a => a.providerId === provider.id);
          const ok = usage.status === 'ok';
          const windows = ok && Array.isArray(usage.windows) ? usage.windows.flatMap(item => {
            const w = record(item);
            if (typeof w.label !== 'string' || typeof w.usedPercent !== 'number' || !Number.isFinite(w.usedPercent)) return [];
            return [{ label: w.label, kind: classifyWindow(w.label, w.kind), usedPercent: w.usedPercent, resetsAt: string(w.resetsAt) }];
          }) : old?.windows ?? [];
          return {
            key: `${provider.id}:${hostId}`, providerId: provider.id, providerName: provider.name,
            hostIds: [hostId], hostNames: [hostName], email: string(usage.accountEmail) ?? (!ok ? old?.email ?? null : null),
            plan: string(usage.planLabel), status: ok ? 'ok' : windows.length ? 'stale' : 'unavailable',
            message: ok ? null : string(usage.message) ?? `Нет данных: ${String(usage.status ?? 'unknown')}`,
            fetchedAt: ok ? at : old?.fetchedAt ?? null, windows,
            resetCount: provider.id === 'codex' && resets.email?.toLowerCase() === string(usage.accountEmail)?.toLowerCase() ? resets.count : null,
          } satisfies Account;
        });
        cache.set(hostId, { at: Date.now(), accounts });
        return accounts;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Машина недоступна';
        return providers.map(provider => {
          const old = saved?.accounts.find(a => a.providerId === provider.id);
          return old ? { ...old, status: 'stale' as const, message } : {
            key: `${provider.id}:${hostId}`, providerId: provider.id, providerName: provider.name,
            hostIds: [hostId], hostNames: [hostName], email: null, plan: null,
            status: 'unavailable' as const, message, fetchedAt: null, windows: [],
            resetCount: null,
          };
        });
      }
    })();
    pending.set(hostId, job);
    try { return await job; } finally { pending.delete(hostId); }
  }
  async function threadSnapshot(threadId: string, refresh: boolean): Promise<Snapshot> {
    const thread = await bb.sdk.threads.get({ threadId });
    const base: Snapshot = { threadId, providerId: thread.providerId, model: null, hostId: null,
      hostName: null, binding: 'unavailable', message: null, account: null };
    if (!providers.some(p => p.id === thread.providerId)) return { ...base, message: 'Этот провайдер не сообщает поддерживаемые лимиты' };
    if (!thread.environmentId) return { ...base, message: 'У треда ещё нет рабочей машины' };
    const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
    const host = await bb.sdk.hosts.get({ hostId: environment.hostId });
    base.hostId = host.id; base.hostName = host.name;
    const [requested, resolved, plugins] = await Promise.all([
      bb.sdk.threads.events.list({ threadId, types: ['client/turn/requested'], order: 'desc', limit: '1' }),
      bb.sdk.threads.events.list({ threadId, types: ['provider.env-resolved'], order: 'desc', limit: '1' }),
      bb.sdk.plugins.list(),
    ]);
    base.model = string(record(record(requested[0]?.data).execution).model);
    const entries = record(resolved[0]?.data).entries;
    const names = Array.isArray(entries) ? entries.map(e => string(record(e).name)).filter((n): n is string => n !== null) : [];
    const pool = plugins.plugins.some(p => (p.id === 'account-pool' || p.id === 'account-pool-balanced') && p.enabled);
    if (!resolved.length || pool || riskyOverride(names, thread.providerId)) {
      return { ...base, binding: 'uncertain', message: pool
        ? 'Работает пул аккаунтов. Аккаунт текущего запуска не подтверждён.'
        : !resolved.length ? 'Нет метаданных запуска для проверки авторизации.'
        : 'У треда отдельный профиль или маршрут авторизации. Аккаунт не подтверждён.' };
    }
    const accounts = await readHost(host.id, host.name, refresh);
    const account = accounts.find(a => a.providerId === thread.providerId) ?? null;
    return { ...base, binding: account?.email ? 'host-cli' : 'uncertain', account,
      message: account?.email ? null : 'CLI не сообщил идентификатор аккаунта' };
  }
  bb.rpc.register(rpcContract, {
    thread: ({ threadId, refresh }) => threadSnapshot(threadId, refresh),
    accounts: async ({ refresh }) => {
      const hosts = await bb.sdk.hosts.list();
      const accounts = (await Promise.all(hosts.map(async host => {
        if (host.status !== 'connected') return (cache.get(host.id)?.accounts ?? []).map(a => ({ ...a, status: 'stale' as const, message: 'Машина не подключена' }));
        return readHost(host.id, host.name, refresh);
      }))).flat();
      return { accounts: dedupeAccounts(accounts.filter(a => a.email !== null || a.windows.length > 0)) };
    },
    details: async ({ key }) => {
      const account = dedupeAccounts([...cache.values()].flatMap(c => c.accounts)).find(a => a.key === key) ?? null;
      if (!account) return { account: null, threads: [] };
      const batches = await Promise.all(account.hostIds.map(async (hostId, index) => {
        const threads = await bb.sdk.threads.list({ hostId, limit: 30 });
        return threads.filter(t => t.providerId === account.providerId).map(t => ({
          id: t.id, title: t.title ?? t.titleFallback ?? 'Тред без названия',
          hostName: account.hostNames[index] ?? hostId, updatedAt: t.updatedAt,
        }));
      }));
      return { account, threads: batches.flat().sort((a,b) => b.updatedAt-a.updatedAt).slice(0,6) };
    },
  });
}
