// SSH от машины-исполнителя до опоры одной кнопкой (шаг мастера «ssh»).
//
// 1. Проверка: `ssh -o BatchMode=yes <алиас> true` на исполнителе.
// 2. Нет доступа: на исполнителе создаётся свой ключ каскада
//    `~/.ssh/bb_cascade_ed25519` (ed25519, без пароля) — безвредно, без согласия.
// 3. Открытая часть добавляется в `authorized_keys` пользователя опоры через
//    терминал BB на опоре — ТОЛЬКО после явного согласия владельца в мастере
//    («Разрешить машине X входить на Y по ключу …»). Без дублей; у строки
//    комментарий `bb-cascade:<hostId исполнителя>` — по нему ключ снимается.
// 4. На исполнителе в `~/.ssh/config` пишется блок `Host bb-<опора>` между
//    метками каскада (HostName — адрес опоры, IdentitiesOnly, ServerAliveInterval).
// 5. Проверка входа `ssh -o BatchMode=yes`. Алиас становится «SSH к опоре» машины.
// Снятие (машина выключена, «Настроить с нуля»): строка ключа на опоре и блок
// в ~/.ssh/config исполнителя удаляются; сам ключ на исполнителе тоже.
// Все функции — построители команд и разбор вывода; исполняет мастер.
import { shQuote } from './setup.ts';

export const CASCADE_KEY = '$HOME/.ssh/bb_cascade_ed25519';
export const keyComment = (hostId: string) => `bb-cascade:${hostId}`;
const BEGIN = (alias: string) => `# >>> bb-cascade ${alias} (создано «Каскадом подписок», не править)`;
const END = (alias: string) => `# <<< bb-cascade ${alias}`;

/** Алиас опоры для ~/.ssh/config исполнителя: `bb-<имя опоры>`. */
export function anchorAlias(anchorLabel: string): string {
  const slug = anchorLabel.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '');
  return `bb-${slug || 'anchor'}`;
}

/** Адрес и пользователь опоры: только простые символы (подставляются в ~/.ssh/config). */
export function isSafeSshHost(text: string): boolean {
  return /^[A-Za-z0-9_.:-]+$/u.test(text) && text.length <= 253;
}

/** Проверка входа без пароля и без вопросов. */
export function sshCheckCommand(target: string): string {
  return `ssh -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new ${shQuote(target)} true && echo ssh-ok`;
}

/** Создать ключ каскада на исполнителе (если нет) и напечатать открытую часть и отпечаток. */
export function ensureKeyCommand(hostId: string): string {
  return [
    'set -e', 'umask 077', 'mkdir -p "$HOME/.ssh"',
    `[ -f "${CASCADE_KEY}" ] || ssh-keygen -q -t ed25519 -N '' -C ${shQuote(keyComment(hostId))} -f "${CASCADE_KEY}"`,
    `echo "pub: $(cat "${CASCADE_KEY}.pub")"`,
    `echo "fp: $(ssh-keygen -lf "${CASCADE_KEY}.pub" | cut -d' ' -f2)"`,
  ].join('\n');
}

export interface KeyInfo { publicKey: string; fingerprint: string }

/** Разбор вывода ensureKeyCommand. */
export function parseKeyOutput(output: string): KeyInfo | null {
  const pub = /pub: (ssh-ed25519 [A-Za-z0-9+/=]+(?: \S+)?)/u.exec(output)?.[1];
  const fp = /fp: (SHA256:[A-Za-z0-9+/=]+)/u.exec(output)?.[1];
  return pub && fp ? { publicKey: pub, fingerprint: fp } : null;
}

/** Добавить ключ в authorized_keys пользователя опоры — без дублей (по телу ключа). */
export function authorizeCommand(key: KeyInfo, hostId: string): string {
  const body = key.publicKey.split(' ').slice(0, 2).join(' ');
  if (!/^ssh-ed25519 [A-Za-z0-9+/=]+$/u.test(body)) throw new Error('неожиданная форма ключа');
  const line = `${body} ${keyComment(hostId)}`;
  return [
    'set -e', 'umask 077', 'mkdir -p "$HOME/.ssh"', 'touch "$HOME/.ssh/authorized_keys"',
    `grep -qF ${shQuote(body)} "$HOME/.ssh/authorized_keys" || echo ${shQuote(line)} >> "$HOME/.ssh/authorized_keys"`,
    'chmod 600 "$HOME/.ssh/authorized_keys"', 'echo authorized',
  ].join('\n');
}

/** Снять ключи каскада исполнителя с опоры (по комментарию). */
export function revokeCommand(hostId: string): string {
  const tag = keyComment(hostId);
  return [
    'f="$HOME/.ssh/authorized_keys"', '[ -f "$f" ] || { echo revoked; exit 0; }',
    `grep -vF ${shQuote(` ${tag}`)} "$f" > "$f.bbc" || true`, 'cat "$f.bbc" > "$f" && rm -f "$f.bbc"', 'echo revoked',
  ].join('\n');
}

/** Блок ~/.ssh/config исполнителя. */
export function configBlock(alias: string, host: string, user: string | null): string {
  if (!isSafeSshHost(host) || (user !== null && !/^[a-z_][a-z0-9_.-]*$/iu.test(user))) throw new Error('адрес или пользователь опоры с особыми символами');
  return [
    BEGIN(alias), `Host ${alias}`, `  HostName ${host}`, ...(user ? [`  User ${user}`] : []),
    `  IdentityFile ~/.ssh/bb_cascade_ed25519`, '  IdentitiesOnly yes', '  ServerAliveInterval 30', '  ServerAliveCountMax 4', END(alias),
  ].join('\n');
}

/** Заменить (или добавить) блок алиаса в ~/.ssh/config исполнителя; прочие записи не трогаются. */
export function writeConfigCommand(alias: string, host: string, user: string | null): string {
  const block = configBlock(alias, host, user);
  return [
    'set -e', 'umask 077', 'mkdir -p "$HOME/.ssh"', 'c="$HOME/.ssh/config"', 'touch "$c"',
    `awk -v b=${shQuote(BEGIN(alias))} -v e=${shQuote(END(alias))} '$0==b{s=1;next} $0==e{s=0;next} !s' "$c" > "$c.bbc"`,
    `printf '%s\\n' ${shQuote(block)} >> "$c.bbc"`, 'cat "$c.bbc" > "$c" && rm -f "$c.bbc"', 'chmod 600 "$c"', 'echo configured',
  ].join('\n');
}

/** Убрать блок алиаса и ключ каскада с исполнителя. */
export function removeLocalCommand(alias: string): string {
  return [
    'c="$HOME/.ssh/config"',
    `[ -f "$c" ] && awk -v b=${shQuote(BEGIN(alias))} -v e=${shQuote(END(alias))} '$0==b{s=1;next} $0==e{s=0;next} !s' "$c" > "$c.bbc" && cat "$c.bbc" > "$c" && rm -f "$c.bbc"`,
    `rm -f "${CASCADE_KEY}" "${CASCADE_KEY}.pub"`, 'echo removed',
  ].join('\n');
}

/** Текст согласия: какой ключ, куда и зачем. */
export function consentText(executor: string, anchor: string, anchorUser: string | null, key: KeyInfo): string {
  return `Разрешить машине ${executor} входить на ${anchor} по ключу ${key.fingerprint} (ed25519, ~/.ssh/bb_cascade_ed25519 на ${executor})? Ключ будет добавлен в ~/.ssh/authorized_keys пользователя ${anchorUser ?? 'опоры'} на ${anchor} с пометкой «bb-cascade»; снимается при выключении машины или «Настроить с нуля».`;
}
