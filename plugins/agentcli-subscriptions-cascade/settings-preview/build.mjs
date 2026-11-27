// Сборка стенда настроек: node settings-preview/build.mjs <папка-вывода>
// 1) состояние — настоящий server.ts на фейковом хосте SDK (state.ts);
// 2) экран — SettingsView в браузере, React и esbuild вне плагина:
//    ASC_PREVIEW_DEPS=<папка с node_modules react, react-dom@19, esbuild>.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
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
const stateFile = join(out, 'state.json');
execFileSync(process.execPath, [join(here, 'state.ts'), stateFile], { cwd: join(here, '..'), stdio: 'inherit' });
await esbuild.build({
  entryPoints: [join(here, 'preview.tsx')],
  bundle: true, format: 'esm', jsx: 'automatic', target: 'es2022', outdir: out, entryNames: 'preview',
  alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')) },
  // Состояние лежит в папке вывода, а не в исходниках.
  plugins: [{ name: 'state', setup: b => b.onResolve({ filter: /^\.\/state\.json$/ }, () => ({ path: stateFile })) }],
  nodePaths: [join(resolve(deps), 'node_modules')],
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
});
writeFileSync(join(out, 'index.html'), `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Каскад · настройки</title>
<link rel="stylesheet" href="preview.css"></head><body><div id="root"></div><script type="module" src="preview.js"></script></body></html>\n`);
console.log(`стенд: ${join(out, 'index.html')}`);
