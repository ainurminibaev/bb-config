// Интеграционный прогон синхронизации между этой машиной (исполнитель) и
// опорой — без установки плагина в BB. Хост-операции: здесь — в процессе,
// на опоре — те же обработчики (host-handlers.ts) через `bb terminal run`.
// Синтетическая папка, затем уборка. Запуск (вне песочницы, нужен демон Mutagen):
//   node sync/integration.ts --anchor <hostId опоры> --ssh <ssh-цель опоры> [--keep]
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncHostHandlers } from './host-handlers.ts';
import { mutagen as runMutagen } from './host-ops.ts';
import { timingLines } from './lines.ts';
import { SyncOrchestrator, type ProjectSyncState, type SyncHostCall, type SyncProjectContext, type SyncResult } from './orchestrator.ts';
import { setupPlan } from './setup.ts';

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const ANCHOR = arg('anchor') ?? '';
const SSH = arg('ssh') ?? '';
const KEEP = process.argv.includes('--keep');
if (!ANCHOR || !SSH) throw new Error('нужны --anchor и --ssh');
const LOCAL = 'local-mac';
const SLUG = 'cascade-sync-test';
const SHARED = '/opt/bbfs';
const ROOT = `${SHARED}/${SLUG}`;
const REMOTE_DIR = '/root/bbc-sync-int';
const REAL = `${REMOTE_DIR}/real`;
const here = dirname(fileURLToPath(import.meta.url));
const dataDir = mkdtempSync(join(tmpdir(), 'bbc-int-data-'));
const report: string[] = [];
const say = (line: string) => { report.push(line); console.log(line); };

// ---- Опора: команды через bb terminal ----

function terminal(command: string, timeout = '120s'): { exitCode: number | null; output: string } {
  let raw: string;
  try {
    raw = execFileSync('bb', ['terminal', 'run', '--machine', ANCHOR, '--json', '--timeout', timeout, '--max-output-bytes', '4000000', '--', 'sh', '-c', command], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    // Ненулевой код команды bb передаёт своим кодом выхода; JSON при этом в stdout.
    raw = String((error as { stdout?: unknown }).stdout ?? '');
    if (!raw.trim().startsWith('{')) throw error;
  }
  const parsed = JSON.parse(raw) as { exitCode: number | null; output: string | null; observation: string };
  if (parsed.observation !== 'exited') throw new Error(`bb terminal: ${parsed.observation}`);
  return { exitCode: parsed.exitCode, output: parsed.output ?? '' };
}
const remote = (command: string) => {
  const out = terminal(command);
  if (out.exitCode !== 0) throw new Error(`опора: ${command.slice(0, 80)} → ${out.exitCode}: ${out.output.slice(-400)}`);
  return out.output.trim();
};
const b64 = (text: string) => Buffer.from(text).toString('base64');

/** Команда bb terminal — до 10 000 символов: файл идёт кусками base64. */
function upload(path: string, content: string) {
  const data = b64(content);
  remote(`: > ${path}.b64`);
  for (let i = 0; i < data.length; i += 8000) remote(`printf %s ${data.slice(i, i + 8000)} >> ${path}.b64`);
  remote(`base64 -d ${path}.b64 > ${path} && rm ${path}.b64`);
}

function uploadHandlers() {
  remote(`mkdir -p ${REMOTE_DIR}/code`);
  for (const file of ['host-ops.ts', 'host-handlers.ts']) upload(`${REMOTE_DIR}/code/${file}`, readFileSync(join(here, file), 'utf8'));
  const cli = `import { syncHostHandlers } from './host-handlers.ts';
const [method, input] = process.argv.slice(2);
const ctx = { experimental_paths: { dataDir: '${REMOTE_DIR}/data', tempDir: '/tmp' }, signal: new AbortController().signal };
const out = await (syncHostHandlers as any)[method](JSON.parse(Buffer.from(input, 'base64').toString()), ctx);
console.log('@@BBC@@' + Buffer.from(JSON.stringify(out)).toString('base64') + '@@END@@');`;
  upload(`${REMOTE_DIR}/code/host-cli.ts`, cli);
}

const call: SyncHostCall = async (hostId, method, input) => {
  const ctx = { experimental_paths: { dataDir, tempDir: tmpdir() }, signal: new AbortController().signal, lifecycle: { signal: new AbortController().signal } };
  if (hostId === LOCAL) return (syncHostHandlers as any)[method](input, ctx);
  const out = terminal(`cd ${REMOTE_DIR}/code && node host-cli.ts ${method} ${b64(JSON.stringify(input))}`);
  const match = out.output.replace(/\s+/g, '').match(/@@BBC@@([A-Za-z0-9+/=]+)@@END@@/);
  if (out.exitCode !== 0 || !match) throw new Error(`опора ${method}: ${out.output.slice(-500)}`);
  return JSON.parse(Buffer.from(match[1]!, 'base64').toString());
};

// ---- Проверки ----

const sh = (command: string) => execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8' }).trim();
function check(name: string, ok: boolean, detail = '') {
  say(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}
let failures = 0;
const label = (h: string) => (h === LOCAL ? 'Mac' : h === ANCHOR ? 'Tru' : h);
function show(title: string, result: SyncResult) {
  const total = result.timings.reduce((s, t) => s + t.seconds, 0);
  say(`— ${title}: ${result.ok ? 'ok' : `ОТКАЗ ${result.reason}: ${result.message}`} (${total.toFixed(2)} с)`);
  for (const line of timingLines(result.timings, label)) say(`    ${line}`);
  for (const n of result.notices) say(`    ! ${n}`);
}

async function main() {
  say(`Интеграция sync: исполнитель — этот Mac, опора ${ANCHOR} (ssh ${SSH}), путь ${ROOT}`);

  // 1. Мастер: проверки шагов (повторный запуск безопасен — второй проход только проверяет).
  uploadHandlers();
  const facts = JSON.parse(remote(`node -e 'console.log(JSON.stringify({root: process.getuid()===0}))'`).split('\n').pop()!) as { root: boolean };
  for (const pass of [1, 2]) {
    const tru = setupPlan({ sharedPath: SHARED, anchor: true }, { platform: 'linux', isRoot: facts.root })!;
    const mac = setupPlan({ sharedPath: SHARED, anchor: false }, { platform: 'macos', isRoot: false })!;
    const results: string[] = [];
    for (const step of tru.slice(1)) {
      let ok = step.check ? terminal(step.check).exitCode === 0 : false;
      if (!ok && step.apply && step.privilege !== 'manual' && step.privilege !== 'macos-dialog') ok = terminal(step.apply, '300s').exitCode === 0 && (!step.check || terminal(step.check).exitCode === 0);
      results.push(`Tru ${step.id}:${ok ? 'ok' : 'нет'}`);
    }
    for (const step of mac.slice(1)) {
      let ok = step.check ? spawnOk(step.check) : false;
      // Папка на Mac уже создана владельцем через окно пароля; окно в прогоне не вызываем.
      if (!ok && step.apply && step.privilege === 'none') ok = spawnOk(step.apply) && (!step.check || spawnOk(step.check));
      results.push(`Mac ${step.id}:${ok ? 'ok' : 'нет'}`);
    }
    check(`мастер, проход ${pass}`, results.every(r => r.endsWith(':ok')), results.join(', '));
  }

  // 2. Синтетический проект на опоре: git, .env 0600, node_modules.
  remote([
    `rm -rf ${REAL} && mkdir -p ${REAL}/src ${REAL}/node_modules/dep && cd ${REAL}`,
    'for i in $(seq 1 200); do echo "export const v$i = $i;" > src/f$i.ts; done',
    'echo SECRET=1 > .env && chmod 600 .env && echo local > .env.local && chmod 644 .env.local',
    'echo dep > node_modules/dep/index.js',
    'printf "node_modules\\n" > .gitignore',
    'git init -q && git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm init',
  ].join(' && '));

  const states = new Map<string, ProjectSyncState>();
  let mode: SyncProjectContext['mode'] = 'lazy';
  const sync = new SyncOrchestrator({
    call,
    store: { get: async id => states.get(id), set: async (id, s) => { states.set(id, structuredClone(s)); } },
    context: async () => ({
      projectId: 'proj_cascade_sync_test', slug: SLUG, anchorRealPath: REAL,
      anchor: { hostId: ANCHOR, label: 'Tru', sharedPath: SHARED, platform: 'linux' },
      executors: [{ hostId: LOCAL, label: 'Mac', sharedPath: SHARED, platform: 'macos' }],
      mode, ignores: ['node_modules', 'dist'], anchorSsh: () => SSH,
    }),
  });
  const T = { threadId: 'thr_int', projectId: 'proj_cascade_sync_test' };

  // 3. Первый ход на Mac.
  let r = await sync.prepareTurn(T, { hostId: LOCAL });
  show('ход 1 на Mac: подготовка (первая синхронизация)', r);
  check('ход 1 подготовлен', r.ok);
  check('путь одинаковый', r.ok && r.cwd === ROOT, r.ok ? r.cwd : '');
  check('файлы и .git доехали', existsSync(`${ROOT}/src/f200.ts`) && existsSync(`${ROOT}/.git/HEAD`));
  check('.env доехал', readFileSync(`${ROOT}/.env`, 'utf8').trim() === 'SECRET=1');
  check('node_modules не уехал', !existsSync(`${ROOT}/node_modules`));
  check('права 0644/0755 на Mac', (statSync(`${ROOT}/src/f1.ts`).mode & 0o777) === 0o644 && (statSync(`${ROOT}/src`).mode & 0o777) === 0o755);
  check('git status на Mac чистый', sh(`cd ${ROOT} && git status --porcelain`) === '');

  // Ход Mac: правка, новый файл, удаление, .env, коммит, застрявший lock.
  writeFileSync(`${ROOT}/src/f1.ts`, 'export const v1 = "mac";\n');
  writeFileSync(`${ROOT}/src/mac-new.ts`, 'export const n = 1;\n');
  rmSync(`${ROOT}/src/f2.ts`);
  writeFileSync(`${ROOT}/.env`, 'SECRET=2\n');
  sh(`cd ${ROOT} && git add -A && git -c user.email=m@m -c user.name=m commit -qm "mac turn"`);
  writeFileSync(`${ROOT}/.git/index.lock`, '');
  r = await sync.finishTurn(T, { hostId: LOCAL });
  show('ход 1 на Mac: конец', r);
  check('ход 1 закрыт', r.ok);
  check('index.lock снят', !existsSync(`${ROOT}/.git/index.lock`) && remote(`test -e ${REAL}/.git/index.lock && echo yes || echo no`) === 'no');
  check('правки Mac на Tru', remote(`cat ${REAL}/src/f1.ts; test -e ${REAL}/src/f2.ts && echo f2 || echo nof2; cat ${REAL}/src/mac-new.ts`).includes('"mac"') && remote(`test -e ${REAL}/src/f2.ts && echo f2 || echo nof2`) === 'nof2');
  check('коммит Mac виден на Tru', remote(`cd ${REAL} && GIT_OPTIONAL_LOCKS=0 git log -1 --format=%s`) === 'mac turn');
  check('git fsck на Tru', terminal(`cd ${REAL} && git fsck --strict >/dev/null 2>&1`).exitCode === 0);
  check('.env на Tru снова 0600', remote(`stat -c %a ${REAL}/.env`) === '600', remote(`stat -c %a ${REAL}/.env ${REAL}/.env.local | tr '\\n' ' '`));
  check('.env новый текст на Tru', remote(`cat ${REAL}/.env`) === 'SECRET=2');

  // 4. Ход на Tru и опоздавшая запись Mac (старый писатель).
  r = await sync.prepareTurn(T, { hostId: ANCHOR });
  show('ход 2 на Tru: подготовка', r);
  remote(`cd ${REAL} && echo 'export const v3 = "tru";' > src/f3.ts && rm src/f4.ts && echo 'tru' > src/tru-new.ts`);
  r = await sync.finishTurn(T, { hostId: ANCHOR });
  check('ход 2 на Tru закрыт', r.ok);
  writeFileSync(`${ROOT}/src/f3.ts`, 'late mac write\n');
  writeFileSync(`${ROOT}/src/late-new.ts`, 'late\n');
  rmSync(`${ROOT}/src/f5.ts`);

  // 5. Снова Mac: карантин и выравнивание по Tru.
  r = await sync.prepareTurn(T, { hostId: LOCAL });
  show('ход 3 на Mac: подготовка (выравнивание)', r);
  check('ход 3 подготовлен', r.ok);
  check('правка Tru выжила, опоздавшая запись Mac не победила', readFileSync(`${ROOT}/src/f3.ts`, 'utf8').includes('"tru"') && remote(`cat ${REAL}/src/f3.ts`).includes('"tru"'));
  check('удалённое на Tru не воскресло', !existsSync(`${ROOT}/src/f4.ts`) && remote(`test -e ${REAL}/src/f4.ts && echo y || echo n`) === 'n');
  check('нетронутый файл Tru восстановлен на Mac', existsSync(`${ROOT}/src/f5.ts`));
  check('лишний новый файл Mac не уехал', !existsSync(`${ROOT}/src/late-new.ts`) && remote(`test -e ${REAL}/src/late-new.ts && echo y || echo n`) === 'n');
  const qdir = r.notices.find(n => n.startsWith('Отложено'))?.split(' — ')[1];
  check('опоздавшие записи в карантине', Boolean(qdir && existsSync(join(qdir, 'src/f3.ts')) && readFileSync(join(qdir, '_deleted.txt'), 'utf8').includes('src/f5.ts')), qdir ?? 'нет строки');

  // 6. Конфликт: обрыв связи во время хода Mac, обе стороны пишут один файл → ход не передаётся.
  // (При живой W запись Mac уезжает раньше записи Tru и конфликта нет — тест А, 6a.)
  await runMutagen(['sync', 'pause', '--label-selector', 'bbc-role=w'], 60_000);
  writeFileSync(`${ROOT}/src/f6.ts`, 'mac side\n');
  remote(`echo 'tru side' > ${REAL}/src/f6.ts`);
  await runMutagen(['sync', 'resume', '--label-selector', 'bbc-role=w'], 60_000);
  r = await sync.finishTurn(T, { hostId: LOCAL });
  show('ход 3 на Mac: конец при конфликте', r);
  check('конфликт → отказ', !r.ok && r.reason === 'conflict' && r.conflicts.includes('src/f6.ts'), !r.ok ? r.conflicts.join(',') : '');
  r = await sync.prepareTurn(T, { hostId: ANCHOR });
  check('ход на Tru ждёт, пока конфликт не решён', !r.ok);
  // Разрешение: побеждает Mac — удаляем версию Tru (как в тесте А).
  remote(`rm ${REAL}/src/f6.ts`);
  r = await sync.finishTurn(T, { hostId: LOCAL });
  show('ход 3 на Mac: конец после разрешения', r);
  check('после разрешения ход закрыт', r.ok);
  check('версия Mac на Tru', remote(`cat ${REAL}/src/f6.ts`) === 'mac side');

  // 7. Тёплый режим: R работает между ходами.
  mode = 'warm';
  r = await sync.prepareTurn(T, { hostId: LOCAL });
  check('тёплый: ход подготовлен', r.ok);
  r = await sync.finishTurn(T, { hostId: LOCAL });
  check('тёплый: ход закрыт, R работает', r.ok && r.timings.some(t => t.step === 'warm' && t.ok));
  remote(`echo warm > ${REAL}/src/warm.ts`);
  await new Promise(res => setTimeout(res, 2500));
  await runMutagen(['sync', 'flush', '--label-selector', 'bbc-role=r'], 60_000);
  check('тёплый: правка Tru доехала до Mac без хода', existsSync(`${ROOT}/src/warm.ts`));
  r = await sync.prepareTurn(T, { hostId: LOCAL });
  show('тёплый: подготовка хода', r);
  r = await sync.finishTurn(T, { hostId: LOCAL });
  check('тёплый: второй ход закрыт', r.ok);

  // Итоговая сверка манифестов.
  const macManifest = sh(`cd ${ROOT} && find . -path ./node_modules -prune -o -type f -print | grep -v '^./.git/' | LC_ALL=C sort | xargs shasum -a 256 | awk '{print $1, $2}'`);
  const truManifest = remote(`cd ${REAL} && find . -path ./node_modules -prune -o -type f -print | grep -v '^./.git/' | LC_ALL=C sort | xargs sha256sum | awk '{print $1, $2}'`);
  check('манифесты Mac и Tru совпали (без .git)', macManifest === truManifest.replace(/\r/g, ''), `${macManifest.split('\n').length} файлов`);
}

function spawnOk(command: string): boolean {
  try { execFileSync('/bin/sh', ['-c', command], { stdio: 'ignore' }); return true; } catch { return false; }
}

async function cleanup() {
  if (KEEP) { say('--keep: уборка пропущена'); return; }
  const steps: string[] = [];
  const out = await runMutagen(['sync', 'terminate', '--label-selector', 'bbc-project=proj_cascade_sync_test'], 60_000);
  steps.push(`сессии: ${out.exitCode === 0 ? 'завершены' : out.stderr.trim()}`);
  try {
    remote(`if grep -q ' ${ROOT} ' /proc/self/mountinfo; then umount ${ROOT}; fi; rmdir ${ROOT} 2>/dev/null; rmdir ${SHARED} 2>/dev/null; rm -rf ${REMOTE_DIR} /root/.mutagen; echo done`);
    steps.push(`Tru: bind mount снят, ${ROOT}, ${SHARED} (пустая), ${REMOTE_DIR}, /root/.mutagen удалены`);
  } catch (error) { steps.push(`Tru: ошибка уборки ${String(error)}`); }
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(join(process.env.HOME ?? '', 'bbfs-quarantine', SLUG), { recursive: true, force: true });
  if (existsSync(join(process.env.HOME ?? '', 'bbfs-quarantine')) && !readdirSync(join(process.env.HOME ?? '', 'bbfs-quarantine')).length) rmSync(join(process.env.HOME ?? '', 'bbfs-quarantine'), { recursive: true });
  rmSync(dataDir, { recursive: true, force: true });
  steps.push(`Mac: ${ROOT}, карантин, временные данные удалены; ${SHARED} оставлена`);
  const left = await runMutagen(['sync', 'list'], 30_000);
  if (left.stdout.includes('No synchronization sessions found')) { await runMutagen(['daemon', 'stop'], 30_000); steps.push('демон Mutagen на Mac остановлен'); }
  say(`Уборка: ${steps.join('; ')}`);
}

try { await main(); } catch (error) { failures++; say(`✗ прогон прерван: ${error instanceof Error ? error.stack : String(error)}`); } finally { await cleanup(); }
say(failures ? `ИТОГ: ошибок ${failures}` : 'ИТОГ: всё прошло');
writeFileSync(join(tmpdir(), 'bbc-sync-integration.txt'), `${report.join('\n')}\n`);
chmodSync(join(tmpdir(), 'bbc-sync-integration.txt'), 0o644);
process.exit(failures ? 1 : 0);
