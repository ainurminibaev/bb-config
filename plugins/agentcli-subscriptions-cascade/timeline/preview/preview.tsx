// Стенд ленты для макетов. Всё, что относится к каскаду, идёт через настоящий код:
// createRouteTimeline → thread/delta → свёртка по providerItemId (как проекция
// сервера BB) → шапка строки из presentation + тело RouteDetails; карточки —
// ConfirmFormView/DecisionFormView; схема — explainProfile через profilePreview и
// CascadeDiagram из profiles-view.tsx. Хостовые элементы BB (сообщения, «Thought»,
// команды, «Working…», поле ввода, рамка карточки) стенд только имитирует по
// классам apps/app (TimelineRowHeader, PendingInteractionShell).
import { useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { AUTO_MODEL_ID } from '../../contract.ts';
import { ACCOUNTS, MAC_CODEX, MAC_GW, TRU_MAX, UA_PRO, config as fixtureConfig } from '../../fixtures.ts';
import { healthFromState, profilePreview } from '../../profiles.ts';
import { CascadeDiagram } from '../../profiles-view.tsx';
import { confirmRequestSchema, decisionRequestSchema, type RoutePayload, type RouteState } from '../contract.ts';
import { confirmTitle, createRouteTimeline, type RouteDelta } from '../emitter.ts';
import type { RoutePresentation } from '../presentation.ts';
import { ConfirmFormView, DecisionFormView, RouteDetails, StageSummary } from '../views.tsx';
import '../../app.css';
import '../timeline.css';
import './preview.css';

const NOW = Date.UTC(2026, 11, 1, 12, 0, 0);
const MIN = 60_000;
const TZ = 'UTC';
const TRU = { machine: 'Tru', provider: 'Claude', account: 'Max', model: 'Opus' };
const MAC = { machine: 'Mac', provider: 'Claude', account: 'vclaude', model: 'Opus' };

interface Row { id: string; status: 'pending' | 'completed'; payload: RoutePayload; presentation: RoutePresentation; progress?: string }

function record(script: (t: ReturnType<typeof createRouteTimeline>) => void): { rows: Row[]; state: RouteState | null } {
  const rows = new Map<string, Row>();
  let state: RouteState | null = null;
  let n = 0;
  const timeline = createRouteTimeline({
    sink: (d: RouteDelta) => {
      if (d.kind === 'item.open') rows.set(d.key.providerItemId, { id: d.key.providerItemId, status: 'pending', payload: d.item.payload, presentation: d.presentation });
      if (d.kind === 'item.progress') { const r = rows.get(d.key.providerItemId); if (r) r.progress = d.message; }
      if (d.kind === 'item.close') rows.set(d.key.providerItemId, { id: d.key.providerItemId, status: 'completed', payload: d.item.payload, presentation: d.presentation });
      if (d.kind === 'extension.state') state = d.payload;
    },
    now: () => NOW, newId: () => `row${++n}`, timeZone: TZ, warn: w => console.warn(w),
  });
  script(timeline);
  return { rows: [...rows.values()], state };
}

// ---- Схема «i» настоящим движком: Tru исчерпан → ход на Mac; для карточки — Tru, Mac и UA исчерпаны → Codex с подтверждением ----
function scheme(exhausted: string[]) {
  const cfg = fixtureConfig();
  // Подписи машин как в ленте («Mac», а не «MacBook»).
  cfg.machines = cfg.machines.map(m => (m.label === 'MacBook' ? { ...m, label: 'Mac' } : m));
  const lookup = (stepId: string) => healthFromState(exhausted.includes(stepId) ? 'exhausted' : 'available', exhausted.includes(stepId) ? NOW + 220 * MIN : null);
  const p = profilePreview(cfg, AUTO_MODEL_ID, ACCOUNTS, lookup, NOW);
  return (close: () => void) => <CascadeDiagram name="Авто" attempts={p.attempts} text={p.text} draft={cfg} test={false} onClose={close} />;
}
const schemeSwitch = scheme([TRU_MAX]);
const schemeConfirm = scheme([TRU_MAX, MAC_GW, UA_PRO]);
void MAC_CODEX;

// ---- Сценарии через настоящий эмиттер ----
const normal = record(t => { t.emitRun(MAC, { stepId: MAC_GW, profileId: 'auto' }); t.emitFlush({ from: 'Mac', to: 'Tru', ms: 600, verify: 'ok' }); t.emitRun(MAC, { stepId: MAC_GW }); });

const switched = record(t => {
  const sw = t.emitSwitch({ reason: 'limit', window: 'Max', from: TRU, to: MAC, resetAt: NOW + 220 * MIN, stepId: MAC_GW, handoff: 'сессия Mac продолжена с событий 13–14' });
  sw.step('лимиты', 420); sw.step('пауза Tru', 110);
  const sync = t.emitSync({ from: 'Tru', to: 'Mac', files: 12, sample: ['src/engine.ts', 'src/limits.ts', 'docs/plan.md', 'package.json'] });
  sync.done({ ms: 2600, bytes: 48_300 });
  t.emitFlush({ from: 'Tru', to: 'Mac', ms: 370, verify: 'ok' });
  sw.done();
  t.emitRun(MAC, { stepId: MAC_GW }).end();
}).rows;

const returned = record(t => {
  const sw = t.emitSwitch({ reason: 'return', window: 'Max', from: MAC, to: TRU, stepId: TRU_MAX });
  t.emitFlush({ from: 'Mac', to: 'Tru', ms: 600, verify: 'ok' });
  sw.step('сверка', 140);
  sw.done();
}).rows;

const confirmRequest = confirmRequestSchema.parse({
  proposalId: 'prop_1', revision: 3, stepId: MAC_CODEX, continuing: false,
  from: TRU, to: { machine: 'Mac', provider: 'Codex', account: 'Рабочий', model: 'GPT-6.2' },
  reason: 'Max исчерпан до 15:40, vclaude и UA тоже на нуле',
  handoff: 'Новая сессия со сводкой', threadUntil: NOW + 220 * MIN,
  preview: { decisions: 2, files: 3, attachments: ['макет.png'] },
});
const decisionRequest = decisionRequestSchema.parse({
  proposalId: 'prop_2', revision: 1, title: 'Mac не на связи',
  message: 'Ход прерван посреди работы. Автоматически не повторяю: на Mac мог остаться незавершённый инструмент.',
  stage: MAC, actions: [{ id: 'retry', label: 'Повторить на Mac' }, { id: 'skip', label: 'Пропустить Mac' }, { id: 'cancel', label: 'Отменить ход' }],
});

// ---- Имитация хостовых элементов BB ----
function Glyph({ name, tint }: { name: string; tint?: { light: string; dark: string } }) {
  const file = name.split('/')[1]!.replace(/^route-/, '');
  const url = `url(icons/${file === 'error' ? 'error' : file}.svg)`;
  return <span className="bb-glyph" style={{ WebkitMaskImage: url, maskImage: url, ...(tint ? { color: `light-dark(${tint.light}, ${tint.dark})` } : {}) }} />;
}

function CascadeRow({ row, open: initial = false, renderScheme, schemeOpen }: { row: Row; open?: boolean; renderScheme?: (close: () => void) => ReactNode; schemeOpen?: boolean }) {
  const [open, setOpen] = useState(initial);
  const label = row.status === 'pending' ? row.presentation.label.pending : row.presentation.label.completed;
  return (
    <div className={`bb-row${open ? ' bb-row-open' : ''}`}>
      <button type="button" className="bb-row-head" aria-expanded={open} onClick={() => setOpen(v => !v)}>
        <Glyph name={row.presentation.icon.glyph} tint={row.presentation.tint} />
        <span className={`bb-row-label${row.status === 'pending' ? ' bb-shine' : ''}`}>{label}</span>
        <Chevron open={open} />
      </button>
      {open && <div className="bb-row-body"><RouteDetails payload={row.payload} now={NOW} timeZone={TZ} renderScheme={renderScheme} schemeOpen={schemeOpen} /></div>}
    </div>
  );
}

const Chevron = ({ open }: { open: boolean }) => (
  <svg viewBox="0 0 16 16" className={`bb-chev${open ? ' bb-chev-open' : ''}`} aria-hidden><path d="M6 4l4 4-4 4" /></svg>
);

function HostRow({ icon, children }: { icon?: 'terminal' | 'edit' | 'brain'; children: ReactNode }) {
  const paths = {
    terminal: 'M3 4.5 6 7.5 3 10.5M7.5 11h5',
    edit: 'M10.5 2.8 13.2 5.5 6 12.7H3.3V10Z',
    brain: 'M8 3v10M5.5 3.5a2.5 2.5 0 0 0-2 4 2.5 2.5 0 0 0 2 4.5M10.5 3.5a2.5 2.5 0 0 1 2 4 2.5 2.5 0 0 1-2 4.5',
  };
  return (
    <div className="bb-row">
      <div className="bb-row-head bb-row-static">
        {icon && <svg viewBox="0 0 16 16" className="bb-glyph bb-glyph-svg" aria-hidden><path d={paths[icon]} /></svg>}
        <span className="bb-row-label">{children}</span>
      </div>
    </div>
  );
}

const User = ({ children }: { children: ReactNode }) => <div className="bb-user">{children}</div>;
const Assistant = ({ children }: { children: ReactNode }) => <div className="bb-assistant">{children}</div>;
const Working = ({ label = 'Working...' }: { label?: string }) => <div className="bb-working"><span className="bb-shine">{label}</span></div>;

function Composer({ stage, card, stageExpanded, renderScheme }: { stage?: RouteState | null; card?: ReactNode; stageExpanded?: boolean; renderScheme?: (close: () => void) => ReactNode }) {
  const [expanded, setExpanded] = useState(stageExpanded ?? false);
  return (
    <div className="bb-composer-stack">
      {card}
      <div className="bb-context">
        <span className="bb-context-seg"><svg viewBox="0 0 16 16" className="bb-ctx-icon" aria-hidden><path d="M5 3v6a3 3 0 0 0 3 3h4M10 10l2 2-2 2" /></svg>bb/ui-thr_t5ikg</span>
        <span className="bb-context-seg">3 файла <span className="bb-add">+42</span> <span className="bb-del">−7</span></span>
        {stage && <StageSummary state={stage} expanded={expanded} onToggle={() => setExpanded(v => !v)} />}
      </div>
      {expanded && stage && renderScheme && <div className="bb-context-details"><div className="asc-tl-scheme">{renderScheme(() => setExpanded(false))}</div></div>}
      <div className="bb-composer">
        <span className="bb-placeholder">Сообщение…</span>
        <div className="bb-composer-foot">
          <span className="bb-pill"><img src="cascade-icon.svg" alt="" className="bb-pill-icon" />Каскад подписок · Авто</span>
          <span className="bb-pill">High</span>
          <span className="bb-send" aria-hidden>↑</span>
        </div>
      </div>
    </div>
  );
}

function InteractionShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="bb-shell">
      <div className="bb-shell-head"><span className="bb-dot" /><span className="bb-shell-title">{title}</span><span className="bb-shell-collapse" aria-hidden>⌄</span></div>
      <div className="bb-shell-body">
        <p className="bb-shell-origin">Asked by the agent through Каскад подписок [Experimental]</p>
        {children}
      </div>
    </section>
  );
}

function Frame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="bb-pane">
      <header className="bb-header"><span className="bb-header-title">{title}</span><span className="bb-header-meta">bb-config</span></header>
      <div className="bb-transcript">{children}</div>
    </div>
  );
}

// ---- Три состояния ----
function NormalTurn() {
  return (
    <Frame title="Лимиты перед ходом">
      <User>Добавь проверку лимитов перед ходом и прогони тесты.</User>
      <HostRow icon="brain">Thought 8s</HostRow>
      <HostRow icon="edit">Edited <code>engine.ts</code> <span className="bb-add">+24</span> <span className="bb-del">−3</span></HostRow>
      <HostRow icon="terminal">Ran <code>npm test</code></HostRow>
      <Assistant>Готово: проверка лимитов в <code>engine.ts</code>, все 46 тестов проходят.</Assistant>
      <User>Теперь собери плагин.</User>
      <HostRow icon="brain">Thought 3s</HostRow>
      <Working />
      <div className="bb-spacer" />
      <Composer stage={normal.state} />
    </Frame>
  );
}

function SwitchTurn({ expanded }: { expanded: boolean }) {
  return (
    <Frame title="Лимиты перед ходом">
      <User>Теперь собери плагин.</User>
      <CascadeRow row={switched[0]!} open={expanded} renderScheme={schemeSwitch} schemeOpen={expanded} />
      <HostRow icon="brain">Thought 5s</HostRow>
      <HostRow icon="terminal">Ran <code>bb plugin build</code></HostRow>
      <Assistant>Собрал: <code>dist/</code> обновлён, сборка без предупреждений.</Assistant>
      {!expanded && <>
        <User>Отлично, обнови README.</User>
        <CascadeRow row={returned[0]!} />
        <HostRow icon="brain">Thought 4s</HostRow>
        <HostRow icon="edit">Edited <code>README.md</code> <span className="bb-add">+6</span></HostRow>
        <Assistant>README обновлён.</Assistant>
      </>}
      <div className="bb-spacer" />
      <Composer stage={expanded ? { phase: 'idle', stage: MAC, at: NOW } : { phase: 'idle', stage: TRU, at: NOW }} />
    </Frame>
  );
}

function ConfirmTurn() {
  return (
    <Frame title="Лимиты перед ходом">
      <User>Продолжай рефакторинг движка.</User>
      <div className="bb-spacer" />
      <Composer stage={{ phase: 'waiting', stage: TRU, at: NOW }} card={
        <InteractionShell title={confirmTitle(confirmRequest)}>
          <ConfirmFormView request={confirmRequest} timeZone={TZ} onAnswer={a => console.log(a)} />
        </InteractionShell>
      } />
    </Frame>
  );
}

function ConfirmScheme() {
  return (
    <Frame title="Лимиты перед ходом">
      <User>Продолжай рефакторинг движка.</User>
      <div className="bb-spacer" />
      <Composer stage={{ phase: 'waiting', stage: TRU, at: NOW }} stageExpanded renderScheme={schemeConfirm} card={
        <InteractionShell title={confirmTitle(confirmRequest)}>
          <ConfirmFormView request={confirmRequest} timeZone={TZ} onAnswer={a => console.log(a)} />
        </InteractionShell>
      } />
    </Frame>
  );
}

function DecisionTurn() {
  return (
    <Frame title="Лимиты перед ходом">
      <User>Теперь собери плагин.</User>
      <CascadeRow row={switched[0]!} />
      <HostRow icon="brain">Thought 5s</HostRow>
      <HostRow icon="terminal">Ran <code>bb plugin build</code></HostRow>
      <div className="bb-spacer" />
      <Composer stage={{ phase: 'waiting', stage: MAC, at: NOW }} card={
        <InteractionShell title={decisionRequest.title}>
          <DecisionFormView request={decisionRequest} onAnswer={a => console.log(a)} />
        </InteractionShell>
      } />
    </Frame>
  );
}

function App() {
  const params = new URLSearchParams(location.search);
  const view = params.get('view') ?? 'normal';
  document.documentElement.className = params.get('theme') === 'dark' ? 'dark' : 'light';
  switch (view) {
    case 'switch': return <SwitchTurn expanded={false} />;
    case 'switch-open': return <SwitchTurn expanded />;
    case 'confirm': return <ConfirmTurn />;
    case 'confirm-scheme': return <ConfirmScheme />;
    case 'decision': return <DecisionTurn />;
    default: return <NormalTurn />;
  }
}

createRoot(document.getElementById('root')!).render(<App />);
