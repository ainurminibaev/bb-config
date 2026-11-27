// Строки для ленты треда из замеров синхронизации (рисует лента, timeline/).
// Формат flush совпадает со status-lines.ts: «Mac → Tru: flush 0,6 с ✓».
import type { SyncResult, SyncTiming } from './orchestrator.ts';

const seconds = (n: number) => n.toFixed(n < 10 ? 1 : 0).replace('.', ',');

const TITLES: Record<SyncTiming['step'], string> = {
  mount: 'папка проекта в общем пути',
  create: 'сессии Mutagen',
  quarantine: 'карантин опоздавших записей',
  'env-read': 'права .env',
  align: 'выравнивание',
  resume: 'включение синхронизации',
  flush: 'flush',
  health: 'проверка конфликтов',
  locks: 'lock-файлы git',
  'resolve-index': 'конфликт .git/index',
  'env-restore': 'возврат 0600 для .env',
  pause: 'пауза синхронизации',
  snapshot: 'снимок дерева',
  warm: 'тёплый режим',
};

/** Видимые шаги: длительные или с результатом. Мелкие успешные (меньше 0,3 с без деталей) скрываются. */
export function timingLines(timings: readonly SyncTiming[], label: (hostId: string) => string): string[] {
  return timings
    .filter(t => !t.ok || t.step === 'flush' || t.step === 'align' || t.step === 'create' || t.detail || t.seconds >= 0.3)
    .map(t => {
      const where = t.from && t.to ? `${label(t.from)} → ${label(t.to)}` : label(t.hostId);
      return `${where}: ${TITLES[t.step]} ${seconds(t.seconds)} с ${t.ok ? '✓' : '✗'}${t.detail ? ` — ${t.detail}` : ''}`;
    });
}

/** Итог шага синхронизации одной строкой: сумма времени или причина отказа. */
export function summaryLine(result: SyncResult, label: (hostId: string) => string, phase: 'prepare' | 'finish'): string {
  const total = result.timings.reduce((sum, t) => sum + t.seconds, 0);
  if (!result.ok) return `Синхронизация: ${result.message}${result.conflicts.length ? ` (${result.conflicts.slice(0, 5).join(', ')})` : ''}`;
  const hosts = [...new Set(result.timings.map(t => label(t.hostId)))].join(', ');
  return `${phase === 'prepare' ? 'Файлы готовы к ходу' : 'Изменения на опоре'} за ${seconds(total)} с${hosts ? ` (${hosts})` : ''} ✓`;
}
