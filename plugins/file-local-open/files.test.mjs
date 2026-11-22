import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { collectBundle, saveBundle, saveToDownloads, sha, MAX_BYTES } from './files.ts';
import { tidyApps } from './mac-apps.ts';
import { LocalPages } from './serve.ts';
async function fixture(run) { const root = await mkdtemp(join(tmpdir(), 'bb-open-test-')); try { await run(root); } finally { await rm(root, { recursive: true, force: true }); } }
test('HTML and nested CSS assets survive a server-to-Mac copy with Unicode paths', () => fixture(async root => {
  const src = join(root, 'source'); await mkdir(join(src, 'assets'), { recursive: true });
  await writeFile(join(src, 'слайды.html'), '<link href="assets/style.css"><img src="assets/картинка.png"><script src="https://example.invalid/remote.js"></script>');
  await writeFile(join(src, 'assets/style.css'), 'body{background:url("картинка.png")}');
  const image = Buffer.from([0, 255, 17, 180]); await writeFile(join(src, 'assets/картинка.png'), image);
  const bundle = await collectBundle(join(src, 'слайды.html')); assert.equal(bundle.entries.length, 3);
  const path = await saveBundle(bundle, join(root, 'downloads'));
  assert.deepEqual(await readFile(join(dirname(path), 'assets/картинка.png')), image);
  assert.match(await readFile(path, 'utf8'), /assets\/style.css/);
  assert.notEqual(path, await saveBundle(bundle, join(root, 'downloads')));
}));
test('never copies symlink resources escaping the presentation directory', (t) => fixture(async root => {
  const src = join(root, 'source'); await mkdir(src);
  await writeFile(join(root, 'outside.png'), 'private');
  try { await symlink(join(root, 'outside.png'), join(src, 'image.png')); }
  catch (error) { if (error.code === 'EPERM') return t.skip('creating a symlink needs a privilege on Windows'); throw error; }
  await writeFile(join(src, 'slides.html'), '<img src="image.png">');
  const bundle = await collectBundle(join(src, 'slides.html'));
  assert.deepEqual(bundle.entries.map(e => e.path), ['slides.html']);
  assert.ok(!bundle.entries.some(e => Buffer.from(e.content, 'base64').toString() === 'private'));
}));
test('copies what scripts load and skips broken links', () => fixture(async root => {
  const src = join(root, 'site'); await mkdir(join(src, 'js'), { recursive: true }); await mkdir(join(src, 'data'));
  await writeFile(join(src, 'index.html'), '<script type="module" src="js/app.js"></script><img src="missing.png"><a href="../outside.html">x</a>');
  await writeFile(join(src, 'js', 'app.js'), "import { x } from './util.js'; fetch('data/items.json'); const img = 'data/pic.png';");
  await writeFile(join(src, 'js', 'util.js'), 'export const x = 1;');
  await writeFile(join(src, 'data', 'items.json'), '[]');
  await writeFile(join(src, 'data', 'pic.png'), 'png');
  const bundle = await collectBundle(join(src, 'index.html'));
  assert.deepEqual(bundle.entries.map(e => e.path).sort(), ['data/items.json', 'data/pic.png', 'index.html', 'js/app.js', 'js/util.js']);
}));
test('keeps installed applications only, default first', () => {
  const app = (name, path, extra = {}) => ({ id: `id.${name}`, name, path, isDefault: false, browser: false, icon: '', ...extra });
  const list = tidyApps([
    app('TextEdit', '/System/Applications/TextEdit.app'),
    app('Testing', '/home/tester/Library/Caches/ms-playwright/x/Google Chrome for Testing.app', { browser: true }),
    app('Safari', '/System/Volumes/Preboot/Cryptexes/App/System/Applications/Safari.app', { browser: true }),
    app('Chrome', '/Applications/Google Chrome.app', { isDefault: true, browser: true }),
    app('Chrome', '/Applications/Google Chrome copy.app', { browser: true, id: 'id.Chrome' }),
    app('Mine', '/home/tester/Applications/Mine.app'),
  ], '/home/tester', 'html');
  assert.deepEqual(list.map(a => a.name), ['Chrome', 'Safari', 'Mine', 'TextEdit']);
});
test('rejects altered bytes and traversal before writing', () => fixture(async root => {
  const entry = { path: 'file.pdf', content: Buffer.from('pdf').toString('base64'), sha256: sha(Buffer.from('different')) };
  await assert.rejects(saveBundle({ main: 'file.pdf', entries: [entry] }, root), /проверки/);
  await assert.rejects(saveBundle({ main: '../file.pdf', entries: [] }, root), /имя/);
  await assert.rejects(saveBundle({ main: 'file.pdf', entries: [{ ...entry, path: '../file.pdf' }] }, root), /путь/);
}));
test('rejects oversized files without reading full contents', () => fixture(async root => {
  const file = join(root, 'large.pdf'); await writeFile(file, Buffer.alloc(MAX_BYTES + 1));
  await assert.rejects(collectBundle(file), /20 МБ/);
}));
test('save puts a single file straight into Downloads with Finder-style names', () => fixture(async root => {
  const data = Buffer.from('%PDF-1.7 test');
  const bundle = { main: 'guide.pdf', entries: [{ path: 'guide.pdf', content: data.toString('base64'), sha256: sha(data) }] };
  const downloads = join(root, 'Downloads');
  assert.equal(await saveToDownloads(bundle, downloads), join(downloads, 'guide.pdf'));
  assert.equal(await saveToDownloads(bundle, downloads), join(downloads, 'guide (2).pdf'));
  assert.deepEqual(await readFile(join(downloads, 'guide (2).pdf')), data);
}));
test('save keeps HTML assets together in a named Downloads folder', () => fixture(async root => {
  const src = join(root, 'source'); await mkdir(src);
  await writeFile(join(src, 'deck.html'), '<img src="a.png">'); await writeFile(join(src, 'a.png'), 'png');
  const downloads = join(root, 'Downloads');
  const path = await saveToDownloads(await collectBundle(join(src, 'deck.html')), downloads);
  assert.equal(path, join(downloads, 'deck', 'deck.html'));
  assert.equal(await readFile(join(downloads, 'deck', 'a.png'), 'utf8'), 'png');
  assert.equal(await saveToDownloads(await collectBundle(join(src, 'deck.html')), downloads), join(downloads, 'deck (2)', 'deck.html'));
}));
test('serves copied pages on 127.0.0.1 under a secret path only', () => fixture(async root => {
  await mkdir(join(root, 'open-1'));
  await writeFile(join(root, 'open-1', 'index.html'), '<h1>hi</h1>');
  await writeFile(join(root, 'secret.txt'), 'no');
  let leases = 0;
  const pages = new LocalPages(root, 60000, () => { leases++; return { dispose: async () => { leases--; } }; });
  try {
    const url = await pages.url(join(root, 'open-1', 'index.html'));
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/open-1\/index\.html$/);
    const ok = await fetch(url);
    assert.equal(ok.status, 200); assert.match(ok.headers.get('content-type'), /text\/html/); assert.equal(await ok.text(), '<h1>hi</h1>');
    const base = new URL(url);
    assert.equal((await fetch(`${base.origin}/open-1/index.html`)).status, 404);
    assert.equal((await fetch(`${base.origin}${base.pathname.split('/').slice(0, 2).join('/')}/..%2Fsecret.txt`)).status, 404);
    assert.equal(leases, 1);
  } finally { await pages.stop(); }
  assert.equal(leases, 0);
}));
