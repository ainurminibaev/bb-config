import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { PluginCliError, cliCommand, defineCli } from '@get-bb/plugin-sdk';
import { hostContract, type EnsureResult } from './contract.ts';
import { VERSION_RE, shouldRun, type HostRecord } from './logic.ts';

const TICK_MS = 2 * 60 * 1000;
const CALL_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_VERSION = '2.2.0';
const KEY = 'host:';

interface Stored extends HostRecord { hostName: string; result: EnsureResult | null; error: string | null }

const errText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    autoInstall: { type: 'boolean', label: 'Автоматически ставить и чинить context-mode на подключённых машинах', default: true },
    version: { type: 'string', label: 'Закреплённая версия npm-пакета context-mode (более новую не откатываем)', default: DEFAULT_VERSION },
  });
  const host = bb.hosts.experimental_client({ contract: hostContract });
  const kv = bb.storage.kv;
  const busy = new Set<string>();

  const config = async () => {
    const v = (await settings.get()) as { autoInstall?: unknown; version?: unknown };
    const version = typeof v.version === 'string' && VERSION_RE.test(v.version.trim()) ? v.version.trim() : DEFAULT_VERSION;
    return { autoInstall: v.autoInstall !== false, version };
  };

  async function ensure(hostId: string, hostName: string, apply: boolean, verify: boolean): Promise<Stored> {
    if (busy.has(hostId)) throw new PluginCliError(`на ${hostName} проверка уже идёт`, { code: 'busy' });
    busy.add(hostId);
    const { version } = await config();
    try {
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
            for (const h of hosts) {
              if (signal.aborted || h.status !== 'connected' || busy.has(h.id)) continue;
              const record = (await kv.get(KEY + h.id)) as Stored | undefined;
              const justConnected = !first && !online.has(h.id);
              if (shouldRun(record, justConnected, Date.now())) void ensure(h.id, h.name, true, false).catch(() => undefined);
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
            const { autoInstall, version } = await config();
            const all = await Promise.all((await kv.list(KEY)).map(async key => (await kv.get(key)) as Stored));
            if (input.options.json) return { exitCode: 0, stdout: JSON.stringify({ autoInstall, version, hosts: all }, null, 2) };
            const head = `Автоустановка: ${autoInstall ? 'включена' : 'выключена'}, версия ${version}`;
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
