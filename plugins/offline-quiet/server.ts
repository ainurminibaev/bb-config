import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { PluginCliError, cliCommand, defineCli } from '@get-bb/plugin-sdk';
import { rpcContract } from './contract';
import { parseList, quietState, toHostLike, warned, type HostLike } from './logic';

export default async function offlineQuiet(bb: BbPluginApi) {
  const settings = bb.settings.define({
    machines: {
      type: 'string',
      label: 'Не предупреждать, что эти машины офлайн',
      description: 'Имена или ID машин через запятую или с новой строки. Сама машина остаётся в BB.',
      experimental_multiline: true,
      default: '',
    },
  });

  const hosts = async (): Promise<HostLike[]> =>
    (await bb.sdk.hosts.list()).map(toHostLike).filter((h): h is HostLike => h !== null);

  bb.rpc.register(rpcContract, {
    state: async () => {
      const [list, all] = await Promise.all([settings.get().then(v => parseList(v.machines)), hosts()]);
      return quietState(all, list);
    },
  });

  const save = (list: string[]) => settings.experimental_set({ machines: list.join(', ') });

  const describe = async () => {
    const list = parseList((await settings.get()).machines);
    const all = await hosts();
    const lines = [list.length ? `Без предупреждений: ${list.join(', ')}` : 'Список пуст: BB предупреждает обо всех машинах.'];
    for (const h of all) {
      const quiet = list.some(x => x.toLowerCase() === h.name.toLowerCase() || x.toLowerCase() === h.id.toLowerCase());
      lines.push(`${quiet ? '🔕' : '  '} ${h.name}  ${h.id}  ${h.status}${warned(h) ? ' (BB предупреждает)' : ''}`);
    }
    const unknown = list.filter(x => !all.some(h => h.name.toLowerCase() === x.toLowerCase() || h.id.toLowerCase() === x.toLowerCase()));
    if (unknown.length) lines.push(`Не найдены среди машин: ${unknown.join(', ')}`);
    return lines.join('\n');
  };

  const machineArg = { name: 'machine', description: 'Имя или ID машины', required: true, variadic: true } as const;
  const joined = (value: string | string[]) => ([] as string[]).concat(value).join(' ').trim();

  bb.cli.register(defineCli({
    name: 'offline-quiet',
    summary: 'Не показывать предупреждение «<машина> is offline» для выбранных машин',
    commands: {
      status: cliCommand({
        summary: 'Список машин без предупреждений и состояние всех машин',
        options: {},
        async run() { return { exitCode: 0, stdout: await describe() }; },
      }),
      add: cliCommand({
        summary: 'Перестать предупреждать об этой машине',
        positionals: [machineArg],
        options: {},
        async run(input) {
          const name = joined(input.positionals.machine);
          if (!name || /[,\n]/u.test(name)) throw new PluginCliError('Укажите одно имя или ID машины', { code: 'bad_name' });
          const list = parseList((await settings.get()).machines);
          if (!list.some(x => x.toLowerCase() === name.toLowerCase())) await save([...list, name]);
          return { exitCode: 0, stdout: await describe() };
        },
      }),
      remove: cliCommand({
        summary: 'Снова предупреждать об этой машине',
        positionals: [machineArg],
        options: {},
        async run(input) {
          const name = joined(input.positionals.machine).toLowerCase();
          const list = parseList((await settings.get()).machines);
          const next = list.filter(x => x.toLowerCase() !== name);
          if (next.length === list.length) throw new PluginCliError(`«${name}» нет в списке`, { code: 'not_listed' });
          await save(next);
          return { exitCode: 0, stdout: await describe() };
        },
      }),
    },
  }));
}
