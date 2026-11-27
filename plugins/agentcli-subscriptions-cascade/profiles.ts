// Профили каскада: умолчания, заготовки «+ Профиль», подписи, список моделей
// провайдера, превью «куда пошёл бы ход» и тестовый источник квоты.
// Чистые функции; план и решение берутся только из движка (engine.ts).
import { AUTO_MODEL_ID, type CascadeConfig, type DiscoveredAccount, type Profile, type QuotaState, type Step } from './contract.ts';
import { buildPlan, explainProfile, profileSteps, stepConfirm, type Attempt, type Decision, type HealthLookup, type ThreadCascadeState } from './engine.ts';
import type { StepHealth } from './limits.ts';

const PROVIDER_SHORT: Record<string, string> = { 'claude-code': 'Claude', codex: 'Codex', 'gemini-cli': 'Gemini' };
export const providerShort = (id: string) => PROVIDER_SHORT[id] ?? id;

const OPUS = 'opus-5.5';
const FABLE = 'fable-5.2';

function profile(patch: Partial<Profile> & Pick<Profile, 'id' | 'name'>): Profile {
  return { enabled: true, policy: 'any', modelKey: null, stepOrder: null, excludedSteps: [], excludedProviders: [], confirm: {}, ...patch };
}

/** Короткое имя модели для цепочек: «Opus 5.5» → «Opus». */
export function shortModel(displayName: string): string {
  return displayName.split(/\s+/)[0] || displayName;
}

/**
 * Профили из коробки: «Авто», «Авто · без Codex», «Opus → Авто», «Fable → Авто»,
 * «Только Opus 5.5», «Только Fable 5.2». Профили модели — только если строка есть в таблице.
 */
export function defaultProfiles(config: Pick<CascadeConfig, 'models'>): Profile[] {
  const row = (key: string) => config.models.find(r => r.key === key);
  const out: Profile[] = [
    profile({ id: AUTO_MODEL_ID, name: 'Авто' }),
    profile({ id: 'auto-no-codex', name: 'Авто · без Codex', excludedProviders: ['codex'] }),
  ];
  for (const key of [OPUS, FABLE]) {
    const r = row(key);
    if (r) out.push(profile({ id: `${shortModel(r.displayName).toLowerCase()}-then-auto`, name: `${shortModel(r.displayName)} → Авто`, policy: 'prefer-then-any', modelKey: key }));
  }
  for (const key of [OPUS, FABLE]) {
    const r = row(key);
    if (r) out.push(profile({ id: `only-${key}`, name: `Только ${r.displayName}`, policy: 'only', modelKey: key }));
  }
  return out;
}

export type PresetKind = 'only-model' | 'model-then-auto' | 'no-codex';
export const PRESETS: readonly { kind: PresetKind; label: string }[] = [
  { kind: 'only-model', label: 'Только модель' },
  { kind: 'model-then-auto', label: 'Модель → Авто' },
  { kind: 'no-codex', label: 'Без Codex' },
];

/** Новый профиль из заготовки «+ Профиль». Модель — первая в общем приоритете. */
export function presetProfile(kind: PresetKind, config: CascadeConfig): Profile {
  const first = config.policies.modelPriority.map(k => config.models.find(r => r.key === k && r.enabled)).find(Boolean)
    ?? config.models.find(r => r.enabled);
  const taken = config.profiles.map(p => p.id);
  const model = first ? shortModel(first.displayName) : 'Модель';
  switch (kind) {
    case 'only-model': return profile({ id: uniqueId(`only-${first?.key ?? 'model'}`, taken), name: `Только ${first?.displayName ?? 'модель'}`, policy: 'only', modelKey: first?.key ?? null });
    case 'model-then-auto': return profile({ id: uniqueId(`${model.toLowerCase()}-then-auto`, taken), name: `${model} → Авто`, policy: 'prefer-then-any', modelKey: first?.key ?? null });
    case 'no-codex': return profile({ id: uniqueId('auto-no-codex', taken), name: 'Авто · без Codex', excludedProviders: ['codex'] });
  }
}

export function duplicateProfile(source: Profile, config: CascadeConfig): Profile {
  return { ...structuredClone(source), id: uniqueId(`${source.id}-copy`, config.profiles.map(p => p.id)), name: `${source.name} (копия)` };
}

function uniqueId(base: string, taken: readonly string[]): string {
  const clean = base.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '') || 'profile';
  if (!taken.includes(clean)) return clean;
  let i = 2;
  while (taken.includes(`${clean}-${i}`)) i++;
  return `${clean}-${i}`;
}

// ---- Подписи ----

const NEUTRAL_THREAD = { isSubthread: false, homeHostId: null };

function machineLabel(config: CascadeConfig, hostId: string): string {
  return config.machines.find(m => m.hostId === hostId)?.label ?? hostId;
}

/** «Opus · Tru», «Opus · vclaude Mac», «Codex · Mac»: модель и машина (у шлюза — с его подписью). */
export function attemptLabel(config: CascadeConfig, a: Pick<Attempt, 'stepId' | 'hostId' | 'providerId' | 'rowKey'>): string {
  const step = config.steps.find(s => s.id === a.stepId);
  const row = a.rowKey ? config.models.find(r => r.key === a.rowKey) : undefined;
  const model = row ? shortModel(row.displayName) : providerShort(a.providerId);
  const gateway = step?.authority === 'gateway' && step.label ? `${step.label} ` : '';
  return `${model} · ${gateway}${machineLabel(config, a.hostId)}`;
}

/** «Codex — с подтверждением»: провайдер целиком, если все его ступени с подтверждением, иначе ступени. */
function confirmPhrase(config: CascadeConfig, live: readonly Attempt[]): string | null {
  const steps = [...new Map(live.map(a => [a.stepId, a])).values()];
  const asking = steps.filter(a => a.confirm);
  if (asking.length === 0) return null;
  const labels: string[] = [];
  for (const provider of [...new Set(asking.map(a => a.providerId))]) {
    const all = steps.filter(a => a.providerId === provider);
    const some = asking.filter(a => a.providerId === provider);
    if (some.length === all.length) labels.push(providerShort(provider));
    else labels.push(...some.map(a => `${providerShort(provider)} · ${machineLabel(config, a.hostId)}`));
  }
  return `${labels.join(', ')} — с подтверждением`;
}

/**
 * Подпись профиля: первая ступень и правило. Используется и в карточке, и как
 * description модели в списке провайдера.
 * «Старт: Opus · Tru. Сначала Opus на Tru → Mac → UA, потом любые модели; Codex — с подтверждением».
 */
export function describeProfile(config: CascadeConfig, profile: Profile, accounts: readonly DiscoveredAccount[]): string {
  const plan = buildPlan({ config, requestedModel: profile.id, accounts, thread: NEUTRAL_THREAD });
  if (!Array.isArray(plan)) return plan.reason === 'unknown-model' ? 'Модель профиля не найдена в таблице' : 'Профиль выключен';
  const live = plan.filter(a => a.skip === null);
  if (live.length === 0) return 'Нет ступеней для этого профиля';
  const first = live[0]!;
  const parts: string[] = [];
  const row = profile.modelKey ? config.models.find(r => r.key === profile.modelKey) : undefined;
  const hostsOf = (items: readonly Attempt[]) => [...new Set(items.map(a => machineLabel(config, a.hostId)))].join(' → ');
  if (profile.policy === 'any') {
    parts.push(`Старт: ${attemptLabel(config, first)}${first.rowKey ? ' — первая в приоритете моделей' : ''}`);
    parts.push(`Дальше любые модели по ступеням ${hostsOf(live)}`);
  } else {
    const own = live.filter(a => a.phase !== 'any');
    const name = row ? shortModel(row.displayName) : profile.modelKey ?? '';
    parts.push(`Старт: ${attemptLabel(config, first)}`);
    if (profile.policy === 'only') parts.push(own.length > 0 ? `Только ${row?.displayName ?? name} на ${hostsOf(own)}` : `${name} нет ни на одной машине`);
    else parts.push(own.length > 0 ? `Сначала ${name} на ${hostsOf(own)}, потом любые модели` : `${name} нет ни на одной машине — сразу любые модели`);
  }
  const excluded = profile.excludedProviders.map(providerShort);
  const confirm = confirmPhrase(config, live);
  let text = parts.join('. ');
  if (excluded.length > 0) text += `, без ${excluded.join(', ')}`;
  if (confirm) text += `; ${confirm}`;
  return text;
}

// ---- Список моделей провайдера = профили ----

const EFFORTS = [
  { reasoningEffort: 'low', description: 'Быстрее и дешевле' },
  { reasoningEffort: 'medium', description: 'Обычный режим' },
  { reasoningEffort: 'high', description: 'Глубже думает' },
] as const;

export interface ProviderModel {
  id: string;
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: { reasoningEffort: string; description: string }[];
}

/**
 * Пункты списка моделей провайдера «Каскад»: включённые профили в порядке
 * владельца, у которых есть хотя бы одна участвующая ступень. Первый — по умолчанию.
 */
export function providerModels(config: CascadeConfig, accounts: readonly DiscoveredAccount[]): ProviderModel[] {
  const out: ProviderModel[] = [];
  for (const p of config.profiles) {
    if (!p.enabled) continue;
    const plan = buildPlan({ config, requestedModel: p.id, accounts, thread: NEUTRAL_THREAD });
    if (!Array.isArray(plan) || !plan.some(a => a.skip === null)) continue;
    out.push({
      id: p.id, model: p.id, displayName: p.name, description: describeProfile(config, p, accounts),
      isDefault: out.length === 0, defaultReasoningEffort: 'medium', supportedReasoningEfforts: EFFORTS.map(e => ({ ...e })),
    });
  }
  return out;
}

// ---- Лимиты для превью и тестовый источник квоты ----

/** StepHealth из сводки экрана (stepLimits) или тестовой записи. */
export function healthFromState(state: QuotaState, resetsAt: number | null): StepHealth {
  return {
    available: state !== 'unavailable', exhausted: state === 'exhausted', unknown: state === 'unknown',
    resetsAt: state === 'exhausted' ? resetsAt : null, reason: state === 'available' ? null : state,
  };
}

/** Тестовые лимиты ступеней (без записи — «лимит есть»). */
export function testQuotaLookup(config: CascadeConfig): HealthLookup {
  return stepId => {
    const entry = config.testQuota.steps[stepId];
    if (!entry) return healthFromState('available', null);
    const at = entry.resetsAt ? Date.parse(entry.resetsAt) : NaN;
    return healthFromState(entry.state, Number.isFinite(at) ? at : null);
  };
}

/** Действует ли тестовый источник в этом треде. */
export function usesTestQuota(config: CascadeConfig, threadId: string): boolean {
  return config.testQuota.enabled && config.testQuota.threadIds.includes(threadId);
}

/** Лимиты, которые движок видит в треде: тестовые для тестовых тредов, иначе реальные. */
export function quotaLookupFor(config: CascadeConfig, threadId: string, real: HealthLookup): HealthLookup {
  return usesTestQuota(config, threadId) ? testQuotaLookup(config) : real;
}

/** Лимиты превью и схемы на экране: тестовые, пока флаг включён, иначе по сводке монитора. */
export function previewLookup(config: CascadeConfig, summary: Readonly<Record<string, { state: QuotaState; resetsAt: number | null }>>): HealthLookup {
  if (config.testQuota.enabled) return testQuotaLookup(config);
  return stepId => {
    const s = summary[stepId];
    return s ? healthFromState(s.state, s.resetsAt) : healthFromState('unknown', null);
  };
}

/** Новый тред без истории — для превью «куда пошёл бы ход сейчас». */
export function previewThread(): ThreadCascadeState {
  return { threadId: 'preview', projectId: 'preview', turnId: 'preview', isSubthread: false, homeHostId: null, currentStepId: null, switchedAt: null, waitingSince: null, consents: [], skippedStepIds: [] };
}

/** Превью и схема профиля одним вызовом движка. */
export function profilePreview(config: CascadeConfig, profileId: string, accounts: readonly DiscoveredAccount[], health: HealthLookup, now: number) {
  const explained = explainProfile({ config, requestedModel: profileId, accounts, health, thread: previewThread(), now });
  return { ...explained, text: previewText(config, explained.decision, explained.attempts, now) };
}

/** «сейчас ход пошёл бы на: Opus · vclaude Mac». */
export function previewText(config: CascadeConfig, decision: Decision, attempts: readonly Attempt[], now: number): string {
  const label = (stepId: string | null, modelId: string | null) => {
    const a = attempts.find(x => x.stepId === stepId && x.modelId === modelId && x.skip === null);
    return a ? attemptLabel(config, a) : stepId ?? '—';
  };
  switch (decision.kind) {
    case 'run': return `сейчас ход пошёл бы на: ${label(decision.stepId, decision.modelId)}`;
    case 'confirm': return `сейчас ход пошёл бы на: ${label(decision.stepId, decision.modelId)} — после подтверждения`;
    case 'wait': return decision.reason === 'exhausted'
      ? `всё исчерпано — ждать сброса до ${formatTime(decision.until, now)}`
      : `квота неизвестна — перепроверка в ${formatTime(decision.until, now)}`;
    case 'ask-owner': return 'всё исчерпано, сброс не скоро — спросить владельца';
    case 'unavailable': return ({
      'no-steps': 'нет ступеней для этого профиля', 'profile-disabled': 'профиль выключен',
      'unknown-profile': 'профиль не найден', 'unknown-model': 'модель профиля не найдена в таблице',
    } as const)[decision.reason];
  }
}

function formatTime(at: number, now: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return at - now < 24 * 3_600_000 ? time : `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${time}`;
}

/** Чипы ступеней карточки профиля: тот же порядок и исключения, что у движка, плюс подтверждение. */
export function stepChips(config: CascadeConfig, p: Profile): { step: Step; excluded: boolean; confirm: boolean }[] {
  return profileSteps(config, p).map(({ step, excluded }) => ({ step, excluded, confirm: stepConfirm(p, step) }));
}
