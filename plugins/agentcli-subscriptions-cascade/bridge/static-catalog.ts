// Статический каталог профилей для model/list, когда сервер не передал свой.
//
// BB кладёт experimental_bridgeOptions в params.providerOptions каждого
// sessionless-запроса (model/list) — это основной путь: там каталог по
// настройкам владельца. Если его нет (старая регистрация, пустой список,
// перезапуск сервера плагина) — мост отдаёт профили каскада по умолчанию,
// чтобы «No models available» никогда не блокировал создание треда.
import { DEFAULT_MODEL_ROWS } from '../config.ts';
import { defaultProfiles, PENDING_STEPS_HINT } from '../profiles.ts';

const EFFORTS = ['low', 'medium', 'high'].map(reasoningEffort => ({ reasoningEffort, description: reasoningEffort }));

export interface CatalogEntry {
  id: string;
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: { reasoningEffort: string; description: string }[];
  reasoningDiscovery: 'known';
}

export function staticCatalog(): CatalogEntry[] {
  const models = DEFAULT_MODEL_ROWS.map(r => ({ ...r, enabled: true, cells: {} }));
  return defaultProfiles({ models }).map((p, i) => ({
    id: p.id, model: p.id, displayName: p.name, description: PENDING_STEPS_HINT,
    isDefault: i === 0, defaultReasoningEffort: 'medium', supportedReasoningEfforts: EFFORTS.map(e => ({ ...e })),
    reasoningDiscovery: 'known',
  }));
}

/** Каталог для ответа model/list: от сервера, иначе статический. */
export function catalogFrom(providerOptions: unknown): unknown[] {
  const catalog = providerOptions !== null && typeof providerOptions === 'object' ? (providerOptions as Record<string, unknown>).catalog : undefined;
  return Array.isArray(catalog) && catalog.length > 0 ? catalog : staticCatalog();
}
