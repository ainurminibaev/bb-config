import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { rpcContract, type Account, type QuotaWindow, type Snapshot } from './contract';
import { appliesToModel, carryModelWindows, claudeProfilePlan, dedupeAccounts, usageWindows, vclaudeUsedPercent, riskyOverride, vclaudeNote, vclaudeRouted, vclaudeThreadSnapshot } from './logic';
import { hostContract } from './host-contract';
import { createVClaudeReader, origin as vclaudeOrigin } from './vclaude';
import { createComparisonReader } from './vclaude-comparison';
import { parseVClaudeLabels, validVClaudeLabels, vclaudeAccountOf, vclaudeGroups, type VClaudeRoute } from './vclaude-accounts';
import { googleComparison, short, volumeFor, type VolumeInputs } from './volumes';
import { accumulate, type MeterReading, type MeterSums } from './token-meter';
import { CASCADE_PLUGIN_ID, CASCADE_STATUS_METHOD, isCascadeProvider, passportCache } from './cascade-passport';
import { cascadeSnapshot, isVClaudeStep } from './cascade-step';
const providers = [{ id: 'claude-code', name: 'Claude Code' }, { id: 'codex', name: 'Codex' }];
// ACP providers backed by the Antigravity CLI; their quotas come from the host entry.
const antigravityProviders = [
  { id: 'acp-antigravity-acp', name: 'Google Antigravity', field: 'google' },
  { id: 'acp-gemini-antig', name: 'Gemini Antig', field: 'antig' },
] as const;
// Shown under the name the owner gave the provider in BB (customAgents displayName).
let providerNames: { at: number; names: Map<string, string> } | null = null;
const supported = (providerId: string) => providers.some(p => p.id === providerId) || antigravityProviders.some(p => p.id === providerId);
const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const string = (v: unknown): string | null => typeof v === 'string' && v.length > 0 ? v : null;

export default function plugin(bb: BbPluginApi) {
  const hostClient = bb.hosts.experimental_client({ contract: hostContract });
  // Паспорт «Каскада подписок»: спрашивается только для его тредов; нет ответа — как без каскада.
  const passportOf = passportCache((threadId, signal) => bb.sdk.plugins.callRpc({
    pluginId: CASCADE_PLUGIN_ID, method: CASCADE_STATUS_METHOD, input: { threadId }, outputSchema: z.unknown(), signal }));
  const settings = bb.settings.define({
    hideGlobalTokenomics: { type: 'boolean', label: 'Hide duplicate global Tokenomics indicator', default: true },
    comparisonHost: { type: 'string', label: 'ID машины с подпиской Claude и журналами на сервере BB', default: '' },
    usdRub: { type: 'number', label: 'Курс ₽ за $ для сравнения цены пакетов в рублях', default: 100 },
    discussProjectId: { type: 'string', label: 'Проект для треда «Обсудить объёмы» (пусто — bb-config)', default: '' },
    discussHostId: { type: 'string', label: 'Машина для треда «Обсудить объёмы» (пусто — машина «сравнения», иначе первая подключённая)', default: '' },
    vclaudeLabels: { type: 'string', label: 'Метки аккаунтов VClaude: JSON {"<ID>": "<метка>"}',
      description: 'ID — 8 символов из подписи «VClaude · <ID>» (хеш ключа машины). Метка, равная почте кабинета, связывает аккаунт с кабинетом на сервере BB.',
      experimental_multiline: true, default: '',
      experimental_schema: z.string().refine(validVClaudeLabels, 'Нужен JSON-объект {"<ID>": "<метка>"}') },
  });
  const readVClaude = createVClaudeReader();
  const readComparison = createComparisonReader(join(homedir(), '.claude', 'projects'),
    () => join(bb.server.experimental_dataDir, 'plugins', 'tokenomics', 'data.db'),
    async () => {
      const hostId = (await settings.get()).comparisonHost.trim();
      if (!hostId) return null;
      const raw = await bb.sdk.system.usageLimits({ hostId, signal: AbortSignal.timeout(10_000) });
      const reported = record(raw['claude-code']);
      if (reported.status !== 'ok' || !Array.isArray(reported.windows)) return null;
      const profile: unknown = JSON.parse(await readFile(join(homedir(), '.claude.json'), 'utf8'));
      const localEmail = string(record(record(profile).oauthAccount).emailAddress)?.toLowerCase();
      const measuredEmail = string(reported.accountEmail)?.toLowerCase();
      if (!localEmail || !measuredEmail || localEmail !== measuredEmail) return null;
      const weekly = reported.windows.map(record).find(window => window.kind === 'weekly' && window.label === 'Weekly limit');
      const end = Date.parse(string(weekly?.resetsAt) ?? '');
      return Number.isFinite(end) && end > Date.now() ? end : null;
    },
    async () => (await readVClaude(false)).usage?.conversionRates ?? {},
  );
  // Claude Code route per machine (host of ANTHROPIC_BASE_URL), kept from the last answer of each machine.
  const claudeRoutes = new Map<string, VClaudeRoute>();
  const routeAt = new Map<string, number>();
  const vclaudeHost = new URL(vclaudeOrigin).hostname;
  // Route of one machine for a thread header: asked at most every 2 minutes, last known kept.
  async function hostRoute(hostId: string, hostName: string): Promise<string | null> {
    if (!claudeRoutes.has(hostId) || Date.now() - (routeAt.get(hostId) ?? 0) > 120_000) {
      const route = await hostClient.call('claudeRoute', null, { hostId, signal: AbortSignal.timeout(5_000) }).catch(() => null);
      if (route) { claudeRoutes.set(hostId, { name: hostName, baseHost: route.baseHost, keyId: route.keyId ?? null }); routeAt.set(hostId, Date.now()); }
    }
    return claudeRoutes.get(hostId)?.baseHost ?? null;
  }
  // `hosts` — BB's current host list: current names, removed machines dropped.
  // One row per VClaude account (hash of the machine's key); the server's cabinet quota
  // belongs to one of them (0.3.2). No cabinet on the server — no rows, as before.
  async function vclaudeAccounts(refresh: boolean, hosts?: readonly { id: string; name: string }[]): Promise<Account[]> {
    const { usage, error, email } = await readVClaude(refresh);
    if (!usage && !error) return [];
    const labels = parseVClaudeLabels((await settings.get()).vclaudeLabels);
    const groups = vclaudeGroups(claudeRoutes, vclaudeHost, hosts, { cabinetEmail: email, labels });
    return groups.map(group => {
      const base = { key: group.key, providerId: 'vclaude', providerName: 'VClaude', hostIds: group.hostIds, hostNames: group.hostNames,
        email: group.cabinet ? email : null, label: group.label, accountId: group.id, plan: null, resetCount: null };
      if (!group.cabinet) return { ...base, status: 'unavailable' as const, fetchedAt: null, windows: [],
        message: `Кабинет этого аккаунта не подключён на сервере BB (ID ${group.id}).` };
      return { ...base, status: error ? (usage ? 'stale' as const : 'unavailable' as const) : 'ok' as const,
        message: error ?? (usage?.limitUnits === 0 ? 'Действующий тариф отсутствует.' : null),
        fetchedAt: usage?.fetchedAt ?? null,
        meter: usage && usage.limitUnits > 0 ? { total: usage.limitUnits, left: usage.remainingUnits, tokensPerUnit: 1 / 0.8 } : null,
        note: usage && usage.limitUnits > 0 ? vclaudeNote(usage.remainingUnits, usage.limitUnits, usage.conversionRates, usage.queue) : null,
        windows: usage && usage.limitUnits > 0 ? [{
          // endsAt — end of the whole queue; the tick measures from the running package's start.
          kind: 'other' as const, label: 'Тариф', endsAt: usage.endsAt, startsAt: usage.startedAt, resetsAt: null,
          usedPercent: vclaudeUsedPercent(usage),
        }] : [] };
    });
  }
  // The VClaude account of the machine a turn runs on (thread header).
  async function vclaudeAccount(refresh: boolean, hostId: string | null): Promise<Account | null> {
    return vclaudeAccountOf(await vclaudeAccounts(refresh), hostId);
  }
  // Cache in memory only. No account identities or usage history persisted.
  const cache = new Map<string, { at: number; accounts: Account[] }>();
  const pending = new Map<string, Promise<Account[]>>();
  // Last per-model windows by account, shared across machines with that login.
  const modelWindows = new Map<string, QuotaWindow[]>();
  const modelWindowsLoaded = bb.storage.kv.get<[string, QuotaWindow[]][]>('modelWindows')
    .then(saved => { for (const [key, value] of saved ?? []) if (!modelWindows.has(key)) modelWindows.set(key, value); }).catch(() => undefined);
  async function displayName(id: string, fallback: string): Promise<string> {
    if (!providerNames || Date.now() - providerNames.at > 300_000) {
      const list = await bb.sdk.providers.list().catch(() => null);
      if (list) providerNames = { at: Date.now(), names: new Map(list.map(p => [p.id, p.displayName])) };
    }
    return providerNames?.names.get(id) ?? fallback;
  }
  async function readHost(hostId: string, hostName: string, refresh: boolean): Promise<Account[]> {
    const saved = cache.get(hostId);
    if (!refresh && saved && Date.now() - saved.at < 120_000) return saved.accounts;
    const running = pending.get(hostId);
    if (running) return running;
    const job = (async () => {
      await modelWindowsLoaded;
      try {
        const [raw, resets, profile, antigravity, route] = await Promise.all([
          bb.sdk.system.usageLimits({ hostId, refresh: true, signal: AbortSignal.timeout(20_000) }),
          hostClient.call('codexResets', null, { hostId, signal: AbortSignal.timeout(15_000) }).catch(() => ({ email: null, count: null })),
          hostClient.call('claudeProfile', null, { hostId, signal: AbortSignal.timeout(5_000) }).catch(() => null),
          // Older host bundles lack this method; such a host simply has no Antigravity rows.
          hostClient.call('antigravity', { refresh }, { hostId, signal: AbortSignal.timeout(40_000) }).catch(() => null),
          // Older host bundles lack this method: the last known route stays.
          hostClient.call('claudeRoute', null, { hostId, signal: AbortSignal.timeout(5_000) }).catch(() => null),
        ]);
        if (route) { claudeRoutes.set(hostId, { name: hostName, baseHost: route.baseHost, keyId: route.keyId ?? null }); routeAt.set(hostId, Date.now()); }
        const at = new Date().toISOString();
        const accounts = providers.map(provider => {
          const usage = record(raw[provider.id]);
          const old = saved?.accounts.find(a => a.providerId === provider.id);
          const parsed = usageWindows(usage);
          const ok = parsed.ok;
          const email = string(usage.accountEmail)?.toLowerCase() ?? null;
          const windows = ok ? carryModelWindows(parsed.windows, email ? modelWindows.get(`${provider.id}:${email}`) : undefined, Date.now()) : old?.windows ?? [];
          if (ok && email) {
            modelWindows.set(`${provider.id}:${email}`, windows.filter(w => w.kind === 'model'));
            // Kept across plugin reloads: a rate-limited Claude answer omits Fable until its reset.
            void bb.storage.kv.set('modelWindows', [...modelWindows]).catch(() => undefined);
          }
          return {
            key: `${provider.id}:${hostId}`, providerId: provider.id, providerName: provider.name,
            hostIds: [hostId], hostNames: [hostName], email: string(usage.accountEmail) ?? (!ok ? old?.email ?? null : null),
            plan: (provider.id === 'claude-code' && profile?.email && profile.email.toLowerCase() === string(usage.accountEmail)?.toLowerCase()
              ? claudeProfilePlan(profile.organizationType, profile.rateLimitTier) : null) ?? string(usage.planLabel), status: ok ? 'ok' : windows.length ? 'stale' : 'unavailable',
            message: ok ? null : string(usage.message) ?? `Нет данных: ${String(usage.status ?? 'unknown')}`,
            fetchedAt: ok ? at : old?.fetchedAt ?? null, windows,
            resetCount: provider.id === 'codex' && resets.email?.toLowerCase() === string(usage.accountEmail)?.toLowerCase() ? resets.count : null,
          } satisfies Account;
        });
        for (const provider of antigravityProviders) {
          const value = antigravity?.[provider.field];
          const old = saved?.accounts.find(a => a.providerId === provider.id);
          if (!value) { if (!antigravity && old) accounts.push({ ...old, status: 'stale', message: 'Машина не ответила о лимитах Antigravity' }); continue; }
          accounts.push({ key: `${provider.id}:${hostId}`, providerId: provider.id, providerName: await displayName(provider.id, provider.name),
            hostIds: [hostId], hostNames: [hostName], resetCount: null, ...value } satisfies Account);
        }
        cache.set(hostId, { at: Date.now(), accounts });
        return accounts;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Машина недоступна';
        const carried = (saved?.accounts ?? []).filter(a => antigravityProviders.some(p => p.id === a.providerId))
          .map(a => ({ ...a, status: 'stale' as const, message }));
        return [...carried, ...providers.map(provider => {
          const old = saved?.accounts.find(a => a.providerId === provider.id);
          return old ? { ...old, status: 'stale' as const, message } : {
            key: `${provider.id}:${hostId}`, providerId: provider.id, providerName: provider.name,
            hostIds: [hostId], hostNames: [hostName], email: null, plan: null,
            status: 'unavailable' as const, message, fetchedAt: null, windows: [],
            resetCount: null,
          };
        })];
      }
    })();
    pending.set(hostId, job);
    try { return await job; } finally { pending.delete(hostId); }
  }
  async function threadSnapshot(threadId: string, refresh: boolean): Promise<Snapshot> {
    const thread = await bb.sdk.threads.get({ threadId });
    // Тред каскада: кольцо по текущей ступени. Каскад не ответил — как раньше (провайдер без лимитов).
    const passport = isCascadeProvider(thread.providerId) ? await passportOf({ id: threadId, providerId: thread.providerId }) : null;
    if (passport?.step) {
      const step = passport.step;
      const hostName = await bb.sdk.hosts.get({ hostId: step.hostId }).then(h => h.name, () => null);
      // Главное — ступень `kind: 'gateway'` VClaude; запасной путь — Claude Code машины ступени направлен на VClaude.
      const viaVClaude = isVClaudeStep(step) || (step.kind === 'subscription'
        && vclaudeRouted(step.providerId, await hostRoute(step.hostId, hostName ?? step.hostId), vclaudeHost));
      // Аккаунт VClaude — тот, чьим ключом ходит машина ступени (маршрут с хешем ключа).
      if (viaVClaude) await hostRoute(step.hostId, hostName ?? step.hostId);
      const account = viaVClaude ? await vclaudeAccount(refresh, step.hostId).catch(() => null)
        : step.kind === 'subscription' ? (await readHost(step.hostId, hostName ?? step.hostId, refresh)).find(a => a.providerId === step.providerId) ?? null
        : null;
      return cascadeSnapshot(threadId, step, passport.profileId, hostName, account, viaVClaude);
    }
    const base: Snapshot = { threadId, providerId: thread.providerId, model: null, hostId: null,
      hostName: null, binding: 'unavailable', message: null, account: null };
    if (!supported(thread.providerId)) return { ...base, message: 'Этот провайдер не сообщает поддерживаемые лимиты' };
    if (!thread.environmentId) return { ...base, message: 'У треда ещё нет рабочей машины' };
    const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
    const host = await bb.sdk.hosts.get({ hostId: environment.hostId });
    base.hostId = host.id; base.hostName = host.name;
    const [requested, resolved, plugins, baseHost] = await Promise.all([
      bb.sdk.threads.events.list({ threadId, types: ['client/turn/requested'], order: 'desc', limit: '1' }),
      bb.sdk.threads.events.list({ threadId, types: ['provider.env-resolved'], order: 'desc', limit: '1' }),
      bb.sdk.plugins.list(),
      thread.providerId === 'claude-code' ? hostRoute(host.id, host.name) : Promise.resolve(null),
    ]);
    base.model = string(record(record(requested[0]?.data).execution).model);
    // Claude Code of this machine goes to VClaude: the package is the thread's quota, not a subscription.
    if (vclaudeRouted(thread.providerId, baseHost, vclaudeHost)) {
      const routed = vclaudeThreadSnapshot(base, baseHost, vclaudeHost, await vclaudeAccount(refresh, host.id).catch(() => null));
      if (routed) return routed;
    }
    const entries = record(resolved[0]?.data).entries;
    const names = Array.isArray(entries) ? entries.map(e => string(record(e).name)).filter((n): n is string => n !== null) : [];
    const pool = plugins.plugins.some(p => (p.id === 'account-pool' || p.id === 'account-pool-balanced') && p.enabled);
    // Antigravity threads run a fixed command (agy / agy-antig) with that machine's own sign-in.
    const acp = antigravityProviders.some(p => p.id === thread.providerId);
    if (!acp && (!resolved.length || pool || riskyOverride(names, thread.providerId))) {
      return { ...base, binding: 'uncertain', message: pool
        ? 'Работает пул аккаунтов. Аккаунт текущего запуска не подтверждён.'
        : !resolved.length ? 'Нет метаданных запуска для проверки авторизации.'
        : 'У треда отдельный профиль или маршрут авторизации. Аккаунт не подтверждён.' };
    }
    const accounts = await readHost(host.id, host.name, refresh);
    const account = accounts.find(a => a.providerId === thread.providerId) ?? null;
    return { ...base, binding: account?.email ? 'host-cli' : 'uncertain', account,
      message: account?.email ? null : 'CLI не сообщил идентификатор аккаунта',
      exhausted: acp ? await exhaustedState(threadId, account, base.model) : null };
  }
  /**
   * ACP providers report a spent budget only as the agent's text (Antig's gateway:
   * «request failed (code 402): {"error":"insufficient_balance",…}»), the thread stays
   * idle. Name the provider and the account so a spent Antig package is not taken
   * for Google's quota.
   */
  async function exhaustedState(threadId: string, account: Account | null, model: string | null): Promise<Snapshot['exhausted']> {
    if (!account) return null;
    const who = `${account.providerName} · ${account.email?.split('@')[0] ?? 'аккаунт'}`;
    const google = await displayName('acp-antigravity-acp', 'Google Antigravity');
    const spent = account.windows.find(w => w.usedPercent >= 100 && appliesToModel(w, model));
    const items = await bb.sdk.threads.events.list({ threadId, types: ['item/completed'], order: 'desc', limit: '30' }).catch(() => []);
    const last = items.map(e => record(record(e.data).item)).find(i => i.type === 'agentMessage');
    const text = string(last?.text) ?? '';
    const refusal = /request failed \(code (402|429)\)|insufficient_balance|RESOURCE_EXHAUSTED|quota exceeded|exceeded your current quota/i.test(text);
    // A refusal older than fresh figures with budget left (topped up since) no longer counts.
    if (!spent && !(refusal && account.status !== 'ok')) return null;
    if (account.providerId === 'acp-gemini-antig') {
      const left = account.meter?.left;
      return { title: `${who} — ${left !== undefined ? `${left} с` : 'баланс 0'}`,
        detail: `Пакет antig.ru исчерпан${refusal ? ': шлюз ответил insufficient_balance' : ''}. Это баланс antig.ru, не квота «${google}». Пополнить: antig.ru → Баланс.`,
        link: 'https://antig.ru/lk/topup' };
    }
    const reset = spent?.resetsAt ? new Date(spent.resetsAt).toLocaleString('ru-RU', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short', timeZone: 'Europe/Moscow' }) : null;
    return { title: `${who} — ${spent ? spent.label : 'лимит'}`,
      detail: `Квота Google AI Pro исчерпана${spent ? ` (${spent.label})` : ''}${reset ? `, сброс ${reset} МСК` : ''}${refusal ? '. Последний ответ — отказ по лимиту.' : '.'}`, link: null };
  }
  async function allAccounts(refresh: boolean): Promise<Account[]> {
    const hosts = await bb.sdk.hosts.list();
    const extra = readVClaude(refresh).catch(() => null);  // warm the quota while machines answer
    const accounts = (await Promise.all(hosts.map(async host => {
      if (host.status !== 'connected') return (cache.get(host.id)?.accounts ?? []).map(a => ({ ...a, status: 'stale' as const, message: 'Машина не подключена' }));
      return readHost(host.id, host.name, refresh);
    }))).flat();
    await extra;
    const vclaude = await vclaudeAccounts(false, hosts);
    return [...dedupeAccounts(accounts.filter(a => a.email !== null || a.windows.length > 0)), ...vclaude];
  }
  const codexVolumes = new Map<string, Awaited<ReturnType<typeof hostClient.call<'codexVolume'>>>>();
  let lastComparison: Awaited<ReturnType<typeof readComparison>> | null = null;
  async function volumeInputs(accounts: Account[]): Promise<VolumeInputs> {
    // Log scans run in the background; the page shows the last known figures at once.
    const hostIds = [...new Set(accounts.filter(a => a.providerId === 'codex').flatMap(a => a.hostIds))];
    const settle = <T,>(job: Promise<T>, ms: number) => Promise.race([job, new Promise<undefined>(r => setTimeout(() => r(undefined), ms))]);
    await settle(Promise.all(hostIds.map(id => hostClient.call('codexVolume', null, { hostId: id, signal: AbortSignal.timeout(120_000) })
      .then(v => { codexVolumes.set(id, v); }).catch(() => undefined))), 3_000);
    const codex = new Map(hostIds.map(id => [id, codexVolumes.get(id) ?? []] as const));
    const { usdRub, comparisonHost } = await settings.get();
    const comparison = readComparison(false).then(r => { lastComparison = r; return r; }).catch(() => null);
    const estimate = ((await settle(comparison, 3_000)) ?? lastComparison)?.estimate;
    const owner = cache.get(comparisonHost.trim())?.accounts.find(a => a.providerId === 'claude-code')?.email?.toLowerCase() ?? null;
    const meters = new Map<string, MeterSums>();
    for (const a of accounts.filter(a => a.providerId === 'acp-antigravity-acp' && a.email)) {
      const saved = await bb.storage.kv.get<{ sums: MeterSums }>(`meter:${a.providerId}:${a.email!.toLowerCase()}`).catch(() => undefined);
      if (saved) meters.set(a.key, saved.sums);
    }
    return { codex, meters, usdRub: usdRub > 0 ? usdRub : 100, claude: estimate && (estimate.usdPerPercent ?? 0) > 0 && (estimate.unitsPerPercent ?? 0) > 0
      ? { usdPerPercent: estimate.usdPerPercent!, unitsPerPercent: estimate.unitsPerPercent!, segments: estimate.segments, email: owner } : null };
  }
  // History of used percent: one row per day in plugin KV, kept 30 days.
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  type Sample = [number, string, string, string, number];  // time, key, account, window label, used %
  async function recordHistory() {
    const now = Date.now();
    const accounts = await allAccounts(false);
    const rows: Sample[] = accounts.filter(a => a.status === 'ok').flatMap(a => a.windows.map(w =>
      [now, a.key, a.providerId === 'vclaude' ? a.label ?? a.email ?? 'VClaude' : `${a.providerName} · ${a.email?.split('@')[0] ?? a.key}`, w.label, Math.round(w.usedPercent * 10) / 10] as Sample));
    await meterTokens(now, accounts);
    const key = `history:${day(now)}`;
    const known = (await bb.storage.kv.get<Sample[]>(key)) ?? [];
    await bb.storage.kv.set(key, [...known, ...rows].slice(-4000));
    for (const old of await bb.storage.kv.list('history:')) if (old < `history:${day(now - 30 * 86_400_000)}`) await bb.storage.kv.delete(old);
  }
  bb.background.schedule('history', '*/15 * * * *', recordHistory);
  // «Прямой Gemini» volume: agy's tokens on every machine of the account against its quota windows.
  async function meterTokens(now: number, accounts: Account[]) {
    for (const account of accounts.filter(a => a.providerId === 'acp-antigravity-acp' && a.status === 'ok' && a.email)) {
      const hosts: MeterReading['hosts'] = {};
      for (const hostId of account.hostIds) {
        const own = cache.get(hostId)?.accounts.find(a => a.providerId === account.providerId);
        if (!own?.tokens) return;  // a machine without figures: skip this interval
        hosts[hostId] = own.tokens;
      }
      const windows: MeterReading['windows'] = Object.fromEntries(account.windows.map(w =>
        [w.label, { used: w.usedPercent, resetsAt: w.resetsAt, group: w.scope?.includes('gemini') ? 'gemini' as const : 'claude-gpt' as const }]));
      const key = `meter:${account.providerId}:${account.email!.toLowerCase()}`;
      const saved = await bb.storage.kv.get<{ last: MeterReading | null; sums: MeterSums }>(key);
      const reading = { at: now, hosts, windows };
      await bb.storage.kv.set(key, { last: reading, sums: accumulate(saved?.last ?? null, reading, saved?.sums ?? {}) });
    }
  }
  async function readHistory(days: number) {
    const keys = Array.from({ length: days }, (_, i) => `history:${day(Date.now() - (days - 1 - i) * 86_400_000)}`);
    const series = new Map<string, { key: string; account: string; label: string; points: [number, number][] }>();
    for (const key of keys) for (const [t, k, account, label, used] of (await bb.storage.kv.get<Sample[]>(key)) ?? []) {
      const id = `${k}|${label}`;
      const s = series.get(id) ?? { key: k, account, label, points: [] };
      s.points.push([t, used]);
      series.set(id, s);
    }
    return { series: [...series.values()] };
  }
  // «Обсудить объёмы»: one BB thread per installation, continued with each question.
  async function discuss(text: string) {
    const accounts = await allAccounts(false);
    const inputs = await volumeInputs(accounts);
    const summary = accounts.map(a => {
      const v = volumeFor(a, inputs);
      return `- ${a.providerName} ${a.email ?? ''} (${a.hostNames.join(', ') || '—'}), ${a.plan ?? 'тариф неизвестен'}: `
        + a.windows.map(w => `${w.label} ${Math.round(w.usedPercent)}%${w.endsAt ? ` до ${w.endsAt.slice(0, 10)}` : w.resetsAt ? ` сброс ${w.resetsAt.slice(0, 16)}Z` : ''}`).join('; ')
        + (a.note ? ` (${a.note})` : '') + (v?.tokens ? `; объём ≈ ${short(v.tokens)} ${v.tokensLabel ?? ''} [${v.confidence}: ${v.source}]` : '');
    }).join('\n');
    const question = text.trim() || 'Посмотри сводку: какие аккаунты большие, какие маленькие, куда выгоднее направлять работу на этой неделе?';
    const message = `Сводка лимитов аккаунтов BB на ${new Date().toISOString().slice(0, 16)}Z (плагин «Аккаунты и объёмы»):\n${summary}\n\nВопрос: ${question}\n\nПравило: к gate.antig.ru скриптами не обращаться.`;
    const saved = await bb.storage.kv.get<string>('discuss:thread');
    if (saved) {
      const thread = await bb.sdk.threads.get({ threadId: saved }).catch(() => null);
      if (thread && !thread.archivedAt) {
        await bb.sdk.threads.send({ threadId: saved, mode: 'auto', input: [{ type: 'text', text: message, mentions: [] }] });
        return { threadId: saved };
      }
    }
    const { discussProjectId, discussHostId, comparisonHost } = await settings.get();
    const projects = await bb.sdk.projects.list();
    const project = projects.find(p => p.id === discussProjectId.trim()) ?? projects.find(p => p.name === 'bb-config') ?? projects[0];
    const hosts = await bb.sdk.hosts.list();
    const host = hosts.find(h => h.id === discussHostId.trim()) ?? hosts.find(h => h.id === comparisonHost.trim())
      ?? hosts.find(h => h.status === 'connected' && h.type === 'persistent');
    if (!project || !host) throw new Error('Не найден проект или машина для обсуждения — задайте их в настройках плагина.');
    const thread = await bb.sdk.threads.spawn({ projectId: project.id, title: 'Обсуждение объёмов аккаунтов',
      environment: { type: 'host', hostId: host.id, workspace: { type: 'unmanaged', path: homedir() } }, prompt: message });
    await bb.storage.kv.set('discuss:thread', thread.id);
    return { threadId: thread.id };
  }
  bb.rpc.register(rpcContract, {
    vclaude: ({ refresh }) => readVClaude(refresh),
    comparison: ({ refresh }) => readComparison(refresh),
    thread: ({ threadId, refresh }) => threadSnapshot(threadId, refresh),
    accounts: async ({ refresh }) => ({ accounts: await allAccounts(refresh) }),
    overview: async ({ refresh }) => {
      const accounts = await allAccounts(refresh);
      const inputs = await volumeInputs(accounts);
      const withVolume = accounts.map(a => ({ ...a, volume: volumeFor(a, inputs) }));
      return { accounts: withVolume, googleAnswer: googleComparison(withVolume) };
    },
    history: async ({ days }) => readHistory(days),
    discuss: async ({ text }) => discuss(text),
    details: async ({ key }) => {
      if (key === 'vclaude' || key.startsWith('vclaude:')) return { account: (await vclaudeAccounts(false)).find(a => a.key === key) ?? null, threads: [] };
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
