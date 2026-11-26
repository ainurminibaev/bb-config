// Antigravity quotas read on the machine where `agy` keeps its sign-in.
//
// Google Antigravity (provider acp-antigravity-acp): the same Cloud Code
// endpoints the official CLI polls itself (quota_manager → retrieveUserQuotaSummary,
// fetchAvailableModels, loadCodeAssist), with the access token the CLI stores.
// Read-only: the token is never refreshed here and agy is never started (a CLI
// run rewrites its keyring marker); an expired token waits for agy's own run.
//
// Antig (provider acp-gemini-antig): the gateway gate.antig.ru must only be
// reached by agy itself — pool accounts are banned for scripted calls. Nothing
// here talks to the gateway. Balance and usage come from the antig.ru cabinet
// (a separate site) with the owner's session cookie, renewed through the
// NextAuth session endpoint the cabinet page calls itself.
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createAgyTokenReader, type GroupTotals } from './agy-tokens.ts';

export type AgWindow = {
  label: string; kind: 'five-hour' | 'weekly' | 'model' | 'other'; usedPercent: number;
  resetsAt: string | null; endsAt?: string | null; scope?: string[];
};
export type AgAccount = {
  email: string | null; plan: string | null; status: 'ok' | 'stale' | 'unavailable';
  message: string | null; fetchedAt: string | null; windows: AgWindow[]; note: string | null;
  meter?: { total: number; left: number; tokensPerUnit: number | null } | null;
  // Cumulative tokens from agy's own conversation stores on this machine.
  tokens?: GroupTotals | null;
};
export type AntigravityResult = { google: AgAccount | null; antig: AgAccount | null };

const GOOGLE_API = 'https://daily-cloudcode-pa.googleapis.com/v1internal:';
const CABINET = 'https://antig.ru';
const readInterval = 3 * 60_000;
const cabinetInterval = 60_000;
const renewInterval = 6 * 60 * 60_000;
const clamp = (v: number) => Math.max(0, Math.min(100, v));
const text = (v: unknown, max = 200) => typeof v === 'string' && v.length > 0 && v.length <= max ? v : null;
const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const fraction = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : null;

/** Model families a group covers, from its model names ("Claude Sonnet 4.6, GPT-OSS 120B"). */
export function families(names: string): string[] {
  const found = ['gemini', 'claude', 'gpt', 'grok'].filter(f => names.toLowerCase().includes(f));
  return found.length ? found : [];
}

/** A window whose reset has passed is full again; until the CLI reports anew, show it as unused. */
export function settle(windows: AgWindow[], now: number): AgWindow[] {
  return windows.map(w => w.resetsAt && Date.parse(w.resetsAt) <= now ? { ...w, usedPercent: 0 } : w);
}

export function parseGoogleQuota(summary: unknown, models: unknown): AgWindow[] {
  const windows: AgWindow[] = [];
  for (const raw of Array.isArray(record(summary).groups) ? record(summary).groups as unknown[] : []) {
    const group = record(raw);
    const name = text(group.displayName) ?? 'Модели';
    const scope = families(`${name} ${text(group.description, 2000) ?? ''}`);
    const short = scope.length ? scope.map(f => f === 'gpt' ? 'GPT' : f[0]!.toUpperCase() + f.slice(1)).join('+') : name;
    for (const item of Array.isArray(group.buckets) ? group.buckets as unknown[] : []) {
      const bucket = record(item);
      const left = fraction(bucket.remainingFraction);
      if (left === null) continue;
      const window = text(bucket.window) ?? '';
      const kind = /week/i.test(window) ? 'weekly' : /5h|hour/i.test(window) ? 'five-hour' : 'other';
      windows.push({ label: `${short} · ${kind === 'weekly' ? 'неделя' : kind === 'five-hour' ? '5 ч' : window}`,
        kind, usedPercent: clamp(100 * (1 - left)), resetsAt: text(bucket.resetTime), scope });
    }
  }
  // Gemini models carry their own quota in the model list; they share one bucket.
  const covered = new Set(windows.flatMap(w => w.scope ?? []));
  const gemini = Object.entries(record(record(models).models)).flatMap(([id, value]) => {
    const quota = record(record(value).quotaInfo);
    const left = fraction(quota.remainingFraction);
    const reset = text(quota.resetTime);
    return /^gemini/i.test(id) && left !== null && reset ? [{ left, reset }] : [];
  });
  if (gemini.length && !covered.has('gemini')) {
    const worst = gemini.reduce((a, b) => b.left < a.left ? b : a);
    windows.unshift({ label: 'Gemini · 5 ч', kind: 'five-hour', usedPercent: clamp(100 * (1 - worst.left)),
      resetsAt: worst.reset, scope: ['gemini'] });
  }
  return windows;
}

export function googlePlan(assist: unknown): string | null {
  const a = record(assist);
  return text(record(a.paidTier).name) ?? text(record(a.currentTier).name);
}

const minutes = (seconds: number) => {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), r = s % 60;
  return h ? `${h} ч${m ? ` ${m} мин` : ''}` : m ? `${m} мин${r && m < 10 ? ` ${r} с` : ''}` : `${r} с`;
};

const balanceSchema = z.object({
  balance_seconds: z.number().finite(), total_purchased_seconds: z.number().finite().nonnegative(),
  total_used_seconds: z.number().finite().nonnegative().optional(),
  expires_at: z.string().nullish(), is_blocked: z.boolean().optional(), blocked_until: z.string().nullish(),
  requests_today: z.number().finite().optional(), time_today_seconds: z.number().finite().optional(),
  tokens_today: z.number().finite().optional(),
}).passthrough();

/**
 * Antig sells server time: seconds of model processing, each request billed as
 * actual seconds × the model's multiplier (Neon ×1.75, Carbon/Argon ×2…).
 * Bought hours expire after 30 days; there are no refill windows. Used share =
 * 1 − balance / purchased, multipliers already inside the billed seconds.
 */
export function parseAntigBalance(input: unknown, now: number): Pick<AgAccount, 'plan' | 'windows' | 'note' | 'message' | 'meter'> {
  const b = balanceSchema.parse(input);
  const total = b.total_purchased_seconds;
  const left = Math.max(0, b.balance_seconds);
  const ends = b.expires_at && Number.isFinite(Date.parse(b.expires_at)) ? b.expires_at : null;
  const blocked = b.is_blocked && b.blocked_until && Date.parse(b.blocked_until) > now ? b.blocked_until : null;
  const today = b.time_today_seconds !== undefined
    ? `сегодня ${minutes(b.time_today_seconds)}${b.requests_today !== undefined ? `, ${b.requests_today} запр.` : ''}` : null;
  // Nothing left, nothing bought or the package expired: the package is spent (100%), never 0%.
  const expired = ends !== null && Date.parse(ends) <= now;
  const spent = left <= 0 || total <= 0 || expired;
  const used = spent ? 100 : clamp(100 * (1 - left / total));
  const note = spent ? [expired ? 'пакет сгорел' : 'закончилось', today].filter(Boolean).join(' · ')
    : [`осталось ${minutes(left)} из ${minutes(total)}`, `≈ ${minutes(left / 1.75)} на ×1,75 · ${minutes(left / 2)} на ×2`, today].filter(Boolean).join(' · ');
  const rate = b.tokens_today && b.time_today_seconds && b.time_today_seconds >= 10 ? b.tokens_today / b.time_today_seconds : null;
  return {
    meter: total > 0 ? { total, left: spent ? 0 : left, tokensPerUnit: rate } : null,
    plan: total > 0 ? `Пакет ${minutes(total)}` : null,
    windows: [{ label: 'Часы', kind: 'other', usedPercent: used, resetsAt: null, endsAt: ends }],
    note,
    message: blocked ? `Аккаунт пула заблокирован до ${new Date(blocked).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' })} МСК`
      : total > 0 ? null : 'Нет купленного времени',
  };
}

async function tokenFile(path: string): Promise<{ access: string | null; expiry: number; email: string | null } | null> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'));
    const token = record(raw.token);
    return { access: text(token.access_token, 4096), expiry: Date.parse(text(token.expiry) ?? ''), email: text(raw.id_token_email)?.toLowerCase() ?? null };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    return { access: null, expiry: NaN, email: null };
  }
}


export function createAntigravityReader(options: {
  home?: string; send?: typeof fetch; now?: () => number;
} = {}) {
  const home = options.home ?? homedir();
  const send = options.send ?? fetch;
  const now = options.now ?? Date.now;
  const googleDir = join(home, '.gemini', 'antigravity-cli');
  const antigDir = join(process.env.ANTIG_HOME || join(home, '.antig-home'), '.gemini', 'antigravity-cli');
  const stateDir = join(process.env.XDG_STATE_HOME || join(home, '.local', 'state'), 'bb-antig');
  const sessionFile = join(stateDir, 'session.json');
  const googleTokens = createAgyTokenReader(googleDir);
  const antigTokens = createAgyTokenReader(antigDir);
  let google: { at: number; value: AgAccount | null } | null = null;
  let antig: { at: number; value: AgAccount | null } | null = null;
  let plan: { at: number; value: string | null } | null = null;
  let lastRenew = 0;
  let pending: Promise<AntigravityResult> | null = null;

  async function readGoogle(): Promise<AgAccount | null> {
    let token = await tokenFile(join(googleDir, 'antigravity-oauth-token'));
    if (!token) return null;
    const previous = google?.value;
    const stale = (message: string): AgAccount => previous
      ? { ...previous, windows: settle(previous.windows, now()), status: previous.windows.length ? 'stale' : 'unavailable', message }
      : { email: token?.email ?? null, plan: null, status: 'unavailable', message, fetchedAt: null, windows: [], note: null };
    // The plugin never runs agy and never writes into its state: a CLI run touches
    // the keyring marker and the token store. Expired token = wait for agy itself.
    if (!token.access || !(token.expiry - now() > 60_000))
      return stale('Токен agy истёк; лимиты обновятся при следующем запуске Antigravity');
    const project = (await readFile(join(googleDir, 'cache', 'default_project_id.txt'), 'utf8').catch(() => '')).trim();
    const call = async (method: string, body: unknown) => {
      const response = await send(GOOGLE_API + method, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Bearer ${token!.access}`, 'Content-Type': 'application/json', 'User-Agent': 'antigravity' },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`Google вернул HTTP ${response.status}`);
      return response.json() as Promise<unknown>;
    };
    try {
      const body = project ? { project } : {};
      const [summary, models] = await Promise.all([call('retrieveUserQuotaSummary', body), call('fetchAvailableModels', body)]);
      if (!plan || now() - plan.at > renewInterval)
        plan = { at: now(), value: googlePlan(await call('loadCodeAssist', { metadata: { ideType: 'ANTIGRAVITY' } }).catch(() => null)) ?? plan?.value ?? null };
      return { email: token.email, plan: plan.value, status: 'ok', message: null,
        fetchedAt: new Date(now()).toISOString(), windows: parseGoogleQuota(summary, models), note: null };
    } catch (error) {
      return stale(error instanceof Error ? error.message : 'Квота Google недоступна');
    }
  }

  async function privateSession(): Promise<string | null> {
    try {
      const info = await lstat(sessionFile);
      if (!info.isFile() || (info.mode & 0o077) !== 0) throw new Error('Antig: права на файл сессии должны быть 0600');
      return z.object({ cookie: z.string().min(1) }).parse(JSON.parse(await readFile(sessionFile, 'utf8'))).cookie;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
      throw error;
    }
  }

  async function saveSession(cookie: string) {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const temporary = `${sessionFile}.${randomUUID()}`;
    try {
      await writeFile(temporary, JSON.stringify({ cookie }), { mode: 0o600, flag: 'wx' });
      await rename(temporary, sessionFile);
    } finally { await rm(temporary, { force: true }); }
  }

  /** The cabinet's own session call slides the NextAuth expiry and reissues the cookie. */
  async function renew(cookie: string): Promise<string> {
    const response = await send(`${CABINET}/api/auth/session`, {
      redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { Cookie: cookie, Accept: 'application/json' },
    });
    if (!response.ok) return cookie;
    const session = record(await response.json().catch(() => null));
    if (!record(session.user) || !Object.keys(record(session.user)).length) throw new Error('Antig: сессия кабинета истекла, нужен повторный вход');
    const fresh = response.headers.getSetCookie().map(v => v.split(';', 1)[0]!)
      .filter(v => /^__Secure-next-auth\.session-token(\.\d+)?=.+/.test(v));
    if (!fresh.length) return cookie;
    const next = fresh.join('; ');
    if (next !== cookie) await saveSession(next);
    return next;
  }

  async function readAntig(): Promise<AgAccount | null> {
    const token = await tokenFile(join(antigDir, 'antigravity-oauth-token'));
    let cookie: string | null;
    try { cookie = await privateSession(); }
    catch (error) {
      return { email: token?.email ?? null, plan: null, status: 'unavailable', fetchedAt: null, windows: [], note: null,
        message: error instanceof Error ? error.message : 'Antig: сессия кабинета недоступна' };
    }
    if (!token && !cookie) return null;
    const previous = antig?.value;
    const failed = (message: string): AgAccount => previous?.windows.length
      ? { ...previous, status: 'stale', message }
      : { email: token?.email ?? null, plan: null, status: 'unavailable', message, fetchedAt: null, windows: [], note: null };
    if (!cookie) return failed('Нет сессии кабинета antig.ru — лимиты недоступны');
    try {
      if (now() - lastRenew > renewInterval) { lastRenew = now(); cookie = await renew(cookie); }
      const response = await send(`${CABINET}/api/lk/balance`, {
        redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { Cookie: cookie, Accept: 'application/json' },
      });
      if (response.status === 401 || response.status === 403) return failed('Antig: сессия кабинета истекла, нужен повторный вход');
      if (!response.ok) return failed(`Кабинет antig.ru вернул HTTP ${response.status}`);
      const parsed = parseAntigBalance(await response.json(), now());
      return { email: token?.email ?? previous?.email ?? null, status: 'ok', fetchedAt: new Date(now()).toISOString(), ...parsed };
    } catch (error) {
      return failed(error instanceof Error && error.message.startsWith('Antig:') ? error.message : 'Кабинет antig.ru временно недоступен');
    }
  }

  return (refresh = false): Promise<AntigravityResult> => {
    if (pending) return pending;
    const fresh = (c: { at: number } | null, interval = readInterval) => c && now() - c.at < (refresh ? 60_000 : interval);
    if (fresh(google) && fresh(antig, cabinetInterval)) return Promise.resolve({ google: google!.value, antig: antig!.value });
    pending = (async () => {
      const [g, a] = await Promise.all([
        fresh(google) ? google!.value : readGoogle().catch(() => google?.value ?? null),
        fresh(antig, cabinetInterval) ? antig!.value : readAntig().catch(() => antig?.value ?? null),
      ]);
      const [gt, at] = await Promise.all([g ? googleTokens().catch(() => null) : null, a ? antigTokens().catch(() => null) : null]);
      if (g && gt) g.tokens = gt;
      if (a && at) a.tokens = at;
      if (!fresh(google)) google = { at: now(), value: g };
      if (!fresh(antig, cabinetInterval)) antig = { at: now(), value: a };
      return { google: g, antig: a };
    })().finally(() => { pending = null; });
    return pending;
  };
}
