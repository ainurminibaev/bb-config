import { createHash } from 'node:crypto';
import { open, realpath, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
export const MAX_BYTES = 20 * 1024 * 1024;
const allowed = new Set('pdf html htm md txt csv json png jpg jpeg gif webp svg doc docx xls xlsx ppt pptx odt ods odp rtf mp3 mp4 wav m4a mov zip'.split(' '));
const assetTypes = new Set('css js mjs png jpg jpeg gif webp svg ico woff woff2 ttf otf mp3 mp4 wav m4a json csv txt wasm html htm'.split(' '));
export const MAX_FILES = 300;
export type Bundle = { main: string; entries: { path: string; content: string; sha256: string }[] };
export const supported = (path: string) => allowed.has(extname(path).slice(1).toLowerCase());
export const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
export function safeRelative(path: string) {
  return path.length > 0 && !isAbsolute(path) && !path.includes('\\') && !path.split('/').some(p => p === '..' || p === '.' || p === '') && !path.includes('\0');
}
export function dependencies(text: string): string[] {
  return [...text.matchAll(/(?:src|href|poster)\s*=\s*["']([^"']+)["']|url\(\s*["']?([^\s)'";]+)|@import\s+["']([^"']+)["']/gi)]
    .map(m => m[1] ?? m[2] ?? m[3]!).filter(v => !/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(v))
    .map(v => decodeURIComponent(v.split(/[?#]/, 1)[0]!)).filter(Boolean);
}
/** Paths a script may load: module specifiers, and quoted relative paths to known asset types (fetch, Image, CSS in JS). */
export function scriptDependencies(text: string): { modules: string[]; assets: string[] } {
  const relative = (v: string) => !/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(v);
  const modules = [...text.matchAll(/(?:\bimport\s*\(\s*|\bfrom\s*|\bimport\s+)["'`]([^"'`\n]+)["'`]/g)].map(m => m[1]!)
    .filter(v => v.startsWith('./') || v.startsWith('../'));
  const ext = [...assetTypes].join('|');
  const assets = [...text.matchAll(new RegExp(`["'\`]((?:\\.{1,2}/)?[\\w\\-./ %]+\\.(?:${ext}))(?:[?#][^"'\`]*)?["'\`]`, 'gi'))].map(m => m[1]!)
    .filter(v => relative(v) && !v.includes('//'));
  const clean = (v: string) => { try { return decodeURIComponent(v); } catch { return v; } };
  return { modules: [...new Set(modules.map(clean))], assets: [...new Set(assets.map(clean))] };
}
export async function collectBundle(path: string): Promise<Bundle> {
  if (!isAbsolute(path) || !allowed.has(extname(path).slice(1).toLowerCase())) throw new Error('Этот тип файла пока не поддерживается.');
  path = await realpath(path);
  const root = dirname(path), entries: Bundle['entries'] = [], seen = new Set<string>();
  let total = 0;
  const visit = async (candidate: string, required = false) => {
    // A broken or outside link in the page is skipped, as a browser would: only the main file must exist.
    let actual: string;
    try { actual = await realpath(candidate); } catch (error) { if (required) throw error; return; }
    // Bundle paths use forward slashes on every system; Windows reports backslashes.
    const rel = relative(root, actual).split(sep).join('/');
    if (!safeRelative(rel)) { if (required) throw new Error('Недопустимый путь файла.'); return; }
    if (seen.has(actual)) return;
    if (!required && !assetTypes.has(extname(actual).slice(1).toLowerCase())) return;
    // Past the limits the page opens with what fits, rather than not at all.
    if (seen.size >= MAX_FILES) return;
    seen.add(actual);
    const handle = await open(actual, 'r');
    let data: Buffer;
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) { if (required) throw new Error('Это не файл.'); seen.delete(actual); return; }
      if (total + stat.size > MAX_BYTES) { if (required) throw new Error('Файл больше 20 МБ.'); return; }
      const buffer = Buffer.alloc(Math.min(MAX_BYTES - total + 1, stat.size + 1));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead !== stat.size) throw new Error('Файл изменился во время копирования. Повторите открытие.');
      data = buffer.subarray(0, bytesRead);
    } finally { await handle.close(); }
    total += data.length;
    entries.push({ path: rel, content: data.toString('base64'), sha256: sha(data) });
    const type = extname(actual).toLowerCase();
    if (['.html', '.htm', '.css'].includes(type)) {
      for (const ref of dependencies(data.toString('utf8'))) await visit(resolve(dirname(actual), ref));
    }
    if (type === '.html' || type === '.htm' || type === '.js' || type === '.mjs') {
      // Inline scripts of the page count too. A module import resolves against the script; fetch() and
      // Image against the page, so a quoted asset is tried both ways.
      const found = scriptDependencies(data.toString('utf8'));
      for (const ref of found.modules) await visit(resolve(dirname(actual), ref));
      for (const ref of found.assets) { await visit(resolve(dirname(actual), ref)); await visit(resolve(root, ref)); }
    }
  };
  await visit(path, true);
  return { main: basename(path), entries };
}
function decodeBundle(bundle: Bundle) {
  if (!safeRelative(bundle.main) || bundle.main.includes('/') || !allowed.has(extname(bundle.main).slice(1).toLowerCase())) throw new Error('Недопустимое имя файла.');
  let total = 0;
  const paths = new Set<string>();
  const decoded = bundle.entries.map(entry => {
    if (!safeRelative(entry.path) || paths.has(entry.path)) throw new Error('Недопустимый путь ресурса.');
    paths.add(entry.path);
    const data = Buffer.from(entry.content, 'base64'); total += data.length;
    if (total > MAX_BYTES || sha(data) !== entry.sha256) throw new Error('Ошибка проверки файла.');
    return { path: entry.path, data };
  });
  if (!paths.has(bundle.main)) throw new Error('Главный файл отсутствует.');
  return decoded;
}
async function writeEntries(directory: string, decoded: { path: string; data: Buffer }[]) {
  for (const entry of decoded) {
    const dest = join(directory, entry.path);
    await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
    await writeFile(dest, entry.data, { flag: 'wx', mode: 0o600 });
  }
}
const isExists = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'EEXIST';
// Temporary copy for "open": a fresh hidden-ish directory per launch.
export async function saveBundle(bundle: Bundle, downloadRoot = join(homedir(), 'Downloads', 'BB Files')) {
  const decoded = decodeBundle(bundle);
  await mkdir(downloadRoot, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(downloadRoot, 'open-'));
  await writeEntries(directory, decoded);
  return join(directory, bundle.main);
}
// "Save": put the file directly into Downloads, Finder-style "name (2).ext" on collision.
// HTML with assets goes into its own "name" folder so relative links keep working.
export async function saveToDownloads(bundle: Bundle, downloads = join(homedir(), 'Downloads')) {
  const decoded = decodeBundle(bundle);
  await mkdir(downloads, { recursive: true });
  const ext = extname(bundle.main), stem = bundle.main.slice(0, bundle.main.length - ext.length) || 'file';
  for (let n = 1; n <= 999; n++) {
    const suffix = n === 1 ? '' : ` (${n})`;
    if (decoded.length === 1) {
      const dest = join(downloads, `${stem}${suffix}${ext}`);
      try { await writeFile(dest, decoded[0]!.data, { flag: 'wx', mode: 0o644 }); return dest; }
      catch (error) { if (isExists(error)) continue; throw error; }
    }
    const directory = join(downloads, `${stem}${suffix}`);
    try { await mkdir(directory, { mode: 0o755 }); }
    catch (error) { if (isExists(error)) continue; throw error; }
    await writeEntries(directory, decoded);
    return join(directory, bundle.main);
  }
  throw new Error('Не удалось подобрать свободное имя в Загрузках.');
}
