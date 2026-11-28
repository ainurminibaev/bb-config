// Обнаружение аккаунтов: что за CLI на машине, залогинен ли, какие модели и
// лимиты. Чистые функции над ответами штатного SDK (терпимы к неизвестным полям).
import type { Reading, WindowSample } from './adapter.ts';
import type { CatalogModel, DiscoveredAccount, LimitWindow } from './contract.ts';

const rec = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const str = (v: unknown): string | null => typeof v === 'string' && v.length > 0 ? v : null;

/** `bb.sdk.providers.models({ hostId, providerId })` → каталог моделей. */
export function catalogFromModels(raw: unknown): { models: CatalogModel[]; error: string | null } {
  const data = rec(raw);
  const list = Array.isArray(data.models) ? data.models : [];
  const models = list.flatMap(item => {
    const m = rec(item);
    const id = str(m.id);
    if (!id) return [];
    return [{ id, displayName: str(m.displayName) ?? id, ...(str(m.model) ? { model: str(m.model)! } : {}) }];
  });
  const error = rec(data.modelLoadError);
  return { models, error: str(error.code) ? `${String(error.code)}${str(error.detail) ? `: ${String(error.detail)}` : ''}` : null };
}

/** `bb.sdk.hosts.providerCliStatus({ hostId })[providerId].installed`. null — неизвестно. */
export function cliInstalled(raw: unknown, providerId: string): boolean | null {
  const entry = rec(rec(raw)[providerId]);
  return typeof entry.installed === 'boolean' ? entry.installed : null;
}

/** Версия CLI из providerCliStatus (`version`); null — неизвестна. */
export function cliVersion(raw: unknown, providerId: string): string | null {
  const entry = rec(rec(raw)[providerId]);
  return str(entry.version) ?? str(entry.cliVersion);
}

/** Окно для экрана настроек (упрощённое WindowSample). */
export function toLimitWindow(w: WindowSample): LimitWindow {
  const kind: LimitWindow['kind'] = w.scope.kind === 'model' ? 'model' : w.scope.kind === 'package' ? 'package'
    : w.period === 'five-hour' ? 'five-hour' : w.period === 'weekly' ? 'weekly' : 'other';
  return {
    kind, label: w.windowId.split(':').slice(1).join(':') || w.windowId,
    usedPercent: w.usedPercent === null ? null : Math.min(100, w.usedPercent),
    resetsAt: w.resetsAt === null ? null : new Date(w.resetsAt).toISOString(),
    models: w.scope.kind === 'model' && w.scope.id ? [w.scope.id] : [],
  };
}

export function toDiscoveredAccount(args: {
  hostId: string; providerId: string; cliStatus: unknown; models: unknown; usage: unknown; reading: Reading; now: string;
}): DiscoveredAccount {
  const installedFlag = cliInstalled(args.cliStatus, args.providerId);
  const catalog = catalogFromModels(args.models);
  const usage = rec(args.usage);
  const usageStatus = str(usage.status);
  const installed = installedFlag ?? (catalog.models.length > 0 || (usageStatus !== null && usageStatus !== 'not_installed'));
  // Статус usage «unauthenticated» бывает и у залогиненного CLI за API-шлюзом:
  // вход определяем по каталогу моделей, а не по лимитам.
  const loggedIn = installed && (catalog.models.length > 0 ? !catalog.error?.startsWith('auth_required') : usageStatus === 'ok');
  return {
    hostId: args.hostId, providerId: args.providerId, installed, loggedIn,
    account: str(usage.accountKey) ?? str(usage.accountEmail)?.toLowerCase() ?? null, plan: str(usage.planLabel),
    models: catalog.models,
    windows: args.reading.kind === 'sample' ? args.reading.windows.map(toLimitWindow) : [],
    limitsStatus: args.reading.kind === 'sample' ? 'ok' : args.reading.reason,
    error: catalog.error,
    fetchedAt: args.now,
    cliVersion: cliVersion(args.cliStatus, args.providerId),
  };
}
