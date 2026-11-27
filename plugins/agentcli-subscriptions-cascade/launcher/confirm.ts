// Карточка подтверждения в ходе. Сервер на решение движка `confirm` отвечает
// routeTurn → { action: 'confirm', prompt }. Запускатель (он внутри хода
// штатного моста) просит мост каскада показать карточку (`interaction/request`
// через timeline/ requestConfirmation), ждёт ответа сколько нужно, передаёт
// ответ серверу (answerConfirmation) и выбирает ступень заново:
//   «Перейти» — согласие со сроком (ход / тред до сброса / всегда) → ход идёт;
//   «Пропустить ступень» — следующая ступень этого же хода;
//   «Ждать прежнюю» — ход не идёт, ожидание сброса;
//   «Отменить ход», закрытая карточка — ход не идёт.
// Все карточки одного хода — с одним turnKey: разовое согласие и пропуски
// действуют на повторные routeTurn этого хода и не переходят на следующий.
import type { AnswerConfirmationOutput, ConfirmPrompt, RouteNote, RouteTurnOutput, RoutedTurn } from '../bridge/route-contract.ts';

/** Ответ моста на карточку. unavailable — карточку показать нельзя (нет моста или потока). */
export type BridgeAnswer =
  | { action: 'go'; scope: 'turn' | 'thread' | 'forever' }
  | { action: 'skip' | 'wait' | 'cancel' | 'dismissed' }
  | { action: 'unavailable'; reason: string };

export interface ConfirmPorts {
  routeTurn(turnKey: string): Promise<RouteTurnOutput>;
  ask(prompt: ConfirmPrompt, turnKey: string): Promise<BridgeAnswer>;
  answer(input: { stepId: string; turnKey: string; action: 'go' | 'skip' | 'wait' | 'cancel' | 'dismissed'; scope: 'turn' | 'thread' | 'forever' | null; threadUntil: number | null }): Promise<AnswerConfirmationOutput>;
  feed(notes: readonly RouteNote[]): Promise<void>;
  log(line: string): void;
}

/** Не больше карточек за ход: «Пропустить» по всем ступеням не зацикливается. */
export const MAX_CARDS_PER_TURN = 8;

export async function resolveRoute(ports: ConfirmPorts, turnKey: string): Promise<RoutedTurn> {
  for (let card = 0; card < MAX_CARDS_PER_TURN; card += 1) {
    const route = await ports.routeTurn(turnKey);
    if (route.action !== 'confirm') return route;
    await ports.feed(route.notes);
    const prompt = route.prompt;
    ports.log(`confirm ${prompt.stepId} turn=${turnKey}`);
    const answer = await ports.ask(prompt, turnKey);
    ports.log(`confirm answer ${answer.action}${answer.action === 'go' ? `/${answer.scope}` : ''}`);
    if (answer.action === 'unavailable') {
      const message = `Переход на ${prompt.to.machine}${prompt.to.provider ? ` · ${prompt.to.provider}` : ''} требует подтверждения, но карточку показать не удалось (${answer.reason}).`;
      return { action: 'refuse', retryable: false, message, notes: [{ kind: 'problem', message: message.slice(0, 300), stage: prompt.to, stepId: prompt.stepId }] };
    }
    const out = await ports.answer({
      stepId: prompt.stepId, turnKey, action: answer.action,
      scope: answer.action === 'go' ? answer.scope : null, threadUntil: prompt.threadUntil,
    });
    if (out.next === 'refuse') return { action: 'refuse', retryable: out.retryable, message: out.message, notes: out.notes };
    await ports.feed(out.notes);
  }
  const message = 'Слишком много карточек подтверждения в одном ходе — ход не начат.';
  return { action: 'refuse', retryable: false, message, notes: [{ kind: 'problem', message }] };
}

/** Разбор ответа моста из сокета (терпимо: неизвестное — unavailable). */
export function parseBridgeAnswer(value: unknown): BridgeAnswer {
  const v = value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
  if (v.action === 'go' && (v.scope === 'turn' || v.scope === 'thread' || v.scope === 'forever')) return { action: 'go', scope: v.scope };
  if (v.action === 'skip' || v.action === 'wait' || v.action === 'cancel' || v.action === 'dismissed') return { action: v.action };
  return { action: 'unavailable', reason: typeof v.reason === 'string' ? v.reason.slice(0, 200) : 'ответ моста не разобран' };
}
