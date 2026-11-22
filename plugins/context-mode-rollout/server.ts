import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { PluginCliError, cliCommand, defineCli } from '@get-bb/plugin-sdk';
import { hostContract, type EnsureResult } from './contract.ts';
import { VERSION_RE, pickVersion, shouldRun, type HostRecord } from './logic.ts';

const TICK_MS = 2 * 60 * 1000;
const CALL_TIMEOUT_MS = 30 * 60 * 1000;
// Used only when the npm registry cannot be reached and nothing was resolved before.
const FALLBACK_VERSION = '2.2.0';
const REGISTRY_URL = 'https://registry.npmjs.org/context-mode';
const REGISTRY_TTL_MS = 60 * 60 * 1000;
const KEY = 'host:';
const TARGET_KEY = 'target';

interface Stored extends HostRecord { hostName: string; result: EnsureResult | null; error: string | null }

const errText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    autoInstall: { type: 'boolean', label: 'Автоматически ставить и чинить context-mode на подключённых машинах', default: true },
    version: { type: 'string', label: 'Версия context-mode: latest — актуальная с npm (после выдержки), или конкретная X.Y.Z (более новую не откатываем)', default: 'latest' },
    minAgeDays: { type: 'number', label: 'Выдержка нового релиза перед раскаткой, дней (для latest)', default: 2 },
  });
  const host = bb.hosts.experimental_client({ contract: hostContract });
  const kv = bb.storage.kv;
  const busy = new Set<string>();

  const config = async () => {
    const v = (await settings.get()) as { autoInstall?: unknown; version?: unknown; minAgeDays?: unknown };
    const raw = typeof v.version === 'string' ? v.version.trim() : 'latest';
    const minAgeDays = typeof v.minAgeDays === 'number' && v.minAgeDays >= 0 ? v.minAgeDays : 2;
    return { autoInstall: v.autoInstall !== false, version: VERSION_RE.test(raw) ? raw : 'latest', minAgeDays };
  };

  interface Target { version: string; source: string; resolvedAt: number }
  let cached: (Target & { key: string }) | null = null;

  /** The version to roll out now: the pinned one, or the npm release picked by pickVersion. */
  async function target(): Promise<Target> {
    const { version, minAgeDays } = await config();
    if (version !== 'latest') return { version, source: 'закреплена в настройках', resolvedAt: Date.now() };
    const key = `latest:${minAgeDays}`;
    if (cached?.key === key && Date.now() - cached.resolvedAt < REGISTRY_TTL_MS) return cached;
    try {
      const res = await fetch(REGISTRY_URL, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`npm registry HTTP ${res.status}`);
      const data = (await res.json()) as { 'dist-tags'?: { latest?: unknown }; time?: Record<string, string> };
      const latest = typeof data['dist-tags']?.latest === 'string' ? data['dist-tags'].latest : undefined;
      const picked = pickVersion(latest, data.time ?? {}, Date.now(), minAgeDays * 24 * 60 * 60 * 1000);
      if (!picked) throw new Error('в npm нет стабильных версий');
      const t: Target = { version: picked, source: `npm latest ${latest ?? '?'}, выдержка ${minAgeDays} дн.`, resolvedAt: Date.now() };
      cached = { ...t, key };
      await kv.set(TARGET_KEY, t);
      return t;
    } catch (error) {
      const last = (await kv.get(TARGET_KEY)) as Target | undefined;
      bb.log.warn(`npm registry: ${errText(error)}; беру ${last?.version ?? FALLBACK_VERSION}`);
      return { version: last?.version ?? FALLBACK_VERSION, source: `npm недоступен (${errText(error)}), последняя известная`, resolvedAt: Date.now() };
    }
  }

  async function ensure(hostId: string, hostName: string, apply: boolean, verify: boolean): Promise<Stored> {
    if (busy.has(hostId)) throw new PluginCliError(`на ${hostName} проверка уже идёт`, { code: 'busy' });
    busy.add(hostId);
    try {
      const { version } = await target();
      const result = await host.call('ensure', { version, apply, verify }, { hostId, timeoutMs: CALL_TIMEOUT_MS });
      const stored: Stored = { hostName, lastRunAt: Date.now(), ok: result.state !== 'error', result, error: null };
      if (apply) await kv.set(KEY + hostId, stored);
      bb.log.info(`${hostName}: ${result.state} — ${result.message}`);
      return stored;
    } catch (error) {
      const stored: Stored = { hostName, lastRunAt: Date.now(), ok: false, result: null, error: errText(error) };
      if (apply) await kv.set(KEY + hostId, stored);
      bb.log.warn(`${hostName}: ${stored.error}`);
      return stored;
    } finally {
      busy.delete(hostId);
    }
  }

  // No "machine connected" event exists: watch the host list and react to a host that appears
  // or comes back online, plus a daily re-check that repairs drift (a CLI reinstalled, a reset profile).
  bb.background.service('rollout', {
    async start(signal: AbortSignal) {
      let online = new Set<string>();
      let first = true;
      while (!signal.aborted) {
        try {
          const { autoInstall } = await config();
          const hosts = await bb.sdk.hosts.list();
          const now = new Set(hosts.filter(h => h.status === 'connected').map(h => h.id));
          if (autoInstall) {
            const { version } = await target();
            for (const h of hosts) {
              if (signal.aborted || h.status !== 'connected' || busy.has(h.id)) continue;
              const record = (await kv.get(KEY + h.id)) as Stored | undefined;
              const justConnected = !first && !online.has(h.id);
              // A new target version (release passed the quarantine) rolls out at once, not at the daily check.
              const newTarget = record?.ok === true && record.result !== null && record.result.pinned !== version;
              if (newTarget || shouldRun(record, justConnected, Date.now())) void ensure(h.id, h.name, true, false).catch(() => undefined);
            }
          }
          online = now;
          first = false;
        } catch (error) {
          bb.log.warn(`tick failed: ${errText(error)}`);
        }
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, TICK_MS);
          signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
        });
      }
    },
  });

  const line = (s: Stored) => {
    const when = new Date(s.lastRunAt).toISOString().replace('T', ' ').slice(0, 16);
    if (!s.result) return `${s.hostName}: ошибка вызова (${when}) — ${s.error}`;
    const r = s.result;
    const agents = r.agents.map(a => `${a.id}=${a.status}`).join(' ');
    return `${s.hostName}: ${r.state} (${when}) context-mode ${r.versionAfter ?? '—'} [${agents || r.clis.join(',') || 'нет CLI'}] — ${r.message}`;
  };

  const resolveHosts = async (machine: string | undefined) => {
    const hosts = (await bb.sdk.hosts.list()).filter(h => h.status === 'connected');
    if (!machine) return hosts;
    const found = hosts.filter(h => h.id === machine || h.name === machine);
    if (!found.length) throw new PluginCliError(`подключённая машина «${machine}» не найдена`, { code: 'host_not_found' });
    return found;
  };

  const machineOpt = { type: 'string', description: 'ID или имя машины (по умолчанию все подключённые)' } as const;
  const jsonOpt = { type: 'boolean', description: 'JSON' } as const;

  bb.cli.register(
    defineCli({
      name: 'context-mode-rollout',
      summary: 'context-mode в Claude Code и Codex на всех машинах BB: состояние, сухой прогон, установка',
      commands: {
        status: cliCommand({
          summary: 'Последний результат автоустановки по каждой машине',
          options: { json: jsonOpt },
          async run(input) {
            const { autoInstall } = await config();
            const t = await target();
            const all = await Promise.all((await kv.list(KEY)).map(async key => (await kv.get(key)) as Stored));
            if (input.options.json) return { exitCode: 0, stdout: JSON.stringify({ autoInstall, target: t, hosts: all }, null, 2) };
            const head = `Автоустановка: ${autoInstall ? 'включена' : 'выключена'}; целевая версия ${t.version} (${t.source})`;
            return { exitCode: 0, stdout: [head, ...(all.length ? all.map(line) : ['Машины ещё не проверялись.'])].join('\n') };
          },
        }),
        check: cliCommand({
          summary: 'Сухой прогон на машине: что поставил бы установщик (ничего не меняет)',
          options: { machine: machineOpt, verify: { type: 'boolean', description: 'Также запустить context-mode doctor (около минуты)' }, json: jsonOpt },
          async run(input) {
            const hosts = await resolveHosts(input.options.machine);
            const out = await Promise.all(hosts.map(h => ensure(h.id, h.name, false, Boolean(input.options.verify))));
            if (input.options.json) return { exitCode: 0, stdout: JSON.stringify(out, null, 2) };
            return { exitCode: out.every(s => s.ok) ? 0 : 1, stdout: out.map(line).join('\n') };
          },
        }),
        apply: cliCommand({
          summary: 'Установить/починить сейчас и проверить doctor',
          options: { machine: machineOpt, json: jsonOpt },
          async run(input) {
            const hosts = await resolveHosts(input.options.machine);
            const out = await Promise.all(hosts.map(h => ensure(h.id, h.name, true, true)));
            if (input.options.json) return { exitCode: 0, stdout: JSON.stringify(out, null, 2) };
            return { exitCode: out.every(s => s.ok) ? 0 : 1, stdout: out.map(line).join('\n') };
          },
        }),
      },
    }),
  );
}
