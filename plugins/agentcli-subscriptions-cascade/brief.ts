// Проверка задания Codex-подтреда (0.3.4). Чистые функции.
//
// Первый ход подтреда треда на профиле «Авто · подтреды на Codex» не
// запускается, пока в задании нет четырёх частей:
//   1. `/goal …` в первой непустой строке;
//   2. «Контекст» — файлы, ветка, что уже исключено;
//   3. «Как делать» — шаги;
//   4. «Критерии приёмки» — проверяемые пункты.
// Части 2–4 распознаются по заголовкам (рус/англ, регистр не важен, «ё» = «е»):
// строка-заголовок Markdown (`## Контекст`), жирная (`**Контекст**`) или с
// двоеточием (`Контекст:`). У раздела должно быть содержание — текст после
// двоеточия или строки до следующего заголовка.

export type BriefPart = 'goal' | 'context' | 'steps' | 'acceptance';

export interface BriefCheck {
  ok: boolean;
  /** Недостающие части в порядке шаблона. */
  missing: BriefPart[];
  /** Части, у которых заголовок есть, а содержания нет (входят и в missing). */
  empty: BriefPart[];
}

export const BRIEF_PART_TITLES: Record<BriefPart, string> = {
  goal: '`/goal …` в первой строке — результат и критерий готовности',
  context: '«Контекст» — файлы, ветка, что уже исключено',
  steps: '«Как делать» — шаги работы',
  acceptance: '«Критерии приёмки» — проверяемые пункты',
};

/** Названия разделов (после нормализации: нижний регистр, «ё» → «е»); длинные — раньше. */
const HEADINGS: Record<Exclude<BriefPart, 'goal'>, readonly string[]> = {
  context: ['контекст', 'context', 'background'],
  steps: ['порядок работы', 'как делать', 'план работы', 'шаги', 'план', 'how to do it', 'how to', 'procedure', 'approach', 'steps', 'plan'],
  acceptance: ['критерии приемки', 'критерии готовности', 'критерии', 'приемка', 'acceptance criteria', 'definition of done', 'acceptance', 'done when'],
};

const normalize = (s: string) => s.toLowerCase().replace(/ё/gu, 'е').replace(/\s+/gu, ' ').trim();

/**
 * Разбор строки как заголовка раздела: `## Контекст`, `**Контекст**`,
 * `Контекст:`, `**Контекст:** текст`, `1. Контекст (файлы):`. Возвращает часть
 * и текст после заголовка на той же строке; null — не заголовок. Обычная
 * строка без маркера считается заголовком, только если после названия идёт
 * двоеточие или тире либо строка состоит из одного названия.
 */
export function headingOf(line: string): { part: Exclude<BriefPart, 'goal'>; rest: string } | null {
  const raw = line.trim();
  if (!raw) return null;
  const markdown = /^#{1,6}\s/u.test(raw);
  let s = raw.replace(/^#{1,6}\s+/u, '').replace(/^\d+[.)]\s+/u, '');
  const bold = /^(\*\*|__)/u.test(s);
  s = normalize(s.replace(/^(\*\*|__)\s*/u, ''));
  for (const part of Object.keys(HEADINGS) as Exclude<BriefPart, 'goal'>[]) {
    for (const name of HEADINGS[part]) {
      if (!s.startsWith(name)) continue;
      let tail = s.slice(name.length);
      // Граница слова: «планы» — не «план».
      if (tail !== '' && !/^[\s:：—–(*_]/u.test(tail)) continue;
      tail = tail.replace(/^\s*\([^)]*\)/u, '');
      // «**Контекст** текст» / «**Контекст:** текст»: закрывающие звёздочки сразу после названия.
      const closed = bold ? tail.replace(/^\s*(\*\*|__)/u, '') : tail;
      const t = closed.replace(/^\s+/u, '');
      if (/^[:：—–]/u.test(t)) return { part, rest: t.slice(1).replace(/^[\s*_]+/u, '').trim() };
      if (markdown) return { part, rest: '' };
      if (bold) return { part, rest: closed !== tail ? t.trim() : '' };
      if (t === '') return { part, rest: '' };
    }
  }
  return null;
}

/** Первая непустая строка — `/goal <текст>`. */
export function hasGoal(text: string): boolean {
  const first = text.split(/\r?\n/u).find(l => l.trim() !== '');
  return first !== undefined && /^\s*\/goal\s+\S/iu.test(first);
}

export function checkBrief(text: string): BriefCheck {
  const lines = text.split(/\r?\n/u);
  const found = new Map<Exclude<BriefPart, 'goal'>, boolean>(); // часть → есть содержание
  let current: Exclude<BriefPart, 'goal'> | null = null;
  for (const line of lines) {
    const h = headingOf(line);
    if (h) {
      current = h.part;
      found.set(h.part, (found.get(h.part) ?? false) || h.rest !== '');
      continue;
    }
    // Новый заголовок Markdown другого смысла закрывает раздел.
    if (/^\s*#{1,6}\s+\S/u.test(line)) { current = null; continue; }
    if (current && line.trim() !== '') found.set(current, true);
  }
  const missing: BriefPart[] = [];
  const empty: BriefPart[] = [];
  if (!hasGoal(text)) missing.push('goal');
  for (const part of ['context', 'steps', 'acceptance'] as const) {
    if (!found.has(part)) missing.push(part);
    else if (!found.get(part)) { missing.push(part); empty.push(part); }
  }
  return { ok: missing.length === 0, missing, empty };
}

/** Шаблон задания для отказа и навыка. */
export const BRIEF_TEMPLATE = [
  '/goal <результат одной фразой>; готово, когда <проверяемое условие>',
  '',
  '## Контекст',
  '- файлы и ветка: …',
  '- что уже проверено или исключено: …',
  '',
  '## Как делать',
  '1. …',
  '2. …',
  '',
  '## Критерии приёмки',
  '- [ ] <команда или проверка> → <ожидаемый результат>',
  '- [ ] …',
].join('\n');

/** Текст отказа первого хода: что не хватает и шаблон. */
export function briefRefusalText(check: BriefCheck): string {
  const lines = check.missing.map(part => `- ${BRIEF_PART_TITLES[part]}${check.empty.includes(part) ? ' (заголовок есть, раздел пустой)' : ''}`);
  return [
    'Задание Codex-подтреда не принято (профиль родителя «Авто · подтреды на Codex»): не хватает частей —',
    ...lines,
    '',
    'Пришлите этому подтреду полное задание (`bb thread tell <подтред>`) или запустите новый подтред с заданием по шаблону:',
    '',
    BRIEF_TEMPLATE,
  ].join('\n');
}

// ---- Текст задания из событий треда ----

export interface BriefEventRow { seq: number; type: string; data: unknown }

const RETRY_CONTINUATION = /^\s*(?:please\s+)?continue[.!]?\s*$/iu;
type Json = Record<string, unknown>;
const rec = (v: unknown): Json => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Json : {};
const str = (v: unknown) => typeof v === 'string' ? v : '';

function requestText(data: Json): string {
  const input = Array.isArray(data.input) ? data.input as unknown[] : [];
  return input.map(i => rec(i)).filter(i => i.type === 'text').map(i => str(i.text)).join('\n').trim();
}

/**
 * Текст задания хода: последний запрос пользователя (`client/turn/requested`);
 * автоповтор BB («Please continue.», `retryOfRequestId`) — исходный запрос.
 * null — запросов нет.
 */
export function briefTextFromEvents(events: readonly BriefEventRow[]): string | null {
  const requests = [...events].filter(e => e.type === 'client/turn/requested').sort((a, b) => a.seq - b.seq);
  const byId = (id: string) => requests.find(e => str(rec(e.data).requestId) === id);
  for (let i = requests.length - 1; i >= 0; i -= 1) {
    let row = requests[i]!;
    for (let hop = 0; hop < 10; hop += 1) {
      const origin = str(rec(row.data).retryOfRequestId);
      const next = origin ? byId(origin) : undefined;
      if (!next) break;
      row = next;
    }
    const text = requestText(rec(row.data));
    if (text && !RETRY_CONTINUATION.test(text)) return text;
  }
  return null;
}
