// JXA run by /usr/bin/osascript in-process: LaunchServices queries only, no Apple Events to other apps,
// so macOS asks for no permission. argv[0] is a sample file of the wanted type, argv[1] the icon size.
export const MAC_APPS_SCRIPT = String.raw`
ObjC.import('AppKit');
function icon(path, size) {
  const img = $.NSWorkspace.sharedWorkspace.iconForFile(path);
  const rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(null, size, size, 8, 4, true, false, $.NSCalibratedRGBColorSpace, 0, 0);
  $.NSGraphicsContext.saveGraphicsState;
  $.NSGraphicsContext.setCurrentContext($.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep));
  img.drawInRectFromRectOperationFraction($.NSMakeRect(0, 0, size, size), $.NSZeroRect, $.NSCompositingOperationCopy, 1.0);
  $.NSGraphicsContext.restoreGraphicsState;
  return rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $()).base64EncodedStringWithOptions(0).js;
}
function list(url) {
  const apps = $.NSWorkspace.sharedWorkspace.URLsForApplicationsToOpenURL(url), out = [];
  for (let i = 0; i < apps.count; i++) out.push(apps.objectAtIndex(i));
  return out;
}
function run(argv) {
  const ws = $.NSWorkspace.sharedWorkspace, size = Number(argv[1]) || 64;
  const url = $.NSURL.fileURLWithPath(argv[0]);
  const def = ws.URLForApplicationToOpenURL(url);
  const browsers = {};
  for (const u of list($.NSURL.URLWithString('http://127.0.0.1/'))) browsers[u.path.js] = true;
  const out = [];
  for (const u of list(url)) {
    const path = u.path.js, bundle = $.NSBundle.bundleWithURL(u);
    const info = key => { const v = bundle.objectForInfoDictionaryKey(key); return v && v.js ? v.js : ''; };
    out.push({ path, id: bundle.bundleIdentifier.js || '', name: info('CFBundleDisplayName') || info('CFBundleName') || path.split('/').pop().replace(/\.app$/, ''),
      isDefault: !!(def && def.path.js === path), browser: !!browsers[path], icon: icon(path, size) });
  }
  return JSON.stringify(out);
}`;
const APP_DIRS = ['/Applications/', '/System/Applications/', '/System/Volumes/Preboot/Cryptexes/App/System/Applications/'];
export type DesktopApp = { id: string; name: string; path: string; isDefault: boolean; browser: boolean; icon: string };
// What usually makes sense first for a file type: viewers, then editors, then everything else that claims it.
const KIND: Record<string, 'web' | 'text' | 'image' | 'pdf' | 'office' | 'media' | 'archive'> = {
  html: 'web', htm: 'web', svg: 'web', md: 'text', txt: 'text', csv: 'text', json: 'text',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', pdf: 'pdf',
  doc: 'office', docx: 'office', xls: 'office', xlsx: 'office', ppt: 'office', pptx: 'office', odt: 'office', ods: 'office', odp: 'office', rtf: 'office',
  mp3: 'media', mp4: 'media', wav: 'media', m4a: 'media', mov: 'media', zip: 'archive',
};
const EDITORS = /^(com\.microsoft\.VSCode|com\.todesktop\.230313mzl4w4u92|com\.sublimetext\.|com\.barebones\.bbedit|dev\.zed\.|com\.jetbrains\.|com\.google\.antigravity|com\.apple\.TextEdit|com\.panic\.nova|com\.coteditor)/i;
const VIEWERS = /^(com\.apple\.Preview|com\.apple\.QuickTimePlayerX|org\.videolan\.vlc|com\.colliderli\.iina|com\.apple\.Music|com\.apple\.Photos|com\.adobe\.Reader|com\.adobe\.Acrobat|com\.apple\.archiveutility|com\.aone\.keka|cx\.c3\.theunarchiver)/i;
const OFFICE = /^(com\.microsoft\.(Word|Excel|Powerpoint)|com\.apple\.iWork\.|org\.libreoffice|com\.kingsoft\.wpsoffice|com\.google\.drivefs)/i;
const NOISE = /^(org\.mozilla\.parsehub|com\.anthropic\.claudefordesktop|com\.apple\.Notes|org\.languagetool|com\.t3tools)/i;
/** Lower is better. */
export function rank(app: DesktopApp, extension: string): number {
  const kind = KIND[extension] ?? 'other';
  const id = app.id;
  const score = (() => {
    if (kind === 'web') return app.browser ? 1 : EDITORS.test(id) ? 2 : 4;
    if (kind === 'text') return EDITORS.test(id) ? 1 : app.browser ? 3 : 4;
    if (kind === 'image' || kind === 'pdf' || kind === 'media' || kind === 'archive') return VIEWERS.test(id) ? 1 : app.browser ? 2 : EDITORS.test(id) ? 3 : 4;
    if (kind === 'office') return OFFICE.test(id) ? 1 : VIEWERS.test(id) ? 2 : 4;
    return 3;
  })();
  return (app.isDefault ? -10 : 0) + score + (NOISE.test(id) ? 5 : 0);
}
/** Keeps real installed applications: drops browser engines from caches and tool folders, one entry per bundle. */
export function tidyApps(apps: DesktopApp[], home: string, extension = ''): DesktopApp[] {
  const dirs = [...APP_DIRS, `${home.replace(/\/+$/, '')}/Applications/`];
  const seen = new Set<string>(), out: DesktopApp[] = [];
  for (const app of [...apps].sort((a, b) => Number(b.isDefault) - Number(a.isDefault))) {
    if (!app.isDefault && !dirs.some(d => app.path.startsWith(d))) continue;
    const key = app.id || app.path;
    if (seen.has(key)) continue;
    seen.add(key); out.push(app);
  }
  return out.sort((a, b) => rank(a, extension) - rank(b, extension) || a.name.localeCompare(b.name));
}
