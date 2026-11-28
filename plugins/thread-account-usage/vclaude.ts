import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { vclaudeUsageSchema, type ConversionRate, type VClaudeUsage } from './vclaude-contract.ts';
import { cabinetEmail } from './vclaude-accounts.ts';

export const origin = 'https://vclaude.ru';
const quotaPath = '/api/cabinet/tariff/usage';
const readInterval = 2 * 60_000;
const loginInterval = 15 * 60_000;
const renewBefore = 24 * 60 * 60_000;
const count = z.number().finite().nonnegative();
const tokenCounts = z.object({
  input_tokens: count, output_tokens: count, cache_read_tokens: count, cache_write_tokens: count,
});
const priceSchema = z.object({ state: z.string(), limit_units: count, used_units: count, price_minor: count });
const queueSchema = priceSchema.extend({
  name: z.string().default('Пакет'), valid_until: z.string().nullish(), started_at: z.string().nullish(),
  queue_position: z.number().nullish(), period_days: z.number().positive().nullish(),
});
const DAY = 86_400_000;
const time = (v: string | null | undefined) => v && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
/**
 * VClaude runs packages one after another: a waiting one starts when the running one
 * runs out of limit or term, and its term (period_days) counts from that start. The
 * cabinet's limit_units/remaining_units already include the queue, nearest_expiry is
 * only the running package's end. Waiting ends are the latest possible.
 */
export function vclaudeQueue(packages: unknown[]) {
  const parsed = packages.flatMap(value => { const p = queueSchema.safeParse(value); return p.success ? [p.data] : []; });
  const running = parsed.filter(p => p.state === 'active' && p.limit_units > 0);
  const waiting = parsed.filter(p => p.state === 'waiting' && p.limit_units > 0)
    .sort((a, b) => (a.queue_position ?? Infinity) - (b.queue_position ?? Infinity));
  let previousEnd = Math.max(0, ...running.map(p => time(p.valid_until) ?? 0)) || null;
  const queue = [...running, ...waiting].map(p => {
    const own = time(p.valid_until);
    const start = time(p.started_at) ?? (p.state === 'waiting' ? previousEnd : null);
    const end = own ?? (start !== null && p.period_days ? start + p.period_days * DAY : null);
    if (p.state === 'waiting') previousEnd = end;
    return { name: p.name, state: p.state, limitUnits: p.limit_units, usedUnits: p.used_units, priceRub: p.price_minor / 100,
      startsAt: start !== null ? new Date(start).toISOString() : null, endsAt: end !== null ? new Date(end).toISOString() : null,
      estimated: own === null };
  });
  const ends = queue.map(p => time(p.endsAt));
  const startedAt = running.map(p => time(p.started_at)).filter((t): t is number => t !== null);
  return { queue, endsAt: ends.length && ends.every(t => t !== null) ? new Date(Math.max(...ends as number[])).toISOString() : null,
    startedAt: startedAt.length ? new Date(Math.min(...startedAt)).toISOString() : null };
}
const coefficientSchema = z.object({
  input: count, output: count, cache_read: count, cache_write_5m: count, cache_write_1h: count,
});

export function parseVClaudeUsage(input: unknown, fetchedAt: string): VClaudeUsage {
  const raw = z.object({
    limit_units: count, remaining_units: count, nearest_expiry: z.string().nullish(),
    window_days: z.number().int().positive().optional(),
    models: z.array(z.object({
      model: z.string(), name: z.string().optional(), units: count, requests: count,
      token_usage_known: z.boolean().optional(), token_usage_estimated: z.boolean().optional(),
    }).passthrough()).default([]),
    packages: z.array(z.unknown()).default([]),
    coefficients: z.array(z.unknown()).default([]),
  }).parse(input);
  // Paid and queued packages: the price of a waiting one is already paid.
  const active = raw.packages.flatMap(value => {
    const parsed = priceSchema.safeParse(value);
    return parsed.success && (parsed.data.state === 'active' || parsed.data.state === 'waiting') && parsed.data.limit_units > 0 ? [parsed.data] : [];
  });
  const chain = vclaudeQueue(raw.packages);
  const nearest = raw.nearest_expiry && Number.isFinite(Date.parse(raw.nearest_expiry)) ? raw.nearest_expiry : null;
  const rates = new Map<string, ConversionRate>();
  for (const value of raw.coefficients) {
    const parsed = z.object({ model: z.string(), values: coefficientSchema }).safeParse(value);
    if (!parsed.success) continue;
    const { model, values } = parsed.data;
    rates.set(model, {
      input: values.input, output: values.output, cacheRead: values.cache_read,
      cacheWrite5m: values.cache_write_5m, cacheWrite1h: values.cache_write_1h,
    });
  }
  return vclaudeUsageSchema.parse({
    fetchedAt, limitUnits: raw.limit_units, remainingUnits: raw.remaining_units,
    // Without a readable queue: the running package's end, as before.
    endsAt: chain.endsAt ?? nearest, nearestExpiry: nearest, startedAt: chain.startedAt, queue: chain.queue,
    paidRub: active.length ? active.reduce((sum, pack) => sum + pack.price_minor, 0) / 100 : null,
    usedRub: active.length ? active.reduce((sum, pack) =>
      sum + pack.price_minor * Math.min(pack.used_units / pack.limit_units, 1), 0) / 100 : null,
    days: raw.window_days ?? null,
    conversionRates: Object.fromEntries(rates),
    models: raw.models.map(model => {
      const measured = tokenCounts.safeParse(model);
      const tokens = measured.success && (model.token_usage_known || model.token_usage_estimated) ? measured.data : null;
      return {
        id: model.model, name: model.name ?? model.model, units: model.units, requests: model.requests,
        tokens: tokens ? {
          input: tokens.input_tokens, output: tokens.output_tokens, cacheRead: tokens.cache_read_tokens,
          cacheWrite: tokens.cache_write_tokens, estimated: model.token_usage_estimated === true,
        } : null,
        rates: rates.get(model.model) ?? null,
      };
    }),
  });
}

const sessionSchema = z.object({ cookie: z.string().min(1), expiresAt: z.string().optional() });
const loginSchema = z.object({ email: z.email(), password: z.string().min(1) });
type Session = z.infer<typeof sessionSchema>;
// email — почта аккаунта кабинета (ответ кабинета или login.json), только в памяти.
type Result = { usage: VClaudeUsage | null; error: string | null; email: string | null };

async function privateJson(path: string): Promise<unknown> {
  const info = await lstat(path);
  if (!info.isFile() || (info.mode & 0o077) !== 0) throw new Error('VClaude: права на файл сессии или входа должны быть 0600.');
  return JSON.parse(await readFile(path, 'utf8'));
}

async function saveSession(file: string, session: Session) {
  const temporary = file + '.' + randomUUID();
  try {
    await writeFile(temporary, JSON.stringify(session), { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

export function createVClaudeReader(directory = join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'bb-vclaude'),
  send: typeof fetch = fetch, now = Date.now) {
  const sessionFile = join(directory, 'session.json');
  const loginFile = join(directory, 'login.json');
  let lastLogin: number | null = null;
  let email: string | null = null;
  let cached: { at: number; result: Result } | null = null;
  let pending: Promise<Result> | null = null;

  function request(path: string, init?: RequestInit) {
    return send(origin + path, { redirect: 'error', signal: AbortSignal.timeout(7_000), ...init });
  }

  async function sessionExpiry(cookie: string) {
    const response = await request('/api/auth/session', { headers: { Cookie: cookie, Accept: 'application/json' } });
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    email = cabinetEmail(body) ?? email;
    const parsed = z.object({ expires_at: z.string() }).safeParse(body);
    return parsed.success && Number.isFinite(Date.parse(parsed.data.expires_at)) ? parsed.data.expires_at : undefined;
  }

  async function renew(): Promise<Session> {
    if (lastLogin !== null && now() - lastLogin < loginInterval)
      throw new Error('VClaude: повторный вход временно отложен.');
    const credentials = loginSchema.parse(await privateJson(loginFile).catch(error => {
      if (error?.code === 'ENOENT') throw new Error('VClaude: нужен повторный вход в кабинет.');
      throw error;
    }));
    lastLogin = now();
    email = credentials.email;
    const response = await request('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', Origin: origin, Referer: origin + '/login' },
      body: JSON.stringify(credentials),
    });
    const cookie = response.headers.getSetCookie().map(value => value.split(';', 1)[0])
      .filter(value => /=.+/.test(value)).join('; ');
    if (!response.ok || !cookie) throw new Error('VClaude: не удалось обновить сессию кабинета.');
    const expiresAt = await sessionExpiry(cookie);
    if (!expiresAt) throw new Error('VClaude: кабинет не подтвердил новую сессию.');
    const session = { cookie, expiresAt };
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await saveSession(sessionFile, session);
    return session;
  }

  // Почта входа кабинета: только поле email, пароль не сохраняется. Нет файла — null.
  async function loginEmail(): Promise<string | null> {
    const parsed = z.object({ email: z.email() }).safeParse(await privateJson(loginFile).catch(() => null));
    return parsed.success ? parsed.data.email : null;
  }

  async function read(): Promise<Result> {
    try {
      let session: Session;
      try { session = sessionSchema.parse(await privateJson(sessionFile)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
        try { await lstat(loginFile); } catch (loginError) {
          if ((loginError as NodeJS.ErrnoException)?.code === 'ENOENT') return { usage: null, error: null, email: null };
          throw loginError;
        }
        session = await renew();
      }
      if (!session.expiresAt) {
        const expiresAt = await sessionExpiry(session.cookie);
        if (expiresAt) {
          session = { ...session, expiresAt };
          await saveSession(sessionFile, session);
        }
      }
      const expires = session.expiresAt ? Date.parse(session.expiresAt) : NaN;
      if (expires - now() <= renewBefore) {
        try { session = await renew(); }
        catch (error) { if (expires <= now()) throw error; }
      }
      const quota = (cookie: string) => request(quotaPath, { headers: { Cookie: cookie, Accept: 'application/json' } });
      let response = await quota(session.cookie);
      if (response.status === 401) {
        session = await renew();
        response = await quota(session.cookie);
      }
      if (!response.ok) throw new Error(`VClaude: кабинет вернул HTTP ${response.status}.`);
      const body: unknown = await response.json();
      const usage = parseVClaudeUsage(body, new Date(now()).toISOString());
      email = cabinetEmail(body) ?? email ?? await loginEmail();
      return { usage, error: null, email };
    } catch (error) {
      const message = error instanceof Error && error.message.startsWith('VClaude:')
        ? error.message : 'VClaude: данные кабинета временно недоступны.';
      return { usage: cached?.result.usage ?? null, error: message, email: email ?? cached?.result.email ?? null };
    }
  }

  return async (refresh = false): Promise<Result> => {
    if (pending) return pending;
    if (cached && now() - cached.at < (refresh ? 5_000 : readInterval)) return cached.result;
    pending = read().then(result => {
      cached = { at: now(), result };
      return result;
    });
    try { return await pending; } finally { pending = null; }
  };
}
