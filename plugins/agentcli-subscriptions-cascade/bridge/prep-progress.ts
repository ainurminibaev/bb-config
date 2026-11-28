// Прогресс подготовки хода (синхронизация перед запуском CLI) для строки ленты.
// Сервер копит события sync/ (шаг начался/закончился, счётчики Mutagen) в
// состоянии треда; запускатель, пока ждёт решения, опрашивает RPC turnProgress
// и шлёт заметку `prep` в ленту. Строка перехода обновляется на месте:
//   «Подготовка Mac: синхронизация Tru → Mac · 2 341 / 10 520 файлов · 23 % · 0:47».
// Чистые функции, кроме трекера (Map в памяти сервера).
import { statusLabel } from '../sync/mutagen.ts';
import type { SyncProgressEvent, SyncStepKind } from '../sync/orchestrator.ts';
import type { RouteNote, StageLabel } from './route-contract.ts';

export type PrepNote = Extract<RouteNote, { kind: 'prep' }>;
type SwitchReason = Extract<RouteNote, { kind: 'switch' }>['reason'];

interface PrepStep { key: string; label: string; ms: number; state: 'running' | 'done' | 'failed'; startedAt: number }

export interface PrepState {
  startedAt: number;
  reason: SwitchReason;
  from: StageLabel | null;
  to: StageLabel;
  stepId: string;
  steps: PrepStep[];
  transfer: { phase: string; files: number | null; done: number | null; bytes: number | null } | null;
  /** Что делает каскад после сбоя: «повтор 2/3: …», «Mac пропущена → UA». */
  attempt: string | null;
}

const STEP_LABELS: Record<SyncStepKind, string> = {
  mount: 'папка на опоре', create: 'сессии Mutagen', quarantine: 'карантин опоздавших записей', 'env-read': 'права .env',
  align: 'выравнивание', resume: 'запуск синхронизации', flush: 'синхронизация', health: 'сверка', locks: 'lock-файлы git',
  'resolve-index': 'конфликт .git/index', 'env-restore': 'права .env', pause: 'пауза', snapshot: 'снимок', warm: 'прогрев', tail: 'закрытие тёплого хвоста',
};

/** Подпись шага: «синхронизация Tru → Mac», «выравнивание Mac по Tru», «сверка». */
export function stepLabel(step: SyncStepKind, from: string | undefined, to: string | undefined, label: (hostId: string) => string): string {
  const base = STEP_LABELS[step] ?? step;
  if (!from || !to) return base;
  if (step === 'align') return `выравнивание ${label(to)} по ${label(from)}`;
  if (step === 'flush') return `синхронизация ${label(from)} → ${label(to)}`;
  return base;
}

export function beginPrep(input: { reason: SwitchReason; from: StageLabel | null; to: StageLabel; stepId: string }, now: number): PrepState {
  return { ...input, startedAt: now, steps: [], transfer: null, attempt: null };
}

/** Событие sync/ → новое состояние строки. */
export function applyPrep(state: PrepState, event: SyncProgressEvent, now: number, label: (hostId: string) => string): PrepState {
  const key = `${event.step}:${event.from ?? ''}:${event.to ?? ''}`;
  const text = stepLabel(event.step, event.from, event.to, label);
  if (event.kind === 'transfer') {
    return { ...state, transfer: { phase: `${statusLabel(event.progress.status)} · ${text}`, files: event.progress.files, done: event.progress.done, bytes: event.progress.bytes } };
  }
  const steps = state.steps.filter(s => !(s.key === key && s.state === 'running'));
  if (event.state === 'running') return { ...state, steps: [...steps, { key, label: text, ms: 0, state: 'running' as const, startedAt: now }].slice(-20) };
  return { ...state, transfer: null, steps: [...steps, { key, label: event.detail && event.state === 'failed' ? `${text}: ${event.detail}`.slice(0, 80) : text, ms: event.ms, state: event.state, startedAt: now - event.ms }].slice(-20) };
}

export function withAttempt(state: PrepState, attempt: string | null): PrepState {
  return { ...state, attempt };
}

const grouped = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/gu, ' ');

/** 0:47, 1:12, 12:05. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Текущий этап: передача с счётчиками, иначе последний идущий шаг. */
function phaseOf(state: PrepState): string {
  if (state.transfer) return state.transfer.phase;
  const running = [...state.steps].reverse().find(s => s.state === 'running');
  return running?.label ?? (state.steps.length ? 'подготовка' : 'выбор ступени');
}

/** Заметка `prep` для ленты (шаги — с длительностью на момент `now`). */
export function prepNote(state: PrepState, now: number): PrepNote {
  const t = state.transfer;
  return {
    kind: 'prep', reason: state.reason, from: state.from, to: state.to, stepId: state.stepId,
    phase: phaseOf(state).slice(0, 120), elapsedMs: Math.max(0, now - state.startedAt),
    steps: state.steps.slice(-20).map(s => ({ label: s.label.slice(0, 80), ms: s.state === 'running' ? Math.max(0, now - s.startedAt) : s.ms, state: s.state })),
    ...(t && (t.files !== null || t.done !== null) ? { sync: { ...(t.files !== null ? { files: t.files } : {}), ...(t.done !== null ? { done: t.done } : {}), ...(t.bytes !== null ? { bytes: t.bytes } : {}) } } : {}),
    ...(state.attempt ? { attempt: state.attempt.slice(0, 160) } : {}),
  };
}

/** «Подготовка Mac: синхронизация Tru → Mac · 2 341 / 10 520 файлов · 23 % · 0:47». */
export function prepMessage(note: PrepNote): string {
  const parts = [`Подготовка ${note.to.machine}: ${note.phase}`];
  const files = note.sync?.files;
  const done = note.sync?.done;
  if (files !== undefined && done !== undefined && files > 0) {
    parts.push(`${grouped(done)} / ${grouped(files)} файлов`, `${Math.min(100, Math.floor((done / files) * 100))} %`);
  } else if (files !== undefined) parts.push(`${grouped(files)} файлов`);
  if (note.attempt) parts.push(note.attempt);
  parts.push(clock(note.elapsedMs));
  return parts.join(' · ');
}

/** Состояния подготовки по тредам (в памяти сервера; после хода удаляется). */
export class PrepTracker {
  private readonly states = new Map<string, PrepState>();
  private readonly now: () => number;
  private readonly label: (hostId: string) => string;
  constructor(now: () => number, label: (hostId: string) => string) { this.now = now; this.label = label; }
  begin(threadId: string, input: Parameters<typeof beginPrep>[0]): void { this.states.set(threadId, beginPrep(input, this.now())); }
  event(threadId: string, event: SyncProgressEvent): void {
    const state = this.states.get(threadId);
    if (state) this.states.set(threadId, applyPrep(state, event, this.now(), this.label));
  }
  attempt(threadId: string, text: string | null): void {
    const state = this.states.get(threadId);
    if (state) this.states.set(threadId, withAttempt(state, text));
  }
  end(threadId: string): void { this.states.delete(threadId); }
  note(threadId: string): PrepNote | null {
    const state = this.states.get(threadId);
    return state ? prepNote(state, this.now()) : null;
  }
}
