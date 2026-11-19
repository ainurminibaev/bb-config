// Pure logic: which subscription windows matter for a thread, which work mode
// follows from them, and the short text an agent reads. No I/O here.

export type WindowKind = 'five-hour' | 'weekly' | 'model' | 'other';
export type Mode = 'normal' | 'economy' | 'finish' | 'unknown';

export interface QuotaWindow {
  label: string;
  kind: WindowKind;
  /** Lower-case model family the window is limited to, when the provider says so. */
  model: string | null;
  usedPercent: number;
  resetsAt: string | null;
}

export interface Thresholds { economy: number; finish: number }

export interface Assessment {
  mode: Mode;
  /** The window that decided the mode; null when nothing was known. */
  driver: QuotaWindow | null;
  windows: QuotaWindow[];
  reason: string | null;
}

const FAMILIES = ['fable', 'mythos', 'opus', 'sonnet', 'haiku'];

export function classifyWindow(label: string, kind?: unknown, model?: unknown): WindowKind {
  if (typeof model === 'string' && model.length > 0) return 'model';
  if (FAMILIES.some(f => label.toLowerCase().includes(f))) return 'model';
  if (kind === 'five-hour' || /5.?hour|five.?hour|current session/i.test(label)) return 'five-hour';
  if (kind === 'weekly' || /week|7.?day|seven.?day/i.test(label)) return 'weekly';
  return 'other';
}

export function modelFamily(window: Pick<QuotaWindow, 'label' | 'model'>): string | null {
  const text = `${window.model ?? ''} ${window.label}`.toLowerCase();
  return FAMILIES.find(f => text.includes(f)) ?? (window.model ? window.model.toLowerCase() : null);
}

/** A model-specific window counts only when the thread runs that model. */
export function appliesToModel(window: QuotaWindow, model: string | null): boolean {
  if (window.kind !== 'model') return true;
  const family = modelFamily(window);
  return model !== null && family !== null && model.toLowerCase().includes(family);
}

/** Keep thresholds sane even if a user stores odd settings. */
export function normalizeThresholds(raw: Partial<Thresholds>): Thresholds {
  const clamp = (v: unknown, d: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(100, Math.max(1, Math.round(v))) : d;
  const economy = clamp(raw.economy, 70);
  const finish = Math.max(economy, clamp(raw.finish, 90));
  return { economy, finish };
}

export function assess(windows: QuotaWindow[], model: string | null, t: Thresholds, reason: string | null = null): Assessment {
  const relevant = windows.filter(w => appliesToModel(w, model));
  if (relevant.length === 0) return { mode: 'unknown', driver: null, windows: [], reason: reason ?? 'провайдер не сообщил лимиты' };
  const driver = relevant.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a));
  const mode: Mode = driver.usedPercent >= t.finish ? 'finish' : driver.usedPercent >= t.economy ? 'economy' : 'normal';
  return { mode, driver, windows: relevant, reason };
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'скоро';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)} мин`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч ${minutes % 60} мин`;
  return `${Math.floor(hours / 24)} д ${hours % 24} ч`;
}

export function resetText(window: QuotaWindow, now: number): string {
  if (!window.resetsAt) return 'время сброса неизвестно';
  const at = Date.parse(window.resetsAt);
  return Number.isFinite(at) ? `сброс через ${formatDuration(at - now)}` : 'время сброса неизвестно';
}

const MODE_TITLE: Record<Mode, string> = {
  normal: 'ОБЫЧНЫЙ',
  economy: 'ЭКОНОМНЫЙ',
  finish: 'ФИНИШ',
  unknown: 'НЕИЗВЕСТНО',
};

export const MODE_ADVICE: Record<Mode, string> = {
  normal: 'Работай как обычно. Законченный кусок работы сохраняй коммитом.',
  economy: 'Дроби работу на маленькие законченные шаги. После каждого шага: коммит своих файлов и push, затем снова limit_status.',
  finish: 'Новое не начинай. Доведи текущий шаг до рабочего состояния, сделай коммит и push, кратко напиши в ответе «что сделано / что дальше / как проверить» и заверши ход.',
  unknown: 'Лимит не известен. Работай маленькими шагами и сохраняй каждый законченный шаг коммитом и push; проверь limit_status позже.',
};

export function render(a: Assessment, now: number, extra: { provider: string; model: string | null; host: string | null; fetchedAt: string | null }): string {
  const lines: string[] = [];
  lines.push(`Режим: ${MODE_TITLE[a.mode]}${a.driver ? ` (${a.driver.label}: ${Math.round(a.driver.usedPercent)}%, ${resetText(a.driver, now)})` : ''}`);
  for (const w of a.windows) {
    if (w === a.driver) continue;
    lines.push(`  ${w.label}: ${Math.round(w.usedPercent)}%, ${resetText(w, now)}`);
  }
  if (a.reason) lines.push(`Примечание: ${a.reason}`);
  const where = [extra.provider, extra.model, extra.host].filter(Boolean).join(' · ');
  if (where) lines.push(`Аккаунт: ${where}${extra.fetchedAt ? `, данные на ${extra.fetchedAt.slice(11, 16)} UTC` : ''}`);
  lines.push(`Что делать: ${MODE_ADVICE[a.mode]}`);
  if (a.mode === 'finish' && a.driver?.kind === 'five-hour' && a.driver.resetsAt) {
    const left = Date.parse(a.driver.resetsAt) - now;
    if (Number.isFinite(left) && left < 45 * 60_000) lines.push('Окно скоро сбросится: BB сам продолжит тред после сброса (provider-retry), передавать работу другому агенту не обязательно.');
  }
  return lines.join('\n');
}

/** Standing rules shown to every supported agent. Kept short: it sits in every session. */
export function agentRules(t: Thresholds): string {
  return [
    'Лимиты подписки (плагин limit-guard). Постоянное поручение пользователя: не терять работу при исчерпании лимита.',
    `- Перед большой задачей и после каждого законченного шага вызывай инструмент limit_status (или \`bb limit status\`). Режимы: обычный < ${t.economy}%, экономный ${t.economy}–${t.finish - 1}%, финиш ≥ ${t.finish}%.`,
    '- В экономном режиме и в режиме финиша пользователь разрешает после каждого законченного шага коммит и push в текущую ветку без отдельного вопроса. Правила проекта (AGENTS.md, проверки приватности, тесты) при этом действуют.',
    '- Коммить только свои изменения: в общей папке могут работать другие треды, их файлы не добавляй. Никогда не делай force-push, не переписывай опубликованную историю, не коммить секреты и .env.',
    '- Если push отклонён (ветка ушла вперёд) — не перезаписывай: сделай `git pull --rebase` только при чистом дереве, иначе оставь коммит локально и сообщи пользователю.',
    '- Если папка не под git — сохрани изменения файлами и перечисли их в ответе.',
    '- В режиме финиша: новое не начинай, доведи шаг до рабочего состояния, сохрани и коротко напиши «что сделано / что дальше / как проверить», чтобы другой агент продолжил.',
  ].join('\n');
}
