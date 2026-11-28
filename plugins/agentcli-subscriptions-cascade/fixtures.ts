// Общие данные тестов: каскад Tru (Max) → Mac (vclaude) → UA (Pro) → Codex на Mac и UA
// (с подтверждением). На UA подписка Pro: Opus и Sonnet есть, Fable нет.
import { stepId, seedConfig } from './config.ts';
import type { CascadeConfig, DiscoveredAccount } from './contract.ts';
import type { StepHealth } from './limits.ts';
import type { ThreadCascadeState } from './engine.ts';

export const TRU = 'host_tru';
export const MAC = 'host_mac';
export const UA = 'host_ua';
export const NOW = Date.parse('2026-11-27T12:00:00Z');

export const TRU_MAX = stepId(TRU, 'claude-code', null);
export const MAC_GW = stepId(MAC, 'claude-code', null);
export const UA_PRO = stepId(UA, 'claude-code', null);
export const MAC_CODEX = stepId(MAC, 'codex', null);
export const UA_CODEX = stepId(UA, 'codex', null);

export function config(): CascadeConfig {
  return seedConfig([{ id: TRU, name: 'Tru', platform: 'linux' }, { id: MAC, name: 'MacBook', platform: 'macos' }, { id: UA, name: 'UA', platform: 'linux' }]);
}

export function account(hostId: string, providerId: string, models: { id: string; displayName: string }[], extra: Partial<DiscoveredAccount> = {}): DiscoveredAccount {
  return { hostId, providerId, installed: true, loggedIn: true, account: null, plan: null, models, windows: [], limitsStatus: 'ok', error: null, fetchedAt: '2026-11-27T12:00:00Z', ...extra };
}

export const ACCOUNTS: DiscoveredAccount[] = [
  account(TRU, 'claude-code', [{ id: 'claude-opus-5-5', displayName: 'Opus 5.5' }, { id: 'claude-fable-5-2', displayName: 'Fable 5.2' }]),
  account(MAC, 'claude-code', [{ id: 'opus55', displayName: 'opus55' }, { id: 'fable52', displayName: 'fable52' }]),
  account(MAC, 'codex', [{ id: 'gpt-6.2-sol', displayName: 'GPT-6.2 Sol' }]),
  account(UA, 'claude-code', [{ id: 'claude-opus-5-5', displayName: 'Opus 5.5' }, { id: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5' }], { plan: 'pro' }),
  account(UA, 'codex', [{ id: 'gpt-6.2-sol', displayName: 'GPT-6.2 Sol' }]),
];

export const ok: StepHealth = { available: true, exhausted: false, unknown: false, resetsAt: null, reason: null };
export const unknown: StepHealth = { available: true, exhausted: false, unknown: true, resetsAt: null, reason: 'квота неизвестна' };
export const offline: StepHealth = { available: false, exhausted: false, unknown: false, resetsAt: null, reason: 'машина не на связи' };
export const exhausted = (resetsAt: number | null): StepHealth => ({ available: true, exhausted: true, unknown: false, resetsAt, reason: 'weekly' });

export function thread(patch: Partial<ThreadCascadeState> = {}): ThreadCascadeState {
  return {
    threadId: 'thr_1', projectId: 'proj_1', turnId: 'turn_1', isSubthread: false, homeHostId: TRU,
    currentStepId: null, switchedAt: null, waitingSince: null, consents: [], skippedStepIds: [], ...patch,
  };
}
