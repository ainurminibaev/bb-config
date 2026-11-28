// Форматирование для строк ленты: секунды с запятой, часы, длительности, склонения.
// Часовой пояс — у зрителя: сервер и мост передают моменты в мс, текст строит
// presentation (на мосту, в поясе машины) и рендерер (в браузере владельца).

export function seconds(ms: number): string {
  const value = ms / 1000;
  return `${value.toLocaleString('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} с`;
}

/** Шаг тайминга: 30 мс · 0,6 с. */
export function step(ms: number): string {
  return ms < 100 ? `${Math.round(ms)} мс` : seconds(ms);
}

/** 0,6 с · 14 с · 2 мин 05 с · 1 ч 12 мин */
export function duration(ms: number): string {
  if (ms < 10_000) return seconds(ms);
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total} с`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} мин ${String(total % 60).padStart(2, '0')} с`;
  return `${Math.floor(minutes / 60)} ч ${minutes % 60} мин`;
}

export function clock(ms: number, timeZone?: string): string {
  return new Date(ms).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone });
}

/** «≈12 мин» до момента; прошедший момент — «сейчас». */
export function until(ms: number, now: number): string {
  const minutes = Math.round((ms - now) / 60_000);
  if (minutes <= 0) return 'сейчас';
  if (minutes < 60) return `≈${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  return `≈${hours} ч${minutes % 60 ? ` ${minutes % 60} мин` : ''}`;
}

export function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10, mod100 = n % 100;
  const word = mod10 === 1 && mod100 !== 11 ? one : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? few : many;
  return `${n.toLocaleString('ru-RU')} ${word}`;
}

export const files = (n: number) => plural(n, 'файл', 'файла', 'файлов');

export function bytes(n: number): string {
  if (n < 1024) return `${n} Б`;
  const units = ['КБ', 'МБ', 'ГБ'];
  let value = n / 1024, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toLocaleString('ru-RU', { maximumFractionDigits: value < 10 ? 1 : 0 })} ${units[unit]}`;
}

/** «Mac · Claude · Opus 5.5» — только заполненные части. */
export function stageLabel(stage: { machine: string; provider?: string; account?: string; model?: string }, parts: ('provider' | 'account' | 'model')[] = ['model']): string {
  return [stage.machine, ...parts.map(p => stage[p])].filter(Boolean).join(' · ');
}
