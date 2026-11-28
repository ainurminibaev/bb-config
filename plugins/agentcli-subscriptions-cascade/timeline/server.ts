// Серверная часть ленты: RPC схемы каскада для метки ступени и порт карточек
// через bb.ui.requestInput для пути A (relay), где своего моста нет.
// В server.ts плагина — одна строка: const timeline = registerTimelineServer(bb).
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { CONFIRM_FORM_ID, CONFIRM_KIND, DECISION_FORM_ID, routeGlyph, timelineRpcContract, type ConfirmAnswer, type DecisionAnswer } from './contract.ts';
import type { AskResult, CardInteraction } from './emitter.ts';
import { ERROR_TINT, stageShort } from './presentation.ts';

/** Ответ RPC threadScheme: данные для CascadeDiagram (profiles-view.tsx). */
export interface ThreadScheme { name: string; text: string; test: boolean; attempts: unknown[]; config: unknown; subthreads?: { attempts: unknown[]; text: string; note: string } }
export type ThreadSchemeProvider = (threadId: string) => Promise<ThreadScheme | null> | ThreadScheme | null;

export interface TimelineServer {
  /**
   * Источник схемы для треда: тот же движок, что выбирает ступень (explainProfile
   * с состоянием треда и лимитами монитора). Подключает исполнитель или сервер.
   * Без источника метка ступени показывает простую цепочку «откуда → куда».
   */
  provideScheme(provider: ThreadSchemeProvider): () => void;
}

export function registerTimelineServer(bb: Pick<BbPluginApi, 'rpc' | 'log'>): TimelineServer {
  let provider: ThreadSchemeProvider | null = null;
  bb.rpc.register(timelineRpcContract, {
    threadScheme: async ({ threadId }) => {
      if (!provider) return null;
      try {
        const scheme = await provider(threadId);
        return scheme ? (JSON.parse(JSON.stringify(scheme)) as never) : null;
      } catch (error) {
        bb.log.warn(`схема каскада для ${threadId}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    },
  });
  return {
    provideScheme(next) {
      provider = next;
      return () => { if (provider === next) provider = null; };
    },
  };
}

type RequestInput = BbPluginApi['ui']['requestInput'];

/**
 * ask для createRouteTimeline на сервере: те же формы confirm-step и decide, но
 * через bb.ui.requestInput. Отмена формы и истечение срока → dismissed (ход ждёт).
 */
export function serverAskPort(ui: { requestInput: RequestInput }, threadId: string, options: { timeoutMs?: number } = {}) {
  return async (request: CardInteraction, signal: AbortSignal): Promise<AskResult> => {
    const confirm = request.kind === CONFIRM_KIND;
    const subject = confirm ? stageShort(request.data.to) : request.title;
    const result = await ui.requestInput({
      threadId,
      rendererId: confirm ? CONFIRM_FORM_ID : DECISION_FORM_ID,
      title: request.title,
      payload: request.data,
      timeoutMs: options.timeoutMs ?? 7 * 24 * 3_600_000,
      presentation: {
        label: confirm
          ? { pending: `Жду подтверждения: ${subject}`, completed: `Подтверждение: ${subject}` }
          : { pending: `Жду решения: ${subject}`, completed: subject },
        icon: { glyph: routeGlyph(confirm ? 'confirm' : 'problem') },
        ...(confirm ? {} : { tint: ERROR_TINT }),
      },
      describeSubmission: value => ({ title: describeAnswer(value, request) }),
    }, { signal });
    if (result.outcome === 'submitted') return result.value;
    return { dismissed: result.reason === 'timeout' ? 'timeout' : 'cancelled' };
  };
}

/** Подпись строки после ответа: «Mac · Codex — в треде до сброса», «Повторить». */
export function describeAnswer(value: unknown, request: CardInteraction): string {
  if (request.kind === CONFIRM_KIND) {
    const answer = value as Partial<ConfirmAnswer> | null;
    const to = stageShort(request.data.to);
    switch (answer?.action) {
      case 'go': return `${to} — ${{ turn: 'на этот ход', thread: 'в треде до сброса', forever: 'навсегда' }[answer.scope ?? 'turn']}`;
      case 'skip': return `${to} пропущена`;
      case 'wait': return 'Жду прежнюю ступень';
      case 'cancel': return 'Ход отменён';
      default: return request.title;
    }
  }
  const answer = value as Partial<DecisionAnswer> | null;
  const chosen = request.data.actions.find(a => a.id === answer?.action);
  return chosen ? `${request.title} · ${chosen.label}` : request.title;
}
