import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { contract, hostContract } from './contract';

export default function pushButton(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: hostContract });
  // The button re-checks Git every 5 seconds while a thread is open. What the
  // thread runs on does not change between checks, so it is reused: thread,
  // project and environment for a minute, the machine's connection for 10
  // seconds. Git itself is still asked every time.
  const remembered = new Map<string, { at: number; value: Promise<unknown> }>();
  function remember<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const hit = remembered.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value as Promise<T>;
    if (remembered.size > 500) remembered.clear();
    const value = load();
    remembered.set(key, { at: Date.now(), value });
    value.catch(() => { if (remembered.get(key)?.value === value) remembered.delete(key); });
    return value;
  }
  bb.rpc.register(contract, {
    async status({ threadId }, context) {
      const signal = context.experimental_signal;
      let hostName: string | undefined;
      let projectName: string | undefined;
      try {
        const thread = await remember(`thread:${threadId}`, 60_000, () => bb.sdk.threads.get({ threadId }).then(t => ({ projectId: t.projectId, environmentId: t.environmentId })));
        try {
          const project = await remember(`project:${thread.projectId}`, 60_000, () => bb.sdk.projects.get({ projectId: thread.projectId }).then(p => ({ name: p.name })));
          projectName = project.name;
        } catch { /* Project metadata must not block Git status. */ }
        if (!thread.environmentId) return { state: 'unavailable' as const, message: 'У треда нет рабочей папки', projectName };
        const environmentId = thread.environmentId;
        const environment = await remember(`environment:${environmentId}`, 60_000, () => bb.sdk.environments.get({ environmentId }).then(e => ({ hostId: e.hostId, path: e.path })));
        const machine = await remember(`machine:${environment.hostId}`, 10_000, () => bb.sdk.hosts.get({ hostId: environment.hostId }).then(h => ({ name: h.name, status: h.status })));
        hostName = machine.name;
        if (!environment.path || machine.status !== 'connected') return { state: 'unavailable' as const, message: 'Машина или папка недоступна', hostName, projectName };
        return { ...await host.call('status', { path: environment.path }, { hostId: environment.hostId, signal, timeoutMs: 8000 }), hostName, projectName };
      } catch {
        return { state: 'unavailable' as const, message: 'Не удалось проверить Git в папке треда', hostName, projectName };
      }
    },
  });
  bb.rpc.experimental_whileWatched('status', (read, signal) => {
    if (!('input' in read) || !read.input || typeof read.input !== 'object' || Array.isArray(read.input)) return;
    const threadId = read.input.threadId;
    if (typeof threadId !== 'string') return;
    return new Promise<void>(resolve => {
      const timer = setInterval(() => bb.rpc.experimental_invalidate(['push-state:' + threadId]), 5000);
      const stop = () => { clearInterval(timer); resolve(); };
      if (signal.aborted) stop();
      else signal.addEventListener('abort', stop, { once: true });
    });
  });
}
