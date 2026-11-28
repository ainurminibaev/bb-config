// Фронтенд «Каскада подписок»: раздел на странице плагина в настройках BB.
// Служебные строки в треде (этап A — строка под шапкой, этап B — таймлайн
// своего провайдера) появятся вместе с исполнителем хода, см. ARCHITECTURE.md.
import { useCallback, useEffect, useState } from 'react';
import { definePluginApp, useRpc } from '@get-bb/plugin-sdk/app';
import type { CascadeConfig, CascadeState, WizardPlanStep, rpcContract } from './contract.ts';
import { SettingsView } from './settings-view.tsx';
import { registerTimelineApp } from './timeline/register.tsx';
import './app.css';

function CascadeSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<CascadeState | null>(null);
  const [draft, setDraft] = useState<CascadeConfig | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>('Загрузка');
  const [error, setError] = useState<string | null>(null);
  const [plans, setPlans] = useState<Record<string, WizardPlanStep[]>>({});

  const accept = useCallback((next: CascadeState) => { setState(next); setDraft(next.config); setDirty(false); }, []);
  const run = useCallback(async (label: string, job: () => Promise<void>) => {
    setBusy(label); setError(null);
    try { await job(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  }, []);

  useEffect(() => { void run('Загрузка', async () => accept(await rpc.call('state', { refresh: false }))); }, [rpc, run, accept]);

  if (!state || !draft) return <div className="asc-root">{error ? <p className="asc-error">{error}</p> : <p className="asc-muted">Загрузка…</p>}</div>;
  return (
    <>
      {error && <p className="asc-error">{error}</p>}
      <SettingsView state={state} draft={draft} dirty={dirty} busy={busy} plans={plans} actions={{
        setDraft: next => { setDraft(next); setDirty(true); },
        save: () => void run('Сохранение', async () => accept(await rpc.call('saveConfig', { config: draft }))),
        refresh: () => void run('Обнаружение', async () => accept(await rpc.call('state', { refresh: true }))),
        adopt: () => void run('Добавление найденного', async () => accept(await rpc.call('adoptDiscovered', null))),
        runWizard: (dryRun, mode = {}) => void run(dryRun ? 'Предпросмотр' : mode.reset ? 'Настройка с нуля' : mode.recheck ? 'Перепроверка' : 'Мастер', async () => {
          if (dirty) accept(await rpc.call('saveConfig', { config: draft }));
          // Мастер идёт на сервере: экран можно закрыть, при возврате видно, где остановились.
          await rpc.call('wizardRun', { dryRun, ...(mode.hostIds ? { hostIds: mode.hostIds } : {}), recheck: mode.recheck ?? false, reset: mode.reset ?? false, allowSsh: mode.allowSsh ?? [] });
          accept(await rpc.call('state', { refresh: false }));
        }),
        showPlan: hostId => void run('Команды', async () => {
          if (plans[hostId]) { setPlans(({ [hostId]: _, ...rest }) => rest); return; }
          const { steps } = await rpc.call('wizardPlan', { hostId });
          setPlans(prev => ({ ...prev, [hostId]: steps }));
        }),
      }} />
    </>
  );
}

export default definePluginApp(app => {
  app.slots.settingsSection({
    id: 'cascade',
    title: 'Каскад подписок',
    description: 'Машины, порядок аккаунтов, профили, модели и файлы.',
    component: CascadeSettings,
  });
  registerTimelineApp(app);
});
