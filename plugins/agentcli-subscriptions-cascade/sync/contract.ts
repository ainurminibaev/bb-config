// Хост-RPC синхронизации: операции, которые выполняются на самой машине
// (исполнитель или опора). Сервер вызывает их через bb.hosts.experimental_client.
// Пути — абсолютные пути машины; относительные пути проверяются на «..».
import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';

const relPaths = z.array(z.string().min(1)).max(10_000);

export const syncHostContract = defineRpcContract({
  /** `mutagen <args>` без оболочки. Бинарь ищется в PATH и обычных местах установки. */
  syncMutagen: {
    input: z.object({ args: z.array(z.string()).min(1).max(200), timeoutMs: z.number().int().positive().max(600_000).default(120_000) }),
    output: z.object({ exitCode: z.number().nullable(), stdout: z.string(), stderr: z.string(), seconds: z.number(), binary: z.string().nullable() }),
  },
  /**
   * Корень проекта на исполнителе перед созданием сессий. Непустая папка без
   * снимка не доверяется: переносится в карантин целиком, опора — эталон.
   */
  syncPrepareBeta: {
    input: z.object({ root: z.string().min(1), key: z.string().min(1), quarantineBase: z.string().min(1) }),
    output: z.object({ created: z.boolean(), movedTo: z.string().nullable() }),
  },
  /** Stat-снимок дерева (путь → размер, mtime, режим) в данных плагина на машине. */
  syncSnapshot: {
    input: z.object({ root: z.string().min(1), key: z.string().min(1), ignores: z.array(z.string()) }),
    output: z.object({ entries: z.number(), seconds: z.number() }),
  },
  /** Сравнить дерево со снимком: изменённое и новое — копия в карантин, удалённое — в список. */
  syncQuarantine: {
    input: z.object({ root: z.string().min(1), key: z.string().min(1), ignores: z.array(z.string()), quarantineBase: z.string().min(1) }),
    output: z.object({ changed: z.number(), deleted: z.number(), dir: z.string().nullable(), hadSnapshot: z.boolean(), seconds: z.number() }),
  },
  /** Файлы `.env*` с правами — до хода исполнителя, чтобы вернуть 0600 после. */
  syncEnvModes: {
    input: z.object({ root: z.string().min(1), ignores: z.array(z.string()) }),
    output: z.object({ files: z.array(z.object({ path: z.string(), mode: z.number() })) }),
  },
  syncChmod: {
    input: z.object({ root: z.string().min(1), paths: relPaths, mode: z.number().int().min(0).max(0o777) }),
    output: z.object({ changed: z.array(z.string()) }),
  },
  /** Оставшиеся `.git/**\/*.lock` и есть ли живой процесс git на машине. */
  syncGitLocks: {
    input: z.object({ root: z.string().min(1) }),
    output: z.object({ locks: z.array(z.string()), gitRunning: z.boolean() }),
  },
  /** Удалить файлы внутри `.git` (застрявший lock, проигравший `.git/index`). */
  syncRemoveGitFiles: {
    input: z.object({ root: z.string().min(1), paths: relPaths }),
    output: z.object({ removed: z.array(z.string()) }),
  },
  /** Опора: `/opt/bbfs/<проект>` — bind mount реальной папки (не symlink: тест А2, п. 1). */
  syncEnsureBindMount: {
    input: z.object({ source: z.string().min(1), target: z.string().min(1) }),
    output: z.object({ status: z.enum(['same-path', 'mounted', 'already']), seconds: z.number() }),
  },
  /** Опора: снять bind mount и удалить пустую точку монтирования. */
  syncRemoveBindMount: {
    input: z.object({ target: z.string().min(1) }),
    output: z.object({ unmounted: z.boolean(), removed: z.boolean() }),
  },
});

export type SyncHostContract = typeof syncHostContract;
