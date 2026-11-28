import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { hostContract, rpcContract } from './contract';
import { CASCADE_PLUGIN_ID, CASCADE_STATUS_METHOD, readPassport, type CascadePassport } from './cascade-passport';
import { fileOrigin } from './cascade-origin';
export type { rpcContract } from './contract';
export default function plugin(bb: BbPluginApi) {
  // The key keeps its first name: installations with a Mac already have it set.
  const settings = bb.settings.define({ macHostId: { type: 'string', label: 'ID компьютера, на котором открывать файлы (пусто — единственный подключённый Mac, иначе единственный Windows-компьютер)', default: '' } });
  const host = bb.hosts.experimental_client({ contract: hostContract });
  /** The desktop computer that opens files: the configured one, else the only Mac, else the only Windows PC. */
  let chosen: { at: number; key: string; value: { target: { id: string; name: string }; platform: string } } | null = null;
  const desktop = async () => {
    const key = (await settings.get()).macHostId;
    if (chosen && chosen.key === key && Date.now() - chosen.at < 5 * 60 * 1000) return chosen.value;
    const value = await resolveDesktop();
    chosen = { at: Date.now(), key, value };
    return value;
  };
  const resolveDesktop = async () => {
    const machines = (await bb.sdk.hosts.list()).filter(h => h.status === 'connected');
    const { macHostId } = await settings.get();
    const candidates = macHostId ? machines.filter(h => h.id === macHostId) : machines;
    const probed = await Promise.all(candidates.map(async machine => {
      try { return { machine, platform: (await host.call('info', null, { hostId: machine.id })).platform }; } catch { return { machine, platform: null }; }
    }));
    // Without an explicit choice an unreadable machine may be the Mac: never fall through to another computer.
    const unknown = probed.filter(h => h.platform === null);
    if (unknown.length && (!macHostId || !probed.some(h => h.platform !== null)))
      throw new Error(`Не удалось определить систему машины ${unknown.map(h => h.machine.name).join(', ')}. Повторите или укажите компьютер в настройках плагина.`);
    const desktops = probed.filter((h): h is { machine: typeof h.machine; platform: string } => h.platform !== null && ['darwin', 'win32'].includes(h.platform));
    const macs = desktops.filter(h => h.platform === 'darwin');
    const target = (macs.length === 1 ? macs[0] : desktops.length === 1 ? desktops[0] : null)?.machine;
    if (!target) throw new Error('Укажите подключённый Mac или Windows-компьютер в настройках плагина.');
    return { target, platform: (macs.length === 1 ? macs[0] : desktops[0])!.platform };
  };
  bb.rpc.register(rpcContract, {
  apps: async ({ extension }) => {
    const { target, platform } = await desktop();
    try { return { platform, ...(await host.call('apps', { extension }, { hostId: target.id })) }; }
    catch (error) { chosen = null; throw error; }
  },
  open: async ({ path, source, action, app }) => {
    const { target } = await desktop();
    let environmentId = source.environmentId;
    // Тред «Каскада подписок»: файлы — на машине со свежей копией по общему пути. Нет паспорта — как раньше.
    let passport: CascadePassport | null = null;
    if (source.threadId) {
      const thread = await bb.sdk.threads.get({ threadId: source.threadId });
      environmentId ??= thread.environmentId;
      passport = await readPassport((threadId, signal) => bb.sdk.plugins.callRpc({
        pluginId: CASCADE_PLUGIN_ID, method: CASCADE_STATUS_METHOD, input: { threadId }, outputSchema: z.unknown(), signal }), { id: source.threadId, providerId: thread.providerId });
    }
    let envHostId: string | null = null, envPath: string | null = null;
    if (environmentId) {
      const env = await bb.sdk.environments.get({ environmentId });
      envHostId = env.hostId; envPath = env.path;
    }
    const origin = fileOrigin({ kind: source.kind, explicitHostId: source.experimental_hostId, envHostId, envPath, passport });
    let hostId = origin.hostId;
    let root = origin.root;
    if (!hostId) throw new Error('Не удалось определить машину файла.');
    if (source.kind === 'thread-storage') {
      const machine = await bb.sdk.hosts.get({ hostId });
      if (!machine.threadStorageRootPath || !source.threadId) throw new Error('Хранилище треда недоступно.');
      root = resolve(machine.threadStorageRootPath, source.threadId);
    }
    const absolute = isAbsolute(path) ? path : root ? resolve(root, path) : null;
    if (!absolute) throw new Error('Не удалось определить полный путь файла.');
    // Already on the computer that opens it (bb on a single PC): open the file itself.
    if (hostId === target.id && action !== 'save') return host.call('launch', { path: absolute, app, action }, { hostId });
    const bundle = await host.call('read', { path: absolute }, { hostId });
    return host.call('open', { bundle, action, app }, { hostId: target.id });
  } });
}
