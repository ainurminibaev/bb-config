// Сборка стенда ленты: node timeline/preview/build.mjs <папка-вывода>
// Нужны react, react-dom и esbuild вне плагина: ASC_PREVIEW_DEPS=<папка с node_modules>.
// Плагин эти пакеты не тянет — BB даёт React хоста, а стенд живёт только для скриншотов.
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.argv[2] ?? join(here, 'out'));
const deps = process.env.ASC_PREVIEW_DEPS;
if (!deps) { console.error('Укажите ASC_PREVIEW_DEPS — папку, где установлены react, react-dom@19 и esbuild.'); process.exit(2); }
const require = createRequire(join(resolve(deps), 'package.json'));
const esbuild = require('esbuild');

mkdirSync(out, { recursive: true });
await esbuild.build({
  entryPoints: [join(here, 'preview.tsx')],
  bundle: true, format: 'esm', jsx: 'automatic', target: 'es2022', outdir: out, entryNames: 'preview',
  alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')) },
  nodePaths: [join(resolve(deps), 'node_modules')],
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
});
cpSync(join(here, '..', 'icons'), join(out, 'icons'), { recursive: true });
cpSync(join(here, '..', '..', 'assets', 'icon.svg'), join(out, 'cascade-icon.svg'));
writeFileSync(join(out, 'index.html'), `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Каскад · лента</title>
<link rel="stylesheet" href="preview.css"></head><body><div id="root"></div><script type="module" src="preview.js"></script></body></html>\n`);
console.log(`стенд: ${join(out, 'index.html')}`);
