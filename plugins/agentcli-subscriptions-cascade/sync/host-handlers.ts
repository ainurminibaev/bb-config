// Обработчики хост-RPC синхронизации для host.ts:
//   contract: { ...hostContract, ...syncHostContract },
//   handlers: { probe, ...syncHostHandlers },
import type { ExperimentalHostRpcHandlers } from '@get-bb/plugin-sdk/host';
import type { SyncHostContract } from './contract.ts';
import { chmodFiles, ensureBindMount, envModes, expandHome, gitLocks, mutagen, prepareBeta, quarantine, removeBindMount, removeGitFiles, writeSnapshot } from './host-ops.ts';

export const syncHostHandlers: ExperimentalHostRpcHandlers<SyncHostContract> = {
  syncMutagen: ({ args, timeoutMs }) => mutagen(args, timeoutMs),
  syncPrepareBeta: ({ root, key, quarantineBase }, ctx) => prepareBeta(ctx.experimental_paths.dataDir, root, key, expandHome(quarantineBase)),
  syncSnapshot: ({ root, key, ignores }, ctx) => writeSnapshot(ctx.experimental_paths.dataDir, root, key, ignores),
  syncQuarantine: ({ root, key, ignores, quarantineBase }, ctx) => quarantine(ctx.experimental_paths.dataDir, root, key, ignores, quarantineBase),
  syncEnvModes: ({ root, ignores }) => envModes(root, ignores),
  syncChmod: ({ root, paths, mode }) => chmodFiles(root, paths, mode),
  syncGitLocks: ({ root }) => gitLocks(root),
  syncRemoveGitFiles: ({ root, paths }) => removeGitFiles(root, paths),
  syncEnsureBindMount: ({ source, target }) => ensureBindMount(source, target),
  syncRemoveBindMount: ({ target }) => removeBindMount(target),
};
