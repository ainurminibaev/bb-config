// Экран настроек «Каскада подписок»: чистое представление (состояние → разметка).
// Данные и сохранение — в app.tsx через useRpc; здесь только черновик и колбэки,
// поэтому экран рендерится и вне BB (предпросмотр/скриншот).
//
// Устройство экрана — прогрессивное раскрытие: сверху сводка «куда пойдёт ход»
// и цепочка ступеней, ниже строки ступеней и список профилей; машины, модели,
// файлы и редкие правила — свёрнутыми секциями с резюме в заголовке.
import { useId, useState } from 'react';
import type { CascadeConfig, CascadeState, CellStatus, Machine, ModelRow, Step, SyncMode, WizardPlanStep } from './contract.ts';
import { attemptLabel, previewLookup, profilePreview, providerShort } from './profiles.ts';
import { ModelPriority, ProfilesView, TestQuotaView } from './profiles-view.tsx';
import { PROBLEM_STATUSES, WIZARD_IDS, changedPolicies, limitLine, remainingPercent, sectionSummaries, stepCustomized, type SectionId } from './settings-summary.ts';
import { Disclosure, Gauge, Hint, Switch, moveItem, toneOf, useReorder, type Tone } from './ui-kit.tsx';

export type { SectionId } from './settings-summary.ts';

export interface SettingsActions {
  setDraft(next: CascadeConfig): void;
  save(): void;
  refresh(): void;
  adopt(): void;
  runWizard(dryRun: boolean, mode?: { hostIds?: string[]; recheck?: boolean; reset?: boolean; allowSsh?: string[] }): void;
  showPlan(hostId: string): void;
}

export interface SettingsViewProps {
  state: CascadeState;
  draft: CascadeConfig;
  dirty: boolean;
  busy: string | null;
  plans: Readonly<Record<string, WizardPlanStep[]>>;
  actions: SettingsActions;
  /** Момент превью профилей; по умолчанию — сейчас. */
  now?: number;
  /** Открытая схема «i» при первом показе (предпросмотр экрана). */
  initialInfo?: string | null;
  /** Раскрытая карточка профиля при первом показе (предпросмотр экрана). */
  initialProfile?: string | null;
  /** Раскрытые секции при первом показе (предпросмотр экрана). */
  initialSections?: readonly SectionId[];
}

const PROVIDER_LABELS: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex', 'gemini-cli': 'Gemini CLI' };
const providerLabel = (id: string) => PROVIDER_LABELS[id] ?? id;
const PROBLEM_CELL: Partial<Record<CellStatus, string>> = {
  unmatched: 'не найдено', ambiguous: 'несколько вариантов', missing: 'нет в каталоге', blocked: 'недоступна на этой ступени',
};
const CELL_TITLE: Record<CellStatus, string> = {
  auto: 'сопоставлено автоматически', manual: 'указано вручную', unmatched: 'не найдено — укажите ID',
  ambiguous: 'несколько вариантов — выберите', missing: 'ID нет в каталоге машины', 'no-cli': 'на машине нет этого CLI', unknown: 'каталог ещё не получен',
  blocked: 'модель недоступна на этой ступени (тариф) — ход идёт на ту же модель на другой ступени или на следующую модель; перепроверка раз в сутки',
};
const WIZARD_LABELS: Record<string, string> = { probe: 'Машина', folder: 'Папка', mutagen: 'Mutagen', ssh: 'SSH до опоры', verify: 'Проверка' };
const RESET_CONFIRM = 'Настроить с нуля: снять сессии Mutagen каскада, убрать выданные каскадом ключи из authorized_keys опоры и сбросить шаги мастера. Файлы проектов и общий путь не трогаются. Продолжить?';

export function SettingsView({ state, draft, dirty, busy, plans, actions, now, initialInfo, initialProfile, initialSections }: SettingsViewProps) {
  const [open, setOpen] = useState<ReadonlySet<SectionId>>(new Set(initialSections ?? []));
  const [reordering, setReordering] = useState(false);
  const [openStep, setOpenStep] = useState<string | null>(null);
  const toggle = (id: SectionId) => setOpen(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const set = (patch: Partial<CascadeConfig>) => actions.setDraft({ ...draft, ...patch });
  const machineLabel = (hostId: string) => draft.machines.find(m => m.hostId === hostId)?.label ?? hostId;
  const at = now ?? Date.now();
  const reorder = useReorder((from, to) => set({ steps: moveItem(draft.steps, from, to) }));

  // Сводка: решение движка для профиля по умолчанию (первого включённого).
  const lead = draft.profiles.find(p => p.enabled) ?? null;
  const preview = lead ? profilePreview(draft, lead.id, state.accounts, previewLookup(draft, state.stepLimits), at) : null;
  const decision = preview?.decision;
  const chosenStep = decision && (decision.kind === 'run' || decision.kind === 'confirm') ? decision.stepId : null;
  const chosen = decision && (decision.kind === 'run' || decision.kind === 'confirm')
    ? preview!.attempts.find(a => a.stepId === decision.stepId && a.modelId === decision.modelId && a.skip === null) : undefined;
  const headline = chosen ? attemptLabel(draft, chosen) : preview ? preview.text.replace(/^сейчас ход пошёл бы на: /, '') : 'нет включённых профилей';

  const summaries = sectionSummaries(state, draft);
  const stepLabel = (step: Step) => step.label || state.accounts.find(a => a.hostId === step.hostId && a.providerId === step.providerId)?.plan || providerShort(step.providerId);

  return (
    <div className="asc-root">
      {state.issues.length > 0 && (
        <div className="asc-issues" role="status">{state.issues.map(i => <p key={i}>{i}</p>)}</div>
      )}

      <section className="asc-hero" aria-labelledby="asc-hero-h">
        <p id="asc-hero-h" className="asc-hero-label">Сейчас ход пошёл бы на</p>
        <p className="asc-hero-target">
          <span>{headline}</span>
          {decision?.kind === 'confirm' && <span className="asc-tag asc-tag-warn">после подтверждения</span>}
        </p>
        {lead && <p className="asc-hero-profile">Профиль «{lead.name}»</p>}
        <ol className="asc-chain" aria-label="Порядок ступеней">
          {draft.steps.filter(s => s.enabled && draft.machines.find(m => m.hostId === s.hostId)?.enabled !== false).map(step => {
            const tone = toneOf(state.stepLimits[step.id]?.state);
            const isNow = step.id === chosenStep;
            return (
              <li key={step.id} className={`asc-link-chip asc-tone-${tone} ${isNow ? 'asc-link-now' : ''}`}
                title={`${machineLabel(step.hostId)} · ${providerLabel(step.providerId)} — ${state.stepLimits[step.id]?.text ?? 'лимит не прочитан'}`}>
                <span className={`asc-dot asc-tone-${tone}`} aria-hidden="true" />
                <span>{machineLabel(step.hostId)} · {step.providerId === 'codex' ? 'Codex' : stepLabel(step)}</span>
                {isNow && <span className="asc-visually-hidden"> — ход сейчас</span>}
              </li>
            );
          })}
        </ol>
        <div className="asc-row">
          <button type="button" className="asc-btn" aria-pressed={reordering} onClick={() => {
            setReordering(!reordering);
            if (!reordering) requestAnimationFrame(() => (document.querySelector('[data-grip^="step:"]') as HTMLElement | null)?.focus());
          }}>{reordering ? 'Готово' : 'Изменить порядок'}</button>
          {/* Вход в мастер из шапки экрана: раскрывает «Машины» и продолжает настройку. */}
          <button type="button" className="asc-btn asc-primary" disabled={busy !== null || draft.machines.every(m => !m.enabled)} onClick={() => {
            if (!open.has('machines')) toggle('machines');
            actions.runWizard(false);
          }}>Настроить</button>
        </div>
      </section>

      <section className="asc-section" aria-labelledby="asc-steps-h">
        <h3 id="asc-steps-h" className="asc-h">Ступени <Hint>Ступень — машина × CLI × аккаунт. Ход идёт на первую включённую с лимитом. Профили берут этот порядок, если не задали свой.</Hint></h3>
        {draft.steps.length === 0
          ? <div className="asc-empty"><p className="asc-muted">Ступеней нет.</p><button type="button" className="asc-btn" disabled={busy !== null} onClick={actions.adopt}>Добавить найденное</button></div>
          : (
            <ol className={`asc-list ${reordering ? 'asc-reordering' : ''}`}>
              {draft.steps.map((step, index) => (
                <StepRow key={step.id} step={step} index={index} total={draft.steps.length}
                  machine={machineLabel(step.hostId)} accountLabel={stepLabel(step)}
                  account={state.accounts.find(a => a.hostId === step.hostId && a.providerId === step.providerId)}
                  limits={state.stepLimits[step.id]} readiness={state.readiness?.[step.id]} now={at} reordering={reordering} over={reorder.over === index}
                  row={reorder.row(index)} handle={reorder.handle(index, `step:${step.id}`)}
                  open={openStep === step.id} onToggle={() => setOpenStep(openStep === step.id ? null : step.id)}
                  onChange={next => set({ steps: draft.steps.map((s, i) => i === index ? next : s) })}
                  onMove={delta => set({ steps: moveItem(draft.steps, index, index + delta) })} />
              ))}
            </ol>
          )}
      </section>

      <section className="asc-section" aria-labelledby="asc-profiles-h">
        <h3 id="asc-profiles-h" className="asc-h">Профили <Hint>Профиль — пункт в списке моделей провайдера «Каскад». Первый включённый — по умолчанию. «i» — схема каскада по текущим лимитам.</Hint></h3>
        <ProfilesView state={state} draft={draft} set={set} now={at} initialInfo={initialInfo ?? null} initialOpen={initialProfile ?? null} />
      </section>

      <div className="asc-discs">
        <Disclosure title="Машины" summary={summaries.machines.text} tone={summaries.machines.tone} open={open.has('machines')} onToggle={() => toggle('machines')}>
          <Machines state={state} draft={draft} busy={busy} plans={plans} actions={actions} set={set} />
        </Disclosure>
        <Disclosure title="Модели" summary={summaries.models.text} tone={summaries.models.tone} open={open.has('models')} onToggle={() => toggle('models')}>
          <ModelPriority draft={draft} set={set} />
          <ModelTable draft={draft} state={state} onChange={models => set({ models })} />
        </Disclosure>
        <Disclosure title="Файлы" summary={summaries.files.text} tone={summaries.files.tone} open={open.has('files')} onToggle={() => toggle('files')}>
          <Files state={state} draft={draft} set={set} />
        </Disclosure>
        <Disclosure title="Дополнительно" summary={summaries.advanced.text} tone={summaries.advanced.tone} open={open.has('advanced')} onToggle={() => toggle('advanced')}>
          <Advanced draft={draft} set={set} />
        </Disclosure>
      </div>

      {(dirty || busy) && (
        <div className="asc-savebar" role="status">
          <span className={busy ? 'asc-muted' : ''}>{busy ? `${busy}…` : 'Есть несохранённые изменения'}</span>
          <button type="button" className="asc-btn asc-primary" disabled={!dirty || busy !== null} onClick={actions.save}>Сохранить</button>
        </div>
      )}
    </div>
  );
}

// ---- Ступени ----

function StepRow({ step, index, total, machine, accountLabel, account, limits: summary, readiness, now, reordering, over, row, handle, open, onToggle, onChange, onMove }: {
  step: Step; index: number; total: number; machine: string; accountLabel: string; now: number;
  readiness?: { ready: boolean; reason: string | null } | undefined;
  account: CascadeState['accounts'][number] | undefined;
  limits: CascadeState['stepLimits'][string] | undefined;
  reordering: boolean; over: boolean;
  row: ReturnType<ReturnType<typeof useReorder>['row']>; handle: ReturnType<ReturnType<typeof useReorder>['handle']>;
  open: boolean; onToggle(): void; onChange(next: Step): void; onMove(delta: number): void;
}) {
  const cliProblem = account && !account.installed ? 'CLI не установлен' : account && !account.loggedIn ? 'CLI не залогинен' : null;
  const tone: Tone = cliProblem ? 'bad' : toneOf(summary?.state);
  const line = limitLine(summary, now);
  const text = cliProblem ?? line.text;
  const remaining = cliProblem ? null : summary?.state === 'exhausted' ? 0 : remainingPercent(account, step) ?? line.remaining;
  const name = `${machine} · ${providerLabel(step.providerId)}`;
  const nonDefault = stepCustomized(step);
  return (
    <li className={`asc-item ${step.enabled ? '' : 'asc-off'} ${over ? 'asc-drop' : ''}`} {...row}>
      <div className="asc-line asc-step-line">
        <button type="button" className="asc-grip" aria-label={`Переместить ступень ${name}: стрелки вверх и вниз`} title="Перетащите, чтобы поменять порядок" {...handle}>⋮⋮</button>
        {reordering
          ? <span className="asc-move">
              <button type="button" className="asc-icon" disabled={index === 0} onClick={() => onMove(-1)} aria-label={`${name} выше`}>↑</button>
              <button type="button" className="asc-icon" disabled={index === total - 1} onClick={() => onMove(1)} aria-label={`${name} ниже`}>↓</button>
            </span>
          : <span className="asc-num" aria-hidden="true">{index + 1}</span>}
        <span className="asc-step-name">
          <b>{machine}</b><span className="asc-muted"> · </span>{providerLabel(step.providerId)}
          {accountLabel && accountLabel !== providerShort(step.providerId) && <span className="asc-muted"> · {accountLabel}</span>}
          {step.confirm && <span className="asc-tag" title="Перед входом спрашивает владельца">спросит</span>}
          {readiness && !readiness.ready && <span className="asc-tag asc-tag-warn" title={`${readiness.reason ?? ''} · bb subscriptions-cascade check --step ${step.id}`}>не готова</span>}
        </span>
        <span className={`asc-limit asc-tone-text-${tone}`} title={cliProblem ?? summary?.text ?? text}>
          <Gauge remaining={remaining} tone={tone} />
          <span className="asc-limit-text">{text}</span>
        </span>
        <Switch checked={step.enabled} label={`Ступень ${name} включена`} onChange={v => onChange({ ...step, enabled: v })} />
        <button type="button" className={`asc-more ${nonDefault ? 'asc-more-mark' : ''}`} aria-expanded={open} aria-label={`Параметры ступени ${name}${nonDefault ? ' (изменены)' : ''}`} title="Параметры" onClick={onToggle}>⋯</button>
      </div>
      {open && (
        <div className="asc-step-more">
          <label className="asc-field"><span>Подпись аккаунта</span>
            <input value={step.label} placeholder={account?.account ?? account?.plan ?? 'как в CLI'} onChange={e => onChange({ ...step, label: e.target.value })} />
          </label>
          <label className="asc-field"><span>Тип</span>
            <select value={step.authority} onChange={e => onChange({ ...step, authority: e.target.value as Step['authority'] })}>
              <option value="subscription">Подписка</option>
              <option value="gateway">API-шлюз</option>
            </select>
          </label>
          <label className="asc-field"><span>Источник квоты</span>
            <select value={step.quotaSource} onChange={e => onChange({ ...step, quotaSource: e.target.value as Step['quotaSource'] })}>
              <option value="provider">Штатно (BB)</option>
              <option value="vclaude">Пакет vclaude</option>
            </select>
          </label>
          <label className="asc-field"><span>Квота неизвестна</span>
            <select value={step.onUnknown} onChange={e => onChange({ ...step, onUnknown: e.target.value as Step['onUnknown'] })}>
              <option value="skip">Пропускать</option>
              <option value="try">Пробовать</option>
            </select>
          </label>
          <label className="asc-field"><span>Одновременных ходов</span>
            <input type="number" min={1} max={64} placeholder="без лимита" value={step.maxConcurrent ?? ''}
              onChange={e => { const n = Number.parseInt(e.target.value, 10); onChange({ ...step, maxConcurrent: Number.isFinite(n) && n >= 1 ? Math.min(n, 64) : null }); }} />
          </label>
          <label className="asc-field"><span>Ступень занята</span>
            <select value={step.onBusy} disabled={step.maxConcurrent === null} onChange={e => onChange({ ...step, onBusy: e.target.value as Step['onBusy'] })}>
              <option value="wait">Ждать места</option>
              <option value="next">Следующая ступень</option>
            </select>
          </label>
          <div className="asc-row asc-span">
            <Switch checked={step.confirm} label="Спрашивать перед входом" onChange={v => onChange({ ...step, confirm: v })} />
            <span>Спрашивать перед входом</span>
            <Hint>Профиль может переопределить это для себя.</Hint>
          </div>
        </div>
      )}
    </li>
  );
}

// ---- Машины ----

function Machines({ state, draft, busy, plans, actions, set }: {
  state: CascadeState; draft: CascadeConfig; busy: string | null; plans: Readonly<Record<string, WizardPlanStep[]>>;
  actions: SettingsActions; set(patch: Partial<CascadeConfig>): void;
}) {
  return (
    <div className="asc-stack">
      <ul className="asc-list">
        {draft.machines.map((m, index) => (
          <MachineRow key={m.hostId} machine={m} host={state.hosts.find(h => h.hostId === m.hostId)} wizard={state.wizard.find(w => w.hostId === m.hostId)}
            onChange={next => set({ machines: draft.machines.map((x, i) => i === index ? next : next.anchor && x.anchor ? { ...x, anchor: false } : x) })}
            onPlan={() => actions.showPlan(m.hostId)} plan={plans[m.hostId]} busy={busy !== null}
            onRun={mode => actions.runWizard(false, { hostIds: [m.hostId], ...mode })} />
        ))}
      </ul>
      <div className="asc-row">
        <button type="button" className="asc-btn asc-primary" disabled={busy !== null || draft.machines.every(m => !m.enabled)} onClick={() => actions.runWizard(false)}>
          {state.wizard.some(w => Object.values(w.steps).some(st => st.status !== 'done' && st.status !== 'skipped')) ? 'Продолжить настройку' : 'Настроить машины'}
        </button>
        <button type="button" className="asc-btn" disabled={busy !== null} onClick={() => actions.runWizard(false, { recheck: true })}>Перепроверить всё</button>
        <button type="button" className="asc-btn asc-btn-quiet" disabled={busy !== null} onClick={() => { if (window.confirm(RESET_CONFIRM)) actions.runWizard(false, { reset: true }); }}>Настроить с нуля</button>
        <button type="button" className="asc-btn asc-btn-quiet" disabled={busy !== null} onClick={() => actions.runWizard(true)}>Предпросмотр шагов</button>
        <Hint>Папка, Mutagen, SSH до опоры, проверка — по очереди. Мастер идёт на сервере: можно закрыть экран, повтор продолжит с места остановки. Тот же мастер — `bb subscriptions-cascade setup`.</Hint>
      </div>
      <div className="asc-row">
        <button type="button" className="asc-btn asc-btn-quiet" disabled={busy !== null} onClick={actions.refresh}>Обновить обнаружение</button>
        <button type="button" className="asc-btn asc-btn-quiet" disabled={busy !== null} onClick={actions.adopt}>Добавить найденное</button>
      </div>
    </div>
  );
}

function MachineRow({ machine, host, wizard, onChange, onPlan, plan, busy, onRun }: {
  machine: Machine; host: CascadeState['hosts'][number] | undefined; wizard: CascadeState['wizard'][number] | undefined;
  onChange(next: Machine): void; onPlan(): void; plan: WizardPlanStep[] | undefined;
  busy: boolean; onRun(mode: { recheck?: boolean; reset?: boolean; allowSsh?: string[] }): void;
}) {
  const platform = host?.platform && host.platform !== 'unknown' ? host.platform : machine.platform;
  const done = WIZARD_IDS.filter(id => ['done', 'skipped'].includes(wizard?.steps[id]?.status ?? '')).length;
  const failed = WIZARD_IDS.find(id => wizard?.steps[id]?.status === 'failed' || wizard?.steps[id]?.status === 'manual');
  return (
    <li className={`asc-item ${machine.enabled ? '' : 'asc-off'}`}>
      <div className="asc-line asc-machine-line">
        <Switch checked={machine.enabled} label={`Машина ${machine.label} в каскаде`} onChange={v => onChange({ ...machine, enabled: v })} />
        <span className={`asc-dot ${host?.connected ? 'asc-tone-ok' : 'asc-tone-bad'}`} role="img" aria-label={host?.connected ? 'на связи' : 'не на связи'} />
        <input className="asc-inline-input asc-machine-name" aria-label="Имя машины" value={machine.label} onChange={e => onChange({ ...machine, label: e.target.value })} />
        <span className="asc-muted">{platformLabel(platform)}</span>
        <input className="asc-inline-input asc-mono" aria-label={`Общий путь на ${machine.label}`} value={machine.sharedPath} onChange={e => onChange({ ...machine, sharedPath: e.target.value })} />
        <label className="asc-radio" title="Опора — эталон файлов после хода на другой машине">
          <input type="radio" name="asc-anchor" checked={machine.anchor} onChange={() => onChange({ ...machine, anchor: true })} />опора
        </label>
        <button type="button" className={`asc-link ${failed ? 'asc-warn-text' : ''}`} aria-expanded={!!plan} onClick={onPlan}
          title={WIZARD_IDS.map(id => `${WIZARD_LABELS[id]}: ${wizard?.steps[id]?.status ?? 'pending'}`).join(', ')}>
          {failed ? `${WIZARD_LABELS[failed]}: нужна помощь` : `настроено ${done}/${WIZARD_IDS.length}`}
        </button>
      </div>
      {wizard?.pendingConsent && (
        <div className="asc-plan">
          <p className="asc-warn-text asc-small-text">{wizard.pendingConsent.text}</p>
          <code className="asc-small-text">{wizard.pendingConsent.publicKey}</code>
          <div className="asc-row">
            <button type="button" className="asc-btn asc-primary" disabled={busy} onClick={() => onRun({ allowSsh: [machine.hostId] })}>Разрешить вход по ключу</button>
          </div>
        </div>
      )}
      <div className="asc-row asc-small-text">
        <button type="button" className="asc-link" disabled={busy} onClick={() => onRun({})}>Продолжить</button>
        <button type="button" className="asc-link" disabled={busy} onClick={() => onRun({ recheck: true })}>Перепроверить</button>
        <button type="button" className="asc-link" disabled={busy} onClick={() => { if (window.confirm(RESET_CONFIRM)) onRun({ reset: true }); }}>С нуля</button>
      </div>
      {machine.anchor && (
        <label className="asc-line asc-small-text">
          <span className="asc-muted">Адрес для SSH</span>
          <input className="asc-inline-input asc-mono" aria-label={`Адрес ${machine.label} для SSH с других машин`} placeholder="IP или имя"
            value={machine.sshAddress ?? ''} onChange={e => onChange({ ...machine, sshAddress: e.target.value.trim() === '' ? null : e.target.value.trim() })} />
          <Hint>Мастер пропишет на других машинах алиас bb-опора с этим адресом.</Hint>
        </label>
      )}
      {!machine.anchor && (
        <label className="asc-line asc-small-text">
          <span className="asc-muted">SSH к опоре</span>
          <input className="asc-inline-input asc-mono" aria-label={`SSH-цель опоры с ${machine.label}`} placeholder="tru или root@host"
            value={machine.anchorSsh ?? ''} onChange={e => onChange({ ...machine, anchorSsh: e.target.value.trim() === '' ? null : e.target.value.trim() })} />
          <Hint>Для Mutagen: имя из ~/.ssh/config этой машины или user@host.</Hint>
        </label>
      )}
      {machine.pathTranslation && <p className="asc-warn-text asc-small-text">Нативный Windows: пути переводятся.</p>}
      {plan && (
        <div className="asc-plan">{plan.map(step => (
          <div key={step.id}><b>{step.title}</b>{step.privilege === 'macos-dialog' && <span className="asc-tag">окно пароля macOS</span>}{step.privilege === 'manual' && <span className="asc-tag asc-tag-warn">вручную</span>}
            {step.apply && <code>{step.apply}</code>}{step.note && <span className="asc-muted"> {step.note}</span>}</div>
        ))}</div>
      )}
    </li>
  );
}

function platformLabel(p: string): string {
  return ({ linux: 'Linux', macos: 'macOS', wsl: 'WSL', windows: 'Windows', unknown: '—' } as Record<string, string>)[p] ?? p;
}

// ---- Модели ----

function ModelTable({ draft, state, onChange }: { draft: CascadeConfig; state: CascadeState; onChange(models: ModelRow[]): void }) {
  const update = (index: number, row: ModelRow) => onChange(draft.models.map((r, i) => i === index ? row : r));
  return (
    <div className="asc-stack">
      <div className="asc-scroll">
        <table className="asc-table asc-models">
          <thead><tr>
            <th scope="col">Модель <Hint>В ячейке — ID модели у CLI машины. Пустая ячейка: на этой машине модель не участвует.</Hint></th>
            {draft.machines.map(m => <th scope="col" key={m.hostId}>{m.label}</th>)}
          </tr></thead>
          <tbody>{draft.models.map((row, index) => (
            <tr key={row.key} className={row.enabled ? '' : 'asc-off'}>
              <th scope="row">
                <span className="asc-row asc-nowrap">
                  <Switch checked={row.enabled} label={`Модель ${row.displayName} в каскаде`} onChange={v => update(index, { ...row, enabled: v })} />
                  <input className="asc-inline-input asc-model-name" aria-label="Название модели" value={row.displayName} onChange={e => update(index, { ...row, displayName: e.target.value })} />
                </span>
                <small className="asc-muted">{providerLabel(row.providerId)}</small>
              </th>
              {draft.machines.map(m => {
                const cell = state.cells[row.key]?.[m.hostId] ?? { status: 'unknown' as CellStatus, modelId: null, candidates: [] };
                const saved = row.cells[m.hostId];
                const value = saved?.source === 'manual' ? saved.modelId ?? '' : cell.modelId ?? '';
                const listId = `asc-${row.key}-${m.hostId}`;
                const problem = PROBLEM_CELL[cell.status];
                return (
                  <td key={m.hostId} className={`asc-cell ${problem ? 'asc-cell-problem' : ''} ${cell.status === 'no-cli' ? 'asc-off' : ''}`} title={cell.status === 'blocked' && 'reason' in cell && cell.reason ? `${CELL_TITLE.blocked}: ${cell.reason}` : CELL_TITLE[cell.status]}>
                    <input list={listId} className="asc-mono" aria-label={`ID ${row.displayName} на ${m.label}`} value={value}
                      placeholder={cell.status === 'no-cli' ? '—' : 'ID модели'} disabled={cell.status === 'no-cli'}
                      onChange={e => {
                        const id = e.target.value.trim();
                        update(index, { ...row, cells: { ...row.cells, [m.hostId]: id ? { modelId: id, source: 'manual' } : { modelId: null, source: 'none' } } });
                      }} />
                    {cell.candidates.length > 0 && <datalist id={listId}>{cell.candidates.map(c => <option key={c} value={c} />)}</datalist>}
                    {problem && <small className="asc-warn-text">{problem}</small>}
                    {saved?.source === 'manual' || saved?.source === 'none'
                      ? <button type="button" className="asc-link" onClick={() => { const cells = { ...row.cells }; delete cells[m.hostId]; update(index, { ...row, cells }); }}>авто</button> : null}
                  </td>
                );
              })}
            </tr>
          ))}</tbody>
        </table>
      </div>
      <div className="asc-row">
        <button type="button" className="asc-btn asc-btn-quiet" onClick={() => {
          const key = uniqueKey(draft.models.map(r => r.key));
          onChange([...draft.models, { key, displayName: 'Новая модель', providerId: 'claude-code', enabled: true, cells: {} }]);
        }}>+ Модель</button>
      </div>
    </div>
  );
}

function uniqueKey(keys: readonly string[]): string {
  let i = 1;
  while (keys.includes(`model-${i}`)) i++;
  return `model-${i}`;
}

// ---- Файлы ----

function Files({ state, draft, set }: { state: CascadeState; draft: CascadeConfig; set(patch: Partial<CascadeConfig>): void }) {
  const files = draft.files;
  const put = (patch: Partial<CascadeConfig['files']>) => set({ files: { ...files, ...patch } });
  return (
    <div className="asc-stack">
      <div className="asc-form">
        <div className="asc-field"><span>Синхронизация <Hint>Mutagen держит общий путь одинаковым на машинах. По требованию — перед ходом; постоянно — всё время.</Hint></span>
          <SyncSelect label="Синхронизация по умолчанию" value={files.defaultSyncMode} onChange={v => put({ defaultSyncMode: v })} />
        </div>
        <div className="asc-row asc-span">
          <Switch checked={files.syncEnv} label="Синхронизировать .env" onChange={v => put({ syncEnv: v })} />
          <span>Синхронизировать .env</span>
        </div>
        <label className="asc-field asc-span"><span>Не синхронизировать</span>
          <input className="asc-mono" value={files.ignores.join(', ')} onChange={e => put({ ignores: e.target.value.split(',').map(x => x.trim()).filter(Boolean) })} />
        </label>
      </div>
      {state.projects.length > 0 && (
        <table className="asc-table">
          <thead><tr><th scope="col">Проект</th><th scope="col">Синхронизация</th></tr></thead>
          <tbody>{state.projects.map(p => (
            <tr key={p.id}><td>{p.name}</td><td>
              <SyncSelect label={`Синхронизация ${p.name}`} value={files.projectSyncModes[p.id] ?? files.defaultSyncMode} onChange={v => put({ projectSyncModes: { ...files.projectSyncModes, [p.id]: v } })} />
            </td></tr>
          ))}</tbody>
        </table>
      )}
    </div>
  );
}

function SyncSelect({ value, onChange, label }: { value: SyncMode; onChange(v: SyncMode): void; label?: string }) {
  return (
    <select aria-label={label} value={value} onChange={e => onChange(e.target.value as SyncMode)}>
      <option value="lazy">По требованию</option>
      <option value="warm">Постоянно</option>
    </select>
  );
}

// ---- Дополнительно ----

function Advanced({ draft, set }: { draft: CascadeConfig; set(patch: Partial<CascadeConfig>): void }) {
  const p = draft.policies;
  const put = (patch: Partial<CascadeConfig['policies']>) => set({ policies: { ...p, ...patch } });
  const changed = new Set(changedPolicies(draft));
  return (
    <div className="asc-stack">
      <div className="asc-form">
        <NumberField label="Возврат на ступень выше, через мин" hint="Только между ходами." changed={changed.has('returnAfterMinutes')} value={p.returnAfterMinutes} min={0} onChange={v => put({ returnAfterMinutes: v })} />
        <NumberField label="Всё исчерпано — ждать сброса, ч" hint="Дольше — спросить владельца." changed={changed.has('exhaustedWaitHours')} value={p.exhaustedWaitHours} min={0} onChange={v => put({ exhaustedWaitHours: v })} />
        <NumberField label="Остаток меньше, % — считать исчерпанным" changed={changed.has('minRemainingPercent')} value={p.minRemainingPercent} min={0} onChange={v => put({ minRemainingPercent: v })} />
        <NumberField label="Свежесть показания лимита, с" changed={changed.has('positiveFreshSeconds')} value={p.positiveFreshSeconds} min={5} onChange={v => put({ positiveFreshSeconds: v })} />
        <label className="asc-field"><span>Исполнение хода{changed.has('executionMode') && <ChangedMark />}</span>
          <select value={p.executionMode} onChange={e => put({ executionMode: e.target.value as CascadeConfig['policies']['executionMode'] })}>
            <option value="provider">Свой провайдер «Каскад» — ходы идут по ступеням</option>
            <option value="off">Выключено — ходы каскада отклоняются</option>
            <option value="relay" disabled>Relay под Claude Code и Codex (не реализован)</option>
          </select>
        </label>
        <div className="asc-row asc-span">
          <Switch checked={p.subthreadsUseOtherMachines} label="Подтреды могут тратить лимит других машин" onChange={v => put({ subthreadsUseOtherMachines: v })} />
          <span>Подтреды могут тратить лимит других машин{changed.has('subthreadsUseOtherMachines') && <ChangedMark />}</span>
        </div>
      </div>
      <TestQuotaView draft={draft} set={set} />
    </div>
  );
}

function ChangedMark() {
  return <span className="asc-changed" title="Отличается от умолчания" aria-label="изменено" />;
}

function NumberField({ label, hint, changed, value, min, onChange }: { label: string; hint?: string; changed: boolean; value: number; min: number; onChange(v: number): void }) {
  const id = useId();
  // Подсказка «?» — кнопка: внутри <label> она перехватила бы подпись поля, поэтому label отдельно.
  return (
    <div className="asc-field"><span><label htmlFor={id}>{label}</label>{hint && <Hint>{hint}</Hint>}{changed && <ChangedMark />}</span>
      <input id={id} type="number" min={min} value={value} onChange={e => { const n = Number(e.target.value); if (Number.isFinite(n) && n >= min) onChange(n); }} />
    </div>
  );
}

export { moveItem as move };
