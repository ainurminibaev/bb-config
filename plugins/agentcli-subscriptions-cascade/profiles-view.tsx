// Профили каскада на экране настроек: список строк, карточка по щелчку, схема «i»,
// приоритет моделей и тестовый источник квоты. Чистое представление: план,
// решение и подписи берутся из движка и profiles.ts — ровно то, что увидит ход.
import { Fragment, useState } from 'react';
import type { CascadeConfig, CascadeState, Profile, ProfilePolicy, QuotaState, Step } from './contract.ts';
import type { ExplainedAttempt } from './engine.ts';
import {
  PRESETS, attemptLabel, describeProfile, duplicateProfile, presetProfile, previewLookup, profilePreview, providerShort, stepChips,
} from './profiles.ts';
import { startLine } from './settings-summary.ts';
import { Hint, Switch, moveItem, useReorder } from './ui-kit.tsx';

export interface ProfilesViewProps {
  state: CascadeState;
  draft: CascadeConfig;
  set(patch: Partial<CascadeConfig>): void;
  /** Момент для превью; на экране — Date.now(). */
  now: number;
  /** Открытая схема «i» при первом показе (для предпросмотра экрана). */
  initialInfo?: string | null;
  /** Раскрытая карточка профиля при первом показе (для предпросмотра экрана). */
  initialOpen?: string | null;
}

const POLICIES: readonly { id: ProfilePolicy; label: string }[] = [
  { id: 'only', label: 'Только' },
  { id: 'prefer-then-any', label: 'Сначала → потом Авто' },
  { id: 'any', label: 'Авто' },
];

const STATE_TEXT: Record<QuotaState, string> = { available: 'лимит есть', exhausted: 'исчерпан', unknown: 'неизвестен', unavailable: 'недоступна' };

export function stepChipLabel(config: CascadeConfig, step: Step): string {
  const machine = config.machines.find(m => m.hostId === step.hostId)?.label ?? step.hostId;
  const provider = providerShort(step.providerId);
  return `${machine} · ${provider}${step.label && step.label !== provider ? ` ${step.label}` : ''}`;
}

export function ProfilesView({ state, draft, set, now, initialInfo = null, initialOpen = null }: ProfilesViewProps) {
  const [info, setInfo] = useState<string | null>(initialInfo);
  const [open, setOpen] = useState<string | null>(initialOpen);
  const [adding, setAdding] = useState(false);
  const health = previewLookup(draft, state.stepLimits);
  const update = (index: number, next: Profile) => set({ profiles: draft.profiles.map((p, i) => i === index ? next : p) });
  const reorder = useReorder((from, to) => set({ profiles: moveItem(draft.profiles, from, to) }));
  const defaultId = draft.profiles.find(p => p.enabled)?.id ?? null;

  return (
    <>
      {draft.testQuota.enabled && <p className="asc-warn-text asc-small-text">Превью и схемы считаются по тестовым лимитам.</p>}
      <ul className="asc-list">
        {draft.profiles.map((profile, index) => {
          const isOpen = open === profile.id;
          const description = describeProfile(draft, profile, state.accounts);
          const preview = info === profile.id || isOpen ? profilePreview(draft, profile.id, state.accounts, health, now) : null;
          return (
            <li key={profile.id} className={`asc-item ${profile.enabled ? '' : 'asc-off'} ${reorder.over === index ? 'asc-drop' : ''}`} {...reorder.row(index)}>
              <div className="asc-line">
                <button type="button" className="asc-grip" aria-label={`Переместить профиль «${profile.name}»: стрелки вверх и вниз`} title="Перетащите — порядок в списке моделей" {...reorder.handle(index, `profile:${profile.id}`)}>⋮⋮</button>
                <Switch checked={profile.enabled} label={`Показывать «${profile.name}» в списке моделей`} onChange={v => update(index, { ...profile, enabled: v })} />
                <button type="button" className="asc-line-main" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : profile.id)}>
                  <span className="asc-line-title">{profile.name}</span>
                  {profile.id === defaultId && <span className="asc-tag">по умолчанию</span>}
                  <span className="asc-line-sub">{startLine(description)}</span>
                </button>
                <button type="button" className={`asc-info ${info === profile.id ? 'asc-info-on' : ''}`} aria-pressed={info === profile.id}
                  onClick={() => setInfo(info === profile.id ? null : profile.id)} title="Схема каскада" aria-label={`Схема каскада «${profile.name}»`}>i</button>
              </div>
              {info === profile.id && preview && (
                <CascadeDiagram name={profile.name} attempts={preview.attempts} text={preview.text} draft={draft} test={draft.testQuota.enabled} onClose={() => setInfo(null)} subthreads={preview.subthreads} />
              )}
              {isOpen && preview && (
                <ProfileCard profile={profile} draft={draft} description={description} preview={preview.text}
                  onChange={next => update(index, next)}
                  onDuplicate={() => set({ profiles: [...draft.profiles.slice(0, index + 1), duplicateProfile(profile, draft), ...draft.profiles.slice(index + 1)] })}
                  onDelete={() => { setOpen(null); set({ profiles: draft.profiles.filter((_, i) => i !== index) }); }} />
              )}
            </li>
          );
        })}
      </ul>
      <div className="asc-toolbar">
        <button type="button" className="asc-btn asc-btn-quiet" aria-expanded={adding} onClick={() => setAdding(!adding)}>+ Профиль</button>
        {adding && PRESETS.map(p => (
          <button type="button" key={p.kind} className="asc-btn asc-btn-small" onClick={() => {
            const created = presetProfile(p.kind, draft);
            set({ profiles: [...draft.profiles, created] }); setAdding(false); setOpen(created.id);
          }}>{p.label}</button>
        ))}
      </div>
    </>
  );
}

function ProfileCard({ profile, draft, description, preview, onChange, onDuplicate, onDelete }: {
  profile: Profile; draft: CascadeConfig; description: string; preview: string;
  onChange(next: Profile): void; onDuplicate(): void; onDelete(): void;
}) {
  const chips = stepChips(draft, profile);
  const providers = [...new Set(draft.steps.map(s => s.providerId))];
  const reorder = useReorder((from, to) => onChange({ ...profile, stepOrder: moveItem(chips.map(c => c.step.id), from, to) }));
  const custom = profile.stepOrder !== null || profile.excludedSteps.length > 0 || Object.keys(profile.confirm).length > 0;
  const setPolicy = (policy: ProfilePolicy) => onChange({
    ...profile, policy, modelKey: policy === 'any' ? profile.modelKey : profile.modelKey ?? draft.policies.modelPriority[0] ?? draft.models[0]?.key ?? null,
  });
  return (
    <div className="asc-card">
      <label className="asc-field"><span>Название</span>
        <input value={profile.name} onChange={e => onChange({ ...profile, name: e.target.value })} />
      </label>
      <p className="asc-muted asc-small-text">{description}</p>
      <div className="asc-field">
        <span id={`pol-${profile.id}`}>Модели <Hint>«Только» — одна модель. «Сначала → потом Авто» — сначала она на всех ступенях, потом любые. «Авто» — лучшая доступная по приоритету моделей.</Hint></span>
        <div className="asc-row">
          <div className="asc-seg" role="radiogroup" aria-labelledby={`pol-${profile.id}`}>{POLICIES.map(p => (
            <button type="button" key={p.id} role="radio" aria-checked={profile.policy === p.id} className={profile.policy === p.id ? 'asc-seg-on' : ''} onClick={() => setPolicy(p.id)}>{p.label}</button>
          ))}</div>
          {profile.policy !== 'any' && (
            <select aria-label="Модель профиля" value={profile.modelKey ?? ''} onChange={e => onChange({ ...profile, modelKey: e.target.value || null })}>
              {draft.models.filter(r => r.enabled).map(r => <option key={r.key} value={r.key}>{r.displayName}</option>)}
            </select>
          )}
        </div>
      </div>
      <div className="asc-field">
        <span>Ступени <Hint>Перетащите — свой порядок. Щелчок по имени — исключить ступень. «?» — спрашивать перед входом на неё.</Hint>
          {custom
            ? <button type="button" className="asc-link" onClick={() => onChange({ ...profile, stepOrder: null, excludedSteps: [], confirm: {} })}>сбросить к общему</button>
            : <span className="asc-muted"> · как в общем каскаде</span>}
        </span>
        <div className="asc-chips">
          {chips.map((chip, i) => (
            <span key={chip.step.id} className={`asc-schip ${chip.excluded ? 'asc-schip-off' : ''} ${reorder.over === i ? 'asc-drop' : ''}`} {...reorder.row(i)}>
              <button type="button" className="asc-grip asc-grip-sm" aria-label={`Переместить ${stepChipLabel(draft, chip.step)}`} {...reorder.handle(i, `chip:${profile.id}:${chip.step.id}`)}>⋮⋮</button>
              <button type="button" className="asc-schip-name" aria-pressed={!chip.excluded} title={chip.excluded ? 'Включить ступень в профиль' : 'Исключить ступень из профиля'} onClick={() => {
                const excludedSteps = profile.excludedSteps.includes(chip.step.id) ? profile.excludedSteps.filter(id => id !== chip.step.id) : [...profile.excludedSteps, chip.step.id];
                onChange({ ...profile, excludedSteps });
              }}>{stepChipLabel(draft, chip.step)}</button>
              <button type="button" className={`asc-ask ${chip.confirm ? 'asc-ask-on' : ''}`} aria-pressed={chip.confirm}
                aria-label={`Спрашивать перед входом на ${stepChipLabel(draft, chip.step)}`} title="Спрашивать перед входом"
                onClick={() => onChange({ ...profile, confirm: { ...profile.confirm, [chip.step.id]: !chip.confirm } })}>?</button>
            </span>
          ))}
        </div>
      </div>
      {providers.length > 1 && (
        <div className="asc-row">
          {providers.map(id => {
            const off = profile.excludedProviders.includes(id);
            return <button type="button" key={id} aria-pressed={!off} className={`asc-pchip ${off ? 'asc-pchip-off' : ''}`}
              onClick={() => onChange({ ...profile, excludedProviders: off ? profile.excludedProviders.filter(x => x !== id) : [...profile.excludedProviders, id] })}>{off ? 'без ' : ''}{providerShort(id)}</button>;
          })}
        </div>
      )}
      <p className="asc-preview"><span className="asc-now-dot" aria-hidden="true" />{preview}</p>
      <div className="asc-row asc-card-foot">
        <button type="button" className="asc-link" onClick={onDuplicate}>Дублировать</button>
        <button type="button" className="asc-link asc-link-danger" onClick={onDelete}>Удалить</button>
      </div>
    </div>
  );
}

/** Приоритет моделей для «Авто»: перетаскиваемые чипы. */
export function ModelPriority({ draft, set }: { draft: CascadeConfig; set(patch: Partial<CascadeConfig>): void }) {
  const priority = draft.policies.modelPriority.length > 0
    ? [...draft.policies.modelPriority.filter(k => draft.models.some(r => r.key === k)), ...draft.models.map(r => r.key).filter(k => !draft.policies.modelPriority.includes(k))]
    : draft.models.map(r => r.key);
  const reorder = useReorder((from, to) => set({ policies: { ...draft.policies, modelPriority: moveItem(priority, from, to) } }));
  return (
    <div className="asc-priority">
      <span className="asc-muted">Приоритет для «Авто» <Hint>Перетащите модели. В профилях «Авто» ход берёт первую доступную.</Hint></span>
      <ol className="asc-chain asc-chain-plain">
        {priority.map((key, i) => {
          const row = draft.models.find(r => r.key === key)!;
          return (
            <li key={key} className={`asc-pchip ${row.enabled ? '' : 'asc-pchip-off'} ${reorder.over === i ? 'asc-drop' : ''}`} {...reorder.row(i)}>
              <button type="button" className="asc-grip asc-grip-sm" aria-label={`Переместить ${row.displayName}`} {...reorder.handle(i, `model:${key}`)}>⋮⋮</button>{row.displayName}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** Схема «i»: попытки профиля слева направо, лимит цветом, «ход сейчас», исключённые — серые. */
export function CascadeDiagram({ name, attempts, text, draft, test, onClose, subthreads }: {
  name: string; attempts: readonly ExplainedAttempt[]; text: string; draft: CascadeConfig; test: boolean; onClose(): void;
  /** 0.3.4: вторая цепочка — куда пошёл бы подтред (профиль «подтреды на Codex»). */
  subthreads?: { attempts: readonly ExplainedAttempt[]; text: string; note: string } | null;
}) {
  return (
    <div className="asc-diagram" role="region" aria-label={`Схема каскада «${name}»`}>
      <div className="asc-diagram-head">
        <b>Схема: {name}</b>{test && <span className="asc-tag asc-tag-warn">тестовые лимиты</span>}
        <span className="asc-legend"><i className="asc-st-available" />есть <i className="asc-st-exhausted" />исчерпан <i className="asc-st-unknown" />неизвестен <i className="asc-st-skip" />пропуск</span>
        <button type="button" className="asc-link" onClick={onClose}>Закрыть</button>
      </div>
      <DiagramFlow attempts={attempts} draft={draft} />
      <p className="asc-muted asc-small-text">{text}.</p>
      {subthreads && (
        <>
          <p className="asc-small-text"><b>Подтреды:</b> {subthreads.note}.</p>
          <DiagramFlow attempts={subthreads.attempts} draft={draft} />
          <p className="asc-muted asc-small-text">{subthreads.text}.</p>
        </>
      )}
    </div>
  );
}

/** Цепочка попыток схемы «i». */
function DiagramFlow({ attempts: all, draft }: { attempts: readonly ExplainedAttempt[]; draft: CascadeConfig }) {
  // Ступени другого провайдера без модели профиля (Codex в фазе «Opus») — шум: не показываем.
  // Остальное — план движка как есть, включая исключённые ступени и «нет модели» у своего провайдера.
  const attempts = all.filter(a => {
    if (a.skip !== 'no-model' || !a.rowKey) return true;
    return draft.models.find(r => r.key === a.rowKey)?.providerId === a.providerId;
  });
  return (
      <div className="asc-flow">
        {attempts.map((a, i) => {
          const step = draft.steps.find(s => s.id === a.stepId);
          const phaseBreak = i > 0 && a.phase === 'any' && attempts[i - 1]!.phase === 'preferred';
          const tone = a.skip ? 'skip' : a.state;
          const note = a.skip === 'excluded' ? 'исключена' : a.skip === 'no-model' ? 'нет модели' : a.skip === 'subthread' ? 'чужая машина' : STATE_TEXT[a.state];
          return (
            <Fragment key={`${a.stepId}|${a.modelId}|${a.skip}|${a.phase}`}>
              {phaseBreak ? <span className="asc-phase">потом Авто →</span> : i > 0 && <span className="asc-arrow" aria-hidden="true">→</span>}
              <div className={`asc-node asc-st-${tone} ${a.skip === 'excluded' ? 'asc-node-x' : ''} ${a.chosen ? 'asc-node-chosen' : ''}`}>
                {a.chosen && <span className="asc-now">ход сейчас</span>}
                <b>{attemptLabel(draft, a)}</b>
                <small>{step?.label ? `${step.label} · ` : ''}{note}{a.confirm && !a.skip ? ' · спросит' : ''}</small>
              </div>
            </Fragment>
          );
        })}
      </div>
  );
}

/** Тестовый источник квоты: лимит каждой ступени вручную, только для перечисленных тредов. */
export function TestQuotaView({ draft, set }: { draft: CascadeConfig; set(patch: Partial<CascadeConfig>): void }) {
  const tq = draft.testQuota;
  const put = (patch: Partial<CascadeConfig['testQuota']>) => set({ testQuota: { ...tq, ...patch } });
  return (
    <div className="asc-stack">
      <div className="asc-row">
        <Switch checked={tq.enabled} label="Тестовая квота" onChange={v => put({ enabled: v })} />
        <span>Тестовая квота</span>
        <Hint>Для приёмочных сценариев: лимит каждой ступени задаётся вручную, реальные лимиты не тратятся. Действует только в перечисленных тредах.</Hint>
      </div>
      {tq.enabled && (
        <>
          <label className="asc-field"><span>Тестовые треды (через запятую)</span>
            <input value={tq.threadIds.join(', ')} placeholder="thr_…" onChange={e => put({ threadIds: e.target.value.split(',').map(x => x.trim()).filter(Boolean) })} />
          </label>
          <table className="asc-table">
            <thead><tr><th scope="col">Ступень</th><th scope="col">Лимит</th><th scope="col">Сброс</th></tr></thead>
            <tbody>{draft.steps.map(step => {
              const entry = tq.steps[step.id] ?? { state: 'available' as QuotaState, resetsAt: null };
              const save = (next: typeof entry) => put({ steps: { ...tq.steps, [step.id]: next } });
              const label = stepChipLabel(draft, step);
              return (
                <tr key={step.id}>
                  <td>{label}</td>
                  <td><select aria-label={`Лимит: ${label}`} value={entry.state} onChange={e => save({ ...entry, state: e.target.value as QuotaState })}>
                    {(['available', 'exhausted', 'unknown', 'unavailable'] as const).map(s => <option key={s} value={s}>{STATE_TEXT[s]}</option>)}
                  </select></td>
                  <td><input type="datetime-local" aria-label={`Сброс: ${label}`} value={toLocalInput(entry.resetsAt)} disabled={entry.state !== 'exhausted'}
                    onChange={e => save({ ...entry, resetsAt: e.target.value ? new Date(e.target.value).toISOString() : null })} /></td>
                </tr>
              );
            })}</tbody>
          </table>
        </>
      )}
    </div>
  );
}

function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
