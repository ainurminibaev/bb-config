// Pure logic: which subscription windows matter for a thread, which work mode
// follows from them, and the short texts agents and people read. No I/O here.

export type WindowKind = 'five-hour' | 'weekly' | 'model' | 'other';
export type Mode = 'normal' | 'economy' | 'finish' | 'unknown';

export interface QuotaWindow {
  label: string;
  kind: WindowKind;
  /** Lower-case model family the window is limited to, when the provider says so. */
  model: string | null;
  usedPercent: number;
  resetsAt: string | null;
  /** Minutes until 100% at the recent pace, when it can be estimated. */
  etaMinutes?: number | null;
}

export interface Level { economy: number; finish: number }
export interface Thresholds {
  /** Five-hour and unknown short windows. */
  short: Level;
  /** Weekly windows, including model-specific weekly windows. */
  long: Level;
  /** Pace: economy / finish when the short window would be full within these minutes. */
  etaEconomyMinutes: number;
  etaFinishMinutes: number;
  /** The pace check starts at this share of the short window (an account rule raises it). */
  paceFrom?: number;
}
export const DEFAULT_THRESHOLDS: Thresholds = {
  short: { economy: 75, finish: 90 }, long: { economy: 90, finish: 97 }, etaEconomyMinutes: 40, etaFinishMinutes: 10,
};

export interface Assessment {
  mode: Mode;
  /** The window that decided the mode; null when nothing was known. */
  driver: QuotaWindow | null;
  windows: QuotaWindow[];
  reason: string | null;
}

const FAMILIES = ['fable', 'mythos', 'opus', 'sonnet', 'haiku'];
const RANK: Record<Mode, number> = { unknown: -1, normal: 0, economy: 1, finish: 2 };

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

const clampPercent = (v: unknown, d: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(100, Math.max(1, Math.round(v))) : d;
const clampMinutes = (v: unknown, d: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(600, Math.max(0, Math.round(v))) : d;

/** Keep thresholds sane even if a user stores odd settings. */
export function normalizeThresholds(raw: {
  shortEconomy?: unknown; shortFinish?: unknown; longEconomy?: unknown; longFinish?: unknown; etaEconomy?: unknown; etaFinish?: unknown;
}): Thresholds {
  const level = (e: unknown, f: unknown, d: Level): Level => {
    const economy = clampPercent(e, d.economy);
    return { economy, finish: Math.max(economy, clampPercent(f, d.finish)) };
  };
  const etaFinishMinutes = clampMinutes(raw.etaFinish, DEFAULT_THRESHOLDS.etaFinishMinutes);
  return {
    short: level(raw.shortEconomy, raw.shortFinish, DEFAULT_THRESHOLDS.short),
    long: level(raw.longEconomy, raw.longFinish, DEFAULT_THRESHOLDS.long),
    etaEconomyMinutes: Math.max(etaFinishMinutes, clampMinutes(raw.etaEconomy, DEFAULT_THRESHOLDS.etaEconomyMinutes)),
    etaFinishMinutes,
  };
}

/** Weekly and model windows move slowly: they get the "long" thresholds and no pace check. */
export function windowMode(w: QuotaWindow, t: Thresholds): Mode {
  const long = w.kind === 'weekly' || w.kind === 'model';
  const level = long ? t.long : t.short;
  if (w.usedPercent >= level.finish) return 'finish';
  const eta = long || w.usedPercent < (t.paceFrom ?? 0) ? null : w.etaMinutes ?? null;
  if (eta !== null && eta <= t.etaFinishMinutes && w.usedPercent < 100) return 'finish';
  if (w.usedPercent >= level.economy) return 'economy';
  if (eta !== null && eta <= t.etaEconomyMinutes) return 'economy';
  return 'normal';
}

export function assess(windows: QuotaWindow[], model: string | null, t: Thresholds, reason: string | null = null): Assessment {
  const relevant = windows.filter(w => appliesToModel(w, model));
  if (relevant.length === 0) return { mode: 'unknown', driver: null, windows: [], reason: reason ?? 'провайдер не сообщил лимиты' };
  let driver = relevant[0]!;
  let mode = windowMode(driver, t);
  for (const w of relevant.slice(1)) {
    const m = windowMode(w, t);
    if (RANK[m] > RANK[mode] || (RANK[m] === RANK[mode] && w.usedPercent > driver.usedPercent)) { driver = w; mode = m; }
  }
  return { mode, driver, windows: relevant, reason };
}

/** Pace from samples of one window: minutes until 100%, or null when it is not growing. */
export function etaMinutes(samples: { at: number; used: number }[], windowMs = 30 * 60_000): number | null {
  if (samples.length < 3) return null;
  const last = samples[samples.length - 1]!;
  const recent = samples.filter(s => last.at - s.at <= windowMs);
  if (recent.length < 3) return null;
  const first = recent[0]!;
  const minutes = (last.at - first.at) / 60_000;
  // Short bursts (a big tool call, a neighbour's spike) are not a pace: ten minutes at least.
  if (minutes < 10 || last.used <= first.used) return null;
  const rate = (last.used - first.used) / minutes;
  return Math.max(0, (100 - last.used) / rate);
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

const MODE_TITLE: Record<Mode, string> = { normal: 'ОБЫЧНЫЙ', economy: 'ЭКОНОМНЫЙ', finish: 'ФИНИШ', unknown: 'НЕИЗВЕСТНО' };

export const MODE_ADVICE: Record<Mode, string> = {
  normal: 'Работай как обычно.',
  economy: 'Работай короткими законченными шагами. Законченный шаг — обычный коммит по правилам проекта. Незаконченное при обрыве плагин сохранит сам.',
  finish: 'Новое не начинай, но не останавливайся, ничего не сделав: доведи текущий шаг до рабочего состояния и коротко напиши «что сделано / что дальше / как проверить». Если по задаче осталась работа — вызови limit_resume_after_reset: плагин поставит в очередь треда продолжение на момент сброса окна. Незаконченное плагин сохранит сам.',
  unknown: 'Лимит неизвестен — работай как обычно.',
};

/** Extra advice that depends on which window blocks and how soon it frees. */
export function situationAdvice(a: Assessment, now: number): string[] {
  const out: string[] = [];
  const d = a.driver;
  if (!d || a.mode !== 'finish') return out;
  const left = d.resetsAt ? Date.parse(d.resetsAt) - now : Number.NaN;
  if (Number.isFinite(left) && left < 30 * 60_000) {
    out.push('Окно сбросится меньше чем через 30 минут: сохранись и жди — BB сам продолжит тред после сброса (provider-retry). Передавать работу не нужно.');
  } else if (d.kind === 'model') {
    out.push(`Упёрся лимит модели «${d.label}»: тред можно продолжить на другой модели этого же сервиса — передача в другой сервис не нужна.`);
  }
  return out;
}

export function render(a: Assessment, now: number, extra: { provider: string; model: string | null; host: string | null; fetchedAt: string | null }): string {
  const pace = (w: QuotaWindow) => (w.etaMinutes !== null && w.etaMinutes !== undefined && w.kind !== 'weekly' && w.kind !== 'model'
    ? `, при текущем темпе до упора ~${formatDuration(w.etaMinutes * 60_000)}` : '');
  const lines: string[] = [];
  lines.push(`Режим: ${MODE_TITLE[a.mode]}${a.driver ? ` (${a.driver.label}: ${Math.round(a.driver.usedPercent)}%, ${resetText(a.driver, now)}${pace(a.driver)})` : ''}`);
  for (const w of a.windows) {
    if (w === a.driver) continue;
    lines.push(`  ${w.label}: ${Math.round(w.usedPercent)}%, ${resetText(w, now)}${pace(w)}`);
  }
  if (a.reason) lines.push(`Примечание: ${a.reason}`);
  const where = [extra.provider, extra.model, extra.host].filter(Boolean).join(' · ');
  if (where) lines.push(`Аккаунт: ${where}${extra.fetchedAt ? `, данные на ${extra.fetchedAt.slice(11, 16)} UTC` : ''}`);
  lines.push(`Что делать: ${MODE_ADVICE[a.mode]}`);
  lines.push(...situationAdvice(a, now));
  return lines.join('\n');
}

/** One short message steered into a running turn when its mode gets worse. */
export function thresholdMessage(a: Assessment, now: number, provider: string): string {
  const d = a.driver!;
  const reset = d.resetsAt ? `, ${resetText(d, now)}` : '';
  return [`[limit-guard] Лимит ${PROVIDER_NAME[provider] ?? provider} «${d.label}»: ${Math.round(d.usedPercent)}%${reset}. Режим ${MODE_TITLE[a.mode]}.`,
    MODE_ADVICE[a.mode], ...situationAdvice(a, now)].join(' ');
}

/** Standing rules shown to every supported agent. Kept short: it sits in every session. */
export function agentRules(): string {
  return [
    'Лимиты подписки (плагин limit-guard). Когда лимит подходит к порогу, плагин сам пришлёт в ход короткое сообщение [limit-guard] с режимом; при обрыве хода он сам сохранит снимок незаконченной работы. Ради лимита коммитить не нужно.',
    '- «Экономный»: работай короткими законченными шагами. «Финиш»: новое не начинай, но доведи текущий шаг до рабочего состояния и напиши «что сделано / что дальше / как проверить»; если работа по задаче осталась — вызови limit_resume_after_reset, чтобы тред сам продолжил после сброса окна.',
    '- Коммиты — только законченные шаги, только свои файлы по именам (не `git add -A`), push — по правилам проекта. В общей папке не переключай ветку и не делай stash, reset, pull, rebase.',
    '- Узнать лимит самому можно инструментом limit_status, например перед большой задачей.',
  ].join('\n');
}

// ---------- A turn already hit the limit ----------

export type RetryState = 'queued' | 'none' | 'unknown';

export interface StuckThread {
  threadId: string;
  title: string;
  providerId: string;
  failedAt: number;
  /** When the blocking window resets, if known. */
  resetAt: number | null;
  /** Whether provider-retry queued an automatic continuation, and when. */
  retry: RetryState;
  retryAt: number | null;
  /** A full model window: switching model within the same provider is enough. */
  modelLimited: string | null;
  alternative: { providerId: string; mode: Mode; percent: number | null } | null;
  notified: boolean;
}

export const PROVIDER_NAME: Record<string, string> = { 'claude-code': 'Claude', codex: 'Codex' };
const providerName = (id: string) => PROVIDER_NAME[id] ?? id;

/** The window that blocks: the full one that resets last; otherwise the latest known reset. */
export function blockingReset(windows: { usedPercent?: number | null; resetsAtMs?: number | null }[]): number | null {
  const resets = (full: boolean) => windows.filter(w => typeof w.resetsAtMs === 'number' && (!full || (w.usedPercent ?? 0) >= 100)).map(w => w.resetsAtMs as number);
  const full = resets(true);
  if (full.length) return Math.max(...full);
  const any = resets(false);
  return any.length ? Math.max(...any) : null;
}

/**
 * Notify once, and only when it helps: a long wait, or nothing will resume the
 * thread on its own. A short wait with an unknown retry decision stays quiet.
 */
export function shouldNotify(s: Pick<StuckThread, 'resetAt' | 'retry' | 'retryAt' | 'notified'>, now: number, notifyAfterMinutes: number): boolean {
  if (s.notified) return false;
  const until = s.retryAt ?? s.resetAt;
  const long = until === null || until - now >= notifyAfterMinutes * 60_000;
  if (s.retry === 'none') return true;
  return long;
}

let zone: string | undefined;
/** Time zone for clock times in messages; empty means the server's own. */
export function setTimeZone(value: string | null | undefined) {
  try { zone = value ? (new Intl.DateTimeFormat('ru-RU', { timeZone: value }), value) : undefined; } catch { zone = undefined; }
}
export function clock(ms: number): string {
  return new Date(ms).toLocaleString('ru-RU', { timeZone: zone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

const roomy = (s: StuckThread) => s.alternative !== null && (s.alternative.mode === 'normal' || s.alternative.mode === 'economy');

export function notification(s: StuckThread, now: number): { title: string; body: string } {
  const until = s.retryAt ?? s.resetAt;
  const wait = until === null ? 'время сброса неизвестно' : `до ${clock(until)} (через ${formatDuration(until - now)})`;
  const title = `Лимит ${providerName(s.providerId)}: «${s.title}» ждёт`.slice(0, 80);
  const retry = s.retry === 'queued' ? ' BB продолжит сам после сброса.' : s.retry === 'none' ? ' Автоповтора нет — после сброса напишите треду «продолжай».' : '';
  const hint = s.modelLimited ? ` Можно сменить модель (${s.modelLimited} занята).`
    : roomy(s) ? ` Можно передать в ${providerName(s.alternative!.providerId)} (занято ${Math.round(s.alternative!.percent ?? 0)}%).` : '';
  return { title, body: `Пауза ${wait}.${retry}${hint}`.slice(0, 180) };
}

export function stuckText(s: StuckThread, now: number): string {
  const until = s.retryAt ?? s.resetAt;
  const retry = s.retry === 'queued' ? ', BB продолжит сам' : s.retry === 'none' ? ', автоповтора нет' : '';
  const lines = [`${s.threadId}  «${s.title}» — ${providerName(s.providerId)}, ${until === null ? 'время сброса неизвестно' : `до ${clock(until)} (через ${formatDuration(until - now)})`}${retry}`];
  if (s.modelLimited) {
    lines.push(`  кончился лимит модели «${s.modelLimited}»: смените модель в треде — передача в другой сервис не нужна`);
  } else if (roomy(s)) {
    lines.push(`  передать: bb handoff ${s.threadId} --to ${s.alternative!.providerId}   (у ${providerName(s.alternative!.providerId)} занято ${Math.round(s.alternative!.percent ?? 0)}%)`);
    if (s.retry === 'queued') lines.push(`  после передачи плагин сам отменит автоповтор; вручную: bb provider-retry cancel ${s.threadId}`);
  } else if (s.alternative) {
    lines.push(`  у ${providerName(s.alternative.providerId)} лимит тоже на исходе или неизвестен — лучше подождать`);
  }
  return lines.join('\n');
}

/** The queued message that resumes a thread after its window resets. */
export function resumeText(note: string | null): string {
  const clean = note?.replace(/\s+/g, ' ').trim().slice(0, 600);
  return `[limit-guard] Окно лимита сбросилось — продолжай задачу с того места, где остановился.${clean ? ` Что дальше: ${clean}` : ''}`;
}

/**
 * The window a resume should wait for: the most pressing one (finish over economy
 * over normal), and among equals the one that resets first.
 */
export function resumeWindow(windows: QuotaWindow[], model: string | null, t: Thresholds, now: number): QuotaWindow | null {
  const ranked = windows.filter(w => appliesToModel(w, model) && w.resetsAt && Date.parse(w.resetsAt) > now)
    .map(w => ({ w, rank: RANK[windowMode(w, t)], at: Date.parse(w.resetsAt!) }))
    .sort((a, b) => b.rank - a.rank || a.at - b.at);
  // Nothing is pressing (or the pressing window hides its reset): a far weekly reset is no reason to wait.
  if (!ranked[0] || ranked[0].rank <= RANK.normal) return null;
  // Several windows used up: work can go on only once the last of them resets.
  const exhausted = ranked.filter(r => r.w.usedPercent >= 100).sort((a, b) => b.at - a.at);
  if (exhausted[0]) return exhausted[0].w;
  return ranked[0].w;
}
