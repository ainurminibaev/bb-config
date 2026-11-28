// Видимость лимитов и готовность ступеней (0.3.5). Чистые функции над ответами
// проб: `bb subscriptions-cascade limits` и `check`, отметка «не готова» в
// настройках и схеме «i», пропуск неготовой ступени маршрутом.
import type { CascadeConfig, DiscoveredAccount, Step } from './contract.ts';
import type { StepHealth } from './limits.ts';
import type { ProbeResult } from './wizard.ts';
import { stepTitle } from './pins.ts';

// ---- limits ----

export interface StepLimitLine {
  stepId: string;
  title: string;
  state: 'available' | 'exhausted' | 'unknown' | 'unavailable';
  /** «неделя 70 %», «осталось 4 млн из 5 млн ед.» — строка экрана настроек. */
  value: string;
  /** Источник квоты: usageLimits BB, кабинет vclaude (Thread Account Usage), только события хода. */
  source: string;
  /** Почему квота неизвестна/недоступна; null — известна. */
  reason: string | null;
}

/** Источник квоты ступени — откуда каскад её читает. */
export function quotaSourceOf(step: Step): string {
  if (step.quotaSource === 'vclaude') return 'кабинет VClaude (RPC thread-account-usage.vclaude)';
  if (step.authority === 'gateway') return 'только события хода (шлюз без опроса)';
  return `bb.sdk.system.usageLimits().${step.providerId} + события хода`;
}

export function limitsReport(config: CascadeConfig, describe: (step: Step) => { health: StepHealth; text: string }): StepLimitLine[] {
  return config.steps.filter(s => s.enabled).map(step => {
    const { health, text } = describe(step);
    const state = !health.available ? 'unavailable' : health.exhausted ? 'exhausted' : health.unknown ? 'unknown' : 'available';
    return { stepId: step.id, title: stepTitle(config, step), state, value: text, source: quotaSourceOf(step), reason: state === 'available' || state === 'exhausted' ? null : health.reason };
  });
}

const STATE_RU = { available: 'есть', exhausted: 'исчерпан', unknown: 'неизвестна', unavailable: 'недоступна' } as const;

export function formatLimits(lines: readonly StepLimitLine[]): string {
  if (lines.length === 0) return 'В каскаде нет включённых ступеней.\n';
  return `${lines.map(l => `${l.state === 'available' ? '✓' : l.state === 'exhausted' ? '■' : '?'} ${l.title}: ${STATE_RU[l.state]} — ${l.value}\n    источник: ${l.source}${l.reason ? `\n    причина: ${l.reason}` : ''}`).join('\n')}\n`;
}

// ---- check ----

export interface CheckItem {
  id: 'machine' | 'cli' | 'login' | 'limits' | 'tau' | 'models' | 'shared-path' | 'mutagen' | 'ssh' | 'dry-run';
  ok: boolean;
  title: string;
  /** Что сделать, если не ok. */
  fix: string | null;
  /** Блокирует ход на ступени (ступень «не готова»). Пункты лимитов и TAU — только предупреждения. */
  blocking: boolean;
}

export interface StepCheck { stepId: string; title: string; ready: boolean; items: CheckItem[]; reason: string | null }

/** Ответы проб одной ступени (всё уже прочитано: обнаружение, probe хоста, мастер, монитор). */
export interface StepProbes {
  connected: boolean;
  /** Ответ probe хоста: null — хост-часть плагина не ответила (нет node или машина спит). */
  probe: ProbeResult | null;
  account: DiscoveredAccount | undefined;
  health: StepHealth;
  /** Состояние той же квоты у Thread Account Usage; null — TAU не установлен или аккаунта нет. */
  tau: { state: 'available' | 'exhausted' | 'unknown' | 'unavailable'; usedPercent: number | null } | null;
  /** Наш процент (самое заполненное окно); null — нет окон. */
  usedPercent: number | null;
  /** Шаги мастера машины (folder/mutagen/ssh): статус последнего прогона. */
  wizard: Partial<Record<'folder' | 'mutagen' | 'ssh', { status: string; message?: string | null }>>;
  /** Машина ступени — опора (там не нужны реплика, Mutagen и SSH до опоры). */
  anchor: boolean;
}

const SETUP = 'bb subscriptions-cascade setup --machine';

/**
 * Готовность ступени по пробам. Блокирующие пункты: машина, CLI, вход, модели (если
 * таблица требует модель на этой машине), для исполнителя — общий путь, Mutagen, SSH.
 * Лимиты и сверка с TAU — предупреждения: неизвестная квота решается onUnknown.
 */
export function checkStep(config: CascadeConfig, step: Step, p: StepProbes): StepCheck {
  const machine = config.machines.find(m => m.hostId === step.hostId)?.label ?? step.hostId;
  const cli = step.providerId === 'codex' ? 'codex' : step.providerId === 'claude-code' ? 'claude' : step.providerId;
  const items: CheckItem[] = [];
  const add = (item: Omit<CheckItem, 'fix'> & { fix?: string | null }) => items.push({ ...item, fix: item.ok ? null : item.fix ?? null });
  add({ id: 'machine', ok: p.connected && p.probe !== null, blocking: true,
    title: p.connected ? (p.probe ? `машина ${machine} на связи, node есть` : `машина ${machine} на связи, но хост-часть плагина не ответила`) : `машина ${machine} не на связи`,
    fix: p.connected ? `проверьте BB на ${machine} (node, плагин «Каскад подписок» включён): ${SETUP} ${machine} --recheck` : `разбудите ${machine} или выключите её в «Машинах»` });
  const installed = p.account?.installed === true;
  add({ id: 'cli', ok: installed, blocking: true,
    title: installed ? `${cli} установлен${p.account?.cliVersion ? `, версия ${p.account.cliVersion}` : ', версия неизвестна'}` : `${cli} не установлен на ${machine}`,
    fix: `установите ${cli} на ${machine}` });
  add({ id: 'login', ok: installed && p.account?.loggedIn === true, blocking: true,
    title: p.account?.loggedIn ? `вход в ${cli} выполнен` : `нет входа в ${cli}${p.account?.error ? ` (${p.account.error})` : ''}`,
    fix: `войдите на ${machine}: ${cli === 'codex' ? 'codex login' : cli === 'claude' ? 'claude /login' : `${cli} login`}` });
  const state = !p.health.available ? 'unavailable' : p.health.exhausted ? 'exhausted' : p.health.unknown ? 'unknown' : 'available';
  add({ id: 'limits', ok: state === 'available' || state === 'exhausted', blocking: false,
    title: state === 'unknown' || state === 'unavailable' ? `лимиты не читаются: ${p.health.reason ?? 'причина неизвестна'}` : `лимиты читаются: ${state === 'exhausted' ? 'исчерпан' : 'есть'}${p.usedPercent !== null ? `, ${Math.round(p.usedPercent)} %` : ''}`,
    fix: `источник: ${quotaSourceOf(step)}; сравните с bb settings usage --machine ${machine} --refresh` });
  if (p.tau) {
    const same = p.tau.state === state && (p.tau.usedPercent === null || p.usedPercent === null || Math.abs(p.tau.usedPercent - p.usedPercent) < 1);
    add({ id: 'tau', ok: same, blocking: false,
      title: same ? 'совпадает с Thread Account Usage' : `расходится с Thread Account Usage: там ${p.tau.state}${p.tau.usedPercent !== null ? ` ${Math.round(p.tau.usedPercent)} %` : ''}, у каскада ${state}${p.usedPercent !== null ? ` ${Math.round(p.usedPercent)} %` : ''}`,
      fix: 'обновите оба (bb settings usage --refresh); если расхождение остаётся — это дефект чтения каскада' });
  }
  const wanted = config.models.filter(r => r.enabled && r.providerId === step.providerId && r.cells[step.hostId]?.modelId);
  const catalog = new Set((p.account?.models ?? []).map(m => m.id));
  const missing = wanted.filter(r => !catalog.has(r.cells[step.hostId]!.modelId!));
  add({ id: 'models', ok: p.account !== undefined && missing.length === 0, blocking: p.account !== undefined && wanted.length > 0 && missing.length === wanted.length,
    title: missing.length === 0 ? `модели таблицы есть в каталоге ${cli} (${wanted.length})` : `нет в каталоге ${cli}: ${missing.map(r => r.displayName).join(', ')}`,
    fix: 'обновите CLI или сопоставьте модель заново в таблице моделей' });
  if (!p.anchor) {
    add({ id: 'shared-path', ok: Boolean(p.probe?.sharedPathExists && p.probe.sharedPathWritable), blocking: true,
      title: p.probe?.sharedPathWritable ? 'общий путь есть и доступен на запись' : p.probe?.sharedPathExists ? 'общий путь есть, но без записи' : 'общего пути нет',
      fix: `${SETUP} ${machine}` });
    add({ id: 'mutagen', ok: Boolean(p.probe?.mutagenVersion), blocking: true,
      title: p.probe?.mutagenVersion ? `Mutagen ${p.probe.mutagenVersion}` : 'Mutagen не установлен', fix: `${SETUP} ${machine}` });
    const ssh = p.wizard.ssh;
    add({ id: 'ssh', ok: ssh?.status === 'done' || ssh?.status === 'skipped', blocking: true,
      title: ssh?.status === 'done' || ssh?.status === 'skipped' ? 'SSH до опоры работает' : `SSH до опоры: ${ssh ? `${ssh.status}${ssh.message ? ` — ${ssh.message}` : ''}` : 'не проверялся'}`,
      fix: `${SETUP} ${machine} --allow-ssh` });
  }
  // «Сухой» запуск без трат лимита: версия CLI из providerCliStatus (модельного запроса нет).
  add({ id: 'dry-run', ok: installed && Boolean(p.account?.cliVersion), blocking: false,
    title: p.account?.cliVersion ? `${cli} --version отвечает` : `${cli} --version: нет ответа`, fix: `проверьте ${cli} на ${machine}` });
  const failed = items.find(i => i.blocking && !i.ok);
  return { stepId: step.id, title: stepTitle(config, step), ready: !failed, items, reason: failed ? `${failed.title}${failed.fix ? ` — ${failed.fix}` : ''}` : null };
}

export function formatCheck(checks: readonly StepCheck[]): string {
  if (checks.length === 0) return 'Нет ступеней для проверки.\n';
  return `${checks.map(c => [`${c.ready ? '✓' : '✗'} ${c.title}${c.ready ? ' — готова' : ' — не готова'}`,
    ...c.items.map(i => `    ${i.ok ? '✓' : i.blocking ? '✗' : '!'} ${i.title}${i.fix ? `\n        → ${i.fix}` : ''}`)].join('\n')).join('\n')}\n`;
}

/** Здоровье ступени с учётом готовности: неготовая — недоступна с причиной (маршрут её пропускает). */
export function withReadiness(health: StepHealth, notReady: string | null): StepHealth {
  if (!notReady) return health;
  return { available: false, exhausted: false, unknown: false, resetsAt: null, reason: `ступень не готова: ${notReady}` };
}

/**
 * Состояние той же квоты у Thread Account Usage (её RPC `accounts`, без обновления).
 * Ступень шлюза vclaude — строка VClaude её машины; остальные — `<провайдер>:<машина>`.
 * null — аккаунта нет. Чужие данные читаются терпимо: неизвестные поля пропускаются.
 */
export function tauStateOf(accounts: readonly unknown[], step: Step, threshold: number): StepProbes['tau'] {
  const rec = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
  const want = step.quotaSource === 'vclaude' ? 'vclaude' : step.providerId;
  const found = accounts.map(rec).find(a => a.providerId === want && Array.isArray(a.hostIds) && (a.hostIds as unknown[]).includes(step.hostId));
  if (!found) return null;
  const windows = Array.isArray(found.windows) ? (found.windows as unknown[]).map(rec) : [];
  const percents = windows.map(w => w.usedPercent).filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  const usedPercent = percents.length ? Math.max(...percents) : null;
  if (found.status === 'unavailable' || usedPercent === null) return { state: 'unknown', usedPercent: null };
  return { state: usedPercent >= threshold ? 'exhausted' : 'available', usedPercent };
}
