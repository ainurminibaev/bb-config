import { cascadeFolder, type CascadePassport } from './cascade-passport.ts';

/**
 * Откуда брать файл рабочей папки. Обычный тред — машина и папка окружения,
 * как раньше. Тред «Каскада подписок» с паспортом — машина со свежей копией
 * (иначе опорная) и общий путь каскада. Явно указанная машина всегда главнее.
 */
export function fileOrigin(input: { kind: string; explicitHostId?: string | null; envHostId: string | null; envPath: string | null; passport: CascadePassport | null }): { hostId: string | null; root: string | null } {
  const folder = input.kind === 'workspace' && !input.explicitHostId ? cascadeFolder(input.passport) : null;
  if (folder) return { hostId: folder.hostId, root: folder.path };
  return { hostId: input.explicitHostId ?? input.envHostId, root: input.envPath };
}
