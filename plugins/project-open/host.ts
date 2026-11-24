import { experimental_defineHostEntry } from '@get-bb/plugin-sdk/host';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { hostContract } from './contract';
import { keepKnownKeys, publicKeys } from './directory';

const support = () => join(homedir(), 'Library/Application Support/BB Project Folder');
const installed = async () => process.platform === 'darwin' && ((await stat(support()).catch(() => null))?.isDirectory() ?? false);

async function hostKeys(): Promise<string[]> {
  if (process.platform !== 'linux' && process.platform !== 'darwin') return [];
  const names = (await readdir('/etc/ssh').catch(() => [] as string[])).filter(name => /^ssh_host_[a-z0-9]+_key\.pub$/.test(name));
  return publicKeys(await Promise.all(names.map(name => readFile(join('/etc/ssh', name), 'utf8').catch(() => ''))));
}

/** An account without a name on this system (a container) is simply not reported. */
function user(): string | null {
  try { return userInfo().username || null; } catch { return null; }
}

export default experimental_defineHostEntry({ contract: hostContract, handlers: {
  identity: async () => ({ platform: process.platform, hostKeys: await hostKeys(), handler: await installed(), user: user() }),
  save: async directory => {
    if (!(await installed())) return { saved: false };
    const file = join(support(), 'machines.json');
    const previous = await readFile(file, 'utf8').then(text => JSON.parse(text) as unknown).catch(() => null);
    const temporary = `${file}.${randomUUID()}`;
    await writeFile(temporary, JSON.stringify(keepKnownKeys(directory, previous), null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, file);
    return { saved: true };
  },
} });
