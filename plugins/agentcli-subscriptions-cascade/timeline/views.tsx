// Чистые представления ленты: тело раскрытой строки, метка ступени и тела карточек.
// Без SDK — их же рисует стенд preview/ для скриншотов.
//
// Рамку карточки, точку внимания, заголовок и «Asked by the agent through …»
// рисует хост BB (PendingInteractionShell); форма даёт только тело. Шапку строки
// ленты тоже рисует хост из presentation; здесь — то, что видно по клику.
import { useState, type ReactNode } from 'react';
import type { ConfirmAnswer, ConfirmRequest, DecisionAnswer, DecisionRequest, RoutePayload, RouteState, StageRef, StepTiming } from './contract.ts';
import { bytes, clock, files, plural, step, until } from './format.ts';
import { stageShort, totalMs } from './presentation.ts';

const full = (s: StageRef) => [s.machine, s.provider, s.account, s.model].filter(Boolean).join(' · ');

// ---------------- Тело раскрытой строки ----------------

export interface RouteDetailsProps {
  payload: RoutePayload;
  now: number;
  timeZone?: string;
  /** Схема каскада (CascadeDiagram на данных движка); null — простая цепочка. */
  renderScheme?: ((close: () => void) => ReactNode) | null;
  /** Начальное состояние схемы (для стенда). */
  schemeOpen?: boolean;
}

export function RouteDetails({ payload, now, timeZone, renderScheme, schemeOpen: initial = false }: RouteDetailsProps) {
  const [schemeOpen, setSchemeOpen] = useState(initial);
  const at = (ms: number) => clock(ms, timeZone);

  if (payload.type !== 'switch') {
    const lines = payload.type === 'wait'
      ? [payload.until ? `До ${at(payload.until)} (${until(payload.until, now)})` : null, payload.note ?? null]
      : [payload.stage ? full(payload.stage) : null, payload.note ?? null];
    return <div className="asc-tl-body">{lines.filter(Boolean).map(l => <p key={l} className="asc-tl-line">{l}</p>)}</div>;
  }

  const reason = {
    limit: `лимит ${payload.window ?? ''} исчерпан${payload.resetAt ? `, сброс в ${at(payload.resetAt)}` : ''}`.replace('  ', ' '),
    return: `${payload.window ?? 'приоритетная ступень'} снова доступна`,
    unavailable: `${payload.from?.machine ?? 'машина'} не отвечает`,
    auth: `вход в CLI на ${payload.from?.machine ?? 'машине'} истёк`,
    error: 'сбой прежней ступени',
    manual: 'выбор владельца',
    start: 'первый ход треда на этой ступени',
  }[payload.reason];

  return (
    <div className="asc-tl-body">
      <p className="asc-tl-line asc-tl-route">
        {payload.from && <><span>{full(payload.from)}</span><span className="asc-tl-arrow" aria-hidden> → </span></>}
        <span className="asc-tl-strong">{full(payload.to)}</span>
      </p>
      <p className="asc-tl-line">{cap(reason)}{payload.handoff ? ` · ${payload.handoff}` : ''}</p>
      {payload.sync && (
        <p className="asc-tl-line">
          Передано {files(payload.sync.files)}{payload.sync.bytes !== undefined ? `, ${bytes(payload.sync.bytes)}` : ''}{payload.sync.full ? ' — первая полная синхронизация' : ''}
          {payload.sync.sample?.length ? <>: {payload.sync.sample.slice(0, 4).map((p, i) => <span key={p}>{i ? ', ' : ''}<code>{p}</code></span>)}{payload.sync.files > 4 ? ' …' : ''}</> : null}
        </p>
      )}
      {payload.state === 'running' && payload.sync?.done !== undefined && payload.sync.files > 0 && (
        <div className="asc-tl-progress" role="progressbar" aria-valuemin={0} aria-valuemax={payload.sync.files} aria-valuenow={payload.sync.done}>
          <span style={{ width: `${Math.min(100, (payload.sync.done / payload.sync.files) * 100)}%` }} />
        </div>
      )}
      {payload.verify === 'mismatch' && payload.mismatches?.length ? (
        <p className="asc-tl-line asc-tl-bad">Копии разошлись: {payload.mismatches.slice(0, 4).map((p, i) => <span key={p}>{i ? ', ' : ''}<code>{p}</code></span>)}</p>
      ) : null}
      {payload.error && <p className="asc-tl-line asc-tl-bad">{payload.error}</p>}
      <Steps steps={payload.steps} />
      <button type="button" className="asc-tl-toggle" aria-expanded={schemeOpen} onClick={() => setSchemeOpen(v => !v)}>
        <span className="asc-tl-i" aria-hidden>i</span>{schemeOpen ? 'Скрыть схему каскада' : 'Схема каскада'}
      </button>
      {schemeOpen && <div className="asc-tl-scheme">{renderScheme ? renderScheme(() => setSchemeOpen(false)) : <ChainScheme from={payload.from} to={payload.to} />}</div>}
    </div>
  );
}

function Steps({ steps }: { steps: StepTiming[] }) {
  if (steps.length === 0) return null;
  const max = Math.max(...steps.map(s => s.ms), 1);
  return (
    <div className="asc-tl-steps">
      {steps.map((s, i) => (
        <div key={`${s.label}-${i}`} className={`asc-tl-step asc-tl-step-${s.state}`}>
          <span>{s.label}</span>
          <span className="asc-tl-bar" aria-hidden><span style={{ width: `${Math.max(2, (s.ms / max) * 100)}%` }} /></span>
          <span className="asc-tl-num">{s.state === 'running' ? '…' : s.state === 'failed' ? '✕' : step(s.ms)}</span>
        </div>
      ))}
      {steps.length > 1 && <div className="asc-tl-step asc-tl-step-total"><span>всего</span><span /><span className="asc-tl-num">{step(totalMs(steps))}</span></div>}
    </div>
  );
}

/** Простая цепочка, пока источник схемы (движок) не подключён. */
export function ChainScheme({ from, to }: { from: StageRef | null | undefined; to: StageRef | null | undefined }) {
  return (
    <p className="asc-tl-line">
      {from && <><s>{stageShort(from)}</s> → </>}
      {to ? <span className="asc-tl-strong">{stageShort(to)}</span> : '—'}
    </p>
  );
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------------- Метка ступени (сегмент контекста над полем ввода) ----------------

export function StageSummary({ state, expanded, onToggle }: { state: RouteState; expanded: boolean; onToggle(): void }) {
  if (!state.stage) return null;
  const live = state.phase === 'running' || state.phase === 'preparing';
  const hint = state.lastSync ? `Последняя синхронизация ${state.lastSync.from} → ${state.lastSync.to}: ${step(state.lastSync.ms)}${state.lastSync.verify === 'ok' ? ', сверка ✓' : ''}` : 'Ступень каскада';
  return (
    <button type="button" className={`asc-tl-stage${live ? ' asc-tl-stage-live' : ''}`} aria-expanded={expanded} onClick={onToggle} title={hint}>
      <svg viewBox="0 0 16 16" aria-hidden className="asc-tl-stage-icon"><path d="M2.5 5h10M10 2.5 12.5 5 10 7.5M13.5 11h-10M6 8.5 3.5 11 6 13.5" /></svg>
      <span>{stageShort(state.stage)}</span>
    </button>
  );
}

// ---------------- Тело карточки подтверждения ----------------

export interface ConfirmFormViewProps {
  request: ConfirmRequest;
  timeZone?: string;
  onAnswer(answer: ConfirmAnswer): void | Promise<void>;
  /** Для стенда: начальный срок. */
  initialScope?: ConfirmRequest['defaultScope'];
}

export function ConfirmFormView({ request, timeZone, onAnswer, initialScope }: ConfirmFormViewProps) {
  const [scope, setScope] = useState(initialScope ?? request.defaultScope);
  const [sending, setSending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const base = { proposalId: request.proposalId, revision: request.revision };
  const send = async (answer: ConfirmAnswer) => {
    if (sending) return;
    setSending(answer.action); setError(null);
    try { await onAnswer(answer); } catch (e) { setError(e instanceof Error ? e.message : String(e)); setSending(null); }
  };
  const preview = request.preview;
  const carried = [
    request.handoff,
    preview?.decisions ? plural(preview.decisions, 'решение', 'решения', 'решений') : null,
    preview?.files ? files(preview.files) : null,
    preview?.attachments?.length ? preview.attachments.join(', ') : null,
    preview?.note ?? null,
  ].filter(Boolean).join(' · ');
  const scopes = [
    ['turn', 'На этот ход', 'Только этот ход. Следующий снова спросит.'],
    ['thread', request.threadUntil ? `В треде до ${clock(request.threadUntil, timeZone)}` : 'В треде до сброса', 'Повторные переходы в этом треде — без вопроса, до сброса лимита.'],
    ['forever', 'Всегда', request.allowForever ? 'Правило для этой ступени в проекте, включая новые треды. Отозвать — в настройках каскада.' : 'Для этой ступени выключено в настройках.'],
  ] as const;

  return (
    <div className="asc-tl-form">
      <p className="asc-tl-form-text">
        {request.from && !request.continuing && <><span className="asc-tl-strong">{stageShort(request.from)}</span>: </>}
        {request.reason}.
      </p>
      {carried && <p className="asc-tl-form-muted">{carried}</p>}
      <div className="asc-tl-seg" role="radiogroup" aria-label="Срок согласия">
        {scopes.map(([id, label, hint]) => {
          const disabled = id === 'forever' && !request.allowForever;
          return (
            <button key={id} type="button" role="radio" aria-checked={scope === id} disabled={disabled || sending !== null}
              title={hint} className={scope === id ? 'asc-tl-seg-on' : undefined} onClick={() => setScope(id)}>{label}</button>
          );
        })}
      </div>
      <div className="asc-tl-form-actions">
        <button type="button" className="asc-tl-btn asc-tl-btn-primary" disabled={sending !== null} onClick={() => void send({ action: 'go', scope, ...base })}>
          {sending === 'go' ? 'Перехожу…' : 'Да'}
        </button>
        <button type="button" className="asc-tl-btn" disabled={sending !== null} onClick={() => void send({ action: 'wait', ...base })}>Ждать</button>
        <span className="asc-tl-spacer" />
        <button type="button" className="asc-tl-btn asc-tl-btn-ghost" disabled={sending !== null} onClick={() => void send({ action: 'skip', ...base })}>Пропустить ступень</button>
        <button type="button" className="asc-tl-btn asc-tl-btn-ghost" disabled={sending !== null} onClick={() => void send({ action: 'cancel', ...base })}>Отменить ход</button>
      </div>
      {error && <p className="asc-tl-form-error" role="alert">{error}</p>}
    </div>
  );
}

// ---------------- Тело карточки решения при сбое ----------------

export function DecisionFormView({ request, onAnswer }: { request: DecisionRequest; onAnswer(answer: DecisionAnswer): void | Promise<void> }) {
  const [sending, setSending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const send = async (action: DecisionAnswer['action']) => {
    if (sending) return;
    setSending(action); setError(null);
    try { await onAnswer({ action, proposalId: request.proposalId, revision: request.revision }); } catch (e) { setError(e instanceof Error ? e.message : String(e)); setSending(null); }
  };
  return (
    <div className="asc-tl-form">
      <p className="asc-tl-form-text">{request.message}</p>
      {request.stage && <p className="asc-tl-form-muted">{full(request.stage)}</p>}
      <div className="asc-tl-form-actions">
        {request.actions.map((a, i) => (
          <button key={a.id} type="button" className={`asc-tl-btn${i === 0 ? ' asc-tl-btn-primary' : ''}`} disabled={sending !== null} onClick={() => void send(a.id)}>
            {sending === a.id ? '…' : a.label}
          </button>
        ))}
      </div>
      {error && <p className="asc-tl-form-error" role="alert">{error}</p>}
    </div>
  );
}
