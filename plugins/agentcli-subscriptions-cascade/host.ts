// Хост-вход плагина (bb.host): работает на каждой машине.
// 1) Хост-RPC `probe` — только чтение фактов о машине для мастера.
// 2) Мост провайдера «Каскад» (этап 2, путь B): обёртка над импортированными
//    штатными мостами Claude Code и Codex (bridge/wrapper.ts).
// 3) Этот же файл — запускатель CLI: мост пишет скрипт, который запускает
//    `node host.mjs` с CASCADE_LAUNCHER_MAIN=1 (launcher/main.ts).
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { experimental_defineHostEntry } from '@get-bb/plugin-sdk/host';
import { hostContract, PROVIDER_ID, type Platform } from './contract.ts';
import { createTimelineFeed } from './bridge/feed.ts';
import { artifactCacheRoot } from './bridge/native.ts';
import { createCascadeBridge } from './bridge/wrapper.ts';
import { LAUNCHER_ENV, launcherMain } from './launcher/main.ts';
import { syncHostContract } from './sync/contract.ts';
import { syncHostHandlers } from './sync/host-handlers.ts';

async function detectPlatform(): Promise<Platform> {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'win32') return 'windows';
  if (process.platform !== 'linux') return 'unknown';
  const version = await readFile('/proc/version', 'utf8').catch(() => '');
  return /microsoft|wsl/i.test(version) ? 'wsl' : 'linux';
}

function mutagenVersion(): Promise<string | null> {
  return new Promise(resolve => {
    execFile('mutagen', ['version'], { timeout: 5_000 }, (error, stdout) => resolve(error ? null : stdout.trim().split('\n')[0]?.slice(0, 40) || null));
  });
}

const can = (path: string, mode: number) => access(path, mode).then(() => true, () => false);

export default experimental_defineHostEntry({
  contract: { ...hostContract, ...syncHostContract },
  handlers: {
    ...syncHostHandlers,
    probe: async ({ sharedPath }) => {
      const [platform, exists, writable, mutagen] = await Promise.all([
        detectPlatform(), can(sharedPath, constants.F_OK), can(sharedPath, constants.W_OK), mutagenVersion(),
      ]);
      let user: string | null = null;
      try { user = userInfo().username; } catch { user = null; }
      return { platform, isRoot: typeof process.getuid === 'function' && process.getuid() === 0, user, sharedPathExists: exists, sharedPathWritable: writable, mutagenVersion: mutagen };
    },
  },
});

const bridgeLog = (line: string) => { process.stderr.write(`[cascade-bridge] ${line}\n`); };

export const experimental_providerBridge = createCascadeBridge({
  providerId: PROVIDER_ID,
  ownArtifactUrl: import.meta.url,
  loadDeps: { cacheRoot: artifactCacheRoot(import.meta.url) },
  feed: createTimelineFeed({ warn: bridgeLog }),
  log: bridgeLog,
});

if (process.env[LAUNCHER_ENV.main] === '1') void launcherMain();
