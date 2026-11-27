// Реальные шаги мастера «Настроить» для синхронизации (папка общего пути,
// Mutagen, проверка) на macOS и Linux/WSL. Каждый шаг — проверка, затем
// применение, если проверка не прошла: повторный запуск безопасен.
//
// Отличия от первого каркаса (по тестам А и А2):
// - Mutagen ставится из архива релиза с закреплённым SHA-256, без Homebrew:
//   на macOS 26 с устаревшими Command Line Tools brew отказывается ставить;
// - `mutagen-agents.tar.gz` кладётся рядом со ссылкой на бинарь (её Mutagen
//   ищет рядом со ссылкой, а не с файлом);
// - опоре сам Mutagen не обязателен (агент ставит исполнитель по SSH), но
//   ставится тоже: бинарь без демона, пригодится для диагностики;
// - на опоре Linux проект подключается bind mount при каждом ходе
//   (syncEnsureBindMount), fstab не меняется; проверяется право монтировать.
import type { Machine, WizardPlanStep } from '../contract.ts';

export const MUTAGEN_VERSION = '0.18.1';

/** SHA-256 архивов релиза v0.18.1 (файл SHA256SUMS релиза; darwin/arm64 совпал с тестом А). */
export const MUTAGEN_SHA256: Readonly<Record<string, string>> = Object.freeze({
  'darwin-arm64': '6f810416d9e5fc4fd5e18431146f8b3c5a2056ba5a24f76c1e66da86eb3257e2',
  'darwin-amd64': '7d06f7d8fcfe90bc7e55cc834a2f2f20c2e0af9ea9bc35911fc4341ad56a9bbf',
  'linux-amd64': '7735286c778cc438418209f24d03a64f3a0151c8065ef0fe079cfaf093af6f8f',
  'linux-arm64': 'bcba735aebf8cbc11da9b3742118a665599ac697fa06bc5751cac8dcd540db8a',
});

export function shQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

export function isSafeUnixPath(path: string): boolean {
  return /^\/[A-Za-z0-9_./-]*$/.test(path) && !path.split('/').includes('..');
}

/** Найти рабочий mutagen там же, где его ищет хост-операция (PATH, ~/.local/bin, /usr/local/bin, Homebrew). */
export const MUTAGEN_FIND = 'for b in "$(command -v mutagen 2>/dev/null)" "$HOME/.local/bin/mutagen" /usr/local/bin/mutagen /opt/homebrew/bin/mutagen; do [ -n "$b" ] && [ -x "$b" ] && "$b" version >/dev/null 2>&1 && { m="$b"; break; }; done';

export const mutagenCheck = `command -v mutagen >/dev/null 2>&1 && mutagen version || { ${MUTAGEN_FIND}; [ -n "$m" ] && "$m" version; }`;

/** Скрипт установки Mutagen из архива релиза с проверкой SHA-256. prefix — `$HOME/.local` или `/usr/local`. */
export function mutagenInstallScript(prefix: string): string {
  const cases = Object.entries(MUTAGEN_SHA256).map(([key, sha]) => {
    const [os, arch] = key.split('-');
    const uname = `${os === 'darwin' ? 'Darwin' : 'Linux'}-${arch === 'amd64' ? 'x86_64' : arch === 'arm64' && os === 'linux' ? 'aarch64|Linux-arm64' : 'arm64'}`;
    return `${uname}) f=mutagen_${os}_${arch}_v$v.tar.gz; s=${sha};;`;
  });
  return [
    'set -e',
    `v=${MUTAGEN_VERSION}`,
    `p=${prefix}`,
    `case "$(uname -s)-$(uname -m)" in ${cases.join(' ')} *) echo "Платформа $(uname -s)-$(uname -m) не поддерживается"; exit 1;; esac`,
    't=$(mktemp -d); trap \'rm -rf "$t"\' EXIT',
    'curl -fsSL -o "$t/$f" "https://github.com/mutagen-io/mutagen/releases/download/v$v/$f"',
    'if command -v sha256sum >/dev/null 2>&1; then h=$(sha256sum "$t/$f" | cut -d" " -f1); else h=$(shasum -a 256 "$t/$f" | cut -d" " -f1); fi',
    '[ "$h" = "$s" ] || { echo "SHA-256 архива не совпал: $h"; exit 1; }',
    'd="$p/opt/mutagen-$v"; mkdir -p "$d" "$p/bin"',
    'tar -xzf "$t/$f" -C "$d"',
    'ln -sf "$d/mutagen" "$p/bin/mutagen"',
    'ln -sf "$d/mutagen-agents.tar.gz" "$p/bin/mutagen-agents.tar.gz"',
    '"$p/bin/mutagen" version',
  ].join('\n');
}

const probeStep: WizardPlanStep = { id: 'probe', title: 'Определить машину', check: null, apply: null, privilege: 'none', note: 'Платформа, пользователь, путь и Mutagen — через хост-RPC плагина, только чтение.' };

/**
 * План шагов для macOS, Linux и WSL. null — платформа не наша (Windows и
 * неизвестная остаются за планом мастера).
 */
export function setupPlan(machine: Pick<Machine, 'sharedPath' | 'anchor'>, probe: { platform: string; isRoot: boolean }): WizardPlanStep[] | null {
  const path = machine.sharedPath;
  if (probe.platform !== 'macos' && probe.platform !== 'linux' && probe.platform !== 'wsl') return null;
  if (!isSafeUnixPath(path)) {
    return [probeStep, { id: 'folder', title: `Создать ${path}`, check: null, apply: null, privilege: 'manual', note: 'Путь с особыми символами: создайте папку вручную или выберите путь из букв, цифр, «/», «.», «-», «_».' }];
  }
  const p = shQuote(path);
  const folderCheck = `test -d ${p} -a -w ${p}`;
  const steps: WizardPlanStep[] = [probeStep];

  if (probe.platform === 'macos') {
    steps.push({
      id: 'folder', title: `Создать ${path}`, check: folderCheck,
      // Системное окно пароля macOS: пароль не проходит через BB. $u раскрывает внешняя оболочка — владелец папки пользователь.
      apply: `u="$(id -un)"; osascript -e "do shell script \\"mkdir -p '${path}' && chown $u '${path}'\\" with administrator privileges"`,
      privilege: 'macos-dialog', note: 'macOS покажет системное окно с паролем администратора (или Touch ID).',
    });
  } else {
    steps.push({
      id: 'folder', title: `Создать ${path}`, check: folderCheck,
      apply: probe.isRoot ? `mkdir -p ${p}` : `sudo -n mkdir -p ${p} && sudo -n chown "$(id -un)" ${p}`,
      privilege: probe.isRoot ? 'root' : 'manual',
      note: probe.isRoot ? 'Под root, без запроса.' : `Не root: нужен sudo без пароля, иначе выполните вручную: sudo mkdir -p ${path} && sudo chown "$(id -un)" ${path}`,
    });
  }

  const prefix = probe.platform !== 'macos' && probe.isRoot ? '/usr/local' : '"$HOME/.local"';
  steps.push({
    id: 'mutagen', title: `Установить Mutagen ${MUTAGEN_VERSION}`, check: mutagenCheck, apply: mutagenInstallScript(prefix), privilege: 'none',
    note: `Архив релиза GitHub с проверкой SHA-256 в ${prefix === '/usr/local' ? '/usr/local' : '~/.local'}; Homebrew не нужен.${machine.anchor ? ' На опоре — только бинарь, демон не запускается.' : ''}`,
  });
  if (machine.anchor) {
    steps.push(probe.platform === 'macos'
      ? { id: 'verify', title: 'Проверить путь', check: `test -w ${p}`, apply: null, privilege: 'none', note: 'Опора macOS: bind mount нет, проекты должны лежать прямо в общем пути.' }
      : { id: 'verify', title: 'Проверить путь и bind mount', check: `test -w ${p} && command -v mount >/dev/null && test "$(id -u)" -eq 0`, apply: null, privilege: probe.isRoot ? 'none' : 'manual', note: 'Проект подключается в общий путь bind mount перед ходом — нужен root. fstab не меняется.' });
    return steps;
  }
  steps.push({
    id: 'verify', title: 'Проверить путь и Mutagen', check: `test -w ${p} && { ${MUTAGEN_FIND}; [ -n "$m" ] && { "$m" daemon start >/dev/null 2>&1 || true; } && "$m" version; }`, apply: null, privilege: 'none',
    note: 'Плюс пробная запись файла через bb file. SSH до опоры проверяется при первой сессии проекта.',
  });
  return steps;
}
