import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { PluginCliError, cliCommand, defineCli } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { clampMinutes, tick } from './logic';

const POLL_MS = 20_000;
const ORIGIN = 'subthread-autocollapse';
const prefsSchema = z.object({ preferences: z.object({ collapsedThreads: z.array(z.string()) }).passthrough() }).passthrough();

export default async function subthreadAutocollapse(bb: BbPluginApi) {
  const settings = bb.settings.define({
    enabled: { type: 'boolean', label: 'Сворачивать подтреды автоматически', default: true },
    minutes: { type: 'number', label: 'Через сколько минут сворачивать', default: 5 },
  });

  let since = new Map<string, number>();
  let lastRun: { at: number; parents: number; expanded: number; collapsed: string[]; error: string | null } | null = null;

  async function collapsedThreads(): Promise<string[]> {
    const result = await bb.sdk.plugins.callRpc({ pluginId: 'thread-list', method: 'listPreferences', input: null, outputSchema: prefsSchema });
    return result.preferences.collapsedThreads;
  }

  async function parentsWithSubthreads(): Promise<string[]> {
    const parents = new Set<string>();
    const limit = 500;
    for (let offset = 0; offset < 10_000; offset += limit) {
      const page = await bb.sdk.threads.list({ hasParent: true, archived: false, limit, offset });
      for (const thread of page) if (thread.parentThreadId) parents.add(thread.parentThreadId);
      if (page.length < limit) break;
    }
    return [...parents];
  }

  async function run() {
    const values = await settings.get();
    if (!values.enabled) { since = new Map(); return; }
    const delayMs = clampMinutes(values.minutes) * 60_000;
    try {
      const [parents, collapsed] = await Promise.all([parentsWithSubthreads(), collapsedThreads()]);
      const result = tick(parents, new Set(collapsed), since, Date.now(), delayMs);
      since = result.since;
      if (result.collapse.length > 0) {
        // Re-read right before writing so a click made meanwhile is not lost.
        const fresh = await collapsedThreads();
        const value = [...new Set([...fresh, ...result.collapse])];
        await bb.sdk.plugins.callRpc({ pluginId: 'thread-list', method: 'setPreference', input: { key: 'collapsedThreads', value, origin: ORIGIN }, outputSchema: z.unknown() });
      }
      lastRun = { at: Date.now(), parents: parents.length, expanded: result.since.size, collapsed: result.collapse, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastRun = { at: Date.now(), parents: 0, expanded: since.size, collapsed: [], error: message };
      bb.log.warn(`Subthread Autocollapse: ${message}`);
    }
  }

  bb.background.service('poll', {
    async start(signal) {
      while (!signal.aborted) {
        await run();
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, POLL_MS);
          signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
        });
      }
    },
  });

  const describe = async () => {
    const values = await settings.get();
    const minutes = clampMinutes(values.minutes);
    const now = Date.now();
    const lines = [`Автосворачивание: ${values.enabled ? 'включено' : 'выключено'}, через ${minutes} мин.`];
    if (lastRun) lines.push(`Последняя проверка: ${new Date(lastRun.at).toISOString()}; родителей с подтредами: ${lastRun.parents}${lastRun.error ? `; ошибка: ${lastRun.error}` : ''}`);
    if (lastRun?.collapsed.length) lines.push(`Свёрнуто в последней проверке: ${lastRun.collapsed.join(', ')}`);
    for (const [threadId, start] of since) lines.push(`${threadId}  свернётся через ${Math.max(0, Math.round((start + minutes * 60_000 - now) / 1000))} с`);
    if (since.size === 0) lines.push('Раскрытых списков подтредов нет.');
    return lines.join('\n');
  };

  bb.cli.register(defineCli({
    name: 'subthread-autocollapse',
    summary: 'Сворачивает раскрытые списки подтредов в боковой панели через заданное время',
    commands: {
      status: cliCommand({
        summary: 'Какие списки подтредов раскрыты и когда свернутся',
        options: {},
        async run() { return { exitCode: 0, stdout: await describe() }; },
      }),
      run: cliCommand({
        summary: 'Проверить сейчас, не дожидаясь очередного опроса',
        options: {},
        async run() {
          await run();
          if (lastRun?.error) throw new PluginCliError(lastRun.error, { code: 'check_failed' });
          return { exitCode: 0, stdout: await describe() };
        },
      }),
    },
  }));
}
