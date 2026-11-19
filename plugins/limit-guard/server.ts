import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { PluginCliError, cliCommand, defineCli } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import {
  agentRules, assess, classifyWindow, normalizeThresholds, render,
  type Assessment, type QuotaWindow, type Thresholds,
} from './logic.ts';

const SUPPORTED = new Set(['claude-code', 'codex']);
const CACHE_MS = 60_000;

const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const text = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

interface HostUsage { at: number; fetchedAt: string | null; raw: Record<string, unknown> }

export interface Status {
  threadId: string;
  providerId: string;
  model: string | null;
  hostId: string | null;
  hostName: string | null;
  fetchedAt: string | null;
  thresholds: Thresholds;
  assessment: Assessment;
}

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    economyPercent: {
      type: 'number', label: 'Экономный режим с, %', default: 70,
      description: 'С этого процента любого окна лимита агент работает маленькими шагами и сохраняет каждый.',
    },
    finishPercent: {
      type: 'number', label: 'Режим финиша с, %', default: 90,
      description: 'С этого процента агент не начинает новое, сохраняет работу и пишет, что дальше.',
    },
  });
  let thresholds: Thresholds = { economy: 70, finish: 90 };
  const loadThresholds = (v: { economyPercent: number; finishPercent: number }) => {
    thresholds = normalizeThresholds({ economy: v.economyPercent, finish: v.finishPercent });
  };
  void settings.get().then(loadThresholds).catch(() => undefined);
  settings.onChange(next => loadThresholds(next));

  // Usage per host, in memory only: no account identities are persisted.
  const cache = new Map<string, HostUsage>();
  const pending = new Map<string, Promise<HostUsage>>();

  async function hostUsage(hostId: string, refresh: boolean): Promise<HostUsage> {
    const saved = cache.get(hostId);
    if (!refresh && saved && Date.now() - saved.at < CACHE_MS) return saved;
    const running = pending.get(hostId);
    if (running) return running;
    const job = (async () => {
      try {
        const raw = record(await bb.sdk.system.usageLimits({ hostId, refresh: true, signal: AbortSignal.timeout(20_000) }));
        const value = { at: Date.now(), fetchedAt: new Date().toISOString(), raw };
        cache.set(hostId, value);
        return value;
      } catch (error) {
        if (saved) return saved;
        throw error;
      }
    })();
    pending.set(hostId, job);
    try { return await job; } finally { pending.delete(hostId); }
  }

  async function threadModel(threadId: string): Promise<string | null> {
    try {
      const events = await bb.sdk.threads.events.list({ threadId, types: ['client/turn/requested'], order: 'desc', limit: '1' });
      return text(record(record(events[0]?.data).execution).model);
    } catch { return null; }
  }

  async function status(threadId: string, refresh: boolean): Promise<Status> {
    const thread = await bb.sdk.threads.get({ threadId });
    const base = { threadId, providerId: thread.providerId, model: null as string | null, hostId: null as string | null,
      hostName: null as string | null, fetchedAt: null as string | null, thresholds };
    const unknown = (reason: string): Status => ({ ...base, assessment: assess([], null, thresholds, reason) });
    if (!SUPPORTED.has(thread.providerId)) return unknown('этот провайдер не сообщает лимиты подписки');
    if (!thread.environmentId) return unknown('у треда ещё нет рабочей машины');
    const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
    base.hostId = environment.hostId;
    try { base.hostName = (await bb.sdk.hosts.get({ hostId: environment.hostId })).name; } catch { /* name is cosmetic */ }
    base.model = await threadModel(threadId);
    let usage: HostUsage;
    try { usage = await hostUsage(environment.hostId, refresh); }
    catch (error) { return unknown(`машина не ответила: ${error instanceof Error ? error.message : String(error)}`); }
    base.fetchedAt = usage.fetchedAt;
    const entry = record(usage.raw[thread.providerId]);
    if (entry.status !== 'ok') return unknown(text(entry.message) ?? `лимиты недоступны (${String(entry.status ?? 'нет данных')})`);
    const windows: QuotaWindow[] = (Array.isArray(entry.windows) ? entry.windows : []).flatMap(item => {
      const w = record(item);
      if (typeof w.label !== 'string' || typeof w.usedPercent !== 'number' || !Number.isFinite(w.usedPercent)) return [];
      return [{ label: w.label, kind: classifyWindow(w.label, w.kind, w.model), model: text(w.model),
        usedPercent: w.usedPercent, resetsAt: text(w.resetsAt) }];
    });
    let reason: string | null = null;
    try {
      const plugins = await bb.sdk.plugins.list();
      if (plugins.plugins.some(p => (p.id === 'account-pool' || p.id === 'account-pool-balanced') && p.enabled)) {
        reason = 'включён пул аккаунтов: цифры относятся к аккаунту машины, не обязательно к этому треду';
      }
    } catch { /* optional hint */ }
    return { ...base, assessment: assess(windows, base.model, thresholds, reason) };
  }

  const describe = (s: Status) => render(s.assessment, Date.now(), {
    provider: s.providerId, model: s.model, host: s.hostName, fetchedAt: s.fetchedAt,
  });

  bb.agents.registerTool({
    name: 'limit_status',
    description: 'Остаток лимита подписки для этого треда и режим работы: обычный, экономный или финиш. Вызывай перед большой задачей и после каждого законченного шага.',
    presentation: { label: { pending: 'Проверяю лимит', completed: 'Проверил лимит' }, suppress: true },
    parameters: z.object({ refresh: z.boolean().optional().describe('Запросить свежие данные, а не кэш за минуту') }),
    async execute({ refresh }, ctx) {
      try { return describe(await status(ctx.threadId, refresh ?? false)); }
      catch (error) { return { content: [{ type: 'text', text: `Лимит не удалось узнать: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    },
  });

  bb.agents.configure(context => SUPPORTED.has(context.provider.id)
    ? { tools: ['limit_status'], skills: [], instructions: agentRules(thresholds) }
    : { tools: [], skills: [] });

  bb.cli.register(defineCli({
    name: 'limit',
    summary: 'Остаток лимита подписки треда и режим работы (limit-guard)',
    commands: {
      status: cliCommand({
        summary: 'Показать лимит и режим: обычный, экономный, финиш',
        options: {
          thread: { type: 'string', description: 'ID треда; внутри треда можно не указывать' },
          self: { type: 'boolean', description: 'Текущий тред (по умолчанию внутри треда)' },
          refresh: { type: 'boolean', description: 'Не брать кэш за последнюю минуту' },
          json: { type: 'boolean', description: 'Вывод в JSON' },
        },
        async run(input, ctx) {
          const threadId = input.options.thread ?? ctx.threadId;
          if (!threadId) throw new PluginCliError('не указан тред', { code: 'thread_required', hint: 'Добавьте --thread <id> или запустите команду внутри треда.' });
          const s = await status(threadId, input.options.refresh ?? false);
          return { exitCode: 0, stdout: input.options.json ? JSON.stringify(s, null, 2) : describe(s) };
        },
      }),
    },
  }));
}
