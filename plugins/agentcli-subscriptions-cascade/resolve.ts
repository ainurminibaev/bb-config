// `bb subscriptions-cascade resolve "<просьба>"` (0.3.0): «Codex 6.2 на Tru»,
// «на аккаунте vclaude», «Opus на UA» → закреплённая ступень каскада.
// Только чтение настроек и таблицы моделей (плюс уже обнаруженные каталоги
// машин для запасного пути), без вызова моделей. Чистые функции.
//
//   { match: { profileId, label } }        — совпадение одно;
//   { candidates: [{ profileId, label }] } — несколько, спросить владельца;
//   { fallback: { provider, machine, machineLabel, model, reason, nearest } }
//                                           — такой ступени в каскаде нет:
//     подтред запускается штатным провайдером с предупреждением.
import type { CascadeConfig, DiscoveredAccount, ModelRow, Step } from './contract.ts';
import { effectiveModelId } from './models.ts';
import { pinnedEntries, stepTitle, type BlockedModel, type PinEntry } from './pins.ts';

export interface ResolveChoice { profileId: string; label: string }

export interface ResolveFallback {
  /** Штатный провайдер BB (`claude-code`, `codex`); null — не понятно, какой. */
  provider: string | null;
  /** ID машины для `--machine`; null — машина не названа. */
  machine: string | null;
  machineLabel: string | null;
  /** ID модели у CLI машины; null — модель CLI по умолчанию. */
  model: string | null;
  reason: string;
  /** Ближайшие закреплённые ступени каскада (без условия на модель). */
  nearest: ResolveChoice[];
}

export type ResolveResult =
  | { match: ResolveChoice }
  | { candidates: ResolveChoice[] }
  | { fallback: ResolveFallback };

export interface ResolveInput {
  config: CascadeConfig;
  accounts: readonly DiscoveredAccount[];
  /** Машины BB (обнаружение): имя → ID, в том числе не входящие в каскад. */
  hosts: readonly { hostId: string; name: string }[];
  blocked?: BlockedModel;
  text: string;
}

const CYR: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p',
  р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

/** Слово для сравнения: латиница, нижний регистр, c → k («маке» ≈ «mac»). */
export function fold(word: string): string {
  return [...word.toLowerCase()].map(ch => CYR[ch] ?? ch).join('').replace(/c/gu, 'k').replace(/[^a-z0-9.]+/gu, '');
}

function words(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}.,-]+/u).map(w => w.replace(/^[-.,]+|[-.,]+$/gu, '')).filter(Boolean);
}

/** Слово просьбы совпадает с меткой: короткая (до 2 знаков) — целиком, длиннее — как начало слова. */
function wordMatches(word: string, label: string): boolean {
  const w = fold(word);
  const l = fold(label);
  if (!l || !w) return false;
  return l.length <= 2 ? w === l : w.startsWith(l);
}

const PROVIDERS: { id: string; words: string[] }[] = [
  { id: 'codex', words: ['codex', 'кодекс'] },
  { id: 'claude-code', words: ['claude', 'клод', 'клауд'] },
  { id: 'gemini-cli', words: ['gemini', 'гемини'] },
];
const ACCOUNT_WORD = /^(аккаунт|аккаунте|аккаунта|аккаунтом|account|акк)$/u;
const VERSION = /^\d+(?:[.,]\d+)?$/u;

function rowFamily(row: ModelRow): string {
  return fold(row.displayName.split(/[\s-]+/u)[0] ?? '');
}

function rowVersions(row: ModelRow): string[] {
  return [...row.displayName.matchAll(/\d+(?:\.\d+)?/gu)].map(m => m[0]);
}

const choice = (e: PinEntry): ResolveChoice => ({ profileId: e.id, label: e.label });

export function resolveRequest(input: ResolveInput): ResolveResult {
  const { config } = input;
  const all = words(input.text);
  const used = new Set<number>();

  // Профиль по имени («Авто · без Codex», «auto»): просьба целиком — имя профиля.
  const whole = fold(input.text);
  const named = config.profiles.find(p => p.enabled && (fold(p.name) === whole || fold(p.id) === whole));
  if (named) return { match: { profileId: named.id, label: named.name } };

  // Аккаунт: «на аккаунте X» — явная просьба; иначе подпись ступени в тексте.
  const accountLabels = (s: Step) => [s.label, s.account ?? ''].map(l => l.trim()).filter(l => l && fold(l) !== fold(providerShortOf(s.providerId)));
  let accountAsked: string | null = null;
  let accountSteps: Step[] | null = null;
  for (let i = 0; i < all.length; i += 1) {
    if (!ACCOUNT_WORD.test(all[i]!)) continue;
    used.add(i);
    const next = all[i + 1];
    if (next) { accountAsked = next; used.add(i + 1); }
  }
  const labelHits = (from: readonly string[]) => config.steps.filter(s => accountLabels(s).some(label => {
    const parts = words(label);
    return parts.length > 0 && from.some((_, i) => parts.every((p, k) => from[i + k] !== undefined && fold(from[i + k]!) === fold(p)));
  }));
  if (accountAsked) {
    const tail = all.slice(all.indexOf(accountAsked));
    accountSteps = labelHits(tail.slice(0, 3));
  } else {
    const hits = labelHits(all);
    if (hits.length > 0) {
      accountSteps = hits;
      for (const s of hits) for (const label of accountLabels(s)) {
        const parts = words(label);
        all.forEach((w, i) => { if (parts.some(p => fold(p) === fold(w))) used.add(i); });
      }
    }
  }

  // Провайдер.
  let provider: string | null = null;
  all.forEach((w, i) => {
    if (used.has(i)) return;
    const hit = PROVIDERS.find(p => p.words.some(x => fold(w).startsWith(fold(x))));
    if (hit) { provider = hit.id; used.add(i); }
  });

  // Машина: сначала метки машин каскада, затем имена машин BB (для запасного пути).
  const machines = new Set<string>();
  all.forEach((w, i) => {
    if (used.has(i)) return;
    for (const m of config.machines) if (wordMatches(w, m.label)) { machines.add(m.hostId); used.add(i); }
  });
  let outsideHost: { hostId: string; name: string } | null = null;
  if (machines.size === 0) {
    for (let i = 0; i < all.length && !outsideHost; i += 1) {
      const w = fold(all[i]!);
      if (used.has(i) || w.length < 3) continue;
      const host = input.hosts.find(h => words(h.name).some(hw => fold(hw).length >= 3 && (fold(hw) === w || fold(hw).startsWith(w))));
      if (host) { outsideHost = host; used.add(i); }
    }
    const inCascade = outsideHost ? config.machines.find(m => m.hostId === outsideHost!.hostId) : undefined;
    if (inCascade) { machines.add(inCascade.hostId); outsideHost = null; }
  }

  // Модель: семейство («Opus», «GPT»), версия («6.2»), остальные слова названия.
  const rows = config.models.filter(r => r.enabled);
  const families = new Set(rows.map(rowFamily).filter(f => f.length >= 3));
  const askedFamilies = new Set<string>();
  const askedVersions = new Set<string>();
  const extra: string[] = [];
  all.forEach((w, i) => {
    if (used.has(i)) return;
    const f = fold(w);
    const fam = [...families].find(x => f.startsWith(x));
    if (fam) { askedFamilies.add(fam); used.add(i); return; }
    if (VERSION.test(w)) { askedVersions.add(w.replace(',', '.')); used.add(i); return; }
    const dashed = /^([\p{L}]+)-(\d+(?:[.,]\d+)?)/u.exec(w);
    if (dashed) {
      const fam2 = [...families].find(x => fold(dashed[1]!).startsWith(x));
      if (fam2) { askedFamilies.add(fam2); askedVersions.add(dashed[2]!.replace(',', '.')); used.add(i); return; }
    }
    if (f.length >= 3) extra.push(f);
  });
  const modelAsked = askedFamilies.size > 0 || askedVersions.size > 0;
  let matchedRows = rows.filter(r => (askedFamilies.size === 0 || askedFamilies.has(rowFamily(r)))
    && (askedVersions.size === 0 || [...askedVersions].every(v => rowVersions(r).includes(v)))
    && (provider === null || r.providerId === provider));
  // Уточняющие слова названия («Sol», «Astra») сужают выбор, если совпали.
  const narrowed = matchedRows.filter(r => extra.some(x => words(r.displayName).slice(1).some(p => fold(p) === x)));
  if (narrowed.length > 0) matchedRows = narrowed;
  const impliedProviders = new Set(modelAsked ? matchedRows.map(r => r.providerId) : []);

  const nothing = !modelAsked && provider === null && machines.size === 0 && !outsideHost && !accountSteps && !accountAsked;
  const fallback = (reason: string, nearest: PinEntry[], extraHint: { hostId?: string | null; providerId?: string | null } = {}): ResolveResult => {
    const prov = provider ?? extraHint.providerId ?? (impliedProviders.size === 1 ? [...impliedProviders][0]! : null)
      ?? (accountSteps && new Set(accountSteps.map(s => s.providerId)).size === 1 ? accountSteps[0]!.providerId : null);
    const hostId = extraHint.hostId ?? (machines.size === 1 ? [...machines][0]! : outsideHost?.hostId ?? null);
    const label = hostId ? config.machines.find(m => m.hostId === hostId)?.label ?? input.hosts.find(h => h.hostId === hostId)?.name ?? hostId : null;
    return { fallback: { provider: prov, machine: hostId, machineLabel: label, model: modelAsked && prov ? fallbackModel(input, hostId, prov, askedFamilies, askedVersions, matchedRows) : null, reason, nearest: nearest.slice(0, 5).map(choice) } };
  };

  if (nothing) return fallback('в просьбе нет ни машины, ни CLI, ни аккаунта, ни модели — уточните у владельца', []);
  if (config.policies.executionMode === 'off') return fallback('Каскад подписок выключен (режим исполнения «Выключено»)', []);

  // Названа машина BB, которой нет в каскаде, — каскад туда не пойдёт.
  if (outsideHost) return fallback(`машины «${outsideHost.name}» нет в каскаде`, []);

  const entries = pinnedEntries(config, input.accounts, input.blocked);
  const where = entries.filter(e => (machines.size === 0 || machines.has(e.hostId))
    && (provider === null || e.providerId === provider)
    && (!accountSteps || accountSteps.some(s => s.id === e.stepId))
    && (!modelAsked || impliedProviders.size === 0 || impliedProviders.has(e.providerId)));
  const hits = where.filter(e => modelAsked ? e.modelKey !== null && matchedRows.some(r => r.key === e.modelKey) : e.modelKey === null);

  if (hits.length === 1) return { match: choice(hits[0]!) };
  if (hits.length > 1) return { candidates: hits.map(choice) };

  // Нет совпадения — объяснить, чего нет, и предложить ближайшее.
  const nearest = where.filter(e => e.modelKey === null);
  if (accountAsked && (!accountSteps || accountSteps.length === 0)) return fallback(`аккаунт «${accountAsked}» не подключён к каскаду`, []);
  if (machines.size > 0 && provider) {
    const stepsThere = config.steps.filter(s => machines.has(s.hostId) && s.providerId === provider);
    const machineNames = [...machines].map(h => config.machines.find(m => m.hostId === h)?.label ?? h).join(', ');
    if (stepsThere.length === 0) return fallback(`в каскаде нет ступени ${providerShortOf(provider)} на ${machineNames}`, []);
    const off = stepsThere.filter(s => !s.enabled || !config.machines.find(m => m.hostId === s.hostId)?.enabled);
    if (off.length === stepsThere.length) return fallback(`ступень ${stepTitle(config, off[0]!)} выключена в каскаде`, []);
  }
  if (where.length === 0 && accountSteps && accountSteps.length > 0) {
    const off = accountSteps.find(s => !s.enabled);
    if (off) return fallback(`ступень ${stepTitle(config, off)} выключена в каскаде`, []);
  }
  if (modelAsked) {
    const name = [...askedFamilies, ...askedVersions].join(' ') || input.text.trim();
    const scope = nearest.length === 1 ? ` на ступени ${nearest[0]!.label}` : '';
    const hint = nearest.length === 1 ? { hostId: nearest[0]!.hostId, providerId: nearest[0]!.providerId } : {};
    return fallback(`модели «${name}» нет в таблице каскада${scope} (или она недоступна на аккаунте)`, nearest, hint);
  }
  return fallback('такой ступени в каскаде нет', nearest);
}

function providerShortOf(id: string): string {
  return id === 'claude-code' ? 'Claude' : id === 'codex' ? 'Codex' : id === 'gemini-cli' ? 'Gemini' : id;
}

/** ID модели для штатного запуска: строка таблицы на этой машине или каталог машины. */
function fallbackModel(input: ResolveInput, hostId: string | null, provider: string, families: ReadonlySet<string>, versions: ReadonlySet<string>, rows: readonly ModelRow[]): string | null {
  const account = hostId ? input.accounts.find(a => a.hostId === hostId && a.providerId === provider) : undefined;
  if (hostId) {
    const ids = [...new Set(rows.filter(r => r.providerId === provider).map(r => effectiveModelId(r, hostId, account)).filter((x): x is string => x !== null))];
    if (ids.length === 1) return ids[0]!;
  }
  const catalog = account?.models ?? [];
  const hits = catalog.filter(m => {
    const name = fold(`${m.displayName}${m.id}`);
    return [...families].every(f => name.includes(f)) && [...versions].every(v => name.includes(v));
  });
  return hits.length === 1 ? hits[0]!.id : null;
}

/** Текст для человека: совпадение, кандидаты или запасной путь с командой. */
export function formatResolve(result: ResolveResult): string {
  const q = (id: string) => `'${id.replace(/'/gu, `'\\''`)}'`;
  if ('match' in result) {
    return `Ступень: ${result.match.label}\nЗапуск: bb thread spawn … --provider subscriptions-cascade --model ${q(result.match.profileId)}\n`;
  }
  if ('candidates' in result) {
    if (result.candidates.length === 0) return 'Подходящих ступеней нет.\n';
    return `Несколько ступеней — уточните у владельца:\n${result.candidates.map(c => `  ${c.label} — ${c.profileId}`).join('\n')}\n`;
  }
  const f = result.fallback;
  const lines = [`Мимо каскада: ${f.reason}.`];
  if (f.provider) lines.push(`Запуск: bb thread spawn … --provider ${f.provider}${f.machine ? ` --machine ${f.machine}` : ''}${f.model ? ` --model ${q(f.model)}` : ''}`);
  if (f.nearest.length > 0) lines.push(`Ближайшее в каскаде: ${f.nearest.map(n => `${n.label} (${n.profileId})`).join('; ')}`);
  lines.push('Владельцу — одна строка: «запущен мимо каскада: <причина>; лимиты не переключаются».');
  return `${lines.join('\n')}\n`;
}
