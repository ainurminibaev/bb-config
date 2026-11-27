// Тестовый источник квоты для одного живого треда (сценарии S1–S13):
//   bb subscriptions-cascade test-quota --thread <id> --set 'Tru=exhausted,+30m;Mac:claude=ok'
//   bb subscriptions-cascade test-quota --thread <id> --clear
//   bb subscriptions-cascade test-quota --thread <id>            (показать)
// Записи живут в конфигурации (`testQuota.threads[threadId]`) и действуют только
// в этом треде, без общего флага. Чистые функции; запись конфигурации — у сервера.
import type { CascadeConfig, QuotaState, Step, TestQuotaEntry } from './contract.ts';

const STATES: Record<string, QuotaState> = {
  ok: 'available', available: 'available', есть: 'available',
  exhausted: 'exhausted', исчерпан: 'exhausted',
  unknown: 'unknown', неизвестно: 'unknown',
  unavailable: 'unavailable', offline: 'unavailable', недоступна: 'unavailable',
};

const PROVIDER_ALIASES: Record<string, string> = { claude: 'claude-code', 'claude-code': 'claude-code', codex: 'codex' };

/** Ступень по ссылке: точный ID, «Машина[:провайдер]» или подпись ступени. */
export function resolveStepRef(config: CascadeConfig, ref: string): Step | string {
  const text = ref.trim();
  const exact = config.steps.find(s => s.id === text);
  if (exact) return exact;
  const [machinePart, providerPart] = text.split(':');
  const provider = providerPart ? PROVIDER_ALIASES[providerPart.toLowerCase()] ?? providerPart : null;
  const machine = config.machines.find(m => m.label.toLowerCase() === (machinePart ?? '').toLowerCase() || m.hostId === machinePart);
  if (machine) {
    const steps = config.steps.filter(s => s.hostId === machine.hostId && (provider === null || s.providerId === provider));
    if (steps.length === 1) return steps[0]!;
    if (steps.length > 1) return `«${text}»: на ${machine.label} несколько ступеней — уточните провайдер (${steps.map(s => `${machine.label}:${s.providerId === 'claude-code' ? 'claude' : s.providerId}`).join(', ')})`;
    return `«${text}»: на ${machine.label} нет такой ступени`;
  }
  const byLabel = config.steps.filter(s => s.label.toLowerCase() === text.toLowerCase());
  if (byLabel.length === 1) return byLabel[0]!;
  return `«${text}»: ступень не найдена (ID ступени, «Машина:claude|codex» или подпись ступени)`;
}

/** Время сброса: ISO или относительное `+30m`, `+2h`, `+90s`. */
export function parseResetAt(text: string, now: number): string | null | Error {
  const value = text.trim();
  if (value === '' || value === '-' || value === 'null') return null;
  const relative = /^\+(\d+(?:\.\d+)?)\s*(s|m|h|d)$/u.exec(value);
  if (relative) {
    const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[relative[2] as 's' | 'm' | 'h' | 'd'];
    return new Date(now + Number(relative[1]) * unit).toISOString();
  }
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : new Error(`время сброса «${value}» не распознано (ISO или +30m)`);
}

/** `<ступень>=<состояние>[,<сброс>]`, записи через `;`. */
export function parseTestQuotaSpec(config: CascadeConfig, spec: string, now: number): { entries: Record<string, TestQuotaEntry> } | { error: string } {
  const entries: Record<string, TestQuotaEntry> = {};
  for (const part of spec.split(';').map(p => p.trim()).filter(Boolean)) {
    const eq = part.lastIndexOf('=');
    if (eq <= 0) return { error: `«${part}»: нужно <ступень>=exhausted|ok|unknown|unavailable[,<сброс>]` };
    const step = resolveStepRef(config, part.slice(0, eq));
    if (typeof step === 'string') return { error: step };
    const [stateText = '', resetText = ''] = part.slice(eq + 1).split(',');
    const state = STATES[stateText.trim().toLowerCase()];
    if (!state) return { error: `«${stateText}»: состояние exhausted, ok, unknown или unavailable` };
    const resetsAt = parseResetAt(resetText, now);
    if (resetsAt instanceof Error) return { error: resetsAt.message };
    entries[step.id] = { state, resetsAt };
  }
  if (Object.keys(entries).length === 0) return { error: 'пустая подмена: укажите хотя бы одну ступень' };
  return { entries };
}

/** Новая конфигурация с подменой треда: записи добавляются к прежним, `clear` снимает подмену. */
export function withThreadTestQuota(config: CascadeConfig, threadId: string, change: { entries?: Record<string, TestQuotaEntry>; clear?: boolean }): CascadeConfig {
  const threads = { ...config.testQuota.threads };
  if (change.clear) delete threads[threadId];
  if (change.entries) threads[threadId] = { ...(change.clear ? {} : threads[threadId] ?? {}), ...change.entries };
  return { ...config, testQuota: { ...config.testQuota, threads } };
}

/** Текст для CLI: что видит движок в треде по каждой ступени. */
export function formatThreadTestQuota(config: CascadeConfig, threadId: string): string {
  const own = config.testQuota.threads[threadId];
  if (!own) return `Тестовой подмены квоты у треда ${threadId} нет — движок видит реальные лимиты${config.testQuota.enabled && config.testQuota.threadIds.includes(threadId) ? ' (кроме общего тестового источника)' : ''}.\n`;
  const label = (id: string) => {
    const step = config.steps.find(s => s.id === id);
    const machine = step ? config.machines.find(m => m.hostId === step.hostId)?.label ?? step.hostId : null;
    return step ? `${machine} · ${step.providerId === 'claude-code' ? 'Claude' : step.providerId} · ${step.label}` : `${id} (ступени нет)`;
  };
  const lines = config.steps.map(s => {
    const e = own[s.id];
    return `${label(s.id)}: ${e ? `${e.state}${e.resetsAt ? ` до ${e.resetsAt}` : ''}` : 'available (нет записи)'}`;
  });
  return `Тестовая квота треда ${threadId}:\n${lines.map(l => `  ${l}`).join('\n')}\n`;
}
