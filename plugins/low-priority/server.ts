import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { PluginCliError, cliCommand, defineCli } from '@get-bb/plugin-sdk';
import { rpcContract, type State } from './contract';
import { clampPercent, decide, nextCheck, parseScope, reason, scopeLabel, type Flag, type Scope, type Window } from './logic';

const FRESH_MS = 90_000;
const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};

export default async function lowPriority(bb: BbPluginApi) {
  const settings = bb.settings.define({
    percent: { type: 'number', label: 'Порог по умолчанию, %', default: 60 },
    scope: { type: 'select', label: 'Какой лимит смотреть по умолчанию', options: ['five-hour', 'weekly', 'any'], default: 'five-hour',
      experimental_optionLabels: { 'five-hour': '5-часовое окно', weekly: 'Недельный лимит', any: 'Любой из двух' } },
  });
  const flags = new Map<string, Flag>();
  for (const key of await bb.storage.kv.list('low:')) {
    const value = await bb.storage.kv.get<Flag>(key);
    if (value) flags.set(key.slice(4), { percent: clampPercent(value.percent, 60), scope: parseScope(value.scope, 'five-hour') });
  }
  const parents = new Map<string, string | null>();
  const usage = new Map<string, { at: number; windows: Window[] | null }>();

  /** The nearest marked thread going up the parent chain, itself first. */
  async function applies(threadId: string, parentHint?: string | null): Promise<{ id: string; flag: Flag } | null> {
    if (flags.size === 0) return null;
    let id: string | null = threadId;
    for (let depth = 0; id && depth < 8; depth++) {
      const flag = flags.get(id);
      if (flag) return { id, flag };
      if (!parents.has(id)) {
        const parent: string | null = depth === 0 && parentHint !== undefined ? parentHint
          : (await bb.sdk.threads.get({ threadId: id })).parentThreadId ?? null;
        parents.set(id, parent);
      }
      id = parents.get(id) ?? null;
    }
    return null;
  }

  async function windowsFor(hostId: string, providerId: string): Promise<Window[] | null> {
    const key = `${hostId}:${providerId}`;
    const saved = usage.get(key);
    if (saved && Date.now() - saved.at < FRESH_MS) return saved.windows;
    let windows: Window[] | null = null;
    try {
      const raw = await bb.sdk.system.usageLimits({ hostId, signal: AbortSignal.timeout(6_000) });
      const mine = record(record(raw)[providerId]);
      if (mine.status === 'ok' && Array.isArray(mine.windows)) {
        windows = mine.windows.flatMap(item => {
          const w = record(item);
          return typeof w.label === 'string' && typeof w.usedPercent === 'number'
            ? [{ label: w.label, kind: w.kind, usedPercent: w.usedPercent, resetsAt: typeof w.resetsAt === 'string' ? w.resetsAt : null }] : [];
        });
      }
    } catch (error) {
      bb.log.warn(`Low Priority: no limit data for ${key}: ${error instanceof Error ? error.message : String(error)}`);
    }
    // Unknown usage never holds work: a broken meter must not stop a thread.
    usage.set(key, { at: Date.now(), windows });
    return windows;
  }

  async function check(threadId: string, parentHint?: string | null) {
    const hit = await applies(threadId, parentHint);
    if (!hit) return { hit: null, decision: { hold: false as const } };
    const thread = await bb.sdk.threads.get({ threadId });
    if (!thread.environmentId) return { hit, decision: { hold: false as const } };
    const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
    return { hit, decision: decide(hit.flag, await windowsFor(environment.hostId, thread.providerId)) };
  }

  bb.experimental_hooks.on('message.dispatch', async (ctx) => {
    try {
      // A steer into a running turn is the user talking to work already paid for.
      if (ctx.attempt !== 'start-turn') return { action: 'proceed' };
      const { decision } = await check(ctx.thread.id, ctx.thread.parentThreadId ?? null);
      if (!decision.hold) return { action: 'proceed' };
      return { action: 'wait', reason: reason(decision), sendAt: nextCheck(decision, Date.now()) };
    } catch (error) {
      bb.log.warn(`Low Priority: check failed, letting the message through: ${error instanceof Error ? error.message : String(error)}`);
      return { action: 'proceed' };
    }
  });

  async function state(threadId: string): Promise<State> {
    const { hit, decision } = await check(threadId);
    const s = { own: flags.get(threadId)?.percent ?? null, effective: hit?.flag.percent ?? null,
      inheritedFrom: hit && hit.id !== threadId ? hit.id : null, holding: decision.hold ? reason(decision) : null };
    return { ...s, summary: !hit ? 'Обычный тред: задания не откладываются.'
      : `Неприоритетный: ждёт, когда ${scopeLabel(hit.flag.scope)} от ${hit.flag.percent}%${s.inheritedFrom ? ` (от родителя ${s.inheritedFrom})` : ''}. ${s.holding ?? 'Сейчас лимит ниже порога, задания идут.'}` };
  }
  async function mark(threadId: string, percent: number | null, scope?: Scope): Promise<State> {
    if (percent === null) { flags.delete(threadId); await bb.storage.kv.delete(`low:${threadId}`); }
    else { const flag = { percent, scope: scope ?? await defaultScope() }; flags.set(threadId, flag); await bb.storage.kv.set(`low:${threadId}`, flag); }
    await bb.experimental_hooks.recheck('message.dispatch');
    return state(threadId);
  }
  const defaultPercent = async () => clampPercent((await settings.get()).percent, 60);
  const defaultScope = async () => parseScope((await settings.get()).scope, 'five-hour');

  bb.events.on('thread.deleted', ({ thread }) => { parents.delete(thread.id); if (flags.delete(thread.id)) void bb.storage.kv.delete(`low:${thread.id}`); });

  bb.rpc.register(rpcContract, {
    state: ({ threadId }) => state(threadId),
    toggle: async ({ threadId }) => mark(threadId, flags.has(threadId) ? null : await defaultPercent()),
    marks: async ({ threadIds }) => {
      const out: Record<string, { percent: number; holding: boolean; title: string }> = {};
      if (flags.size === 0) return out;
      for (const threadId of threadIds) {
        try {
          const hit = await applies(threadId);
          if (!hit) continue;
          const s = await state(threadId);
          out[threadId] = { percent: hit.flag.percent, holding: s.holding !== null, title: s.summary };
        } catch { /* a thread that vanished has no badge */ }
      }
      return out;
    },
  });

  const describe = (s: State) => s.summary;
  const threadOption = { type: 'string', description: 'ID треда; внутри треда можно не указывать' } as const;
  const requireThread = (value: string | undefined, ctx: { threadId?: string }) => {
    const id = value ?? ctx.threadId;
    if (!id) throw new PluginCliError('укажите --thread', { code: 'no_thread' });
    return id;
  };
  bb.cli.register(defineCli({
    name: 'low-priority',
    summary: 'Неприоритетные треды: задания ждут, пока лимит подписки выше порога',
    commands: {
      on: cliCommand({
        summary: 'Сделать тред неприоритетным (он и его подтреды ждут выше порога)',
        options: { thread: threadOption, at: { type: 'string', description: 'Порог в процентах; по умолчанию из настроек (60)' },
          window: { type: 'string', description: 'Какой лимит смотреть: 5h, week или any; по умолчанию из настроек (5h)' } },
        async run(input, ctx) {
          const percent = input.options.at === undefined ? await defaultPercent() : clampPercent(input.options.at, NaN);
          if (!Number.isFinite(percent)) throw new PluginCliError('--at должен быть числом от 1 до 100', { code: 'bad_percent' });
          return { exitCode: 0, stdout: describe(await mark(requireThread(input.options.thread, ctx), percent, parseScope(input.options.window, await defaultScope()))) };
        },
      }),
      off: cliCommand({
        summary: 'Снять отметку с треда; ждущие задания отправятся',
        options: { thread: threadOption },
        async run(input, ctx) { return { exitCode: 0, stdout: describe(await mark(requireThread(input.options.thread, ctx), null)) }; },
      }),
      status: cliCommand({
        summary: 'Показать, неприоритетный ли тред и держит ли он задания сейчас',
        options: { thread: threadOption },
        async run(input, ctx) { return { exitCode: 0, stdout: describe(await state(requireThread(input.options.thread, ctx))) }; },
      }),
      list: cliCommand({
        summary: 'Все отмеченные треды',
        options: {},
        async run() { return { exitCode: 0, stdout: flags.size ? [...flags].map(([id, f]) => `${id}  ${f.percent}%  ${scopeLabel(f.scope)}`).join('\n') : 'Неприоритетных тредов нет.' }; },
      }),
    },
  }));
}
