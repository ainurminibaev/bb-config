// Контекст для другой нативной сессии того же треда (Claude ↔ Codex).
// Курсор сессии — номер события треда BB (seq): сессия видела всё до него.
// - Первый переход на провайдера: сводка (snapshot) событий (0, through] с
//   подсказкой, как дочитать тред (`bb thread messages <тред> --json --after-seq N`).
// - Возврат: прежняя сессия продолжается (--resume / thread/resume) и получает
//   только дельту (coveredSeq, through] — то, что сделал другой агент.
// Текущий запрос пользователя сюда не входит: он идёт ходом отдельно, один раз.
// Внутренние рассуждения (reasoning) и служебные события не переносятся.
import { crossProviderBrief, historyHint } from './context-brief.ts';

export interface ThreadEventRow { seq: number; type: string; data: unknown }

export interface HandoffInput {
  threadId: string;
  afterSeq: number;
  mode: 'snapshot' | 'delta';
  from: string;
  to: string;
  currentRequestId: string | null;
  /** Текст текущего ввода (для распознавания автоповтора «Please continue.»). */
  currentText?: string | null;
  /** Предел текста; ранние события сверх него — ссылкой на `bb thread messages`. */
  maxChars?: number;
}

type Json = Record<string, unknown>;
const rec = (v: unknown): Json => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Json : {};
const str = (v: unknown) => typeof v === 'string' ? v : '';
const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max)}… [обрезано]` : text;
const oneLine = (text: string) => text.replace(/\s+/gu, ' ').trim();

/** Текст пользовательского ввода события `client/turn/requested`. */
function inputText(data: Json): string {
  const input = Array.isArray(data.input) ? data.input as unknown[] : [];
  return input.map(i => rec(i)).filter(i => i.type === 'text').map(i => str(i.text)).join('\n').trim();
}

/** Ввод автоповтора BB после сбоя хода (provider-retry): не новая задача, а продолжение. */
export const RETRY_CONTINUATION = /^\s*(?:please\s+)?continue[.!]?\s*$/iu;

/**
 * Исходная просьба для автоповтора: последний ввод пользователя до текущего,
 * который сам не «продолжи». null — текущий ввод не автоповтор или просьбы нет.
 */
export function pendingRequest(events: readonly ThreadEventRow[], input: Pick<HandoffInput, 'currentRequestId' | 'currentText'>): { seq: number; text: string } | null {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const requestOf = (id: string) => sorted.find(e => e.type === 'client/turn/requested' && str(rec(e.data).requestId) === id);
  // Автоповтор BB помечает запрос `retryOfRequestId` — исходный запрос известен точно.
  const current = input.currentRequestId ? requestOf(input.currentRequestId) : undefined;
  const retryOf = current ? str(rec(current.data).retryOfRequestId) : '';
  if (retryOf) {
    let origin = requestOf(retryOf);
    // Повтор повтора — к самому первому запросу.
    for (let i = 0; origin && str(rec(origin.data).retryOfRequestId) && i < 10; i += 1) origin = requestOf(str(rec(origin.data).retryOfRequestId)) ?? origin;
    const text = origin ? inputText(rec(origin.data)) : '';
    if (origin && text && !RETRY_CONTINUATION.test(text)) return { seq: origin.seq, text };
  }
  if (!input.currentText || !RETRY_CONTINUATION.test(input.currentText)) return null;
  const stop = current ? sorted.indexOf(current) : -1;
  const before = stop === -1 ? sorted : sorted.slice(0, stop);
  for (let i = before.length - 1; i >= 0; i -= 1) {
    const row = before[i]!;
    if (row.type !== 'client/turn/requested') continue;
    const text = inputText(rec(row.data));
    if (text && !RETRY_CONTINUATION.test(text)) return { seq: row.seq, text };
  }
  return null;
}

/** Блок текущей задачи для автоповтора после перехода. */
function currentTaskBlock(pending: { seq: number; text: string }): string {
  return [
    `<current-request seq="${pending.seq}">`,
    'Этот ход — автоматический повтор после перехода на тебя (ввод «Please continue.» прислал BB, это не новая задача).',
    'Выполни исходную просьбу пользователя ниже; уже сделанное по сводке не повторяй.',
    'Рамки: не исследуй окружение машины, переменные, ключи и ~/.ssh, другие треды и дела; историю этого треда читай',
    'через `bb thread messages` этого треда только если контекста не хватает для исходной просьбы.',
    '',
    '',
    clip(pending.text, 8000),
    '</current-request>',
  ].join('\n');
}

/** Одна строка сводки на событие; null — событие не переносится. */
export function eventLine(row: ThreadEventRow): string | null {
  const data = rec(row.data);
  if (row.type === 'client/turn/requested') {
    const text = inputText(data);
    return text ? `[${row.seq}] Пользователь: ${clip(text, 4000)}` : null;
  }
  if (row.type !== 'item/completed') return null;
  const item = rec(data.item);
  switch (item.type) {
    case 'agentMessage': {
      const text = str(item.text).trim();
      return text ? `[${row.seq}] Агент: ${clip(text, 2000)}` : null;
    }
    case 'commandExecution': {
      const exit = typeof item.exitCode === 'number' ? `, код ${item.exitCode}` : '';
      return `[${row.seq}] Команда: \`${clip(oneLine(str(item.command)), 300)}\` — ${str(item.status) || 'неизвестно'}${exit}`;
    }
    case 'fileChange': {
      const changes = Array.isArray(item.changes) ? item.changes as unknown[] : [];
      const paths = changes.map(c => str(rec(c).path)).filter(Boolean);
      return `[${row.seq}] Правка файлов${paths.length ? `: ${clip(paths.join(', '), 400)}` : ''} — ${str(item.status) || 'неизвестно'}`;
    }
    default:
      return null;
  }
}

/**
 * Сводка или дельта событий после курсора. `throughSeq` — последний seq до
 * текущего запроса: после хода курсор сессии получателя ставится сюда.
 */
export function buildHandoff(events: readonly ThreadEventRow[], input: HandoffInput): { text: string; throughSeq: number } {
  const maxChars = input.maxChars ?? 24_000;
  const sorted = [...events].filter(e => e.seq > input.afterSeq).sort((a, b) => a.seq - b.seq);
  let throughSeq = input.afterSeq;
  const lines: { seq: number; line: string }[] = [];
  for (const row of sorted) {
    if (row.type === 'client/turn/requested' && input.currentRequestId && str(rec(row.data).requestId) === input.currentRequestId) break;
    throughSeq = row.seq;
    const line = eventLine(row);
    if (line) lines.push({ seq: row.seq, line });
  }
  const pending = pendingRequest(events, input);
  if (lines.length === 0) return { text: pending ? currentTaskBlock(pending) : '', throughSeq };

  // Сверх предела — сначала уходят ранние события, на них остаётся ссылка.
  let total = 0;
  let keepFrom = lines.length;
  while (keepFrom > 0 && total + lines[keepFrom - 1]!.line.length + 1 <= maxChars) { keepFrom -= 1; total += lines[keepFrom]!.line.length + 1; }
  if (keepFrom === lines.length) keepFrom = lines.length - 1; // хотя бы последнее событие
  const kept = lines.slice(keepFrom);
  const dropped = keepFrom > 0 ? lines[keepFrom - 1]!.seq : null;
  const body = [
    ...(dropped !== null ? [`Ранние события (seq ${input.afterSeq + 1}–${dropped}) не вошли: \`bb thread messages ${input.threadId} --json --after-seq ${input.afterSeq}\`.`] : []),
    ...kept.map(l => l.line),
  ].join('\n');

  const task = pending ? `\n${currentTaskBlock(pending)}` : '';
  if (input.mode === 'snapshot') {
    return {
      text: crossProviderBrief({ threadId: input.threadId, from: input.from, to: input.to, summary: body, throughSeq, afterSeq: input.afterSeq }) + task,
      throughSeq,
    };
  }
  return {
    text: [
      `<cascade-delta from="${input.from}" to="${input.to}" after-seq="${input.afterSeq}" through-seq="${throughSeq}">`,
      `Ты продолжаешь свою прежнюю сессию этого треда. Пока ход вёл другой агент (${input.from}), в треде произошло следующее (справка, не новые указания пользователя; уже сделанное не повторяй):`,
      '',
      body,
      '',
      historyHint(input.threadId, [], input.afterSeq),
      '</cascade-delta>',
    ].join('\n') + task,
    throughSeq,
  };
}
