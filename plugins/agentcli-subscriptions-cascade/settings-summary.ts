// Резюме для экрана настроек: однострочные заголовки свёрнутых секций, отличия
// от умолчаний, подпись «Старт: …» и остаток для полоски лимита. Чистые функции —
// экран (settings-view.tsx) только рисует их результат.
import { filesSchema, policiesSchema } from './contract.ts';
import type { CascadeConfig, CascadeState, CellStatus, Step } from './contract.ts';

export type SectionId = 'machines' | 'models' | 'files' | 'advanced';
export interface SectionSummary { text: string; tone?: 'warn' | 'muted' }

export const WIZARD_IDS = ['probe', 'folder', 'mutagen', 'ssh', 'verify'] as const;
export const PROBLEM_STATUSES: readonly CellStatus[] = ['unmatched', 'ambiguous', 'missing'];
const DEFAULT_POLICIES = policiesSchema.parse({});
const DEFAULT_FILES = filesSchema.parse({});
/** Правила, которые видны в «Дополнительно». Бюджет чтения и перепроверка — служебные, на экран не выводятся. */
export const POLICY_KEYS = ['subthreadsUseOtherMachines', 'returnAfterMinutes', 'exhaustedWaitHours', 'minRemainingPercent', 'positiveFreshSeconds', 'executionMode'] as const;
export type PolicyKey = typeof POLICY_KEYS[number];

export function plural(n: number, one: string, few: string, many: string): string {
  const d = n % 10, h = n % 100;
  return d === 1 && h !== 11 ? one : d >= 2 && d <= 4 && (h < 12 || h > 14) ? few : many;
}

/** Правила, отличающиеся от умолчаний схемы. */
export function changedPolicies(config: CascadeConfig): PolicyKey[] {
  return POLICY_KEYS.filter(k => config.policies[k] !== DEFAULT_POLICIES[k]);
}

export function filesChanged(config: CascadeConfig): boolean {
  const f = config.files;
  return f.defaultSyncMode !== DEFAULT_FILES.defaultSyncMode || f.syncEnv !== DEFAULT_FILES.syncEnv
    || f.ignores.join(',') !== DEFAULT_FILES.ignores.join(',') || Object.keys(f.projectSyncModes).length > 0;
}

/** Машина готова: на связи и все шаги мастера пройдены или пропущены. */
export function machineReady(state: CascadeState, hostId: string): boolean {
  const host = state.hosts.find(h => h.hostId === hostId);
  const wizard = state.wizard.find(w => w.hostId === hostId);
  return !!host?.connected && WIZARD_IDS.every(id => ['done', 'skipped'].includes(wizard?.steps[id]?.status ?? ''));
}

export function sectionSummaries(state: CascadeState, config: CascadeConfig): Record<SectionId, SectionSummary> {
  const enabled = config.machines.filter(m => m.enabled);
  const ready = enabled.filter(m => machineReady(state, m.hostId)).length;
  const offline = enabled.filter(m => !state.hosts.find(h => h.hostId === m.hostId)?.connected).length;
  const machines: SectionSummary = enabled.length === 0 ? { text: 'ни одна не включена', tone: 'warn' }
    : offline > 0 ? { text: `${offline} не на связи из ${enabled.length}`, tone: 'warn' }
    : ready === enabled.length ? { text: `${ready} ${plural(ready, 'готова', 'готовы', 'готовы')}` }
    : { text: `${enabled.length} на связи, не настроено: ${enabled.length - ready}`, tone: 'warn' };

  const problems = Object.values(state.cells).flatMap(row => Object.values(row)).filter(c => PROBLEM_STATUSES.includes(c.status)).length;
  const active = config.models.filter(r => r.enabled).length;
  const models: SectionSummary = problems > 0
    ? { text: `${problems} ${plural(problems, 'несопоставленная', 'несопоставленных', 'несопоставленных')}`, tone: 'warn' }
    : { text: `${active} ${plural(active, 'модель', 'модели', 'моделей')}, все сопоставлены` };

  const f = config.files;
  const files: SectionSummary = { text: `${f.defaultSyncMode === 'lazy' ? 'по требованию' : 'постоянно'}, ${f.syncEnv ? 'с .env' : 'без .env'}${filesChanged(config) ? ' · изменено' : ''}` };

  const changed = changedPolicies(config).length;
  const advanced: SectionSummary = config.testQuota.enabled ? { text: 'включена тестовая квота', tone: 'warn' }
    : changed > 0 ? { text: `изменено: ${changed}` } : { text: 'по умолчанию', tone: 'muted' };
  return { machines, models, files, advanced };
}

/** «Старт: Opus · Tru» — первая фраза подписи профиля без пояснения про приоритет. */
export function startLine(description: string): string {
  return description.split('. ')[0]!.replace(/ — первая в приоритете моделей$/, '');
}

/** Остаток по окнам штатного источника: 100 − самое загруженное окно. Пакет vclaude и шлюз — без полоски. */
export function remainingPercent(account: CascadeState['accounts'][number] | undefined, step: Step): number | null {
  if (step.quotaSource !== 'provider' || !account) return null;
  const used = account.windows.map(w => w.usedPercent).filter((x): x is number => x !== null);
  return used.length > 0 ? 100 - Math.max(...used) : null;
}

const WINDOW_RU: Record<string, string> = { weekly: 'неделя', '5h': '5 ч', five_hour: '5 ч', 'five-hour': '5 ч', daily: 'день' };
const num = (s: string) => Number(s.replace(/\s/g, '').replace(',', '.'));

/** «01.12 21:00» или «21:00», если сброс в ближайшие сутки. */
export function formatReset(at: number, now: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return at - now < 24 * 3_600_000 ? time : `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${time}`;
}

/**
 * Короткая строка лимита ступени для одной строки экрана и остаток для полоски.
 * Исходный текст — describeReading из limits.ts; здесь только сокращаем и переводим
 * подписи окон. Незнакомый формат показывается как есть.
 */
export function limitLine(summary: CascadeState['stepLimits'][string] | undefined, now: number): { text: string; remaining: number | null } {
  if (!summary) return { text: 'лимит не прочитан', remaining: null };
  if (summary.state === 'exhausted') return { text: summary.resetsAt ? `исчерпан до ${formatReset(summary.resetsAt, now)}` : 'исчерпан', remaining: 0 };
  const text = summary.text
    .replace(/\s*\(квота неизвестна: [^)]*\)$/, '')
    .replace(/([A-Za-z0-9_-]+) (\d+|\?)%/g, (_, label: string, pct: string) => `${WINDOW_RU[label.toLowerCase()] ?? label} ${pct} %`);
  const pkg = /^осталось ([\d\s,]+) млн из ([\d\s,]+) млн/.exec(text);
  if (pkg) {
    const left = num(pkg[1]!), total = num(pkg[2]!);
    return { text: `${pkg[1]!.trim()} из ${pkg[2]!.trim()} млн`, remaining: total > 0 ? (left / total) * 100 : null };
  }
  return { text, remaining: null };
}

/** Параметры ступени отличаются от умолчаний схемы (тогда у «⋯» метка). */
export function stepCustomized(step: Step): boolean {
  return step.authority !== 'subscription' || step.quotaSource !== 'provider' || step.onUnknown !== 'skip' || step.confirm || step.maxConcurrent !== null;
}
