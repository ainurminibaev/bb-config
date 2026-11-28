// `adopt --native` (0.3.0): перевод треда Claude Code на каскад без потери памяти.
//
//   bb subscriptions-cascade adopt --native --thread <id> [--model <профиль>] [--prompt <текст>] [--wait <сек>] [--dry-run] [--json]
//
// 1. Ждём, пока исходный тред простаивает (status idle, очередь пуста).
// 2. Берём ID его сессии Claude из событий треда (`thread/identity`, `turn/*`).
// 3. Создаём тред каскада в ТОМ ЖЕ окружении (`environment: reuse`), с тем же
//    названием и родителем, профиль по умолчанию `auto`. В метаданные треда
//    кладётся только одноразовый ключ, сам посев — в хранилище плагина: чужая
//    запись метаданных не подсунет треду чужую сессию.
// 4. Первый ход каскада: сервер отдаёт запускателю `seedSession`, запускатель на
//    машине треда копирует jsonl исходной сессии под ID сессии нового треда и
//    стартует CLI с `--resume` — модель видит ту же цепочку сообщений.
// Исходный тред не трогаем: архивирует диспетчер после проверки.
// Для Codex и ACP — обычный `adopt` (Handoff-документ).

export interface NativeSourceThread {
  id: string;
  title: string;
  providerId: string;
  projectId: string;
  environmentId: string | null;
  parentThreadId: string | null;
  archived: boolean;
  status: string | null;
  queued: number;
}

export interface AdoptSeed {
  sourceThreadId: string;
  sourceSessionId: string;
  profileId: string;
  createdAt: number;
}

export interface NativeAdoptPorts {
  getThread(threadId: string): Promise<NativeSourceThread | null>;
  /** ID нативной сессии Claude треда по его событиям; null — сессии ещё нет. */
  sessionId(threadId: string): Promise<string | null>;
  saveSeed(nonce: string, seed: AdoptSeed): Promise<void>;
  dropSeed(nonce: string): Promise<void>;
  /** Новый тред каскада; возвращает его ID. */
  spawn(args: { projectId: string; environmentId: string; parentThreadId: string | null; title: string; model: string; prompt: string; nonce: string }): Promise<string>;
  sleep(ms: number): Promise<void>;
  now(): number;
  randomId(): string;
}

export interface NativeAdoptOptions {
  threadId: string;
  dryRun: boolean;
  /** Профиль каскада нового треда (по умолчанию `auto`). */
  model: string;
  prompt: string;
  /** Сколько ждать простоя исходного треда, с. */
  waitSeconds: number;
  providerId: string;
}

export interface NativeAdoptResult {
  threadId: string;
  title: string;
  action: 'native' | 'skip';
  reason: string;
  sessionId?: string | null;
  environmentId?: string | null;
  newThreadId?: string | null;
  error?: string;
}

export const DEFAULT_ADOPT_PROMPT = 'Тред переведён на Каскад подписок, сессия та же. Коротко, без инструментов: что мы решили последним, с каким файлом или веткой работали, что осталось сделать?';

/** Тред простаивает: не идёт ход и в очереди пусто. */
export function isIdle(t: Pick<NativeSourceThread, 'status' | 'queued'>): boolean {
  return t.status === 'idle' && t.queued === 0;
}

export async function runNativeAdopt(ports: NativeAdoptPorts, options: NativeAdoptOptions): Promise<NativeAdoptResult> {
  const skip = (t: Partial<NativeSourceThread>, reason: string): NativeAdoptResult => ({ threadId: options.threadId, title: t.title ?? '', action: 'skip', reason });
  let t = await ports.getThread(options.threadId);
  if (!t) return skip({}, 'тред не найден');
  if (t.archived) return skip(t, 'в архиве');
  if (t.providerId === options.providerId) return skip(t, 'уже в каскаде');
  if (t.providerId !== 'claude-code') return skip(t, `--native только для Claude Code (у треда ${t.providerId}); для него — adopt без --native (Handoff)`);
  const environmentId = t.environmentId;
  if (!environmentId) return skip(t, 'у треда нет окружения — продолжить в том же окружении нельзя');

  // 1. Простой: в --dry-run только показываем состояние.
  if (!isIdle(t) && !options.dryRun) {
    const until = ports.now() + options.waitSeconds * 1000;
    while (!isIdle(t) && ports.now() < until) {
      await ports.sleep(5_000);
      t = await ports.getThread(options.threadId) ?? t;
    }
    if (!isIdle(t)) return { ...skip(t, `тред не освободился за ${options.waitSeconds} с (${t.status}, в очереди ${t.queued})`), environmentId: t.environmentId };
  }

  // 2. Сессия Claude исходного треда.
  const sessionId = await ports.sessionId(t.id);
  if (!sessionId) return { ...skip(t, 'у треда ещё нет сессии Claude — переводить нечего, создайте тред каскада'), environmentId: t.environmentId };
  const busy = isIdle(t) ? '' : ` — сейчас ${t.status}, в очереди ${t.queued}: перевод дождётся простоя (до ${options.waitSeconds} с)`;
  const reason = `claude-code → каскад «${options.model}», то же окружение ${t.environmentId}, сессия ${sessionId} (копия при первом ходе)${busy}`;
  if (options.dryRun) return { threadId: t.id, title: t.title, action: 'native', reason, sessionId, environmentId: t.environmentId };

  // 3. Посев и новый тред. Сбой создания — посев убирается.
  const nonce = ports.randomId();
  await ports.saveSeed(nonce, { sourceThreadId: t.id, sourceSessionId: sessionId, profileId: options.model, createdAt: ports.now() });
  try {
    const newThreadId = await ports.spawn({
      projectId: t.projectId, environmentId, parentThreadId: t.parentThreadId, title: t.title || `Каскад: ${t.id}`,
      model: options.model, prompt: options.prompt, nonce,
    });
    return { threadId: t.id, title: t.title, action: 'native', reason, sessionId, environmentId: t.environmentId, newThreadId };
  } catch (error) {
    await ports.dropSeed(nonce).catch(() => undefined);
    return { threadId: t.id, title: t.title, action: 'native', reason, sessionId, environmentId: t.environmentId, error: error instanceof Error ? error.message : String(error) };
  }
}

export function formatNativeAdopt(r: NativeAdoptResult, dryRun: boolean): string {
  const head = `${r.threadId}  ${r.title.slice(0, 60)}`;
  if (r.action === 'skip') return `  пропуск  ${head} — ${r.reason}\n`;
  if (dryRun) return `План (ничего не изменено):\n  перевод  ${head} — ${r.reason}\nИсходный тред не меняется; архивирует его диспетчер после проверки.\n`;
  if (r.error) return `  ошибка   ${head} — ${r.error}\n`;
  return `  готово   ${head} → ${r.newThreadId ?? 'новый тред'} (сессия продолжится при первом ходе; исходный тред не тронут)\n`;
}

/**
 * Посев треда: одноразовый ключ из метаданных треда → посев из хранилища.
 * Ключ без посева, старше суток или уже занятый другим тредом — не действует.
 */
export interface SeedStore {
  pending(nonce: string): Promise<AdoptSeed | null>;
  claim(nonce: string, threadId: string, seed: AdoptSeed): Promise<void>;
  claimed(threadId: string): Promise<AdoptSeed | null>;
}

export async function seedFor(store: SeedStore, threadId: string, nonce: string | null, now: number): Promise<AdoptSeed | null> {
  const known = await store.claimed(threadId);
  if (known) return known;
  if (!nonce) return null;
  const seed = await store.pending(nonce);
  if (!seed || now - seed.createdAt > 24 * 3_600_000) return null;
  await store.claim(nonce, threadId, seed);
  return seed;
}

/** ID сессии Claude по событиям треда (новые первыми): `thread/identity`, `thread/started`, `turn/*`. */
export function sessionFromEvents(rows: readonly { type: string; data: unknown }[]): string | null {
  for (const row of rows) {
    if (!['thread/identity', 'thread/started', 'turn/completed', 'turn/started', 'turn/input/accepted'].includes(row.type)) continue;
    const id = row.data && typeof row.data === 'object' ? (row.data as Record<string, unknown>).providerThreadId : null;
    if (typeof id === 'string' && /^[0-9a-f-]{8,}$/iu.test(id)) return id;
  }
  return null;
}
