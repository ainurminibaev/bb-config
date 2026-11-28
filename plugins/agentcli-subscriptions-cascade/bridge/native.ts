// Импорт штатных мостов provider-claude-code и provider-codex без копирования кода.
//
// Демон кэширует host-артефакт каждого плагина по пути
//   <daemonDataDir>/plugin-host-artifacts/<pluginId>/<digest>/host.mjs,
// где digest = sha256 содержимого (= sha256(<rootDir>/dist/host.js) на сервере).
// Наш артефакт лежит в том же кэше, поэтому корень кэша известен из import.meta.url.
//
// Защита как в Plugin Keeper: сервер передаёт ожидаемый digest (providerOptions),
// мост берёт ровно этот каталог, сверяет sha256 файла и форму экспорта.
// Не сошлось — понятная ошибка, ход не стартует, тред и штатные провайдеры целы (S13).
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export type NativeProviderId = 'claude-code' | 'codex';

export interface NativeBridgeSpec {
  providerId: NativeProviderId;
  /** ID штатного плагина BB, чей артефакт импортируем. */
  pluginId: string;
  /** Переменные, через которые штатный мост берёт CLI. */
  executableEnv: { command: string; args?: string };
}

export const NATIVE_BRIDGES: Record<NativeProviderId, NativeBridgeSpec> = {
  'claude-code': { providerId: 'claude-code', pluginId: 'provider-claude-code', executableEnv: { command: 'BB_CLAUDE_CODE_EXECUTABLE' } },
  codex: { providerId: 'codex', pluginId: 'provider-codex', executableEnv: { command: 'BB_CODEX_BRIDGE_APP_SERVER_COMMAND', args: 'BB_CODEX_BRIDGE_APP_SERVER_ARGS' } },
};

export interface BridgeContext { pluginId: string; dataDir: string; tempDir: string }

/** Форма экспорта моста (Provider Bridge Protocol, experimental_apiVersion 1). */
export interface BridgeEntry {
  experimental_apiVersion: 1;
  handleLine(line: string): void;
  start?(context: BridgeContext): void;
  onClose?(): void;
  onSigterm?(): void;
  onSigint?(): void;
}

export type NativeLoadErrorCode = 'artifact-missing' | 'digest-mismatch' | 'shape' | 'import-failed' | 'no-digest';

export class NativeLoadError extends Error {
  readonly code: NativeLoadErrorCode;
  readonly providerId: NativeProviderId;
  constructor(code: NativeLoadErrorCode, providerId: NativeProviderId, message: string) {
    super(message);
    this.code = code;
    this.providerId = providerId;
  }
}

const DIGEST = /^[0-9a-f]{64}$/u;
const BRIDGE_LABEL: Record<NativeProviderId, string> = { 'claude-code': 'Claude Code', codex: 'Codex' };

/** Понятный текст для треда и настроек. */
export function nativeLoadHint(error: NativeLoadError): string {
  const name = BRIDGE_LABEL[error.providerId];
  switch (error.code) {
    case 'artifact-missing':
      return `Штатный мост ${name} ещё не появился на этой машине (или BB обновился). Запустите один короткий ход штатного ${name} на этой машине и повторите.`;
    case 'digest-mismatch':
      return `Штатный мост ${name} на этой машине не совпадает с установленным на сервере BB. Запустите один ход штатного ${name} на этой машине — BB обновит его.`;
    case 'shape':
      return `BB изменил мост ${name}: каскад его не распознал и выключен для этой машины. Треды на штатных провайдерах работают как раньше; нужна новая версия каскада.`;
    case 'no-digest':
      return `Сервер каскада не передал версию моста ${name}: штатный провайдер ${name} не найден или выключен.`;
    default:
      return `Не удалось загрузить штатный мост ${name}: ${error.message}`;
  }
}

/** Корень кэша артефактов: два уровня над каталогом собственного артефакта. */
export function artifactCacheRoot(ownModuleUrl: string): string {
  return dirname(dirname(dirname(fileURLToPath(ownModuleUrl))));
}

export function artifactPath(cacheRoot: string, pluginId: string, digest: string): string {
  return join(cacheRoot, pluginId, digest, 'host.mjs');
}

/** Все известные демону версии артефакта (свежие первыми) — для диагностики. */
export function listArtifactDigests(cacheRoot: string, pluginId: string): string[] {
  const dir = join(cacheRoot, pluginId);
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  return names.filter(n => DIGEST.test(n) && existsSync(join(dir, n, 'host.mjs')))
    .sort((a, b) => statSync(join(dir, b, 'host.mjs')).mtimeMs - statSync(join(dir, a, 'host.mjs')).mtimeMs);
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Проверка формы экспорта: имя, версия API, функции. */
export function checkBridgeEntry(value: unknown): BridgeEntry | null {
  if (value === null || typeof value !== 'object') return null;
  const entry = value as Record<string, unknown>;
  if (entry.experimental_apiVersion !== 1 || typeof entry.handleLine !== 'function') return null;
  for (const name of ['start', 'onClose', 'onSigterm', 'onSigint']) {
    if (entry[name] !== undefined && typeof entry[name] !== 'function') return null;
  }
  return entry as unknown as BridgeEntry;
}

export interface LoadedNativeBridge {
  spec: NativeBridgeSpec;
  digest: string;
  path: string;
  entry: BridgeEntry;
}

export interface LoadDeps {
  cacheRoot: string;
  hash?(path: string): string;
  importModule?(url: string): Promise<Record<string, unknown>>;
}

/**
 * Загрузить штатный мост указанной версии. expectedDigest — от сервера; null
 * допустим только для initialize (версия ещё неизвестна): тогда берётся самая
 * свежая, а сверка произойдёт на первом ходе.
 */
export async function loadNativeBridge(providerId: NativeProviderId, expectedDigest: string | null, deps: LoadDeps): Promise<LoadedNativeBridge> {
  const spec = NATIVE_BRIDGES[providerId];
  const hash = deps.hash ?? sha256File;
  const importModule = deps.importModule ?? (url => import(url) as Promise<Record<string, unknown>>);
  let digest = expectedDigest;
  if (digest !== null && !DIGEST.test(digest)) throw new NativeLoadError('no-digest', providerId, `неверный digest ${digest}`);
  if (digest === null) {
    digest = listArtifactDigests(deps.cacheRoot, spec.pluginId)[0] ?? null;
    if (digest === null) throw new NativeLoadError('artifact-missing', providerId, `нет артефакта ${spec.pluginId} в ${deps.cacheRoot}`);
  }
  const path = artifactPath(deps.cacheRoot, spec.pluginId, digest);
  if (!existsSync(path)) throw new NativeLoadError('artifact-missing', providerId, `нет ${path}`);
  const actual = hash(path);
  if (actual !== digest) throw new NativeLoadError('digest-mismatch', providerId, `sha256 ${actual} ≠ ${digest}`);
  let mod: Record<string, unknown>;
  try { mod = await importModule(pathToFileURL(path).href); } catch (error) {
    throw new NativeLoadError('import-failed', providerId, error instanceof Error ? error.message : String(error));
  }
  const entry = checkBridgeEntry(mod.experimental_providerBridge);
  if (!entry) throw new NativeLoadError('shape', providerId, `${path}: неожиданная форма experimental_providerBridge`);
  return { spec, digest, path, entry };
}
