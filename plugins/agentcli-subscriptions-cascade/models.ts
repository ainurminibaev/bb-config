// Таблица ассоциаций моделей и каталог провайдера «Каскад». Чистые функции.
import {
  MODEL_ID_PREFIX,
  type CascadeConfig, type CatalogModel, type CellStatus, type DiscoveredAccount, type ModelRow,
} from './contract.ts';

/** Слова-бренды, которые не различают модели: «Claude Opus 5.5» = «Opus 5.5». */
const BRAND_WORDS = ['claude', 'anthropic', 'openai'];

/**
 * Канонический ключ названия модели: нижний регистр, без брендов, без
 * разделителей. «Fable 5.2», «claude-fable-5-2» и «fable52» дают «fable52».
 * Суффиксы вида `[1m]` или дата релиза отбрасываются, чтобы не мешать сравнению.
 */
export function canonicalModelKey(name: string): string {
  let text = name.toLowerCase().trim();
  text = text.replace(/\[[^\]]*\]/g, ' ').replace(/\([^)]*\)/g, ' ');
  text = text.replace(/[-_ ]20\d{6}\b/g, ' ');
  for (const word of BRAND_WORDS) text = text.replace(new RegExp(`\\b${word}\\b`, 'g'), ' ');
  return text.replace(/[^a-z0-9]+/g, '');
}

export interface CellView {
  status: CellStatus;
  modelId: string | null;
  candidates: string[];
}

/**
 * Ячейка «модель × машина».
 * - manual: владелец указал ID вручную (если каталог известен и ID в нём нет — missing);
 * - auto: ровно одна модель каталога совпала по ключу;
 * - ambiguous: совпало несколько — нужен выбор;
 * - unmatched: каталог есть, совпадений нет — подсветка и ручной ввод;
 * - no-cli: на машине нет CLI этого провайдера;
 * - unknown: каталог машины ещё не получен.
 */
export function resolveCell(row: ModelRow, hostId: string, account: DiscoveredAccount | undefined): CellView {
  const saved = row.cells[hostId];
  const catalog = account?.installed ? account.models : null;
  if (saved?.source === 'manual' && saved.modelId) {
    const missing = catalog !== null && catalog.length > 0 && !catalog.some(m => m.id === saved.modelId);
    return { status: missing ? 'missing' : 'manual', modelId: saved.modelId, candidates: [] };
  }
  if (saved?.source === 'none') return { status: 'unmatched', modelId: null, candidates: [] };
  if (account && !account.installed) return { status: 'no-cli', modelId: null, candidates: [] };
  if (!catalog) return saved?.modelId ? { status: 'auto', modelId: saved.modelId, candidates: [] } : { status: 'unknown', modelId: null, candidates: [] };
  const matches = matchCatalog(row, catalog);
  if (matches.length === 1) return { status: 'auto', modelId: matches[0]!, candidates: [] };
  if (matches.length > 1) return { status: 'ambiguous', modelId: null, candidates: matches };
  return { status: 'unmatched', modelId: null, candidates: catalog.map(m => m.id).slice(0, 20) };
}

/** ID моделей каталога, совпавших со строкой по каноническому ключу названия или ID. */
export function matchCatalog(row: Pick<ModelRow, 'displayName' | 'key'>, catalog: readonly CatalogModel[]): string[] {
  const wanted = new Set([canonicalModelKey(row.displayName), canonicalModelKey(row.key)]);
  const hits = catalog.filter(m => [m.displayName, m.id, m.model ?? ''].some(n => n && wanted.has(canonicalModelKey(n))));
  // Если среди совпавших есть точное совпадение отображаемого имени — берём только его.
  const exact = hits.filter(m => canonicalModelKey(m.displayName) === canonicalModelKey(row.displayName));
  return [...new Set((exact.length === 1 ? exact : hits).map(m => m.id))];
}

/** Действующий ID модели строки на машине или null, если машина не участвует. */
export function effectiveModelId(row: ModelRow, hostId: string, account: DiscoveredAccount | undefined): string | null {
  const cell = resolveCell(row, hostId, account);
  return cell.status === 'auto' || cell.status === 'manual' ? cell.modelId : null;
}

/** Фиксирует автоподбор в конфигурации: ручные ячейки не трогаются. */
export function applyAutoMatches(config: CascadeConfig, accounts: readonly DiscoveredAccount[]): CascadeConfig {
  const models = config.models.map(row => {
    const cells = { ...row.cells };
    for (const machine of config.machines) {
      const account = accounts.find(a => a.hostId === machine.hostId && a.providerId === row.providerId);
      const saved = cells[machine.hostId];
      if (saved?.source === 'manual' || saved?.source === 'none') continue;
      const cell = resolveCell(row, machine.hostId, account);
      if (cell.status === 'auto') cells[machine.hostId] = { modelId: cell.modelId, source: 'auto' };
      else if (account?.installed && account.models.length > 0) delete cells[machine.hostId];
    }
    return { ...row, cells };
  });
  return { ...config, models };
}

/** Строки для моделей из каталогов машин, которых ещё нет в таблице. */
export function suggestRows(config: CascadeConfig, accounts: readonly DiscoveredAccount[]): ModelRow[] {
  const known = new Set(config.models.map(r => `${r.providerId}|${canonicalModelKey(r.displayName)}`));
  const usedKeys = new Set(config.models.map(r => r.key));
  const out: ModelRow[] = [];
  for (const account of accounts) {
    for (const model of account.models) {
      const id = `${account.providerId}|${canonicalModelKey(model.displayName)}`;
      if (known.has(id)) continue;
      known.add(id);
      let key = slug(model.displayName) || slug(model.id);
      if (!key) continue;
      while (usedKeys.has(key)) key = `${key}-x`;
      usedKeys.add(key);
      out.push({ key, displayName: model.displayName, providerId: account.providerId, enabled: true, cells: {} });
    }
  }
  return out;
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '').replace(/^[^a-z0-9]+/, '');
}

// Каталог провайдера в пикере BB — это профили каскада (profiles.ts, providerModels).

/** Ключ строки из устаревшего ID модели `m:<ключ>`; остальное → null. */
export function rowKeyFromModelId(modelId: string): string | null {
  return modelId.startsWith(MODEL_ID_PREFIX) ? modelId.slice(MODEL_ID_PREFIX.length) : null;
}
