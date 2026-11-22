import { experimental_defineHostEntry } from '@get-bb/plugin-sdk/host';
import { execFile } from 'node:child_process';
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { basename, extname, isAbsolute, join } from 'node:path';
import { hostContract } from './contract';
import { collectBundle, saveBundle, saveToDownloads, supported } from './files';
import { MAC_APPS_SCRIPT, tidyApps, type DesktopApp } from './mac-apps';
import { LocalPages } from './serve';
const run = promisify(execFile);
const isHtml = (path: string) => ['.html', '.htm'].includes(extname(path).toLowerCase());
let pages: LocalPages | null = null;
const appCache = new Map<string, { at: number; apps: DesktopApp[] }>();
/** An application path from `apps`; anything else is refused before it reaches `open -a`. */
async function checkedApp(app: string | null | undefined): Promise<string | null> {
  if (!app) return null;
  if (process.platform !== 'darwin' || !isAbsolute(app) || !app.endsWith('.app') || app.includes('\0')) throw new Error('Неизвестное приложение.');
  if (!(await stat(app).catch(() => null))?.isDirectory()) throw new Error('Приложение не найдено на компьютере.');
  return app;
}
/** Opens the file in an application on this computer and names that application. */
async function launch(path: string, app: string | null, retain: () => { dispose(): Promise<void> }, copiedRoot: string | null): Promise<string> {
  if (process.platform === 'darwin') {
    let target = path;
    // A copied page is served over http so its scripts, modules and fetch() work; a text editor still gets the file.
    const browser = app ? (await appsFor('html')).some(a => a.path === app && a.browser) : true;
    if (isHtml(path) && copiedRoot && browser) {
      pages ??= new LocalPages(copiedRoot, 4 * 60 * 60 * 1000, retain);
      target = await pages.url(path);
    }
    await run('/usr/bin/open', app ? ['-a', app, target] : [target], { timeout: 15000 });
    return app ? basename(app, '.app') : isHtml(path) ? 'браузер по умолчанию' : 'приложение по умолчанию';
  }
  if (process.platform === 'win32') {
    // The shell's "open" action for the file type, with no command line for cmd.exe to interpret.
    await run('rundll32.exe', ['url.dll,FileProtocolHandler', path], { timeout: 15000, windowsHide: true });
    return isHtml(path) ? 'браузер по умолчанию' : 'приложение по умолчанию';
  }
  throw new Error('Для открытия нужна подключённая машина с macOS или Windows.');
}
/**
 * Applications for a file type. LaunchServices takes a few seconds with icons, so the answer is kept on disk:
 * a cached list is returned at once and refreshed in the background when older than six hours.
 */
async function appsFor(extension: string, dirs?: { tempDir: string; dataDir: string }): Promise<DesktopApp[]> {
  if (process.platform !== 'darwin') return [];
  const memo = appCache.get(extension);
  if (memo && Date.now() - memo.at < 10 * 60 * 1000) return memo.apps;
  const file = dirs ? join(dirs.dataDir, `apps-${extension}.json`) : null;
  const disk = file ? await readFile(file, 'utf8').then(t => JSON.parse(t) as { at: number; apps: DesktopApp[] }).catch(() => null) : null;
  if (disk && Array.isArray(disk.apps)) {
    appCache.set(extension, { at: Date.now(), apps: disk.apps });
    if (Date.now() - disk.at > 6 * 60 * 60 * 1000) void scan(extension, dirs!, file!).catch(() => undefined);
    return disk.apps;
  }
  return scan(extension, dirs ?? { tempDir: '/tmp', dataDir: '/tmp' }, file);
}
const scanning = new Map<string, Promise<DesktopApp[]>>();
function scan(extension: string, dirs: { tempDir: string; dataDir: string }, file: string | null): Promise<DesktopApp[]> {
  let job = scanning.get(extension);
  if (job) return job;
  job = (async () => {
    const sample = join(dirs.tempDir, `bb-file-local-open-sample.${extension}`), script = join(dirs.tempDir, 'bb-file-local-open-apps.js');
    await writeFile(sample, '', { mode: 0o600 });
    await writeFile(script, MAC_APPS_SCRIPT, { mode: 0o600 });
    const { stdout } = await run('/usr/bin/osascript', ['-l', 'JavaScript', script, sample, '36'], { timeout: 20000, maxBuffer: 16 * 1024 * 1024 });
    const apps = tidyApps(JSON.parse(stdout) as DesktopApp[], homedir(), extension);
    appCache.set(extension, { at: Date.now(), apps });
    if (file) {
      await mkdir(dirs.dataDir, { recursive: true });
      await writeFile(`${file}.tmp`, JSON.stringify({ at: Date.now(), apps }), { mode: 0o600 });
      await rename(`${file}.tmp`, file);
    }
    return apps;
  })().finally(() => scanning.delete(extension));
  scanning.set(extension, job);
  return job;
}
/** Puts the file itself on the Mac clipboard, ready to paste into Telegram, Mail or Finder. AppleScript's own
 * clipboard command addresses no other application, so macOS asks for no permission. */
async function copyToClipboard(path: string) {
  if (process.platform !== 'darwin') throw new Error('Копирование файла в буфер обмена пока работает только на Mac.');
  await run('/usr/bin/osascript', ['-e', 'on run argv', '-e', 'set the clipboard to (POSIX file (item 1 of argv))', '-e', 'end run', path], { timeout: 15000 });
}
const downloadRoot = () => join(homedir(), 'Downloads', 'BB Files');
export default experimental_defineHostEntry({ contract: hostContract, handlers: {
  info: async () => ({ platform: process.platform }),
  read: ({ path }) => collectBundle(path),
  apps: async ({ extension }, context) => ({ apps: await appsFor(extension, context.experimental_paths) }),
  open: async ({ bundle, action, app }, context) => {
    if (action === 'save') {
      const saved = await saveToDownloads(bundle);
      // Show the saved file in Finder or Explorer; a failure to reveal is not a failure to save.
      if (process.platform === 'darwin') await run('/usr/bin/open', ['-R', saved], { timeout: 15000 }).catch(() => undefined);
      // explorer.exe exits with 1 even on success.
      else if (process.platform === 'win32') await run('explorer.exe', [`/select,${saved}`], { timeout: 15000, windowsHide: true }).catch(() => undefined);
      return { path: saved, application: 'Загрузки' };
    }
    if (!['darwin', 'win32'].includes(process.platform)) throw new Error('Для открытия нужна подключённая машина с macOS или Windows.');
    if (action === 'clipboard') {
      const path = await saveBundle(bundle, downloadRoot());
      await copyToClipboard(path);
      return { path, application: 'буфер обмена' };
    }
    const chosen = await checkedApp(app);
    const path = await saveBundle(bundle, downloadRoot());
    return { path, application: await launch(path, chosen, () => context.experimental_retainWorker(), downloadRoot()) };
  },
  // The file already is on the computer that opens it: no copy is made.
  launch: async ({ path, app, action }, context) => {
    if (!isAbsolute(path)) throw new Error('Этот тип файла пока не поддерживается.');
    // The link's own name proves nothing: the type is checked on what would actually be opened.
    path = await realpath(path);
    if (!supported(path) || !(await stat(path)).isFile()) throw new Error('Этот тип файла пока не поддерживается.');
    if (action === 'clipboard') { await copyToClipboard(path); return { path, application: 'буфер обмена' }; }
    // A page in place is opened as a file: serving an arbitrary folder of this computer is not wanted.
    return { path, application: await launch(path, await checkedApp(app), () => context.experimental_retainWorker(), null) };
  },
} });
