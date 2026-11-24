import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { hostContract, rpcContract } from './contract';
import { buildMachines, type Identity } from './directory';
export type { rpcContract } from './contract';

export default function projectOpen(bb: BbPluginApi) {
  bb.settings.define({
    finderHelper: { type: 'boolean', label: 'Локальный обработчик Finder установлен', default: false },
    finderSelect: { type: 'boolean', label: 'Выделять файл в Finder', default: false,
      description: 'Нужен обработчик 0.3.0 или новее на каждом Mac, с которого открываете. Выключено: открывается папка файла.' },
    placement: { type: 'select', label: 'Где показывать папку и терминал треда', default: 'row', options: ['row', 'menu'],
      experimental_optionLabels: { row: 'Кнопки в строке треда при наведении', menu: 'В меню «…» треда' },
      description: 'В меню «…» кнопки из строк убираются; отдельные действия можно вернуть в строку через Customize actions. В заголовке открытого треда кнопки есть всегда.' },
  });

  const host = bb.hosts.experimental_client({ contract: hostContract });
  let running: Promise<{ saved: number }> | null = null;
  async function prepare() {
    const hosts = (await bb.sdk.hosts.list()) as { id: string; name?: string | null; status?: string }[];
    const online = hosts.filter(h => h.status === 'connected');
    const [projects, environments, answers] = await Promise.all([
      bb.sdk.projects.list(), allEnvironments(),
      Promise.all(online.map(async h => [h.id, await host.call('identity', null, { hostId: h.id }).catch(() => null)] as const)),
    ]);
    const known = answers.filter((a): a is readonly [string, Identity & { handler: boolean }] => a[1] !== null);
    const machines = buildMachines(hosts, projects as never, environments, new Map(known));
    const results = await Promise.all(known.filter(([, identity]) => identity.handler).map(([self]) =>
      host.call('save', { version: 1 as const, self, machines }, { hostId: self }).then(r => r.saved, () => false)));
    return { saved: results.filter(Boolean).length };
  }
  async function allEnvironments() {
    const all: { hostId?: string | null; path?: string | null }[] = [];
    for (let offset = 0; offset < 5000; offset += 200) {
      const page = (await bb.sdk.environments.list({ limit: 200, offset })) as unknown as typeof all;
      all.push(...page);
      if (page.length < 200) break;
    }
    return all;
  }
  // One pass at a time: several clicks share it.
  bb.rpc.register(rpcContract, { prepare: () => running ??= prepare().finally(() => { running = null; }) });
}
