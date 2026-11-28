// payload строки → presentation моста. Шапку строки (одна строка в свёрнутом
// виде, вес «Thought 8s») рисует хост BB из presentation — и на вебе, и на
// телефоне, и когда фронтенд плагина ещё не загружен. Хост красит tint только
// значок, подпись остаётся приглушённой: строки ленты всегда тихие. Заметное —
// карточки над полем ввода (confirm-step, decide).
import { routeGlyph, type RoutePayload, type StageRef, type StepTiming, type SwitchPayload } from './contract.ts';
import { clock, files, seconds, step } from './format.ts';

export interface RoutePresentation {
  label: { pending: string; completed: string };
  icon: { glyph: string };
  title?: string;
  detail?: string;
  tint?: { light: string; dark: string };
}

/** Значок сбоя — цвет destructive-text темы BB. */
export const ERROR_TINT = { light: '#b42318', dark: '#f07c6c' };

export interface PresentationContext { now: number; timeZone?: string }

const MAX_LABEL = 120;
const MAX_DETAIL = 600;
const cut = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

/** «Mac · Opus» — машина и модель; без модели — только машина. */
export const stageShort = (stage: StageRef) => [stage.machine, stage.model].filter(Boolean).join(' · ');

export const totalMs = (steps: readonly StepTiming[]) => steps.reduce((sum, s) => sum + s.ms, 0);

/** Начало подписи перехода: откуда и почему. */
function switchHead(p: SwitchPayload): string {
  const from = p.from?.machine ?? '';
  switch (p.reason) {
    case 'limit': return `${from} исчерпан`;
    case 'return': return `${p.window ?? p.to.account ?? p.to.machine} свободен`;
    case 'unavailable': return `${from} не на связи`;
    case 'auth': return `Вход на ${from} истёк`;
    case 'error': return `Сбой на ${from}`;
    case 'manual': return 'Выбор владельца';
    case 'start': return 'Ход';
  }
}

/** Куда: при возврате — только машина («→ Tru»), иначе машина и модель. */
const switchTarget = (p: SwitchPayload) => (p.reason === 'return' ? p.to.machine : stageShort(p.to));

export function routeLabel(payload: RoutePayload, ctx: PresentationContext): { pending: string; completed: string } {
  const at = (ms: number) => clock(ms, ctx.timeZone);
  switch (payload.type) {
    case 'switch': {
      const head = payload.reason === 'start' ? `Ход на ${stageShort(payload.to)}` : `${switchHead(payload)} → ${switchTarget(payload)}`;
      if (payload.state === 'failed') {
        return same(`Не перешёл на ${payload.to.machine}${payload.error ? `: ${payload.error}` : ''}`);
      }
      const total = totalMs(payload.steps);
      return { pending: `${head}…`, completed: total > 0 ? `${head} · ${seconds(total)}` : head };
    }
    case 'wait': {
      const base = {
        reset: `Жду сброса ${payload.window ?? 'лимита'}`,
        offline: `Жду ${payload.machine ?? 'машину'}`,
        recheck: 'Квота неизвестна · перепроверка',
      }[payload.cause];
      const time = payload.until ? ` · ${at(payload.until)}` : '';
      return { pending: `${base}${time}`, completed: payload.outcome ? `${base} · ${payload.outcome}` : base };
    }
    case 'problem':
      return same(payload.resolution ? `${payload.message} · ${payload.resolution}` : payload.message);
  }
}

/** Короткий Markdown для тела строки без рендерера (телефон, плагин выгружен). */
export function routeDetail(payload: RoutePayload, ctx: PresentationContext): string | undefined {
  const lines: string[] = [];
  const full = (s: StageRef) => [s.machine, s.provider, s.account, s.model].filter(Boolean).join(' · ');
  switch (payload.type) {
    case 'switch':
      lines.push(`${payload.from ? `${full(payload.from)} → ` : ''}${full(payload.to)}`);
      if (payload.resetAt) lines.push(`Сброс ${clock(payload.resetAt, ctx.timeZone)}`);
      if (payload.handoff) lines.push(payload.handoff);
      if (payload.sync) lines.push(`Синхронизация: ${files(payload.sync.files)}`);
      if (payload.steps.length) lines.push(payload.steps.map(s => `${s.label} ${step(s.ms)}`).join(' · '));
      if (payload.mismatches?.length) lines.push(`Расходятся: ${payload.mismatches.slice(0, 5).map(p => `\`${p}\``).join(', ')}`);
      break;
    case 'wait':
    case 'problem':
      if (payload.note) lines.push(payload.note);
      break;
  }
  const detail = lines.join('\n\n');
  return detail ? cut(detail, MAX_DETAIL) : undefined;
}

export function isFailure(payload: RoutePayload): boolean {
  return payload.type === 'problem' || (payload.type === 'switch' && payload.state === 'failed');
}

export function routePresentation(payload: RoutePayload, ctx: PresentationContext): RoutePresentation {
  const label = routeLabel(payload, ctx);
  const presentation: RoutePresentation = {
    label: { pending: cut(label.pending, MAX_LABEL), completed: cut(label.completed, MAX_LABEL) },
    icon: { glyph: routeGlyph(isFailure(payload) ? 'problem' : payload.type === 'wait' ? 'wait' : 'switch') },
  };
  const detail = routeDetail(payload, ctx);
  if (detail) presentation.detail = detail;
  if (isFailure(payload)) presentation.tint = ERROR_TINT;
  return presentation;
}

const same = (value: string) => ({ pending: value, completed: value });
