// Квота Codex через сам Codex на машине (0.4.0). `system.usageLimits` BB читает квоту
// напрямую из сети машины; на части машин (российский IP) ответ — HTTP 403, хотя сам
// Codex ходит своим маршрутом и квоту знает. app-server отдаёт её запросом
// `account/rateLimits/read` — без модельного запроса и без трат лимита.
import { spawn } from 'node:child_process';
import { resolveRealExecutable } from './local.ts';

type Json = Record<string, unknown>;
const rec = (v: unknown): Json => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Json : {};
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Ответ `account/rateLimits/read` → форма `system.usageLimits().codex` (её разбирает адаптер). */
export function codexRateLimitsToUsage(result: unknown): Json | null {
  const limits = rec(rec(result).rateLimits);
  const windows: Json[] = [];
  for (const slot of ['primary', 'secondary'] as const) {
    const w = rec(limits[slot]);
    const used = num(w.usedPercent);
    if (used === null) continue;
    const minutes = num(w.windowDurationMins);
    const resets = num(w.resetsAt);
    const kind = minutes === 300 ? 'five-hour' : minutes === 10_080 ? 'weekly' : 'other';
    windows.push({
      label: kind === 'five-hour' ? '5h limit' : kind === 'weekly' ? 'Weekly limit' : `${minutes ?? '?'} min limit`,
      kind, usedPercent: used, resetsAt: resets === null ? null : new Date(resets * 1000).toISOString(),
    });
  }
  if (windows.length === 0) return null;
  const plan = typeof limits.planType === 'string' ? limits.planType : null;
  return { status: 'ok', windows, ...(plan ? { planLabel: plan } : {}), source: 'codex-app-server' };
}

/** Запустить `codex app-server`, спросить квоту, закрыть. Ошибка — `{ usage: null, error }`. */
export function readCodexRateLimits(env: NodeJS.ProcessEnv = process.env, timeoutMs = 20_000): Promise<{ usage: Json | null; error: string | null }> {
  const command = resolveRealExecutable('codex', env);
  if (!command) return Promise.resolve({ usage: null, error: 'codex не найден на машине' });
  return new Promise(resolve => {
    let done = false;
    let buffer = '';
    const child = spawn(command, ['app-server'], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    const finish = (out: { usage: Json | null; error: string | null }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* уже вышел */ }
      resolve(out);
    };
    const timer = setTimeout(() => finish({ usage: null, error: 'codex app-server не ответил вовремя' }), timeoutMs);
    child.on('error', error => finish({ usage: null, error: String(error).slice(0, 160) }));
    child.on('exit', code => finish({ usage: null, error: `codex app-server завершился (код ${code})` }));
    child.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf('\n');
        let msg: Json;
        try { msg = JSON.parse(line) as Json; } catch { continue; }
        if (msg.id === 1) {
          child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`);
          child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read', params: {} })}\n`);
        } else if (msg.id === 2) {
          if (msg.error) finish({ usage: null, error: String(rec(msg.error).message ?? 'ошибка app-server').slice(0, 160) });
          else {
            const usage = codexRateLimitsToUsage(msg.result);
            finish(usage ? { usage, error: null } : { usage: null, error: 'app-server не вернул окон квоты' });
          }
        }
      }
    });
    child.stdin!.on('error', () => undefined);
    child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'subscriptions-cascade-quota', version: '0' } } })}\n`);
  });
}
