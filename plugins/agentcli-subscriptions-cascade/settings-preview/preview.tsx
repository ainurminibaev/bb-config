// Стенд экрана настроек для скриншотов: SettingsView на состоянии, которое
// вернул server.ts на фейковом хосте SDK (state.ts). Вид задаётся в адресе:
// ?view=collapsed — по умолчанию; ?view=profile — раскрыта карточка профиля;
// ?theme=dark — тёмная тема; ?width=700 — ширина панели настроек.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { CascadeConfig, CascadeState } from '../contract.ts';
import { SettingsView } from '../settings-view.tsx';
import '../app.css';
import './preview.css';
// Подставляет build.mjs из state.ts.
import data from './state.json';

const { state, now } = data as unknown as { state: CascadeState; now: number };
const params = new URLSearchParams(location.search);
const view = params.get('view') ?? 'collapsed';
document.documentElement.dataset.theme = params.get('theme') ?? 'light';
document.documentElement.style.setProperty('--pv-width', `${params.get('width') ?? 700}px`);

function Stand() {
  const [draft, setDraft] = useState<CascadeConfig>(state.config);
  const [dirty, setDirty] = useState(false);
  const noop = () => {};
  return (
    <main className="pv-panel">
      <header className="pv-head"><h2>Каскад подписок</h2><p>Машины, порядок аккаунтов, профили, модели и файлы.</p></header>
      <SettingsView state={state} draft={draft} dirty={dirty} busy={null} plans={{}} now={now}
        initialProfile={view === 'profile' ? 'opus-then-auto' : null}
        initialInfo={view === 'info' ? 'auto' : null}
        initialSections={view === 'open' ? ['machines', 'models', 'files', 'advanced'] : []}
        actions={{ setDraft: next => { setDraft(next); setDirty(true); }, save: () => setDirty(false), refresh: noop, adopt: noop, runWizard: noop, showPlan: noop }} />
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<Stand />);
