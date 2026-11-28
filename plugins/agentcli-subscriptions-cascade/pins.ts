// Закреплённые ступени (0.3.0): пункт списка моделей «Mac · Claude (vclaude) ·
// Opus 5.5» = профиль `pin:<stepId>[:<ключ модели>]`. Тред на закреплённой
// ступени ходит только туда; исчерпана — ждёт сброса или спрашивает владельца,
// как «Только X». Профиль синтетический: в настройках не хранится, строится из
// включённых ступеней и таблицы моделей при каждом выборе. Чистые функции.
import type { CascadeConfig, DiscoveredAccount, ModelRow, Profile, Step } from './contract.ts';
import { effectiveModelId } from './models.ts';
import { SUBTHREAD_CODEX_NAME, isSubthreadCodexId } from './subthreads.ts';

export const PIN_PREFIX = 'pin:';

const PROVIDER_SHORT: Record<string, string> = { 'claude-code': 'Claude', codex: 'Codex', 'gemini-cli': 'Gemini' };
const providerShort = (id: string) => PROVIDER_SHORT[id] ?? id;

export const isPinId = (id: string | null | undefined): boolean => typeof id === 'string' && id.startsWith(PIN_PREFIX);

/** ID закреплённой ступени: `pin:<stepId>` или `pin:<stepId>:<ключ модели>`. */
export function pinId(stepId: string, modelKey: string | null): string {
  return `${PIN_PREFIX}${stepId}${modelKey ? `:${modelKey}` : ''}`;
}

/**
 * Разбор `pin:…`: ступень — самый длинный ID ступени, с которого начинается
 * остаток (ID ступени сам содержит «:»), дальше — ключ модели. Ступень могла
 * исчезнуть из настроек — null.
 */
export function parsePin(config: Pick<CascadeConfig, 'steps'>, id: string): { step: Step; modelKey: string | null } | null {
  if (!isPinId(id)) return null;
  const rest = id.slice(PIN_PREFIX.length);
  let found: Step | null = null;
  for (const s of config.steps) {
    if ((rest === s.id || rest.startsWith(`${s.id}:`)) && (!found || s.id.length > found.id.length)) found = s;
  }
  if (!found) return null;
  const modelKey = rest.length > found.id.length ? rest.slice(found.id.length + 1) : null;
  return { step: found, modelKey: modelKey || null };
}

/** Подпись аккаунта ступени в скобках, если она что-то добавляет к имени CLI. */
function accountSuffix(step: Step): string {
  const label = step.label.trim();
  if (!label || label.toLowerCase() === providerShort(step.providerId).toLowerCase() || label === step.providerId) return '';
  return ` (${label})`;
}

/** «Mac · Claude (vclaude)», «Tru · Codex». */
export function stepTitle(config: Pick<CascadeConfig, 'machines'>, step: Step): string {
  const machine = config.machines.find(m => m.hostId === step.hostId)?.label ?? step.hostId;
  return `${machine} · ${providerShort(step.providerId)}${accountSuffix(step)}`;
}

/** «Mac · Claude (vclaude) · Opus 5.5»; без модели — «Mac · Claude (vclaude)». */
export function pinLabel(config: Pick<CascadeConfig, 'machines'>, step: Step, row: Pick<ModelRow, 'displayName'> | null): string {
  return row ? `${stepTitle(config, step)} · ${row.displayName}` : stepTitle(config, step);
}

/**
 * Профиль закреплённой ступени. С моделью — `only` (только эта модель на этой
 * ступени), без модели — `any` по общему приоритету, но тоже только на ней:
 * остальные ступени исключены. Подтверждение входа на неё не спрашивается —
 * владелец выбрал её сам (в меню или просьбой через `resolve`).
 */
export function pinnedProfile(config: CascadeConfig, id: string): Profile | null {
  const pin = parsePin(config, id);
  if (!pin) return null;
  const row = pin.modelKey ? config.models.find(r => r.key === pin.modelKey) ?? null : null;
  return {
    id, name: pinLabel(config, pin.step, row ?? (pin.modelKey ? { displayName: pin.modelKey } : null)), enabled: true,
    policy: pin.modelKey ? 'only' : 'any', modelKey: pin.modelKey,
    stepOrder: [pin.step.id], excludedSteps: config.steps.filter(s => s.id !== pin.step.id).map(s => s.id),
    excludedProviders: [], confirm: { [pin.step.id]: false }, subthreads: 'same',
  };
}

/** Имя профиля по ID: из настроек, закреплённой ступени или сам ID. */
export function profileName(config: CascadeConfig, id: string): string {
  if (isSubthreadCodexId(id)) return SUBTHREAD_CODEX_NAME;
  return config.profiles.find(p => p.id === id)?.name ?? pinnedProfile(config, id)?.name ?? id;
}

export interface PinEntry {
  id: string;
  label: string;
  description: string;
  stepId: string;
  hostId: string;
  providerId: string;
  /** Ключ строки таблицы; null — ступень целиком (модели по приоритету). */
  modelKey: string | null;
  /** ID модели у CLI машины ступени; null — модель CLI по умолчанию. */
  modelId: string | null;
}

/** Модель недоступна на аккаунте машины (ответ CLI в ходе, на сутки). */
export type BlockedModel = (hostId: string, modelId: string) => boolean;

/**
 * Закреплённые ступени для списка моделей и `resolve`: включённые ступени на
 * включённых машинах в порядке каскада; у каждой — сама ступень и её модели из
 * таблицы (по общему приоритету). Не показываются: машина или ступень выключена,
 * CLI на машине не установлен, у модели нет ID на этой машине, модель недоступна
 * на аккаунте.
 */
export function pinnedEntries(config: CascadeConfig, accounts: readonly DiscoveredAccount[], blocked: BlockedModel = () => false): PinEntry[] {
  const machinesOn = new Set(config.machines.filter(m => m.enabled).map(m => m.hostId));
  const enabledRows = config.models.filter(r => r.enabled);
  const priority = [...new Set([...config.policies.modelPriority.map(k => enabledRows.find(r => r.key === k)).filter((r): r is ModelRow => !!r), ...enabledRows])];
  const out: PinEntry[] = [];
  for (const step of config.steps) {
    if (!step.enabled || !machinesOn.has(step.hostId)) continue;
    const account = accounts.find(a => a.hostId === step.hostId && a.providerId === step.providerId);
    if (account && !account.installed) continue;
    const title = stepTitle(config, step);
    const rows = priority
      .filter(r => r.providerId === step.providerId)
      .map(r => ({ r, modelId: effectiveModelId(r, step.hostId, account) }))
      .filter((x): x is { r: ModelRow; modelId: string } => x.modelId !== null && !blocked(step.hostId, x.modelId));
    out.push({
      id: pinId(step.id, null), label: title, stepId: step.id, hostId: step.hostId, providerId: step.providerId, modelKey: null, modelId: null,
      description: `Закреплено: только ${title}${rows.length > 0 ? ', модели по приоритету' : ''}. Исчерпана — ждёт сброса или спросит`,
    });
    for (const { r, modelId } of rows) {
      out.push({
        id: pinId(step.id, r.key), label: pinLabel(config, step, r), stepId: step.id, hostId: step.hostId, providerId: step.providerId, modelKey: r.key, modelId,
        description: `Закреплено: только ${r.displayName} на ${title}. Исчерпана — ждёт сброса или спросит`,
      });
    }
  }
  return out;
}
