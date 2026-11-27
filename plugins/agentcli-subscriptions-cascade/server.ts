// Сервер плагина «Каскад подписок»: настройки, обнаружение аккаунтов,
// регистрация провайдера с динамическим списком моделей, мастер «Настроить».
// Исполнитель хода — bridge/ (мост, маршрутизатор) и launcher/ (запуск CLI на машине ступени).
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { defaultRegistry } from './adapters.ts';
import { normalizeConfig, seedConfig, sharedPathFor, stageOf, stepId } from './config.ts';
import {
  PROVIDER_ID, hostContract, rpcContract, stepSchema,
  type CascadeConfig, type CascadeState, type DiscoveredAccount, type Machine, type Platform, type WizardMachineState,
} from './contract.ts';
import { toDiscoveredAccount } from './discovery.ts';
import { registerExecutor } from './bridge/server-register.ts';
import { describeReading, healthFromReading, LimitMonitor, readingFromUsageLimits } from './limits.ts';
import { applyAutoMatches, resolveCell, suggestRows } from './models.ts';
import { providerModels, quotaLookupFor } from './profiles.ts';
import { revokeSsh, runWizard, wizardPlan, type ExecResult, type ProbeResult, type WizardDeps } from './wizard.ts';
import { MUTAGEN_FIND } from './sync/setup.ts';
import { MUTAGEN_LABEL } from './sync/mutagen.ts';
import { timelineExtensionKinds } from './timeline/contract.ts';
import { registerTimelineServer } from './timeline/server.ts';
import { registerSyncServer, syncModeOf } from './sync/service.ts';

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    config: {
      type: 'string', experimental_multiline: true, default: '',
      label: 'Конфигурация каскада (JSON)',
      description: 'Редактируется на экране ниже. Пусто — каскад по умолчанию: Claude на Tru → Claude на Mac → Claude на UA → Codex с подтверждением.',
    },
  });
  // Лента треда: RPC действий из строк; исполнитель подписывается через timeline.onAction.
  const timeline = registerTimelineServer(bb);
  const hostClient = bb.hosts.experimental_client({ contract: hostContract });
  const connected = new Set<string>();
  // Один запрос usageLimits на машину отдаёт все провайдеры: объединяем параллельные вызовы.
  const usageInFlight = new Map<string, Promise<Record<string, unknown>>>();
  const usageLimits = (hostId: string, signal: AbortSignal): Promise<Record<string, unknown>> => {
    const running = usageInFlight.get(hostId);
    if (running) return running;
    const job = bb.sdk.system.usageLimits({ hostId, refresh: true, signal }).then(r => r as Record<string, unknown>)
      .finally(() => usageInFlight.delete(hostId));
    usageInFlight.set(hostId, job);
    return job;
  };
  // Пакет vclaude читает плагин thread-account-usage (его кабинет, ключи и адрес остаются там).
  const vclaudeUsage = (refresh: boolean, signal: AbortSignal) => bb.sdk.plugins.callRpc({
    pluginId: 'thread-account-usage', method: 'vclaude', input: { refresh }, signal,
    outputSchema: z.object({ usage: z.unknown(), error: z.string().nullable() }),
  });
  const registry = defaultRegistry({ usageLimits, vclaudeUsage, now: () => Date.now() });
  // Модуль мониторинга лимитов: по LimitsAdapter на провайдер; движок читает его через healthFromReading.
  const monitor = new LimitMonitor(provider => registry.get(provider)?.limits);
  // Синхронизация файлов (Mutagen): исполнитель вызывает fileSync.prepareTurn / finishTurn вокруг хода.
  const fileSync = registerSyncServer(bb, () => loadConfig());
  // Исполнитель хода (путь B): RPC routeTurn/finishTurn для запускателя, паспорт треда, CLI.
  const executor = registerExecutor(bb, {
    providerId: PROVIDER_ID,
    loadConfig: async () => (await loadConfig()).config,
    setup: input => setup(input),
    saveConfig: async config => { await settings.experimental_set({ config: JSON.stringify(normalizeConfig(config), null, 2) }); },
    accounts: () => accounts,
    ensureDiscovered: () => discover(false),
    health: (config, threadId) => quotaLookupFor(config, threadId, (id, modelId) => {
      const step = config.steps.find(s => s.id === id);
      return healthFromReading(step ? monitor.current(stageOf(step)) : undefined, modelId, { connected: step ? connected.has(step.hostId) : false, now: Date.now(), policies: config.policies });
    }),
    refreshLimits: async (config, steps) => { await Promise.all(steps.map(s => monitor.refresh(stageOf(s), config.policies.preTurnBudgetMs).catch(() => undefined))); },
    observeLimit: (_config, step, event) => monitor.observe(stageOf(step), event, Date.now()),
    sync: { prepareTurn: (t, s, progress) => fileSync.prepareTurn(t, s, progress), finishTurn: (t, s) => fileSync.finishTurn(t, s), modeOf: (config, projectId) => syncModeOf(config, projectId) },
  });
  // Схема каскада в метке ступени — тот же движок и состояние треда, что у исполнителя.
  timeline.provideScheme(threadId => executor.scheme(threadId));

  let accounts: DiscoveredAccount[] = [];
  let hosts: CascadeState['hosts'] = [];
  let discoveredAt = 0;

  async function loadConfig(): Promise<{ config: CascadeConfig; seeded: boolean }> {
    const raw = (await settings.get()).config.trim();
    if (raw) {
      try { return { config: normalizeConfig(JSON.parse(raw)), seeded: false }; } catch { /* битый JSON — показываем умолчание и issue */ }
    }
    // Пустые настройки: каскад по умолчанию строится по машинам BB. До первого
    // обнаружения берём лёгкий список машин (без проб), иначе каскад без машин
    // не даёт ни ступеней, ни каталога моделей.
    if (hosts.length === 0) await quickHosts().catch(() => undefined);
    return { config: seedConfig(hosts.map(h => ({ id: h.hostId, name: h.name, platform: h.platform }))), seeded: true };
  }

  /** Машины BB одним вызовом, без проб и лимитов: имя и платформа по имени. */
  async function quickHosts(): Promise<void> {
    const list = await bb.sdk.hosts.list({ signal: AbortSignal.timeout(10_000) });
    if (hosts.length > 0) return; // обнаружение успело раньше
    hosts = list.filter(h => h.lifecycle.phase === 'active').map(h => ({
      hostId: h.id, name: h.name, connected: h.status === 'connected',
      platform: (/\bmac/i.test(h.name) ? 'macos' : /\bwin/i.test(h.name) ? 'windows' : 'linux') as Platform,
    }));
  }

  async function probe(hostId: string, sharedPath: string): Promise<ProbeResult> {
    return hostClient.call('probe', { sharedPath }, { hostId, signal: AbortSignal.timeout(15_000) });
  }

  // Обнаружение: один проход по машинам, на машину — usageLimits, providerCliStatus, probe и models по адаптерам.
  async function discover(refresh: boolean): Promise<void> {
    if (!refresh && Date.now() - discoveredAt < 120_000 && hosts.length > 0) return;
    const list = await bb.sdk.hosts.list({ signal: AbortSignal.timeout(10_000) });
    connected.clear();
    for (const h of list) if (h.status === 'connected') connected.add(h.id);
    const now = new Date().toISOString();
    const perHost = await Promise.all(list.filter(h => h.lifecycle.phase === 'active').map(async h => {
      const live = h.status === 'connected';
      const [facts, cli, usage] = live ? await Promise.all([
        probe(h.id, '/opt/bbfs').catch(() => null),
        bb.sdk.hosts.providerCliStatus({ hostId: h.id, signal: AbortSignal.timeout(15_000) }).catch(() => null),
        usageLimits(h.id, AbortSignal.timeout(20_000)).catch(() => ({} as Record<string, unknown>)),
      ]) : [null, null, {} as Record<string, unknown>];
      const at = Date.now();
      const found = live ? await Promise.all(registry.list().map(async adapter => toDiscoveredAccount({
        hostId: h.id, providerId: adapter.id, cliStatus: cli, now, usage: usage[adapter.id],
        models: await bb.sdk.providers.models({ hostId: h.id, providerId: adapter.id, preferCached: !refresh, signal: AbortSignal.timeout(20_000) }).catch(() => null),
        reading: readingFromUsageLimits(usage[adapter.id], { hostId: h.id, provider: adapter.id, profileRef: 'default', authority: 'subscription', bindingEpoch: 'discovery' }, at, true),
      }))) : [];
      return { host: { hostId: h.id, name: h.name, connected: live, platform: (facts?.platform ?? 'unknown') as Platform }, found };
    }));
    hosts = perHost.map(p => p.host);
    accounts = perHost.flatMap(p => p.found);
    discoveredAt = Date.now();
  }

  // ---- Провайдер «Каскад»: каталог моделей едет в bridgeOptions, перерегистрация при изменении ----
  let registration: { dispose(): void } | null = null;
  let catalogKey = '';
  async function syncProvider(config: CascadeConfig): Promise<void> {
    const models = providerModels(config, accounts);
    const key = JSON.stringify(models);
    if (key === catalogKey && registration) return;
    catalogKey = key;
    registration?.dispose();
    registration = bb.providers.register({
      id: PROVIDER_ID,
      displayName: 'Каскад подписок',
      icon: './assets/icon.svg',
      strings: {
        signInHint: 'Каскад использует CLI, залогиненные на машинах. Войдите в Claude Code или Codex на нужной машине.',
        expiredHint: 'Вход в CLI одной из машин истёк. Войдите заново на этой машине.',
        installUrl: 'https://getbb.app',
      },
      // Возможности — как у штатного Claude Code (ход исполняет его импортированный мост).
      capabilities: {
        supportsServiceTier: false, supportsNativeUserQuestion: true, fork: 'none', supportsManualCompaction: true,
        supportsThreadArchive: false, supportsThreadRename: false, permissionModes: ['accept-edits', 'auto', 'full'], reasoningLevels: ['low', 'medium', 'high'],
      },
      reasoningLevels: [{ id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' }],
      composerActions: ['plan'],
      env: { passthrough: ['CLAUDE_CODE_OAUTH_TOKEN'] },
      extensionKinds: timelineExtensionKinds,
      maintenance: { health: false, usage: false, installation: false },
      models: { scope: 'host', fallback: models.length > 0 ? models.map(m => ({ id: m.id, displayName: m.displayName, description: m.description, supportedReasoningEfforts: m.supportedReasoningEfforts, defaultReasoningEffort: m.defaultReasoningEffort, isDefault: m.isDefault })) : [] },
      experimental_bridgeOptions: { catalog: models.map(m => ({ ...m, reasoningDiscovery: 'known' })) },
      deriveProviderOptions: ctx => executor.deriveProviderOptions(ctx) as never,
    });
  }

  async function state(refresh: boolean): Promise<CascadeState> {
    await discover(refresh).catch(error => bb.log.warn(`обнаружение: ${error instanceof Error ? error.message : String(error)}`));
    const { config, seeded } = await loadConfig();
    const raw = (await settings.get()).config.trim();
    const issues: string[] = [];
    if (seeded && raw) issues.push('Сохранённая конфигурация не читается — показан каскад по умолчанию. Сохраните заново.');
    else if (seeded) issues.push('Показан каскад по умолчанию; он ещё не сохранён.');
    const cells: CascadeState['cells'] = {};
    for (const row of config.models) {
      cells[row.key] = Object.fromEntries(config.machines.map(m => [m.hostId,
        resolveCell(row, m.hostId, accounts.find(a => a.hostId === m.hostId && a.providerId === row.providerId))]));
    }
    for (const step of config.steps) {
      const account = accounts.find(a => a.hostId === step.hostId && a.providerId === step.providerId);
      if (account && !account.loggedIn) issues.push(`${label(config, step.hostId)} · ${step.providerId}: CLI не залогинен — ступень будет пропускаться.`);
    }
    await syncProvider(config).catch(error => issues.push(`Провайдер не зарегистрирован: ${error instanceof Error ? error.message : String(error)}`));
    issues.push(...executor.issues());
    const projects = (await bb.sdk.projects.list().catch(() => [])).map(p => ({ id: p.id, name: p.name }));
    const stepLimits: CascadeState['stepLimits'] = {};
    await Promise.all(config.steps.map(async step => {
      const stage = stageOf(step);
      const reading = refresh || !monitor.current(stage) ? await monitor.refresh(stage, config.policies.preTurnBudgetMs) : monitor.current(stage);
      const health = healthFromReading(reading, null, { connected: connected.has(step.hostId), now: Date.now(), policies: config.policies });
      stepLimits[step.id] = { ...describeReading(reading, health), resetsAt: health.resetsAt };
    }));
    return { config, hosts, accounts, cells, wizard: await wizardStates(config), stepLimits, projects, issues };
  }

  async function save(config: CascadeConfig): Promise<CascadeState> {
    const normalized = normalizeConfig(config);
    // Машина выключена — ключ каскада снимается с опоры (в фоне, без ошибок наружу).
    const before = (await loadConfig().catch(() => null))?.config;
    const anchor = normalized.machines.find(m => m.anchor) ?? null;
    for (const m of normalized.machines) {
      const was = before?.machines.find(x => x.hostId === m.hostId);
      if (was?.enabled && !m.enabled && !m.anchor) void revokeSsh(m, { exec, anchor }).then(n => bb.log.info(`машина ${m.label} выключена: ${n.join('; ')}`)).catch(() => undefined);
    }
    await settings.experimental_set({ config: JSON.stringify(normalized, null, 2) });
    return state(false);
  }

  async function adopt(): Promise<CascadeState> {
    await discover(true);
    let { config } = await loadConfig();
    const machines: Machine[] = [...config.machines];
    for (const h of hosts) {
      if (machines.some(m => m.hostId === h.hostId)) continue;
      // Новые машины добавляются выключенными: включает владелец.
      machines.push({ hostId: h.hostId, label: h.name, enabled: false, platform: h.platform, anchor: false, anchorSsh: null, sshAddress: null, ...sharedPathFor(h.platform) });
    }
    const steps = [...config.steps];
    for (const a of accounts.filter(a => a.installed)) {
      const id = stepId(a.hostId, a.providerId, null);
      if (steps.some(s => s.id === id)) continue;
      // Новая ступень — в конец каскада и с подтверждением: профили с общим
      // порядком подхватят её последней, переход на неё спросит владельца.
      // CLI залогинен, а квота подписки недоступна (auth) — похоже на API-шлюз; владелец уточнит.
      const gateway = a.providerId === 'claude-code' && a.loggedIn && a.limitsStatus === 'auth';
      steps.push(stepSchema.parse({ id, hostId: a.hostId, providerId: a.providerId, label: a.plan ?? (gateway ? 'шлюз' : ''), confirm: true, authority: gateway ? 'gateway' : 'subscription' }));
    }
    config = { ...config, machines, steps };
    config = { ...config, models: [...config.models, ...suggestRows(config, accounts)] };
    return save(applyAutoMatches(config, accounts));
  }

  // ---- Мастер «Настроить» ----
  const wizardKey = (hostId: string) => `wizard:${hostId}`;
  async function wizardStates(config: CascadeConfig): Promise<WizardMachineState[]> {
    const out: WizardMachineState[] = [];
    for (const m of config.machines) {
      const saved = await bb.storage.kv.get<WizardMachineState>(wizardKey(m.hostId)).catch(() => undefined);
      if (saved) out.push(saved);
    }
    return out;
  }

  /** Команда на машине через штатный терминал BB; ждём выхода процесса. */
  async function exec(machine: Machine, platform: Platform, command: string, timeoutMs: number): Promise<ExecResult> {
    const argv = platform === 'windows' ? ['powershell', '-NoProfile', '-NonInteractive', '-Command', command] : ['/bin/sh', '-lc', command];
    const terminal = await bb.sdk.terminals.create({ cols: 120, rows: 30, title: 'Каскад: мастер', scope: { kind: 'host_path', hostId: machine.hostId, cwd: null }, start: { mode: 'argv', argv } });
    const deadline = Date.now() + timeoutMs;
    let output = '';
    let since: number | undefined;
    try {
      while (Date.now() < deadline) {
        const page = await bb.sdk.terminals.output({ terminalId: terminal.id, ...(since === undefined ? {} : { sinceSeq: since }), signal: AbortSignal.timeout(10_000) });
        for (const chunk of page.chunks) output += Buffer.from(chunk.dataBase64, 'base64').toString('utf8');
        since = page.nextSeq;
        if (page.status === 'exited' || page.status === 'disconnected') return { exitCode: page.exitCode, output: output.slice(-4000) };
        await new Promise(r => setTimeout(r, 1_000));
      }
      return { exitCode: null, output: `${output.slice(-3000)}\nПревышено время ожидания` };
    } finally {
      await bb.sdk.terminals.close({ terminalId: terminal.id, mode: 'force' }).catch(() => undefined);
    }
  }

  const wizardDeps: WizardDeps = {
    probe: machine => probe(machine.hostId, machine.sharedPath),
    exec,
    async writeProbe(machine) {
      const path = `${machine.sharedPath.replace(/[\\/]+$/, '')}/.bb-cascade-probe`;
      await bb.sdk.files.write({ hostId: machine.hostId, path, content: 'ok' } as Parameters<typeof bb.sdk.files.write>[0]);
      await bb.sdk.files.remove({ hostId: machine.hostId, path });
      return true;
    },
    save: s => bb.storage.kv.set(wizardKey(s.hostId), s),
    now: () => new Date().toISOString(),
    async setAnchorSsh(hostId, target) {
      const { config } = await loadConfig();
      await save({ ...config, machines: config.machines.map(m => (m.hostId === hostId ? { ...m, anchorSsh: target } : m)) });
    },
  };

  /**
   * Мастер целиком на сервере: состояние шагов в bb.storage.kv, повтор продолжает
   * с места остановки; экран, CLI и ленивая настройка хода вызывают одно и то же.
   */
  async function setup(input: { hostIds?: string[]; dryRun?: boolean; recheck?: boolean; reset?: boolean; allowSsh?: string[] }): Promise<{ wizard: WizardMachineState[]; notes: string[] }> {
    const { config } = await loadConfig();
    const anchor = config.machines.find(m => m.anchor) ?? null;
    const machines = config.machines.filter(m => !input.hostIds || input.hostIds.includes(m.hostId));
    const notes: string[] = [];
    if (input.reset && !input.dryRun) {
      // «Настроить с нуля»: сессии Mutagen каскада, выданные ключи и шаги; файлы проектов и общий путь не трогаем.
      for (const m of machines) {
        if (!m.anchor) {
          const r = await exec(m, m.platform, `${MUTAGEN_FIND}; [ -n "$m" ] && "$m" sync terminate --label-selector ${MUTAGEN_LABEL}=1 || true`, 120_000).catch(() => null);
          notes.push(r?.exitCode === 0 ? `${m.label}: сессии Mutagen каскада сняты` : `${m.label}: сессии не сняты (${(r?.output ?? 'нет связи').slice(-120)})`);
          notes.push(...await revokeSsh(m, { exec, anchor }));
        }
        await bb.storage.kv.delete(wizardKey(m.hostId));
      }
      if (machines.some(m => !m.anchor && m.anchorSsh?.startsWith('bb-'))) {
        await save({ ...config, machines: config.machines.map(m => (machines.includes(m) && m.anchorSsh?.startsWith('bb-') ? { ...m, anchorSsh: null } : m)) });
      }
    }
    const states = new Map((await wizardStates((await loadConfig()).config)).map(st => [st.hostId, st]));
    const wizard = await runWizard(machines, states, { ...wizardDeps, anchor }, { dryRun: input.dryRun ?? false, recheck: input.recheck ?? false, allowSsh: new Set(input.allowSsh ?? []) });
    return { wizard, notes };
  }

  let wizardRunning: Promise<WizardMachineState[]> | null = null;
  bb.rpc.register(rpcContract, {
    state: ({ refresh }) => state(refresh),
    saveConfig: ({ config }) => save(config),
    adoptDiscovered: () => adopt(),
    wizardPlan: async ({ hostId }) => {
      const { config } = await loadConfig();
      const machine = config.machines.find(m => m.hostId === hostId);
      if (!machine) return { steps: [] };
      const facts = await probe(hostId, machine.sharedPath).catch(() => null);
      return { steps: wizardPlan(machine, { platform: facts?.platform ?? machine.platform, isRoot: facts?.isRoot ?? false }) };
    },
    wizardRun: async ({ hostIds, dryRun, recheck, reset, allowSsh }) => {
      if (wizardRunning) return { wizard: await wizardRunning };  // повторный клик не запускает второй проход
      wizardRunning = setup({ hostIds, dryRun, recheck, reset, allowSsh }).then(r => r.wizard);
      try { return { wizard: await wizardRunning }; } finally { wizardRunning = null; }
    },
  }, { experimental_discoverable: true, experimental_description: 'Каскад подписок: состояние и настройки экрана, мастер «Настроить» (wizardPlan, wizardRun: recheck — перепроверить, reset — с нуля, allowSsh — разрешить вход на опору по ключу).' });

  // Регистрация провайдера при загрузке: сразу (каталог есть всегда, см. providerModels),
  // затем в фоне обнаружение машин и уточнённый каталог — без ожидания экрана настроек.
  void loadConfig().then(({ config }) => syncProvider(config))
    .catch(error => bb.log.warn(`провайдер: ${String(error)}`))
    .then(() => discover(false))
    .then(() => loadConfig()).then(({ config }) => syncProvider(config))
    .catch(error => bb.log.warn(`обнаружение при запуске: ${String(error)}`));
  settings.onChange(() => { void loadConfig().then(({ config }) => syncProvider(config)).catch(() => undefined); void executor.refreshTestFlags(); });
}

function label(config: CascadeConfig, hostId: string): string {
  return config.machines.find(m => m.hostId === hostId)?.label ?? hostId;
}
