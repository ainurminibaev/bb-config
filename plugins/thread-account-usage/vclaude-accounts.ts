// Аккаунты VClaude по машинам (0.3.2). Кабинет VClaude читается на сервере BB одной
// сессией, а машины ходят в шлюз своими ключами. Аккаунт машины — короткий хеш её
// ключа: ключ не покидает машину и нигде не хранится. Машины с одним ключом — одна
// строка; кабинет сервера относится к одной из групп (подпись — почта кабинета).
import { createHash } from 'node:crypto';

/** Маршрут Claude Code машины, как его помнит сервер. keyId нет у старых сборок хоста. */
export type VClaudeRoute = { name: string; baseHost: string | null; keyId?: string | null };
export type VClaudeGroup = {
  /** Хеш ключа (8 hex); null — ключ машины неизвестен. */
  id: string | null;
  /** Ключ строки: 'vclaude' у группы кабинета (история и ссылки как раньше), иначе `vclaude:<id>`. */
  key: string;
  label: string;
  /** Квота кабинета сервера относится к этой группе. */
  cabinet: boolean;
  hostIds: string[];
  hostNames: string[];
};

const keyNames = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'] as const;
const text = (v: unknown) => typeof v === 'string' && v.trim() ? v.trim() : null;

/**
 * Стабильный ID аккаунта VClaude машины: sha256 ключа, первые 8 hex. Ключ берётся
 * оттуда же, откуда адрес шлюза: env из settings.json, иначе окружение процесса.
 * Наружу уходит только хеш.
 */
export function vclaudeKeyId(settings: unknown, env: Readonly<Record<string, string | undefined>> = {}): string | null {
  const raw = settings && typeof settings === 'object' ? (settings as { env?: unknown }).env : undefined;
  const fromSettings = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const key = keyNames.map(name => text(fromSettings[name])).find(Boolean)
    ?? keyNames.map(name => text(env[name])).find(Boolean);
  return key ? createHash('sha256').update(key).digest('hex').slice(0, 8) : null;
}

/** Настройка `vclaudeLabels`: JSON `{"<id>": "<метка>"}`. Ошибки и чужие поля — пропускаются. */
export function parseVClaudeLabels(value: string | null | undefined): Record<string, string> {
  if (!value?.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>)
      .flatMap(([id, label]) => {
        const name = text(label);
        return /^[0-9a-f]{8}$/i.test(id.trim()) && name && name.length <= 120 ? [[id.trim().toLowerCase(), name]] : [];
      }));
  } catch { return {}; }
}
export const validVClaudeLabels = (value: string) => {
  if (!value.trim()) return true;
  try { const v: unknown = JSON.parse(value); return !!v && typeof v === 'object' && !Array.isArray(v); } catch { return false; }
};

/**
 * Группы машин, чей Claude Code идёт в шлюз `targetHost`, по аккаунту (хешу ключа).
 * Группа кабинета: та, чья ручная метка равна почте кабинета; иначе единственный ключ;
 * иначе (несколько ключей без сопоставления) — отдельная строка кабинета без машин.
 * Машины без известного ключа (старый хост, ключ не найден) — в строке кабинета, как раньше.
 * `withCabinet` — кабинет на сервере подключён (иначе строки нет, как до 0.3.2).
 */
export function vclaudeGroups(routes: ReadonlyMap<string, VClaudeRoute>, targetHost: string,
  hosts: readonly { id: string; name: string }[] | undefined, options: {
    cabinetEmail?: string | null; labels?: Readonly<Record<string, string>>; withCabinet?: boolean;
  } = {}): VClaudeGroup[] {
  const labels = options.labels ?? {};
  const list = hosts ?? [...routes].map(([id, r]) => ({ id, name: r.name }));
  const routed = list.flatMap(h => {
    const route = routes.get(h.id);
    if (route?.baseHost !== targetHost.toLowerCase()) return [];
    const keyId = route.keyId && /^[0-9a-f]{8}$/i.test(route.keyId) ? route.keyId.toLowerCase() : null;
    return [{ ...h, keyId }];
  });
  const keyed = [...new Set(routed.flatMap(h => h.keyId ? [h.keyId] : []))];
  const email = options.cabinetEmail?.trim().toLowerCase() || null;
  const matched = email ? keyed.find(id => labels[id]?.trim().toLowerCase() === email) : undefined;
  const cabinetId = matched ?? (keyed.length === 1 ? keyed[0] : null);
  const name = (id: string | null, cabinet: boolean) =>
    (id ? labels[id] : undefined) ?? (cabinet ? options.cabinetEmail?.trim() || null : null) ?? (id ? `VClaude · ${id}` : 'VClaude');
  const pick = (test: (keyId: string | null) => boolean) => {
    const hit = routed.filter(h => test(h.keyId));
    return { hostIds: hit.map(h => h.id), hostNames: hit.map(h => h.name) };
  };
  const groups: VClaudeGroup[] = [];
  if (options.withCabinet !== false) {
    groups.push({ id: cabinetId, key: 'vclaude', label: name(cabinetId, true), cabinet: true,
      ...pick(keyId => keyId === null || keyId === cabinetId) });
  }
  for (const id of keyed) {
    if (options.withCabinet !== false && id === cabinetId) continue;
    groups.push({ id, key: `vclaude:${id}`, label: name(id, false), cabinet: false, ...pick(keyId => keyId === id) });
  }
  return groups;
}

/** Аккаунт машины треда; машина не найдена в строках — строка кабинета. */
export function vclaudeAccountOf<T extends { key: string; hostIds: readonly string[] }>(accounts: readonly T[], hostId: string | null): T | null {
  return (hostId ? accounts.find(a => a.hostIds.includes(hostId)) : undefined) ?? accounts.find(a => a.key === 'vclaude') ?? null;
}

/**
 * Почта аккаунта из ответа кабинета, если он её сообщает. Поля не задокументированы,
 * поэтому смотрим терпимо: email, user.email, account.email, profile.email.
 */
export function cabinetEmail(value: unknown): string | null {
  const record = (v: unknown) => v && typeof v === 'object' ? v as Record<string, unknown> : {};
  const root = record(value);
  const found = [root.email, record(root.user).email, record(root.account).email, record(root.profile).email]
    .map(text).find(v => v !== null && v.length < 200 && /^[^\s@]+@[^\s@]+$/.test(v));
  return found ?? null;
}
