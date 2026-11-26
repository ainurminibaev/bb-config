import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAntigravityReader, googlePlan, parseAntigBalance, parseGoogleQuota, settle } from './antigravity.ts';
import { accountExhausted, appliesToModel } from './logic.ts';
import type { Account } from './contract.ts';

const summary = { groups: [{ displayName: 'Claude and GPT models',
  description: 'Models within this group: Claude Sonnet 4.6, Claude Opus 4.6, GPT-OSS 120B',
  buckets: [
    { bucketId: '3p-weekly', window: 'weekly', resetTime: '2026-12-03T04:46:09Z', remainingFraction: 0.75 },
    { bucketId: '3p-5h', window: '5h', resetTime: '2026-11-26T09:46:09Z', remainingFraction: 1 },
  ] }] };
const models = { models: {
  'gemini-3.8-flash-tiered': { quotaInfo: { remainingFraction: 0.9854376, resetTime: '2026-11-26T09:26:44Z' } },
  'gemini-3-flash': { displayName: 'Gemini 3 Flash', quotaInfo: { remainingFraction: 0.9854376, resetTime: '2026-11-26T09:26:44Z' } },
  'claude-sonnet-4-6': { quotaInfo: { remainingFraction: 1, resetTime: '2026-11-26T09:46:10Z' } },
  tab_flash_lite_preview: { quotaInfo: { remainingFraction: 1 } },
} };

test('Google quota: Gemini models and the Claude+GPT group become scoped windows', () => {
  const windows = parseGoogleQuota(summary, models);
  assert.deepEqual(windows.map(w => [w.label, w.kind, Math.round(w.usedPercent * 10) / 10, w.scope]), [
    ['Gemini · 5 ч', 'five-hour', 1.5, ['gemini']],
    ['Claude+GPT · неделя', 'weekly', 25, ['claude', 'gpt']],
    ['Claude+GPT · 5 ч', 'five-hour', 0, ['claude', 'gpt']],
  ]);
  assert.equal(appliesToModel(windows[0]!, 'gemini-3.8-flash-high'), true);
  assert.equal(appliesToModel(windows[0]!, 'claude-opus-4-6-thinking'), false);
  assert.equal(appliesToModel(windows[1]!, 'gpt-oss-120b-medium'), true);
  assert.equal(appliesToModel(windows[1]!, null), true);
});

test('Google plan prefers the paid tier name', () => {
  assert.equal(googlePlan({ currentTier: { name: 'Antigravity' }, paidTier: { name: 'Google AI Pro' } }), 'Google AI Pro');
  assert.equal(googlePlan({ currentTier: { name: 'Antigravity' } }), 'Antigravity');
  assert.equal(googlePlan(null), null);
});

test('a window past its reset is shown as refilled', () => {
  const [w] = settle([{ label: 'Gemini · 5 ч', kind: 'five-hour', usedPercent: 80, resetsAt: '2026-01-01T00:00:00Z' }], Date.parse('2026-01-02T00:00:00Z'));
  assert.equal(w!.usedPercent, 0);
});

test('Antig balance: used share of bought seconds, multipliers already billed', () => {
  const now = Date.parse('2026-11-26T05:00:00Z');
  const parsed = parseAntigBalance({ balance_seconds: 3585, total_purchased_seconds: 3600, total_used_seconds: 15,
    expires_at: '2026-12-26T04:16:34.902Z', is_blocked: false, requests_today: 4, time_today_seconds: 15, extra: 'ignored' }, now);
  assert.equal(parsed.plan, 'Пакет 1 ч');
  assert.equal(parsed.windows.length, 1);
  assert.equal(parsed.windows[0]!.kind, 'other');
  assert.equal(Math.round(parsed.windows[0]!.usedPercent * 100) / 100, 0.42);
  assert.equal(parsed.windows[0]!.endsAt, '2026-12-26T04:16:34.902Z');
  assert.match(parsed.note!, /осталось 59 мин из 1 ч/);
  assert.match(parsed.note!, /34 мин на ×1,75/);
  assert.equal(parsed.message, null);
  const blocked = parseAntigBalance({ balance_seconds: 0, total_purchased_seconds: 3600, is_blocked: true, blocked_until: '2026-11-26T06:00:00Z' }, now);
  assert.match(blocked.message!, /заблокирован до/);
  assert.equal(blocked.windows[0]!.usedPercent, 100);
});

const account = (providerId: string, windows: Account['windows']): Account => ({ key: 'k', providerId, providerName: 'x',
  hostIds: [], hostNames: [], email: 'a@b', plan: null, status: 'ok', message: null, fetchedAt: null, windows, resetCount: null });

test('a spent Gemini group alone does not block a Google Antigravity account; a spent Antig package does', () => {
  const g = parseGoogleQuota(summary, { models: { 'gemini-3-flash': { quotaInfo: { remainingFraction: 0, resetTime: '2026-11-26T09:26:44Z' } } } });
  assert.equal(accountExhausted(account('acp-antigravity-acp', g)), false);
  assert.equal(accountExhausted(account('acp-antigravity-acp', g.map(w => ({ ...w, usedPercent: 100 })))), true);
  assert.equal(accountExhausted(account('acp-gemini-antig', [{ label: 'Часы', kind: 'other', usedPercent: 100, resetsAt: null }])), true);
  assert.equal(accountExhausted(account('codex', [{ label: 'Credits', kind: 'other', usedPercent: 100, resetsAt: null }])), false);
});

async function fakeHome() {
  const home = await mkdtemp(join(tmpdir(), 'tau-ag-'));
  const google = join(home, '.gemini', 'antigravity-cli');
  await mkdir(join(google, 'cache'), { recursive: true });
  await writeFile(join(google, 'cache', 'default_project_id.txt'), 'proj-1\n');
  await writeFile(join(google, 'antigravity-oauth-token'), JSON.stringify({ token: { access_token: 'g-token', expiry: '2099-01-01T00:00:00Z' }, id_token_email: 'Google@Example.com' }));
  const antig = join(home, '.antig-home', '.gemini', 'antigravity-cli');
  await mkdir(antig, { recursive: true });
  await writeFile(join(antig, 'antigravity-oauth-token'), JSON.stringify({ token: { access_token: 'ag_secret', expiry: '2099-01-01T00:00:00Z' }, id_token_email: 'antig@example.com' }));
  return home;
}

test('reader: Google via Cloud Code, Antig via the cabinet only — never the gateway, Antig key never sent', async () => {
  const home = await fakeHome();
  const state = join(home, '.local', 'state', 'bb-antig');
  await mkdir(state, { recursive: true });
  await writeFile(join(state, 'session.json'), JSON.stringify({ cookie: '__Secure-next-auth.session-token=old' }), { mode: 0o600 });
  const calls: { url: string; auth: string | null; cookie: string | null }[] = [];
  const send = (async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    calls.push({ url, auth: headers.get('authorization'), cookie: headers.get('cookie') });
    const json = (body: unknown, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json', ...extra } });
    if (url.endsWith('retrieveUserQuotaSummary')) return json(summary);
    if (url.endsWith('fetchAvailableModels')) return json(models);
    if (url.endsWith('loadCodeAssist')) return json({ paidTier: { name: 'Google AI Pro' } });
    if (url.endsWith('/api/auth/session')) return json({ user: { name: 'x' }, expires: '2026-12-26T00:00:00Z' },
      { 'set-cookie': '__Secure-next-auth.session-token=new; Path=/; HttpOnly; Secure' });
    if (url.endsWith('/api/lk/balance')) return json({ balance_seconds: 1800, total_purchased_seconds: 3600, expires_at: '2026-12-26T04:16:34Z' });
    return new Response('no', { status: 404 });
  }) as typeof fetch;
  const read = createAntigravityReader({ home, send, now: () => Date.parse('2026-11-26T05:00:00Z') });
  const result = await read();
  assert.equal(result.google?.email, 'google@example.com');
  assert.equal(result.google?.plan, 'Google AI Pro');
  assert.equal(result.google?.windows.length, 3);
  assert.equal(result.antig?.email, 'antig@example.com');
  assert.equal(result.antig?.windows[0]?.usedPercent, 50);
  assert.ok(calls.every(c => !c.url.includes('antig.ru') || c.url.startsWith('https://antig.ru/')), 'only the cabinet');
  assert.ok(calls.every(c => !c.url.includes('gate.')), 'never the gateway');
  assert.ok(calls.every(c => !(c.auth ?? '').includes('ag_') && !(c.cookie ?? '').includes('ag_')), 'Antig key never leaves the machine');
  assert.ok(calls.filter(c => c.url.includes('googleapis')).every(c => c.auth === 'Bearer g-token'));
  const saved = JSON.parse(await readFile(join(state, 'session.json'), 'utf8'));
  assert.equal(saved.cookie, '__Secure-next-auth.session-token=new');
  assert.equal((await stat(join(state, 'session.json'))).mode & 0o777, 0o600);
  // Cached: a second read within the interval sends nothing.
  const before = calls.length;
  await read();
  assert.equal(calls.length, before);
});

test('reader: expired Google token reports stale, never starts agy and never calls Google', async () => {
  const home = await fakeHome();
  await writeFile(join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), JSON.stringify({ token: { access_token: 'g', expiry: '2020-01-01T00:00:00Z' }, id_token_email: 'g@example.com' }));
  await mkdir(join(home, '.local', 'bin'), { recursive: true });
  await writeFile(join(home, '.local', 'bin', 'agy'), Buffer.from('\x7fELF-fake', 'latin1'));
  const urls: string[] = [];
  const read = createAntigravityReader({ home, send: (async (url: string) => { urls.push(url); return new Response('{}'); }) as typeof fetch,
    now: () => Date.parse('2026-11-26T05:00:00Z') });
  const result = await read();
  assert.equal(result.google?.status, 'unavailable');
  assert.match(result.google?.message ?? '', /Токен agy истёк/);
  assert.ok(!urls.some(u => u.includes('googleapis')));
  assert.equal(result.antig?.status, 'unavailable', 'no cabinet session: name and status only');
  assert.match(result.antig?.message ?? '', /Нет сессии кабинета/);
});


test('Antig: zero balance, nothing bought or an expired package is 100% spent, never 0%', () => {
  const now = Date.parse('2026-11-26T08:00:00Z');
  const empty = parseAntigBalance({ balance_seconds: 0, total_purchased_seconds: 3600, total_used_seconds: 3600,
    expires_at: '2026-12-26T04:16:34.902Z', requests_today: 162, time_today_seconds: 3600, tokens_today: 11961595 }, now);
  assert.equal(empty.windows[0]!.usedPercent, 100);
  assert.equal(empty.note, 'закончилось · сегодня 1 ч, 162 запр.');
  assert.equal(empty.meter!.left, 0);
  const none = parseAntigBalance({ balance_seconds: 0, total_purchased_seconds: 0 }, now);
  assert.equal(none.windows[0]!.usedPercent, 100);
  assert.equal(none.message, 'Нет купленного времени');
  const expired = parseAntigBalance({ balance_seconds: 1200, total_purchased_seconds: 3600, expires_at: '2026-11-01T00:00:00Z' }, now);
  assert.equal(expired.windows[0]!.usedPercent, 100);
  assert.match(expired.note!, /^пакет сгорел/);
  assert.equal(accountExhausted(account('acp-gemini-antig', empty.windows)), true);
});
