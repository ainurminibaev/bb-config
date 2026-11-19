import { useEffect, useState } from 'react';
import { definePluginApp, useRpc } from '@get-bb/plugin-sdk/app';
import type { ExperimentalThreadRowMetadataDataInput, ExperimentalThreadRowMetadataProps, PluginRpcClient } from '@get-bb/plugin-sdk/app';
import { toast } from 'sonner';
import type { rpcContract } from './contract';
import './app.css';

type Marks = Record<string, { percent: number; holding: boolean; title: string }> | undefined;
const CHANGED = 'low-priority:changed';
// Menu rows run outside React, so the overlay below keeps the client for them.
let client: PluginRpcClient<typeof rpcContract> | null = null;
function KeepClient() { client = useRpc<typeof rpcContract>(); return null; }

function useMarks({ threads }: ExperimentalThreadRowMetadataDataInput): Marks {
  const rpc = useRpc<typeof rpcContract>();
  const ids = threads.map(thread => thread.id).slice(0, 500).join(',');
  const [marks, setMarks] = useState<Marks>(undefined);
  useEffect(() => {
    let cancelled = false;
    const load = () => { rpc.call('marks', { threadIds: ids ? ids.split(',') : [] }).then(r => { if (!cancelled) setMarks(r); }, () => { if (!cancelled) setMarks({}); }); };
    load();
    const timer = window.setInterval(load, 60_000);
    window.addEventListener(CHANGED, load);
    return () => { cancelled = true; window.clearInterval(timer); window.removeEventListener(CHANGED, load); };
  }, [rpc, ids]);
  return marks;
}

function Badge({ thread, data }: ExperimentalThreadRowMetadataProps<Marks>) {
  const mark = data?.[thread.id];
  return mark ? <span className="lp-badge" data-holding={mark.holding} title={mark.title}>{mark.holding ? 'ждёт' : 'низкий'} · {mark.percent}%</span> : null;
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: 'low-priority-client', component: KeepClient });
  app.slots.experimental_threadRowMetadata<Marks>({ id: 'low-priority', order: 90, useData: useMarks, component: Badge });
  // One row in the composer's "+" menu: no new control on the thread screen.
  app.composer.customize({
    id: 'low-priority', scopes: ['thread'],
    plusMenu: [{
      id: 'toggle', label: 'Неприоритетный тред: вкл/выкл', icon: 'Hourglass',
      description: 'Задания в этом треде и подтредах ждут, пока лимит подписки выше порога',
      async run({ composer }) {
        if (composer.scope.kind !== 'thread' || !client) return;
        try {
          const s = await client.call('toggle', { threadId: composer.scope.threadId });
          window.dispatchEvent(new Event(CHANGED));
          toast(s.own === null ? 'Тред снова обычный' : 'Тред теперь неприоритетный', { description: s.summary });
        } catch (error) { toast.error(error instanceof Error ? error.message : String(error)); }
      },
    }],
  });
});
