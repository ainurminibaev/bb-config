// Ожидаемые версии штатных мостов: sha256(<rootDir>/dist/host.js) установленных
// provider-claude-code и provider-codex на сервере BB. Это тот же digest, под
// которым демон машины кладёт артефакт в кэш (проверено в stage2-bridge-spike.md).
// Сервер передаёт digest мосту в providerOptions; мост берёт ровно эту версию.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NATIVE_BRIDGES, type NativeProviderId } from './native.ts';

export interface NativeBridgeStatus {
  providerId: NativeProviderId;
  pluginId: string;
  /** null — плагина нет, он выключен или артефакт не читается. */
  digest: string | null;
  version: string | null;
  problem: string | null;
}

export interface PluginListEntry { id: string; rootDir: string; enabled: boolean; status?: string; version?: string | null }

export async function nativeBridgeStatus(
  list: () => Promise<readonly PluginListEntry[]>,
  read: (path: string) => Promise<Buffer> = path => readFile(path),
): Promise<NativeBridgeStatus[]> {
  let plugins: readonly PluginListEntry[] = [];
  let listError: string | null = null;
  try { plugins = await list(); } catch (error) { listError = error instanceof Error ? error.message : String(error); }
  return Promise.all((Object.keys(NATIVE_BRIDGES) as NativeProviderId[]).map(async providerId => {
    const spec = NATIVE_BRIDGES[providerId];
    const base = { providerId, pluginId: spec.pluginId, version: null as string | null };
    if (listError) return { ...base, digest: null, problem: `список плагинов недоступен: ${listError}` };
    const entry = plugins.find(p => p.id === spec.pluginId);
    if (!entry) return { ...base, digest: null, problem: `плагин ${spec.pluginId} не установлен` };
    if (!entry.enabled) return { ...base, version: entry.version ?? null, digest: null, problem: `плагин ${spec.pluginId} выключен` };
    try {
      const data = await read(join(entry.rootDir, 'dist', 'host.js'));
      return { ...base, version: entry.version ?? null, digest: createHash('sha256').update(data).digest('hex'), problem: null };
    } catch (error) {
      return { ...base, version: entry.version ?? null, digest: null, problem: `нет собранного моста: ${error instanceof Error ? error.message : String(error)}` };
    }
  }));
}

export function digestMap(statuses: readonly NativeBridgeStatus[]): Record<string, string> {
  return Object.fromEntries(statuses.filter(s => s.digest).map(s => [s.providerId, s.digest!]));
}
