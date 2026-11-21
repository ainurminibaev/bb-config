/** Pure release selection and the agent prompt; no I/O. */

export interface Release { tag: string; title: string; notes: string; url: string; publishedAt: string }
export interface Remaining { step: string; machine: string }
export interface LocalStatus {
  installed: { release: string; commit: string | null; appliedFrom?: string; at?: string; how?: string } | null;
  partial: { release: string; remaining: Remaining[] } | null;
  run: { release: string; owner: string; startedAt: string } | null;
  dependencyIssues?: string[];
  lastRun?: { owner: string; release: string; complete: boolean; at: string } | null;
}

const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const NOTES_LIMIT = 4000;

export function parseTag(tag: string): [number, number, number] | null {
  const match = TAG.exec(tag);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function compareTags(a: string, b: string): number {
  const [x, y] = [parseTag(a)!, parseTag(b)!];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/**
 * Published stable releases, oldest first. Drafts, prereleases and tags that
 * are not plain vX.Y.Z are not an update signal. A malformed answer throws:
 * it is a failed check, never "no updates".
 */
export function stableReleases(raw: unknown): Release[] {
  if (!Array.isArray(raw)) throw new Error("GitHub вернул неожиданный ответ вместо списка релизов.");
  const releases: Release[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") throw new Error("GitHub вернул неожиданный ответ вместо списка релизов.");
    const { tag_name: tag, draft, prerelease, name, body, html_url: url, published_at: publishedAt } = item as Record<string, unknown>;
    if (typeof tag !== "string" || typeof draft !== "boolean" || typeof prerelease !== "boolean") {
      throw new Error("GitHub вернул неожиданный ответ вместо списка релизов.");
    }
    if (draft || prerelease || !parseTag(tag) || typeof publishedAt !== "string") continue;
    releases.push({
      tag, publishedAt,
      // "v1.2.0 — Title" would repeat the version next to the tag.
      title: (typeof name === "string" ? name.trim() : "").replace(new RegExp(`^${tag.replace(/\./g, "\\.")}\\s*[—–:-]*\\s*`), "") || tag,
      notes: typeof body === "string" ? body.slice(0, NOTES_LIMIT) : "",
      url: typeof url === "string" && url.startsWith("https://") ? url : "",
    });
  }
  return releases.sort((a, b) => compareTags(a.tag, b.tag));
}

export function newerThan(releases: Release[], installed: string | null): Release[] {
  return installed && parseTag(installed) ? releases.filter((r) => compareTags(r.tag, installed) > 0) : releases;
}

/** `owner/repo` of a GitHub remote URL, or null for anything else. */
export function parseRepository(remote: string): string | null {
  const match = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(remote.trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

export function buildPrompt(args: {
  repository: string; root: string; target: Release; commit: string; pending: Release[]; local: LocalStatus;
}): string {
  const { repository, root, target, commit, pending, local } = args;
  const apply = `python3 scripts/updates.py apply ${target.tag} --commit ${commit} --repository ${repository} --machines <id,id,...>`;
  return [
    `Примени обновление доработок BB из репозитория ${repository}.`,
    "",
    `Закреплённый релиз: ${target.tag}, коммит ${commit}.`,
    "Источник — только этот коммит. Не используй main, другие ветки или теги вместо него.",
    `Папка скрипта обновления на сервере BB: ${root}`,
    `Установленная версия по журналу: ${local.installed?.release ?? "не определена (каждый шаг сначала проверяется по фактическому состоянию)"}.`,
    `Релизы к применению по порядку: ${pending.map((r) => r.tag).join(", ")}.`,
    ...(local.run?.owner === "plugin-config-updates" ? ["Обновление, начатое кнопкой, не завершилось и держит запуск в журнале: добавь к команде `--takeover`, чтобы продолжить его."] : []),
    ...(local.partial ? [`Прошлый запуск ${local.partial.release} остался частичным: не завершено шагов — ${local.partial.remaining.length}. Продолжи остаток.`] : []),
    "",
    "Порядок:",
    `1. Получи машины через \`bb machine list --json\`. Из папки скрипта выполни одно действие: \`${apply}\`. Команда скачает закреплённый релиз, сведёт установку к его полному набору (недостающие компоненты ставит, устаревшие обновляет, исключённые и отключённые пользователем сохраняет), проверит шаги всех пропущенных релизов и запишет журнал. Повтор безопасен и доделывает остаток после сбоя. Рабочая ветка и локальные правки остаются нетронутыми.`,
    "2. Разбери JSON-ответ. Код 0 — всё применено; 2 — остался остаток (`remaining`); 3 — нужно решение пользователя или подтверждение. Ошибку шага разбери по `docs/updates.md` и `docs/releases/<версия>.md` из каталога релиза (`.local/updates/releases/<коммит>`), исправь причину и повтори ту же команду.",
    "3. Шаги на других машинах (`otherMachines`) и шаги без автоматической проверки выполняй по инструкции релиза и фиксируй через `record` с тем, что именно проверено (порядок — `docs/updates.md`).",
    "4. Затем `bb config-updates check`.",
    "",
    "Не применяй снимок настроек автора (`scripts/restore.py`) и не меняй личные настройки, аккаунты и маршруты пользователя. Компонент, от которого пользователь отказывается, исключи командой `python3 scripts/bundle.py exclude <id>` до повтора. Не делай commit и push.",
    "В конце сообщи по компонентам и машинам: что уже было, что установлено или обновлено сейчас, что осталось и почему. Отдельно и явно перечисли пункты `attention`: личные входы (авторизация), настройки и действия на других машинах — сам их не выполняй без пользователя.",
  ].join("\n");
}
