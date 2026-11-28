// «Перевести в каскад»: живые треды штатных Claude Code / Codex переезжают
// в провайдер каскада через штатный Handoff (новый тред с контекстом), а у
// исходного снимается ожидающий автоповтор provider-retry — иначе он
// повторит ход на исчерпанном лимите.
//   bb subscriptions-cascade adopt --stuck | --thread <id> | --project <id> [--dry-run] [--model <профиль>]
// `--native --thread <id>` — без Handoff, та же сессия Claude (adopt-native.ts).
// Чужие плагины вызываются по их CLI (REST сервера BB), их код не трогаем.

export interface AdoptThread {
  id: string;
  title: string;
  providerId: string;
  projectId: string;
  archived: boolean;
  /** Статус для --stuck: ошибка/лимит. */
  status: string | null;
}

export interface AdoptPorts {
  listThreads(filter: { projectId?: string }): Promise<AdoptThread[]>;
  getThread(threadId: string): Promise<AdoptThread | null>;
  /** Треды с ожидающим автоповтором (provider-retry status). */
  pendingRetries(): Promise<string[]>;
  /** Команда плагина BB: { exitCode, stdout, stderr }. */
  runPluginCli(pluginId: string, argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export interface AdoptOptions {
  stuck: boolean;
  threadId: string | null;
  projectId: string | null;
  dryRun: boolean;
  /** Профиль каскада для новых тредов. */
  model: string;
  providerId: string;
  /** `--native` (0.3.0): продолжить ту же сессию Claude в треде каскада, а не Handoff. */
  native?: boolean;
  /** Первое сообщение нового треда (`--native`). */
  prompt?: string | null;
  /** Сколько ждать простоя исходного треда, с (`--native`). */
  waitSeconds?: number;
}

export interface AdoptItem {
  threadId: string;
  title: string;
  action: 'handoff' | 'skip';
  reason: string;
  newThreadId?: string | null;
  retryCancelled?: boolean;
  error?: string;
}

const NATIVE = new Set(['claude-code', 'codex']);

export function parseAdoptArgs(argv: readonly string[]): AdoptOptions | { error: string } {
  const out = { stuck: false, threadId: null as string | null, projectId: null as string | null, dryRun: false, model: 'auto', json: false, native: false, prompt: null as string | null, waitSeconds: 600 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const value = () => { const v = argv[i + 1]; i += 1; return v ?? null; };
    if (arg === '--stuck') out.stuck = true;
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--thread') out.threadId = value();
    else if (arg === '--project') out.projectId = value();
    else if (arg === '--model') out.model = value() ?? 'auto';
    else if (arg === '--native') out.native = true;
    else if (arg === '--prompt') out.prompt = value();
    else if (arg === '--wait') { const n = Number(value()); if (!Number.isFinite(n) || n < 0) return { error: '--wait <секунды>' }; out.waitSeconds = n; }
    else return { error: `неизвестный аргумент ${arg}` };
  }
  const modes = [out.stuck, out.threadId !== null, out.projectId !== null].filter(Boolean).length;
  if (modes !== 1) return { error: 'укажите ровно одно: --stuck, --thread <id> или --project <id>' };
  if (out.native && !out.threadId) return { error: '--native переводит один тред: укажите --thread <id>' };
  return { stuck: out.stuck, threadId: out.threadId, projectId: out.projectId, dryRun: out.dryRun, model: out.model, providerId: '', native: out.native, prompt: out.prompt, waitSeconds: out.waitSeconds };
}

/** ID нового треда из вывода Handoff (`thr_…` в последней строке с ним). */
export function newThreadIdFrom(stdout: string, sourceId: string): string | null {
  const ids = [...stdout.matchAll(/\bthr_[a-z0-9]{6,}\b/gu)].map(m => m[0]).filter(id => id !== sourceId);
  return ids.at(-1) ?? null;
}

export async function planAdopt(ports: AdoptPorts, options: AdoptOptions): Promise<AdoptItem[]> {
  let threads: AdoptThread[] = [];
  if (options.threadId) {
    const t = await ports.getThread(options.threadId);
    if (!t) return [{ threadId: options.threadId, title: '', action: 'skip', reason: 'тред не найден' }];
    threads = [t];
  } else if (options.projectId) {
    threads = await ports.listThreads({ projectId: options.projectId });
  } else {
    const pending = new Set(await ports.pendingRetries());
    const all = await ports.listThreads({});
    threads = all.filter(t => pending.has(t.id) || t.status === 'error');
  }
  return threads.map(t => {
    if (t.archived) return { threadId: t.id, title: t.title, action: 'skip' as const, reason: 'в архиве' };
    if (t.providerId === options.providerId) return { threadId: t.id, title: t.title, action: 'skip' as const, reason: 'уже в каскаде' };
    if (!NATIVE.has(t.providerId)) return { threadId: t.id, title: t.title, action: 'skip' as const, reason: `провайдер ${t.providerId} не переводится` };
    return { threadId: t.id, title: t.title, action: 'handoff' as const, reason: `${t.providerId} → каскад «${options.model}»` };
  });
}

export async function runAdopt(ports: AdoptPorts, options: AdoptOptions): Promise<AdoptItem[]> {
  const plan = await planAdopt(ports, options);
  if (options.dryRun) return plan;
  const out: AdoptItem[] = [];
  for (const item of plan) {
    if (item.action !== 'handoff') { out.push(item); continue; }
    const handoff = await ports.runPluginCli('handoff', [item.threadId, '--to', options.providerId, '--model', options.model])
      .catch(error => ({ exitCode: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) }));
    if (handoff.exitCode !== 0) {
      out.push({ ...item, error: (handoff.stderr || handoff.stdout).trim().slice(0, 300) || `handoff: код ${handoff.exitCode}` });
      continue;
    }
    // Автоповтор у исходного треда больше не нужен: его ход продолжит новый тред.
    const cancel = await ports.runPluginCli('provider-retry', ['cancel', item.threadId])
      .catch(() => ({ exitCode: 1, stdout: '', stderr: '' }));
    out.push({ ...item, newThreadId: newThreadIdFrom(handoff.stdout, item.threadId), retryCancelled: cancel.exitCode === 0 });
  }
  return out;
}

export function formatAdopt(items: readonly AdoptItem[], dryRun: boolean): string {
  if (items.length === 0) return 'Подходящих тредов нет.\n';
  const lines = items.map(i => {
    const head = `${i.threadId}  ${i.title.slice(0, 60)}`;
    if (i.action === 'skip') return `  пропуск  ${head} — ${i.reason}`;
    if (dryRun) return `  перевод  ${head} — ${i.reason}`;
    if (i.error) return `  ошибка   ${head} — ${i.error}`;
    return `  готово   ${head} → ${i.newThreadId ?? 'новый тред'}${i.retryCancelled ? ', автоповтор снят' : ''}`;
  });
  return `${dryRun ? 'План (ничего не изменено):' : 'Перевод в каскад:'}\n${lines.join('\n')}\n`;
}
