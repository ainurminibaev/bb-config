// How much work a plan's window or package holds, in tokens and API dollars.
// Every figure names its source and confidence: official (provider page or
// cabinet), measured (this installation's logs against the provider's own
// percent), estimate (derived from those with a published ratio or price).
import type { Account, Volume } from './contract.ts';
import { planPrice } from './logic.ts';
import type { CodexWindowVolume } from './codex-volume.ts';
import { windowVolume, type MeterSums } from './token-meter.ts';

export type ClaudeEstimate = { usdPerPercent: number; unitsPerPercent: number; segments: number; email: string | null };
export type VolumeInputs = {
  claude: ClaudeEstimate | null;
  codex: Map<string, CodexWindowVolume[]>;  // by host ID
  meters?: Map<string, MeterSums>;          // Прямой Gemini: tokens vs quota percent, by account key
  usdRub: number;
};

const OPUS_UNITS_PER_INPUT_TOKEN = 0.8;      // VClaude cabinet: Opus 5.5 input, 800 000 units per million tokens
const WEEKS_PER_MONTH = 52 / 12;
// GPT-5 API list prices (USD per million: input, cached input, output) — an
// estimate of what Codex tokens would cost through the API.
const CODEX_PRICE = { input: 1.25, cached: 0.125, output: 10 };
const GOOGLE_AI_PRO_USD = 19.99;
const ANTIG_PACKAGE_RUB: Record<number, number> = { 3600: 500, 36_000: 4000, 90_000: 8000 };
const ANTIG_SITE_TOKENS_PER_HOUR = [20e6, 80e6];

const usd = (rub: number, rate: number) => rub / rate;
function monthly(account: Account): number | null {
  if (account.providerId === 'acp-antigravity-acp') return /pro/i.test(account.plan ?? '') ? GOOGLE_AI_PRO_USD : null;
  const label = planPrice(account.providerId, account.plan);
  const value = Number(label.replace(/[^0-9.]/g, ''));
  return label && Number.isFinite(value) && value > 0 ? value : null;
}
/** Plan size relative to Max 20x, from Anthropic's published multipliers (Max 5x/20x = 5×/20× Pro). */
function claudeShare(plan: string | null): number | null {
  const p = (plan ?? '').toLowerCase();
  if (/20x/.test(p)) return 1;
  if (/5x/.test(p)) return 0.25;
  if (/^pro\b/.test(p)) return 0.05;
  return null;
}

export function volumeFor(account: Account, inputs: VolumeInputs): Volume | null {
  const price = monthly(account);
  const perWindow = (tokens: number | null, windowUsd: number | null): Pick<Volume, 'pricePerMTokens'> => ({
    pricePerMTokens: tokens && windowUsd !== null ? windowUsd / (tokens / 1e6) : null,
  });
  switch (account.providerId) {
    case 'claude-code': {
      const c = inputs.claude;
      const share = claudeShare(account.plan);
      if (!c || share === null) return { window: 'неделя', tokens: null, tokensLabel: null, usd: null, pricePerMTokens: null,
        source: 'Anthropic не публикует объём в токенах; замер — по журналам Claude на машине со «сравнением»', confidence: 'none' };
      const same = c.email !== null && c.email === account.email?.toLowerCase();
      const tokens = c.unitsPerPercent * 100 / OPUS_UNITS_PER_INPUT_TOKEN * (same ? 1 : share);
      const apiUsd = c.usdPerPercent * 100 * (same ? 1 : share);
      return { window: 'неделя', tokens, tokensLabel: 'вх. токенов Opus 5.5 (эквивалент)', usd: apiUsd,
        ...perWindow(tokens, price !== null ? price / WEEKS_PER_MONTH : null),
        source: same ? `замер: журналы Claude × % недели (${c.segments} отрезков)`
          : `оценка: замер Max 20x × ${share} (официальные множители Pro/Max)`,
        confidence: same ? 'measured' : 'estimate' };
    }
    case 'codex': {
      const samples = account.hostIds.flatMap(id => inputs.codex.get(id) ?? [])
        .filter(v => v.percentSpan >= 5 && v.samples >= 300 && (!account.plan || (v.plan ?? '').toLowerCase().replace(/[\s_-]/g, '') === account.plan.toLowerCase().replace(/[\s_-]/g, '')))
        .sort((a, b) => b.percentSpan - a.percentSpan);
      const best = samples[0];
      if (!best) return { window: 'неделя', tokens: null, tokensLabel: null, usd: null, pricePerMTokens: null,
        source: 'OpenAI не публикует объём; замер появится, когда на машине накопится ≥300 запросов Codex с ростом окна ≥5% (иначе аккаунт тратят и в других местах)', confidence: 'none' };
      const k = 100 / best.percentSpan;
      const input = best.input * k, cached = best.cached * k, output = best.output * k;
      const apiUsd = (input * CODEX_PRICE.input + cached * CODEX_PRICE.cached + output * CODEX_PRICE.output) / 1e6;
      const tokens = input + cached + output;
      return { window: 'неделя', tokens, tokensLabel: `токенов: вход ${short(input)}, кэш ${short(cached)}, выход ${short(output)}`, usd: apiUsd,
        ...perWindow(tokens, price !== null ? price / WEEKS_PER_MONTH : null),
        source: `замер: журналы Codex, ${best.samples} запросов на ${Math.round(best.percentSpan)}% недели; $ — по ценам GPT-5 API`,
        confidence: 'measured' };
    }
    case 'acp-antigravity-acp': {
      const sums = inputs.meters?.get(account.key) ?? {};
      const measured = Object.entries(sums).map(([label, v]) => ({ label, v, tokens: windowVolume(v) }))
        .filter(m => m.tokens !== null).sort((a, b) => b.v.percent - a.v.percent);
      const main = measured[0];
      if (!main) return { window: '5 ч / неделя', tokens: null, tokensLabel: null, usd: null, pricePerMTokens: null,
        source: 'замер копится: токены agy из его разговоров (conversations/*.db, все машины аккаунта) сопоставляются с ростом % окон раз в 15 мин; цифра появится после роста окна на 2%+',
        confidence: 'none' };
      const label = measured.map(m => `${m.label}: ≈ ${short(m.tokens!)}`).join('; ');
      return { window: main.label, tokens: main.tokens, tokensLabel: `токенов (вход+кэш+выход) на окно; ${label}`, usd: null,
        ...perWindow(main.tokens, price !== null ? price / WEEKS_PER_MONTH : null),
        source: `замер: токены agy (gen_metadata) на ${Math.round(main.v.percent)}% окна, ${main.v.samples} интервалов`,
        confidence: 'measured' };
    }
    case 'acp-gemini-antig': {
      const m = account.meter;
      if (!m) return null;
      const rub = ANTIG_PACKAGE_RUB[m.total] ?? null;
      const measured = m.tokensPerUnit;
      const tokens = measured ? m.total * measured : m.total / 3600 * (ANTIG_SITE_TOKENS_PER_HOUR[0]! + ANTIG_SITE_TOKENS_PER_HOUR[1]!) / 2;
      return { window: 'пакет', tokens, tokensLabel: 'токенов (по истории расхода)', usd: null,
        ...perWindow(tokens, rub !== null ? usd(rub, inputs.usdRub) : null),
        source: measured ? `замер: история antig.ru сегодня, ${short(measured * 3600)} токенов/ч на ×1; сайт: 20–80 млн/ч`
          : 'сайт antig.ru: 20–80 млн вх. токенов за час (середина диапазона)',
        confidence: measured ? 'measured' : 'official' };
    }
    case 'vclaude': {
      const m = account.meter;
      if (!m) return null;
      return { window: 'пакет', tokens: m.total / OPUS_UNITS_PER_INPUT_TOKEN, tokensLabel: 'вх. токенов Opus 5.5', usd: null,
        pricePerMTokens: null, source: 'кабинет VClaude: единицы ÷ коэффициент Opus 5.5', confidence: 'official' };
    }
    default: return null;
  }
}

export function short(tokens: number): string {
  return tokens >= 1e9 ? `${(tokens / 1e9).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} млрд`
    : tokens >= 1e6 ? `${(tokens / 1e6).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} млн`
    : `${Math.round(tokens / 1e3)} тыс.`;
}

/** The page's answer to «how big is Google AI Pro next to Claude Max 20x and Codex Pro». */
export function googleComparison(accounts: Account[]): string {
  const known = accounts.filter(a => a.volume?.tokens && a.volume.confidence !== 'none')
    .map(a => `${a.providerName} ${a.plan ?? ''}: ≈ ${short(a.volume!.tokens!)} ${a.volume!.window === 'пакет' ? 'в пакете' : `за ${a.volume!.window}`}`.replace(/\s+/g, ' '));
  const google = accounts.find(a => a.providerId === 'acp-antigravity-acp');
  const own = google?.volume?.confidence === 'measured' && google.volume.tokens
    ? `${google.providerName} (Google AI Pro): ≈ ${short(google.volume.tokens)} токенов на окно «${google.volume.window}» — замер по токенам agy против % квоты. `
    : `${google?.providerName ?? 'Google AI Pro'}: замер копится — токены agy из его разговоров сопоставляются с ростом % квоты раз в 15 минут; Google объём окон не публикует. `;
  return own + 'Официально: у Pro раздельные окна — Gemini (5 ч) и Claude (5 ч и неделя), расход пропорционален стоимости токенов модели, недельный лимит зависит от тарифа (Ultra больше). '
    + (known.length ? `Для сравнения (замеры этой установки): ${known.join('; ')}.` : '');
}
