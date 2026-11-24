/** Native app link to this client's small Finder handler. No SSH data in URLs. */
export function folderClientMode(client: { userAgent: string; platform: string; maxTouchPoints: number; compactTouch: boolean }, finderHelper: boolean): 'files' | 'finder' | 'native' {
  const mobile = client.compactTouch || /iPhone|iPad|iPod|Android/i.test(client.userAgent) || (client.platform === 'MacIntel' && client.maxTouchPoints > 1);
  if (mobile) return 'files';
  if (finderHelper && /Macintosh|MacIntel|Mac OS X/.test(client.userAgent + ' ' + client.platform)) return 'finder';
  return 'native';
}

/** `select`: the path is a file to select in its folder; only handlers from 0.3.0 accept that. */
export function finderFolderUrl(hostId: string, path: string, request: string = crypto.randomUUID(), select = false): string {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(hostId) || !/^[A-Za-z0-9-]{1,80}$/.test(request)) throw new Error('Некорректный идентификатор папки.');
  if (!path.startsWith('/') || /[\x00-\x1f\x7f]/.test(path) || path.split('/').some(segment => segment === '..')) {
    throw new Error('Для Finder требуется абсолютный путь папки.');
  }
  const url = new URL('bb-project-folder://open');
  url.search = new URLSearchParams({ host: hostId, path, request, ...(select ? { select: '1' } : {}) }).toString();
  return url.href;
}
