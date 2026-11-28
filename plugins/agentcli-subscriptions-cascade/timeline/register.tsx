// Фронтенд ленты. В app.tsx плагина — одна строка: registerTimelineApp(app).
// - строки своего провайдера (experimental_timelineRenderer): тело по клику;
// - карточки над полем ввода (pendingInteraction): confirm-step и decide;
// - метка ступени «Mac · Opus» (threadContextSegment над полем ввода и строка
//   threadContextCardRow, когда BB показывает карточку контекста) со схемой «i».
//   Внутри шапки треда SDK маленьких значков не даёт: threadHeaderRow — строка
//   во всю ширину, threadHeaderTitle заменяет заголовок у всех тредов.
import { useEffect, useState } from 'react';
import {
  experimental_ThreadContextCardRow, experimental_THREAD_INFO_ROW_GROUPS, experimental_useThreadContextKind,
  experimental_useThreadExtensionState, useRpc,
  type ExperimentalThreadContextCardProps, type ExperimentalThreadContextSegmentProps, type PluginAppBuilder,
  type PluginPendingInteractionProps, type PluginTimelineRendererProps,
} from '@get-bb/plugin-sdk/app';
import type { CascadeConfig } from '../contract.ts';
import type { ExplainedAttempt } from '../engine.ts';
import { CascadeDiagram } from '../profiles-view.tsx';
import {
  CONFIRM_FORM_ID, DECISION_FORM_ID, ROUTE_KIND, confirmRequestSchema, decisionRequestSchema, routePayloadSchema, routeStateSchema,
  type RouteState, type timelineRpcContract,
} from './contract.ts';
import { stageShort } from './presentation.ts';
import type { ThreadScheme as SchemeData } from './server.ts';
import { ChainScheme, ConfirmFormView, DecisionFormView, RouteDetails, StageSummary } from './views.tsx';
import './timeline.css';

const ContextCardRow = experimental_ThreadContextCardRow;

/** Пока строка открыта, «≈12 мин» обновляется. */
function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  return now;
}

/** Схема «i» треда: план движка с текущими лимитами (RPC threadScheme) в CascadeDiagram. */
function ThreadScheme({ threadId, fallback, onClose }: { threadId: string; fallback: RouteState['stage']; onClose(): void }) {
  const rpc = useRpc<typeof timelineRpcContract>();
  const [scheme, setScheme] = useState<SchemeData | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    rpc.call('threadScheme', { threadId }).then(s => { if (alive) setScheme(s); }, () => { if (alive) setScheme(null); });
    return () => { alive = false; };
  }, [rpc, threadId]);
  if (scheme === undefined) return <p className="asc-tl-line">Схема…</p>;
  if (scheme === null) return <ChainScheme from={null} to={fallback} />;
  return (
    <CascadeDiagram name={scheme.name} text={scheme.text} test={scheme.test} onClose={onClose}
      attempts={scheme.attempts as unknown as ExplainedAttempt[]} draft={scheme.config as unknown as CascadeConfig}
      subthreads={scheme.subthreads ? { ...scheme.subthreads, attempts: scheme.subthreads.attempts as unknown as ExplainedAttempt[] } : null} />
  );
}

function RouteRow({ row, payload, thread, Original }: PluginTimelineRendererProps) {
  const now = useNow(row.status === 'pending');
  const parsed = routePayloadSchema.safeParse(payload);
  // Незнакомая (более новая) форма payload — штатное тело хоста, а не пустая строка.
  if (!parsed.success) return <Original />;
  const to = parsed.data.type === 'switch' ? parsed.data.to : null;
  return <RouteDetails payload={parsed.data} now={now} renderScheme={close => <ThreadScheme threadId={thread.id} fallback={to} onClose={close} />} />;
}

/** Хост отдаёт `request.data` как payload; терпимо принимаем и полный `{ kind, title, data }`. */
function formData(payload: unknown): unknown {
  const raw = payload as Record<string, unknown> | null;
  return raw && typeof raw === 'object' && raw.data && typeof raw.data === 'object' ? raw.data : raw;
}

const Unreadable = () => <p className="asc-tl-form-error">Карточка каскада не читается — обновите плагин. Ход ждёт.</p>;

function ConfirmForm({ interaction, submit }: PluginPendingInteractionProps) {
  const parsed = confirmRequestSchema.safeParse(formData(interaction.payload));
  return parsed.success ? <ConfirmFormView request={parsed.data} onAnswer={answer => submit(answer)} /> : <Unreadable />;
}

function DecisionForm({ interaction, submit }: PluginPendingInteractionProps) {
  const parsed = decisionRequestSchema.safeParse(formData(interaction.payload));
  return parsed.success ? <DecisionFormView request={parsed.data} onAnswer={answer => submit(answer)} /> : <Unreadable />;
}

function useRouteState(threadId: string): RouteState | null {
  const raw = experimental_useThreadExtensionState(threadId, ROUTE_KIND);
  const parsed = routeStateSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function StageSegment({ threadId, isExpanded, onToggle }: ExperimentalThreadContextSegmentProps) {
  const state = useRouteState(threadId);
  return state ? <StageSummary state={state} expanded={isExpanded} onToggle={onToggle} /> : null;
}

function StageSegmentDetails({ threadId, isExpanded, onToggle }: ExperimentalThreadContextSegmentProps) {
  const state = useRouteState(threadId);
  if (!isExpanded || !state) return null;
  return <div className="asc-tl-stage-details"><ThreadScheme threadId={threadId} fallback={state.stage} onClose={onToggle} /></div>;
}

function StageCardRow({ threadId }: ExperimentalThreadContextCardProps) {
  const state = useRouteState(threadId);
  const [open, setOpen] = useState(false);
  if (!state?.stage) return null;
  return (
    <>
      <ContextCardRow icon="ArrowLeftRight" label={stageShort(state.stage)} title="Ступень каскада · схема по клику"
        trailing={state.phase === 'running' ? 'ход' : state.phase === 'waiting' ? 'ждёт' : undefined} onClick={() => setOpen(v => !v)} />
      {open && <div className="asc-tl-stage-details"><ThreadScheme threadId={threadId} fallback={state.stage} onClose={() => setOpen(false)} /></div>}
    </>
  );
}

export function registerTimelineApp(app: PluginAppBuilder): void {
  app.slots.experimental_timelineRenderer({ kind: ROUTE_KIND, component: RouteRow });
  app.slots.pendingInteraction({ id: CONFIRM_FORM_ID, component: ConfirmForm });
  app.slots.pendingInteraction({ id: DECISION_FORM_ID, component: DecisionForm });
  app.slots.experimental_threadContextSegment({
    id: 'cascade-stage', title: 'Ступень каскада', group: '1_thread', order: 90,
    summary: StageSegment, details: StageSegmentDetails,
    // В режиме карточки контекста метку рисует строка карточки — без дубля.
    useVisible: ({ threadId }) => {
      const kind = experimental_useThreadContextKind();
      return kind === 'banner' && useRouteState(threadId)?.stage != null;
    },
  });
  app.slots.experimental_threadContextCardRow({ id: 'cascade-stage', group: experimental_THREAD_INFO_ROW_GROUPS.environment, order: 90, component: StageCardRow });
}
