// Умолчания и нормализация конфигурации. Чистые функции, без SDK.
import type { Stage } from './adapter.ts';
import { defaultProfiles } from './profiles.ts';
import { configSchema, stepSchema, type CascadeConfig, type Machine, type ModelRow, type Platform, type Step } from './contract.ts';

export const DEFAULT_SHARED_PATH = '/opt/bbfs';
export const DEFAULT_WINDOWS_SHARED_PATH = 'C:\\bbfs';

/** Модели по названиям, с которых начинается таблица. ID на машинах подбираются автоматически. */
export const DEFAULT_MODEL_ROWS: readonly Pick<ModelRow, 'key' | 'displayName' | 'providerId'>[] = [
  { key: 'opus-5.5', displayName: 'Opus 5.5', providerId: 'claude-code' },
  { key: 'fable-5.2', displayName: 'Fable 5.2', providerId: 'claude-code' },
  { key: 'sonnet-5.5', displayName: 'Sonnet 5.5', providerId: 'claude-code' },
  { key: 'haiku-5.5', displayName: 'Haiku 5.5', providerId: 'claude-code' },
];

export function emptyConfig(): CascadeConfig {
  return configSchema.parse({});
}

export function sharedPathFor(platform: Platform): { sharedPath: string; pathTranslation: boolean } {
  return platform === 'windows'
    ? { sharedPath: DEFAULT_WINDOWS_SHARED_PATH, pathTranslation: true }
    : { sharedPath: DEFAULT_SHARED_PATH, pathTranslation: false };
}

export interface SeedHost { id: string; name: string; platform: Platform }

/**
 * Каскад владельца по умолчанию: Claude (Max 20) на сервере Tru → Claude через
 * шлюз vclaude на Mac → Claude (Pro) на UA → Codex только с подтверждением
 * (Mac, затем UA). Машины находятся по имени и платформе; ID в код не вшиты.
 * Ненайденная машина просто не попадает в каскад.
 */
export function seedConfig(hosts: readonly SeedHost[]): CascadeConfig {
  const ua = hosts.find(h => /\bua\b/i.test(h.name));
  const tru = hosts.find(h => /\btru\b/i.test(h.name)) ?? hosts.find(h => h !== ua && h.platform === 'linux');
  const mac = hosts.find(h => h !== tru && h !== ua && (h.platform === 'macos' || /\bmac/i.test(h.name)));
  const machines: Machine[] = [];
  const steps: Step[] = [];
  const machine = (h: SeedHost, label: string, anchor: boolean): Machine => ({
    hostId: h.id, label, enabled: true, platform: h.platform, anchor, ...sharedPathFor(h.platform),
  });
  const step = (h: SeedHost, providerId: string, label: string, confirm: boolean, extra: Partial<Step> = {}): Step => stepSchema.parse({
    id: stepId(h.id, providerId, null), hostId: h.id, providerId, label, confirm, ...extra,
  });
  if (tru) { machines.push(machine(tru, 'Tru', true)); steps.push(step(tru, 'claude-code', 'Max 20', false)); }
  // Claude на Mac ходит через API-шлюз vclaude: квота — остаток пакета в единицах
  // из плагина thread-account-usage. Нет данных — ступень пропускается (onUnknown: skip).
  if (mac) { machines.push(machine(mac, 'Mac', !tru)); steps.push(step(mac, 'claude-code', 'vclaude', false, { authority: 'gateway', quotaSource: 'vclaude' })); }
  // UA — вторая настоящая подписка claude.ai (Pro) и свой Codex.
  if (ua) { machines.push(machine(ua, 'UA', !tru && !mac)); steps.push(step(ua, 'claude-code', 'Pro', false)); }
  const codexHost = mac ?? tru;
  if (codexHost) steps.push(step(codexHost, 'codex', 'Codex', true));
  if (ua) steps.push(step(ua, 'codex', 'Codex', true));
  const models = DEFAULT_MODEL_ROWS.map(r => ({ ...r, enabled: true, cells: {} }));
  const policies = { modelPriority: DEFAULT_MODEL_ROWS.map(r => r.key) };
  return configSchema.parse({ machines, steps, models, policies, profiles: defaultProfiles({ models }) });
}

/** Стабильный ID ступени: машина × провайдер × профиль. Порядковый номер ID не служит. */
export function stepId(hostId: string, providerId: string, profileRef: string | null): string {
  return `${hostId}:${providerId}:${profileRef ?? '*'}`;
}

/** FNV-1a, 32 бита: короткий детерминированный отпечаток. */
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Поколение связи профиль–аккаунт–маршрут. Меняется при смене машины, профиля,
 * аккаунта или типа квоты — старые согласия и чтения лимитов перестают действовать.
 */
export function bindingEpoch(step: Pick<Step, 'hostId' | 'providerId' | 'profileRef' | 'account' | 'authority' | 'quotaSource'>): string {
  return fnv1a([step.hostId, step.providerId, step.profileRef ?? '', step.account ?? '', step.authority, step.quotaSource].join('\u0000'));
}

export function stageOf(step: Step): Stage {
  return {
    hostId: step.hostId, provider: step.providerId, profileRef: step.profileRef ?? 'default', authority: step.authority,
    ...(step.quotaGroup ? { quotaGroup: step.quotaGroup } : {}), quotaSource: step.quotaSource, bindingEpoch: bindingEpoch(step),
  };
}

/**
 * Приводит конфигурацию к инвариантам: уникальные машины, ступени и строки,
 * ступени только на известных машинах, ровно одна опорная машина (если машины есть).
 */
export function normalizeConfig(input: unknown): CascadeConfig {
  const parsed = configSchema.safeParse(input);
  const config = parsed.success ? parsed.data : emptyConfig();
  const machines = uniqueBy(config.machines, m => m.hostId);
  const known = new Set(machines.map(m => m.hostId));
  const steps = uniqueBy(config.steps.filter(s => known.has(s.hostId)), s => s.id);
  const models = uniqueBy(config.models, r => r.key);
  const anchorIndex = machines.findIndex(m => m.anchor);
  const anchored = machines.map((m, i) => ({ ...m, anchor: anchorIndex === -1 ? i === 0 : i === anchorIndex }));
  // Профили по умолчанию — только если поля нет (конфигурация до профилей).
  // Пустой список, оставленный владельцем, не заполняется заново.
  const hasProfiles = typeof input === 'object' && input !== null && Array.isArray((input as { profiles?: unknown }).profiles);
  const profiles = hasProfiles ? uniqueBy(config.profiles, p => p.id) : defaultProfiles({ models });
  return { ...config, machines: anchored, steps, models, profiles };
}

function uniqueBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter(item => { const k = key(item); if (seen.has(k)) return false; seen.add(k); return true; });
}

/** Режим синхронизации проекта: своя настройка проекта или общий по умолчанию. */
export function syncModeFor(config: CascadeConfig, projectId: string) {
  return config.files.projectSyncModes[projectId] ?? config.files.defaultSyncMode;
}

/** Исключения Mutagen: `.env` убирается из синхронизации, только если владелец выключил её. */
export function syncIgnores(config: CascadeConfig): string[] {
  const list = [...config.files.ignores];
  if (!config.files.syncEnv) list.push('.env', '.env.*');
  return [...new Set(list)];
}
