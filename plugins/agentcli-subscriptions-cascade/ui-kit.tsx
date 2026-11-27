// Мелкие элементы экрана настроек: переключатель, подсказка «?», свёрнутая
// секция, полоска лимита и перетаскивание (мышью и стрелками с клавиатуры).
// Только разметка и классы asc-*; цвета — переменные темы BB в app.css.
import { useId, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import type { QuotaState } from './contract.ts';

/** Тон по состоянию лимита: зелёный, красный, жёлтый, серый. */
export type Tone = 'ok' | 'bad' | 'warn' | 'off';
export const toneOf = (state: QuotaState | undefined): Tone =>
  state === 'available' ? 'ok' : state === 'exhausted' ? 'bad' : state === 'unavailable' ? 'off' : 'warn';

export function Switch({ checked, label, onChange }: { checked: boolean; label: string; onChange(v: boolean): void }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} title={label}
      className={`asc-switch ${checked ? 'asc-switch-on' : ''}`} onClick={() => onChange(!checked)}>
      <span className="asc-switch-knob" />
    </button>
  );
}

/** Кнопка «?» с всплывающим пояснением при наведении и фокусе. */
export function Hint({ children }: { children: string }) {
  const id = useId();
  return (
    <span className="asc-hint">
      <button type="button" className="asc-hint-btn" aria-describedby={id} aria-label="Пояснение">?</button>
      <span role="tooltip" id={id} className="asc-hint-pop">{children}</span>
    </span>
  );
}

/** Свёрнутая секция: заголовок с однострочным резюме, тело — по щелчку. */
export function Disclosure({ title, summary, tone, open, onToggle, children }: {
  title: string; summary: string; tone?: 'warn' | 'muted'; open: boolean; onToggle(): void; children: ReactNode;
}) {
  const id = useId();
  return (
    <section className={`asc-disc ${open ? 'asc-disc-open' : ''}`}>
      <h3 className="asc-disc-h">
        <button type="button" className="asc-disc-head" aria-expanded={open} aria-controls={id} onClick={onToggle}>
          <span className="asc-chev" aria-hidden="true" />
          <span className="asc-disc-title">{title}</span>
          <span className={`asc-disc-sum ${tone === 'warn' ? 'asc-warn-text' : ''}`}>
            {tone === 'warn' && <span className="asc-warn-mark" aria-hidden="true">!</span>}{summary}
          </span>
        </button>
      </h3>
      {open && <div id={id} className="asc-disc-body">{children}</div>}
    </section>
  );
}

/** Полоска остатка: ширина — остаток в процентах, цвет — состояние лимита. */
export function Gauge({ remaining, tone }: { remaining: number | null; tone: Tone }) {
  if (remaining === null) return <span className={`asc-dot asc-tone-${tone}`} aria-hidden="true" />;
  const value = Math.max(0, Math.min(100, Math.round(remaining)));
  return (
    <span className={`asc-gauge asc-tone-${tone}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value} aria-label={`Остаток ${value} %`}>
      <i style={{ width: `${value}%` }} />
    </span>
  );
}

export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  if (to < 0 || to >= items.length || from === to) return [...items];
  const out = [...items];
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item!);
  return out;
}

/**
 * Перетаскивание внутри одного списка. Возвращает свойства для строки (приём)
 * и для ручки (захват мышью, стрелки ↑/↓ с клавиатуры).
 */
export function useReorder(onMove: (from: number, to: number) => void) {
  const [from, setFrom] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  return {
    dragging: from,
    over,
    row: (index: number) => ({
      onDragOver: (e: DragEvent) => { if (from !== null) { e.preventDefault(); setOver(index); } },
      onDrop: (e: DragEvent) => { e.preventDefault(); if (from !== null && from !== index) onMove(from, index); setFrom(null); setOver(null); },
    }),
    handle: (index: number, focusKey: string) => ({
      draggable: true,
      'data-grip': focusKey,
      onDragStart: (e: DragEvent) => { setFrom(index); e.dataTransfer.effectAllowed = 'move'; },
      onDragEnd: () => { setFrom(null); setOver(null); },
      onKeyDown: (e: KeyboardEvent) => {
        const delta = e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : 0;
        if (delta === 0) return;
        e.preventDefault();
        onMove(index, index + delta);
        // Строка переезжает в DOM — возвращаем фокус ручке той же записи.
        requestAnimationFrame(() => (document.querySelector(`[data-grip="${CSS.escape(focusKey)}"]`) as HTMLElement | null)?.focus());
      },
    }),
  };
}
