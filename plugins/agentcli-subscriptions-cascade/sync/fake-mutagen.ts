// Фейковый Mutagen и хост-операции для юнит-тестов оркестратора: сессии
// живут в памяти, каждый вызов пишется в журнал `log`, ответы хост-операций
// задаются тестом.
import type { SyncHostCall, SyncInput, SyncOutput } from './orchestrator.ts';

interface FakeSession {
  name: string;
  labels: Record<string, string>;
  mode: string;
  paused: boolean;
  conflicts: string[];
  connected: boolean;
  lastError: string | null;
  symlinkMode: string;
}

export class FakeMutagen {
  readonly log: string[] = [];
  /** hostId → имя → сессия. */
  readonly sessions = new Map<string, Map<string, FakeSession>>();
  quarantineResult = { changed: 0, deleted: 0, dir: null as string | null, hadSnapshot: true };
  prepareBetaResult = { created: true, movedTo: null as string | null };
  envFiles: { path: string; mode: number }[] = [];
  /** Очередь ответов syncGitLocks; последний повторяется. */
  gitLocks: { locks: string[]; gitRunning: boolean }[] = [{ locks: [], gitRunning: false }];
  /** Конфликты, которые появятся в W после следующего flush. */
  conflictsAfterFlush: string[] = [];
  /** Снять конфликт `.git/index`, когда на опоре удалили индекс. */
  resolveIndexOnRemove = true;
  failCommand: string | null = null;
  /** Сколько следующих `sync list` покажут W в статусе scanning (сразу после flush). */
  scanningLists = 0;
  /** Абсолютные символические ссылки на опоре: в режиме portable Mutagen их отвергает. */
  absoluteLinks: string[] = [];
  /** Долгий flush (мс) и прогресс передачи, который в это время видит `sync list`. */
  flushDelayMs = 0;
  staging: { receivedFiles: number; expectedFiles: number; totalReceivedSize: number } | null = null;
  /** Ошибка `sync flush` для N следующих вызовов (обрыв SSH). */
  failFlushes = 0;

  private readonly flushing = new Set<string>();

  private host(hostId: string) {
    let map = this.sessions.get(hostId);
    if (!map) { map = new Map(); this.sessions.set(hostId, map); }
    return map;
  }

  call: SyncHostCall = async <M extends Parameters<SyncHostCall>[1]>(hostId: string, method: M, input: SyncInput<M>): Promise<SyncOutput<M>> => {
    const out = (value: unknown) => value as SyncOutput<M>;
    const i = input as Record<string, unknown>;
    if (method === 'syncMutagen') {
      const args = i.args as string[];
      const line = `${hostId}: mutagen ${args[0] === 'sync' ? args.slice(1).filter(a => !a.startsWith('--') && !a.includes('=')).slice(0, 2).join(' ') : args.join(' ')}`;
      this.log.push(line.trim());
      if (this.failCommand && args.includes(this.failCommand)) return out({ exitCode: 1, stdout: '', stderr: `fake ${this.failCommand} failed`, seconds: 0, binary: 'mutagen' });
      return out(await this.mutagen(hostId, args));
    }
    this.log.push(`${hostId}: ${method}${method === 'syncRemoveGitFiles' || method === 'syncChmod' ? ` ${(i.paths as string[]).join(',')}` : ''}`);
    switch (method) {
      case 'syncPrepareBeta': return out(this.prepareBetaResult);
      case 'syncSnapshot': return out({ entries: 42, seconds: 0.01 });
      case 'syncQuarantine': return out({ ...this.quarantineResult, seconds: 0.01 });
      case 'syncEnvModes': return out({ files: this.envFiles });
      case 'syncChmod': return out({ changed: (i.paths as string[]).filter(p => this.envFiles.some(f => f.path === p)) });
      case 'syncGitLocks': return out(this.gitLocks.length > 1 ? this.gitLocks.shift()! : this.gitLocks[0]!);
      case 'syncRemoveGitFiles': {
        const paths = i.paths as string[];
        if (this.resolveIndexOnRemove && paths.includes('.git/index')) for (const map of this.sessions.values()) for (const s of map.values()) s.conflicts = s.conflicts.filter(c => c !== '.git/index');
        return out({ removed: paths });
      }
      case 'syncEnsureBindMount': return out({ status: 'already', seconds: 0.01 });
      case 'syncRemoveBindMount': return out({ unmounted: true, removed: true });
      default: throw new Error(`fake: нет метода ${method}`);
    }
  };

  private async mutagen(hostId: string, args: string[]) {
    const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '', seconds: 0.01, binary: 'mutagen' });
    const sessions = this.host(hostId);
    const [, verb] = args;
    if (verb === 'create') {
      const name = args[args.indexOf('--name') + 1]!;
      const labels: Record<string, string> = {};
      args.forEach((a, n) => { if (a === '--label') { const [k, v] = args[n + 1]!.split('='); labels[k!] = v!; } });
      sessions.set(name, { name, labels, mode: args[args.indexOf('--mode') + 1]!, paused: args.includes('--paused'), conflicts: [], connected: true, lastError: null, symlinkMode: (args.find(a => a.startsWith('--symlink-mode=')) ?? '--symlink-mode=portable').split('=')[1]! });
      return ok();
    }
    if (verb === 'list') {
      const selector = args[args.indexOf('--label-selector') + 1]!;
      const wanted = Object.fromEntries(selector.split(',').map(p => p.split('=')));
      const list = [...sessions.values()].filter(s => Object.entries(wanted).every(([k, v]) => s.labels[k] === v)).map(s => ({
        identifier: `sync_${s.name}`, name: s.name, labels: s.labels, mode: s.mode, paused: s.paused,
        status: s.paused ? 'disconnected' : this.flushing.has(s.name) ? 'staging-beta' : s.labels['bbc-role'] === 'w' && this.scanningLists > 0 ? 'scanning' : 'watching',
        alpha: { connected: !s.paused && s.connected, ...(s.symlinkMode === 'portable' && this.absoluteLinks.length ? { scanProblems: this.absoluteLinks.map(path => ({ path, error: 'invalid symbolic link: target is absolute' })) } : {}) }, beta: { connected: !s.paused && s.connected, ...(this.flushing.has(s.name) && this.staging ? { stagingProgress: this.staging, files: this.staging.expectedFiles } : {}) },
        ...(s.conflicts.length ? { conflicts: s.conflicts.map(root => ({ root, alphaChanges: [], betaChanges: [] })) } : {}),
        ...(s.lastError ? { lastError: s.lastError } : {}),
      }));
      if (this.scanningLists > 0) this.scanningLists--;
      return ok(JSON.stringify(list));
    }
    if (verb === 'terminate' && args.includes('--label-selector')) {
      const selector = args[args.indexOf('--label-selector') + 1]!;
      const wanted = Object.fromEntries(selector.split(',').map(p => p.split('=')));
      for (const s of [...sessions.values()]) if (Object.entries(wanted).every(([k, v]) => s.labels[k] === v)) sessions.delete(s.name);
      return ok();
    }
    const session = sessions.get(args[2]!);
    if (!session) return { exitCode: 1, stdout: '', stderr: `unable to locate requested sessions: ${args[2]}`, seconds: 0, binary: 'mutagen' };
    if (verb === 'pause') session.paused = true;
    else if (verb === 'resume') session.paused = false;
    else if (verb === 'terminate') sessions.delete(session.name);
    else if (verb === 'flush') {
      if (session.paused) return { exitCode: 1, stdout: '', stderr: 'session is paused', seconds: 0, binary: 'mutagen' };
      if (this.failFlushes > 0) { this.failFlushes -= 1; return { exitCode: 1, stdout: '', stderr: 'ssh: connect to host tru: Connection reset', seconds: 0, binary: 'mutagen' }; }
      if (this.flushDelayMs > 0) {
        this.flushing.add(session.name);
        await new Promise(resolve => setTimeout(resolve, this.flushDelayMs));
        this.flushing.delete(session.name);
      }
      if (session.labels['bbc-role'] === 'w' && this.conflictsAfterFlush.length) { session.conflicts = [...this.conflictsAfterFlush]; this.conflictsAfterFlush = []; }
    }
    return ok();
  }

  session(hostId: string, role: 'w' | 'r'): FakeSession | undefined {
    return [...this.host(hostId).values()].find(s => s.labels['bbc-role'] === role);
  }
}
