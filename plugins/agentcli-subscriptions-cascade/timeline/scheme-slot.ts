// Место схемы каскада в ленте. Саму схему (кнопка «i») делает работа по
// профилям; она регистрирует компонент здесь, а лента показывает его в
// раскрытой строке переключения. Пока компонента нет — встроенная мини-цепочка
// «откуда → куда» (views.tsx, FallbackScheme).
import type { ComponentType } from 'react';
import type { StageRef } from './contract.ts';

export interface CascadeSchemeProps {
  threadId: string;
  /** Ступень, с которой ушли (если известна). */
  fromStepId?: string;
  /** Ступень, на которой идёт ход. */
  activeStepId?: string;
  from?: StageRef;
  to?: StageRef;
  /** Компактный вид для ленты. */
  compact: true;
}

let scheme: ComponentType<CascadeSchemeProps> | null = null;

/** Вызывается из app.tsx работой по профилям: registerCascadeScheme(CascadeScheme). */
export function registerCascadeScheme(component: ComponentType<CascadeSchemeProps> | null): void {
  scheme = component;
}

export function cascadeScheme(): ComponentType<CascadeSchemeProps> | null {
  return scheme;
}
