import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { extname, join, sep } from 'node:path';
const types: Record<string, string> = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg',
  jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf',
  otf: 'font/otf', mp3: 'audio/mpeg', mp4: 'video/mp4', wav: 'audio/wav', m4a: 'audio/mp4', txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8', pdf: 'application/pdf', wasm: 'application/wasm',
};
/**
 * Serves copied pages to this computer's browser only: 127.0.0.1, a random secret first path segment,
 * files strictly inside `root`. http:// lets ES modules, fetch() and workers run, which file:// forbids.
 */
export class LocalPages {
  private server: Server | null = null;
  private base = '';
  private timer: NodeJS.Timeout | null = null;
  private lease: { dispose(): Promise<void> } | null = null;
  private readonly root: string;
  private readonly idleMs: number;
  private readonly retain: () => { dispose(): Promise<void> } | null;
  constructor(root: string, idleMs: number, retain: () => { dispose(): Promise<void> } | null) {
    this.root = root; this.idleMs = idleMs; this.retain = retain;
  }
  async url(file: string): Promise<string> {
    const root = await realpath(this.root), real = await realpath(file);
    if (!real.startsWith(root + sep)) throw new Error('Файл вне папки BB Files.');
    if (!this.server) await this.start(root);
    this.touch();
    return this.base + real.slice(root.length + 1).split(sep).map(encodeURIComponent).join('/');
  }
  private touch() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.stop(), this.idleMs);
    this.timer.unref?.();
  }
  private async start(root: string) {
    const secret = randomBytes(16).toString('hex');
    const server = createServer((req, res) => {
      this.touch();
      void (async () => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const parts = url.pathname.split('/').slice(1).map(p => decodeURIComponent(p));
        if (req.method !== 'GET' && req.method !== 'HEAD' || parts.shift() !== secret || parts.some(p => !p || p === '.' || p === '..' || p.includes('/') || p.includes('\\') || p.includes('\0'))) throw 404;
        const target = await realpath(join(root, ...parts));
        if (!target.startsWith(root + sep) || !(await stat(target)).isFile()) throw 404;
        res.writeHead(200, { 'content-type': types[extname(target).slice(1).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        if (req.method === 'HEAD') { res.end(); return; }
        createReadStream(target).pipe(res);
      })().catch(() => { if (!res.headersSent) res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Не найдено'); });
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Не удалось запустить локальный сервер страниц.');
    this.server = server; this.base = `http://127.0.0.1:${address.port}/${secret}/`;
    this.lease = this.retain();
  }
  async stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const server = this.server; this.server = null;
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    const lease = this.lease; this.lease = null;
    await lease?.dispose().catch(() => undefined);
  }
}
