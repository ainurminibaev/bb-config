import { PluginCliError, cliCommand, defineCli, type BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { hostContract, rpcContract, type Catalog, type ProjectView } from './contract';
import {
  AUTO_FIELDS, applyAuto, applyManual, describePull, diffManifests, emptyEntry, eventSummary, hydrate, otherCopies, pushHistory, renameCategory, needsDescription, search, syncEvent, unlock, verdict, worktreeLine, worktreeState, formatBytes, neighbourNote, isolationRule, landText,
  type AutoField, type CopyDiff, type Entry, type Link, type Manifest, type Patch, type PullResult, type Scan, type SourceView, type Status, type SyncEvent, type WorktreeView, type Isolation, type LandResult,
} from './core';

const SYNC_RULE = 'Project Catalog — синхронизация папки. При первом сообщении треда плагин сам делает git fetch и подтягивает свежее, только если папка чистая, ветка просто отстала и в папке не работает другой тред; итог — ниже, если он успел. Инструмент project_sync (или `bb catalog pull`) повторяет это вручную, например после долгой работы. Если сказано о незакоммиченных правках, расхождении веток или неотправленных коммитах — не исправляй это сам без просьбы пользователя: учти в работе и коротко скажи пользователю.';

type StoredDiff = CopyDiff & { a: string; b: string };
const FULL_SCAN_EVERY_MS = 30 * 60 * 1000;
const csv = (value: string | undefined) => value === undefined ? undefined : value.split(',').map(item => item.trim()).filter(Boolean);
function parseLinks(value: string | undefined): Link[] | undefined {
  return csv(value)?.map(item => {
    const at = item.indexOf('=');
    return at > 0 && !/^https?:/i.test(item.slice(0, at)) ? { label: item.slice(0, at), url: item.slice(at + 1) } : { label: '', url: item };
  });
}

export default function projectCatalog(bb: BbPluginApi) {
  const entries = new Map<string, Entry>();
  const scans = new Map<string, Scan>();
  const diffs = new Map<string, StoredDiff>();
  /** Latest known README/AGENTS hash per project, for the staleness check. */
  const docHashes = new Map<string, string | null>();
  let groups: Record<string, string> = {};
  let lastFullScan: number | null = null;
  let scanning = false;
  let icons: { at: number; map: Record<string, string> } = { at: 0, map: {} };

  const db = bb.storage.database();
  bb.storage.migrate(db, [`CREATE TABLE IF NOT EXISTS manifests (source_id TEXT PRIMARY KEY, scanned_at INTEGER NOT NULL, json TEXT NOT NULL)`]);
  const host = bb.hosts.experimental_client({ contract: hostContract });
  const settings = bb.settings.define({
    autoPull: {
      type: 'select', label: 'Синхронизация папки при старте треда', options: ['auto', 'check', 'off'], default: 'auto',
      experimental_optionLabels: { auto: 'Подтягивать свежее, если папка чистая и свободна', check: 'Только проверять и сообщать', off: 'Выключено' },
      description: 'Подтягивание — только fast-forward чистой ветки; в папке с файлом .bb/hands-off ничего не делается.',
    },
    cleanupMissingWorktrees: {
      type: 'boolean', label: 'Удалять записи BB о worktree, папки которых нет', default: false,
      description: 'Выключено: такие записи только показываются в «Worktree». Отключённый диск тоже выглядит как «папки нет».',
    },
  });
  let autoPull = 'auto';
  let cleanupMissing = false;
  const applySettings = (v: { autoPull: string; cleanupMissingWorktrees: boolean }) => { autoPull = v.autoPull; cleanupMissing = v.cleanupMissingWorktrees; };
  void settings.get().then(applySettings).catch(() => undefined);
  settings.onChange(next => applySettings(next));

  const ready = (async () => {
    for (const key of await bb.storage.kv.list('p:')) {
      const value = await bb.storage.kv.get<Entry>(key);
      if (value) entries.set(key.slice(2), hydrate(value));
    }
    for (const key of await bb.storage.kv.list('s:')) {
      const value = await bb.storage.kv.get<Scan>(key);
      if (value) scans.set(key.slice(2), value);
    }
    for (const key of await bb.storage.kv.list('d:')) {
      const value = await bb.storage.kv.get<StoredDiff>(key);
      if (value) diffs.set(key.slice(2), value);
    }
    lastFullScan = (await bb.storage.kv.get<number>('meta:lastFullScan')) ?? null;
    groups = (await bb.storage.kv.get<Record<string, string>>('meta:groups')) ?? {};
    try { await rememberDocHashes(); } catch (error) { bb.log.warn(`Project Catalog: could not index sources: ${String(error)}`); }
  })();

  async function rememberDocHashes() {
    for (const project of await bb.sdk.projects.list()) {
      const ordered = [...project.sources].sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
      const scan = ordered.map(source => scans.get(source.id)).find(item => item && (item.kind === 'git' || item.kind === 'plain'));
      docHashes.set(project.id, scan?.docHash ?? null);
    }
  }
  async function saveEntry(projectId: string, entry: Entry) {
    entries.set(projectId, entry);
    await bb.storage.kv.set(`p:${projectId}`, entry);
    bb.realtime.publish('changed', { projectId });
  }
  const readManifest = (sourceId: string) => {
    const row = db.prepare('SELECT json FROM manifests WHERE source_id = ?').get(sourceId) as { json: string } | undefined;
    return row ? JSON.parse(row.json) as Manifest : null;
  };

  type ProjectDto = Awaited<ReturnType<typeof bb.sdk.projects.list>>[number];
  /** Compare the two folders without git of one project, leaving out folders marked as local. */
  async function compare(project: ProjectDto, names: Map<string, string>) {
    const plain = project.sources.filter(source => scans.get(source.id)?.kind === 'plain');
    const [first, second] = [...plain].sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
    const left = first && readManifest(first.id);
    const right = second && readManifest(second.id);
    if (first && second && left && right) {
      const diff: StoredDiff = { ...diffManifests(left, right, 40, entries.get(project.id)?.localPaths ?? []), a: names.get(first.hostId ?? '') ?? 'A', b: names.get(second.hostId ?? '') ?? 'B' };
      diffs.set(project.id, diff);
      await bb.storage.kv.set(`d:${project.id}`, diff);
    } else if (diffs.delete(project.id)) await bb.storage.kv.delete(`d:${project.id}`);
  }
  async function recompare(projectId: string) {
    const [project, hosts] = await Promise.all([bb.sdk.projects.get({ projectId }), bb.sdk.hosts.list()]);
    await compare(project as ProjectDto, new Map(hosts.map(item => [item.id, item.name])));
  }

  async function runScan(only: string | null) {
    await ready;
    if (scanning) return false;
    scanning = true;
    bb.realtime.publish('changed', { scanning: true });
    try {
      const [projects, hosts] = await Promise.all([bb.sdk.projects.list(), bb.sdk.hosts.list()]);
      const names = new Map(hosts.map(item => [item.id, item.name]));
      const online = new Set(hosts.filter(item => item.status === 'connected').map(item => item.id));
      const byHost = new Map<string, { id: string; path: string; manifest: boolean }[]>();
      for (const project of projects) {
        if (only && project.id !== only) continue;
        for (const source of project.sources) {
          if (source.type !== 'local_path' || !source.hostId || !source.path || !online.has(source.hostId)) continue;
          const list = byHost.get(source.hostId) ?? [];
          // Content hashes are only needed where copies on two machines must be compared.
          list.push({ id: source.id, path: source.path, manifest: project.sources.length > 1 });
          byHost.set(source.hostId, list);
        }
      }
      await Promise.all([...byHost].map(async ([hostId, targets]) => {
        for (let at = 0; at < targets.length; at += 100) {
          try {
            const { results } = await host.call('scan', { targets: targets.slice(at, at + 100) }, { hostId, timeoutMs: 240_000 });
            for (const result of results) {
              scans.set(result.id, result.scan);
              await bb.storage.kv.set(`s:${result.id}`, result.scan);
              if (result.manifest) db.prepare('INSERT INTO manifests (source_id, scanned_at, json) VALUES (?, ?, ?) ON CONFLICT(source_id) DO UPDATE SET scanned_at = excluded.scanned_at, json = excluded.json')
                .run(result.id, result.scan.scannedAt, JSON.stringify(result.manifest));
              else db.prepare('DELETE FROM manifests WHERE source_id = ?').run(result.id);
            }
          } catch (error) { bb.log.warn(`Project Catalog: scan failed on ${names.get(hostId) ?? hostId}: ${String(error)}`); }
        }
      }));
      for (const project of projects) if (!only || project.id === only) await compare(project, names);
      await rememberDocHashes();
      if (!only) { lastFullScan = Date.now(); await bb.storage.kv.set('meta:lastFullScan', lastFullScan); }
      return true;
    } finally {
      scanning = false;
      bb.realtime.publish('changed', { scanning: false });
    }
  }
  const scanInBackground = (only: string | null) => { void runScan(only).catch(error => bb.log.warn(`Project Catalog: scan failed: ${String(error)}`)); };

  async function projectIcons() {
    if (Date.now() - icons.at < 5 * 60_000) return icons.map;
    try {
      const result = await bb.sdk.plugins.callRpc({ pluginId: 'machine-tabs', method: 'project_icons', input: {}, outputSchema: z.object({ icons: z.record(z.string(), z.string()) }) });
      icons = { at: Date.now(), map: result.icons };
    } catch { icons = { at: Date.now(), map: {} }; }
    return icons.map;
  }

  async function views(): Promise<{ list: ProjectView[]; hosts: Catalog['hosts'] }> {
    await ready;
    const [projects, hostList, iconMap] = await Promise.all([bb.sdk.projects.list(), bb.sdk.hosts.list(), projectIcons()]);
    const hosts = hostList.map(item => ({ id: item.id, name: item.name, connected: item.status === 'connected' }));
    const hostById = new Map(hosts.map(item => [item.id, item]));
    const list = projects.map(project => {
      const stored = entries.get(project.id);
      const sources = project.sources.filter(source => source.type === 'local_path' && source.hostId && source.path).map(source => ({
        id: source.id, hostId: source.hostId!, hostName: hostById.get(source.hostId!)?.name ?? source.hostId!, path: source.path!,
        isDefault: source.isDefault, connected: hostById.get(source.hostId!)?.connected ?? false, scan: scans.get(source.id) ?? null,
      })).sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
      const diff = diffs.get(project.id) ?? null;
      return {
        id: project.id, name: project.name, remote: project.gitRemoteUrl ?? null, createdAt: project.createdAt, icon: iconMap[project.id] ?? null,
        entry: hydrate(stored), described: Boolean(stored && (stored.summary || stored.describedAt)),
        sources, verdict: verdict(sources as SourceView[], diff, { independent: stored?.independent ?? false, localPaths: stored?.localPaths ?? [] }), diff,
      } satisfies ProjectView;
    });
    return { list, hosts };
  }
  async function view(projectId: string) {
    const found = (await views()).list.find(item => item.id === projectId);
    if (!found) throw new Error(`Проект ${projectId} не найден`);
    return found;
  }
  const docsOf = (list: ProjectView[]) => list.map(item => ({
    id: item.id, name: item.name, aliases: item.entry.aliases, category: item.entry.categories.join(' '), tags: item.entry.tags,
    summary: item.entry.summary, notes: item.entry.notes, paths: item.sources.map(source => source.path), view: item,
  }));
  function categories() {
    const count = new Map<string, number>();
    for (const entry of entries.values()) for (const name of entry.categories) count.set(name, (count.get(name) ?? 0) + 1);
    return [...count].sort((a, b) => b[1] - a[1]);
  }

  async function setGroup(category: string, group: string) {
    const name = group.replace(/\s+/g, ' ').trim().slice(0, 40);
    groups = { ...groups };
    if (name) groups[category] = name; else delete groups[category];
    await bb.storage.kv.set('meta:groups', groups);
    bb.realtime.publish('changed', { groups: true });
  }

  /** Rename a category in every card and carry its group over. */
  async function renameCategoryEverywhere(from: string, rawTo: string) {
    await ready;
    const to = rawTo.replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!to || to === from) return 0;
    let changed = 0;
    for (const [projectId, stored] of entries) {
      const next = renameCategory(hydrate(stored), from, to, Date.now());
      if (!next) continue;
      entries.set(projectId, next);
      await bb.storage.kv.set(`p:${projectId}`, next);
      changed++;
    }
    if (groups[from]) { const group = groups[from]!; groups = { ...groups }; delete groups[from]; if (!groups[to]) groups[to] = group; await bb.storage.kv.set('meta:groups', groups); }
    bb.realtime.publish('changed', { categories: true });
    return changed;
  }
  /** Rename a group, or delete it with an empty name: its categories become ungrouped. */
  async function renameGroupEverywhere(from: string, rawTo: string) {
    await ready;
    const to = rawTo.replace(/\s+/g, ' ').trim().slice(0, 40);
    groups = Object.fromEntries(Object.entries(groups).flatMap(([category, group]) => group !== from ? [[category, group]] : to ? [[category, to]] : []));
    await bb.storage.kv.set('meta:groups', groups);
    bb.realtime.publish('changed', { groups: true });
  }

  bb.rpc.register(rpcContract, {
    async catalog() {
      const { list, hosts } = await views();
      if (!scanning && (lastFullScan === null || Date.now() - lastFullScan > FULL_SCAN_EVERY_MS)) scanInBackground(null);
      return { projects: list, hosts, groups, scanning, scannedAt: lastFullScan };
    },
    async save({ projectId, patch }) {
      await ready;
      await saveEntry(projectId, applyManual(entries.get(projectId) ?? emptyEntry(), patch as Patch, Date.now()));
      if (patch.localPaths !== undefined) await recompare(projectId);
      return view(projectId);
    },
    async unlock({ projectId, fields }) {
      await ready;
      await saveEntry(projectId, unlock(entries.get(projectId) ?? emptyEntry(), fields, Date.now()));
      return view(projectId);
    },
    async refresh({ projectId }) {
      if (scanning) return { started: false };
      scanInBackground(projectId);
      return { started: true };
    },
    async rename_category({ from, to }) {
      const changed = await renameCategoryEverywhere(from, to);
      return { changed, groups };
    },
    async rename_group({ from, to }) {
      await renameGroupEverywhere(from, to);
      return { groups };
    },
    async set_group({ category, group }) {
      await ready;
      await setGroup(category, group);
      return { groups };
    },
    async threads({ projectId }) {
      const [result, hosts] = await Promise.all([bb.sdk.threads.list({ projectId, archived: false, limit: 200 }), bb.sdk.hosts.list()]);
      const rows = (Array.isArray(result) ? result : ((result as { threads?: unknown[] }).threads ?? [])) as { id: string; title?: string | null; titleFallback?: string | null; status: string; updatedAt: number; parentThreadId?: string | null; pinnedAt?: number | null; environmentHostId?: string | null; visibility?: string }[];
      const roots = rows.filter(row => !row.parentThreadId && row.visibility !== 'hidden').sort((a, b) => b.updatedAt - a.updatedAt);
      const names = new Map(hosts.map(item => [item.id, item.name]));
      return { total: roots.length, threads: roots.slice(0, 5).map(row => ({ id: row.id, title: row.title || row.titleFallback || 'Без названия', status: row.status, updatedAt: row.updatedAt, hostName: row.environmentHostId ? names.get(row.environmentHostId) ?? null : null, pinned: Boolean(row.pinnedAt) })) };
    },
    async describe_with_agent({ projectId }) {
      const project = await bb.sdk.projects.get({ projectId });
      const thread = await bb.sdk.threads.spawn({
        projectId, environment: { type: 'project-default' }, title: `Описание проекта «${project.name}» для каталога`,
        prompt: `Обнови карточку этого проекта в каталоге BB. Прочитай README, AGENTS.md и осмотри структуру папки, затем выполни одну команду:\n\nbb catalog describe --summary "<1–2 предложения по-русски: что это и зачем>" --category "<категория>" --tags "<3–6 тегов через запятую>" --aliases "<как пользователь может назвать проект вслух, включая русские написания, через запятую>" --links "<название=https://…, если в проекте есть значимые ссылки>"\n\nСуществующие категории смотри в «bb catalog categories» и по возможности используй одну из них. Поля, которые пользователь правил вручную, команда сохранит сама. Больше ничего в проекте не меняй; в ответе покажи итоговую карточку.`,
      });
      return { threadId: thread.id };
    },
    async history({ projectId }) {
      return { events: await history(projectId) };
    },
    async worktrees({ projectId, sizes }) {
      return { worktrees: await worktrees(projectId, sizes) };
    },
  });

  // ---------- Safe pull on the thread's own machine ----------
  const historyCache = new Map<string, SyncEvent[]>();
  async function history(projectId: string): Promise<SyncEvent[]> {
    const cached = historyCache.get(projectId);
    if (cached) return cached;
    const stored = (await bb.storage.kv.get<SyncEvent[]>(`h:${projectId}`)) ?? [];
    historyCache.set(projectId, stored);
    return stored;
  }
  let historyWrite: Promise<unknown> = Promise.resolve();
  function remember(projectId: string, event: SyncEvent) {
    // Serialized so two threads finishing together do not drop each other's event.
    historyWrite = historyWrite.then(async () => {
      const next = pushHistory(await history(projectId), event);
      historyCache.set(projectId, next);
      await bb.storage.kv.set(`h:${projectId}`, next);
      bb.realtime.publish('history', { projectId });
    }).catch(error => bb.log.warn(`Project Catalog: history write failed: ${String(error)}`));
    return historyWrite;
  }

  type ThreadRowLite = { id: string; status: string; updatedAt: number; title?: string | null; titleFallback?: string | null; environmentPath?: string | null; environmentHostId?: string | null };
  const overlaps = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
  /**
   * Other threads (hidden ones too) in the same folder, a folder inside it or around it,
   * running now or in the last 15 minutes. Throws when the list cannot be read: callers then do not pull.
   */
  async function neighbours(threadId: string, hostId: string, path: string) {
    const all = await bb.sdk.threads.list({ archived: false, limit: 500, includeHidden: true, hostId }) as unknown;
    const rows = (Array.isArray(all) ? all : ((all as { threads?: unknown[] }).threads ?? [])) as ThreadRowLite[];
    return rows.filter(row => row.id !== threadId && row.environmentHostId === hostId && row.environmentPath && overlaps(row.environmentPath.replace(/\/+$/, ''), path.replace(/\/+$/, ''))
      && (row.status === 'active' || Date.now() - row.updatedAt < 15 * 60_000))
      .map(row => ({ id: row.id, title: row.title || row.titleFallback || 'без названия', active: row.status === 'active' }));
  }
  async function syncFolder(input: { threadId: string; projectId: string | null; hostId: string; path: string; apply: boolean }): Promise<{ text: string; result: PullResult; event: SyncEvent | null; busy: { id: string; title: string }[] }> {
    const hostRow = await bb.sdk.hosts.get({ hostId: input.hostId });
    let busy: { id: string; title: string; active: boolean }[] = [];
    let unknownNeighbours = false;
    try { busy = await neighbours(input.threadId, input.hostId, input.path); } catch { unknownNeighbours = true; }
    // Pull only when it is certain that nobody else works here.
    const apply = input.apply && busy.length === 0 && !unknownNeighbours;
    const result = await host.call('pull', { path: input.path, apply }, { hostId: input.hostId, timeoutMs: 180_000 });
    const lines = [describePull(result, `${hostRow.name}: ${input.path}`)];
    const note = input.apply ? (unknownNeighbours ? 'не удалось проверить, работают ли здесь другие треды — свежее не подтягиваю' : neighbourNote(busy)) : null;
    if (note) lines.push(note);
    let event: SyncEvent | null = null;
    if (input.projectId) {
      event = syncEvent(result, { at: Date.now(), hostId: input.hostId, hostName: hostRow.name, path: input.path, threadId: input.threadId, apply });
      await remember(input.projectId, event);
      try {
        const item = await view(input.projectId);
        const others = otherCopies(item.sources as SourceView[], input.hostId, Date.now());
        if (others.length) lines.push('Другие машины (по последней проверке каталога):', ...others.map(other => `  ${other}`));
      } catch { /* the project may be personal or deleted */ }
      if (result.repos.some(repo => repo.action === 'pulled' || repo.fetched)) scanInBackground(input.projectId);
    }
    return { text: lines.join('\n'), result, event, busy };
  }
  async function syncThread(threadId: string, apply: boolean) {
    const thread = await bb.sdk.threads.get({ threadId });
    if (!thread.environmentId) throw new PluginCliError('у треда ещё нет рабочей папки', { code: 'no_environment', hint: 'Отправьте треду первое сообщение и повторите.' });
    const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId }) as { hostId: string; path?: string | null };
    if (!environment.path) throw new PluginCliError('у окружения треда нет пути на машине', { code: 'no_path' });
    return syncFolder({ threadId, projectId: thread.projectId ?? null, hostId: environment.hostId, path: environment.path, apply });
  }

  // ---------- Pull by code at a thread's first message ----------
  // BB gives a dispatch hook 10 seconds, so the hook only starts the sync and queues the first
  // message ("wait"); the sync's end re-asks the hook, which then lets the message go. Files never
  // change under a running turn, and the result reaches the session instructions.
  const startSync = new Map<string, { at: number; text: string; done: boolean; startedAt: number }>();
  const decided = new Set<string>();
  bb.experimental_hooks.on('message.dispatch', async ctx => {
    try {
      if (ctx.attempt !== 'start-turn' || decided.has(ctx.thread.id)) return { action: 'proceed' };
      const running = startSync.get(ctx.thread.id);
      if (running) {
        if (running.done || Date.now() - running.startedAt > 5 * 60_000) { decided.add(ctx.thread.id); return { action: 'proceed' }; }
        return { action: 'wait', reason: 'Синхронизирую папку проекта перед стартом', sendAt: Date.now() + 60_000 };
      }
      if (autoPull === 'off' || ctx.project.kind !== 'standard' || !ctx.environment || ctx.environment.status !== 'ready' || !ctx.environment.path) { decided.add(ctx.thread.id); return { action: 'proceed' }; }
      const earlier = await bb.sdk.threads.events.list({ threadId: ctx.thread.id, types: ['client/turn/requested'], limit: '1' });
      if (earlier.length) { decided.add(ctx.thread.id); return { action: 'proceed' }; }
      const threadId = ctx.thread.id;
      startSync.set(threadId, { at: Date.now(), text: '', done: false, startedAt: Date.now() });
      void syncFolder({ threadId, projectId: ctx.project.id, hostId: ctx.environment.hostId, path: ctx.environment.path, apply: autoPull === 'auto' })
        .then(done => {
          // A busy git folder: this thread is told to work in its own copy before editing.
          const rule = done.busy.length && done.result.kind === 'git' ? `\n\n${isolationRule(done.busy)}` : '';
          startSync.set(threadId, { at: Date.now(), text: `${done.text}${rule}`, done: true, startedAt: Date.now() });
        })
        .catch(error => {
          bb.log.warn(`Project Catalog: start sync failed: ${String(error)}`);
          startSync.set(threadId, { at: Date.now(), text: '', done: true, startedAt: Date.now() });
        })
        .finally(() => { void bb.experimental_hooks.recheck('message.dispatch').catch(() => undefined); });
      return { action: 'wait', reason: 'Синхронизирую папку проекта перед стартом', sendAt: Date.now() + 60_000 };
    } catch (error) {
      bb.log.warn(`Project Catalog: dispatch hook: ${String(error)}`);
      decided.add(ctx.thread.id);
      return { action: 'proceed' };
    }
  });
  setInterval(() => { for (const [id, value] of startSync) if (Date.now() - value.at > 6 * 60 * 60_000) startSync.delete(id); if (decided.size > 5000) decided.clear(); }, 60 * 60_000).unref?.();

  // ---------- Worktrees: extra copies BB made for threads ----------
  const sizeCache = new Map<string, { at: number; bytes: number | null; exists: boolean }>();
  async function worktrees(projectId: string | null, withSizes: boolean | 'exists'): Promise<WorktreeView[]> {
    const [environments, hostList] = await Promise.all([
      bb.sdk.environments.list({ ...(projectId ? { projectId } : {}), status: 'ready', limit: 500 }),
      bb.sdk.hosts.list(),
    ]);
    const hostNames = new Map(hostList.map(item => [item.id, item.name]));
    const online = new Set(hostList.filter(item => item.status === 'connected').map(item => item.id));
    const list = (environments as unknown as Record<string, unknown>[]).filter(env => env.isWorktree === true && typeof env.path === 'string' && typeof env.projectId === 'string');
    const now = Date.now();
    const views = await Promise.all(list.map(async env => {
      const environmentId = String(env.id);
      const rows = async (archived: boolean) => {
        const result = await bb.sdk.threads.list({ environmentId, archived, limit: 200, includeHidden: true });
        return (Array.isArray(result) ? result : ((result as { threads?: unknown[] }).threads ?? [])) as { updatedAt: number }[];
      };
      const [live, archived] = await Promise.all([rows(false), rows(true)]);
      const lifecycle = (env.lifecycle ?? {}) as { retireAt?: number | string | null };
      const retireAt = lifecycle.retireAt === null || lifecycle.retireAt === undefined ? null : typeof lifecycle.retireAt === 'number' ? lifecycle.retireAt : Date.parse(lifecycle.retireAt) || null;
      const times = [...live, ...archived].map(row => row.updatedAt).filter(Number.isFinite);
      const lastActivity = times.length ? Math.max(...times) : (typeof env.updatedAt === 'number' ? env.updatedAt : null);
      const hostId = String(env.hostId);
      const view: WorktreeView = {
        environmentId, projectId: String(env.projectId), hostId, hostName: hostNames.get(hostId) ?? hostId, path: String(env.path),
        branch: typeof env.branchName === 'string' ? env.branchName : null, liveThreads: live.length, archivedThreads: archived.length,
        lastActivity, retireAt, bytes: sizeCache.get(environmentId)?.bytes ?? null, exists: sizeCache.get(environmentId)?.exists ?? null, state: 'active',
      };
      view.state = worktreeState(view, now);
      return view;
    }));
    if (withSizes) {
      const byHost = new Map<string, WorktreeView[]>();
      for (const view of views) {
        const cached = sizeCache.get(view.environmentId);
        if (withSizes === true && cached && now - cached.at < 60 * 60_000) continue;
        if (!online.has(view.hostId)) continue;
        byHost.set(view.hostId, [...(byHost.get(view.hostId) ?? []), view]);
      }
      await Promise.all([...byHost].map(async ([hostId, items]) => {
        try {
          const { sizes } = await host.call('sizes', { paths: items.slice(0, 50).map(item => item.path), measure: withSizes === true }, { hostId, timeoutMs: 120_000 });
          for (const item of items) {
            const found = sizes.find(size => size.path === item.path);
            if (withSizes === true) item.bytes = found?.bytes ?? null;
            item.exists = found ? found.exists : null;
            item.state = worktreeState(item, now);
            // A failed measurement is retried next time instead of being cached.
            if (withSizes === true && found && (found.bytes !== null || !found.exists)) sizeCache.set(item.environmentId, { at: Date.now(), bytes: found.bytes, exists: found.exists });
          }
        } catch (error) { bb.log.warn(`Project Catalog: worktree sizes failed on ${hostNames.get(hostId) ?? hostId}: ${String(error)}`); }
      }));
    }
    const order: Record<WorktreeView['state'], number> = { missing: 0, orphan: 1, idle: 2, active: 3, retiring: 4 };
    return views.sort((a, b) => order[a.state] - order[b.state] || (b.bytes ?? 0) - (a.bytes ?? 0));
  }

  // ---------- Isolation: a second thread works in its own copy, landed back by code ----------
  async function isolationOf(threadId: string) { return (await bb.storage.kv.get<Isolation>(`iso:${threadId}`)) ?? null; }
  async function isolateThread(threadId: string): Promise<string> {
    const existing = await isolationOf(threadId);
    if (existing) return `Копия уже есть: ${existing.copy} (ветка ${existing.branch}). Если тред ещё не там — вызови update_environment_directory с этим путём и закончи ход.`;
    const thread = await bb.sdk.threads.get({ threadId });
    if (!thread.environmentId || !thread.projectId) throw new Error('у треда нет папки проекта');
    const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId }) as { hostId: string; path?: string | null };
    if (!environment.path) throw new Error('у окружения треда нет пути');
    const result = await host.call('isolate', { path: environment.path, threadId }, { hostId: environment.hostId, timeoutMs: 20 * 60_000 });
    if (!result.ok || !result.path || !result.branch || !result.base) return `Копию сделать не удалось: ${result.message}. Работай в общей папке осторожно: только свои файлы, без переключения ветки.`;
    const record: Isolation = { threadId, projectId: thread.projectId, hostId: environment.hostId, main: environment.path, copy: result.path, branch: result.branch, base: result.base, createdAt: Date.now(), lastLand: null, lastLandAt: null };
    await bb.storage.kv.set(`iso:${threadId}`, record);
    return [`Создана отдельная копия: ${result.path}`, `Ветка ${result.branch} от ${result.base.slice(0, 8)}${result.copied ? `; скопировано файлов по .worktreeinclude: ${result.copied}` : ''}${result.setup ? `; ${result.setup}` : ''}.`,
      `Сейчас вызови update_environment_directory с путём ${result.path} и закончи ход — следующий ход начнётся в копии.`,
      'В конце работы закоммить законченное и вызови project_land.'].join('\n');
  }
  const landing = new Set<string>();
  /** `removeEmpty`: a copy without new commits goes only when its thread asked or is archived. */
  async function tryLand(record: Isolation, reason: string, removeEmpty: boolean): Promise<LandResult> {
    if (landing.has(record.threadId)) return { state: 'waiting', message: 'вливание уже идёт', commits: 0 };
    landing.add(record.threadId);
    try {
      // Unknown neighbours mean "do not touch": a failed thread list must not merge under a running thread.
      let busy: Awaited<ReturnType<typeof neighbours>> | null = null;
      try { busy = (await neighbours(record.threadId, record.hostId, record.main)).filter(n => n.active); } catch { busy = null; }
      const result: LandResult = busy === null
        ? { state: 'waiting', message: 'не удалось узнать, кто работает в основной папке — волью позже', commits: 0 }
        : busy.length
        ? { state: 'waiting', message: `в основной папке сейчас работает ${busy.map(n => `«${n.title}»`).join(', ')} — волью, когда она освободится`, commits: 0 }
        : await host.call('land', { path: record.main, copy: record.copy, branch: record.branch, removeEmpty }, { hostId: record.hostId, timeoutMs: 300_000 });
      if (result.state === 'landed' || result.state === 'gone') {
        await bb.storage.kv.delete(`iso:${record.threadId}`);
        if (result.state === 'landed') {
          await remember(record.projectId, { at: Date.now(), hostId: record.hostId, hostName: (await bb.sdk.hosts.get({ hostId: record.hostId }).catch(() => ({ name: record.hostId }))).name,
            path: record.main, threadId: record.threadId, apply: true, kind: 'git',
            repos: [{ path: '', branch: record.branch, action: 'pulled', reason: null, commits: result.commits, behind: 0, ahead: 0, dirty: 0 }] });
        }
      } else {
        await bb.storage.kv.set(`iso:${record.threadId}`, { ...record, lastLand: result, lastLandAt: Date.now() });
      }
      bb.log.info(`Project Catalog: land ${record.branch} (${reason}): ${result.state} — ${result.message}`);
      return result;
    } finally { landing.delete(record.threadId); }
  }
  /**
   * Land copies whose work is finished: the thread called project_land, or it is
   * archived or gone. An idle thread between turns is not finished — its copy stays.
   * Called when threads go idle or are archived, and every 30 minutes.
   */
  async function landPending(reason: string) {
    for (const key of await bb.storage.kv.list('iso:')) {
      const record = await bb.storage.kv.get<Isolation>(key);
      if (!record) continue;
      let thread: Awaited<ReturnType<typeof bb.sdk.threads.get>> | null | undefined;
      try { thread = await bb.sdk.threads.get({ threadId: record.threadId }); }
      catch (error) { thread = /not.?found|404/i.test(String(error)) ? null : undefined; }
      if (thread === undefined) continue; // BB did not answer: decide later
      const finished = thread === null || Boolean((thread as { archivedAt?: number | null }).archivedAt);
      if (!finished && (!record.landRequested || thread?.status === 'active')) continue;
      if (record.lastLand?.state === 'conflict' && record.lastLandAt && Date.now() - record.lastLandAt < 6 * 60 * 60_000) continue;
      await tryLand(record, reason, finished).catch(error => bb.log.warn(`Project Catalog: land failed: ${String(error)}`));
    }
  }
  bb.events.on('thread.idle', () => { void landPending('тред затих'); });
  bb.events.on('thread.archived', () => { void landPending('тред в архиве'); });

  bb.agents.registerTool({
    name: 'project_isolate',
    description: 'Создать отдельную копию проекта (git worktree на своей ветке) для этого треда, когда в общей папке работает другой тред. Вызывать до первых правок. Затем вызвать update_environment_directory с путём из ответа.',
    presentation: { label: { pending: 'Делаю отдельную копию проекта', completed: 'Сделал отдельную копию проекта' } },
    parameters: z.object({}),
    async execute(_params, ctx) {
      try { return await isolateThread(ctx.threadId); }
      catch (error) { return { content: [{ type: 'text', text: `Копия не создана: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    },
  });
  bb.agents.registerTool({
    name: 'project_land',
    description: 'Влить закоммиченную работу из отдельной копии этого треда в основную папку проекта и убрать копию. Если основная папка занята или в ней правки — плагин вольёт позже сам.',
    presentation: { label: { pending: 'Вливаю работу в основную папку', completed: 'Влил работу в основную папку' } },
    parameters: z.object({}),
    async execute(_params, ctx) {
      try {
        const record = await isolationOf(ctx.threadId);
        if (!record) return 'У этого треда нет отдельной копии — вливать нечего.';
        if (!record.landRequested) await bb.storage.kv.set(`iso:${ctx.threadId}`, { ...record, landRequested: true });
        const result = await tryLand({ ...record, landRequested: true }, 'агент попросил', true);
        return result.state === 'landed' ? `${landText(result)}. Тред остаётся в папке копии, которой больше нет: для дальнейшей работы вызови update_environment_directory с путём ${record.main}.`
          : result.state === 'waiting' ? `${landText(result)}. Плагин вольёт сам, когда станет можно.` : landText(result);
      } catch (error) { return { content: [{ type: 'text', text: `Вливание не выполнено: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    },
  });

  bb.agents.registerTool({
    name: 'project_sync',
    description: 'Подтянуть свежую версию проекта в папку этого треда (git fetch + только fast-forward чистой ветки) и показать, что изменилось и что на других машинах. Ничего не сливает, не перезаписывает и не удаляет.',
    presentation: { label: { pending: 'Синхронизирую папку проекта', completed: 'Синхронизировал папку проекта' } },
    parameters: z.object({ check_only: z.boolean().optional().describe('Только проверить, ничего не подтягивать') }),
    async execute({ check_only }, ctx) {
      try { return (await syncThread(ctx.threadId, !check_only)).text; }
      catch (error) { return { content: [{ type: 'text', text: `Синхронизация не выполнена: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    },
  });

  // Like Project Logo: a thread working in an undescribed project is asked once
  // to describe it. Nothing runs in the background and no model is called here.
  // Every project thread also gets project_sync and the rule to call it first.
  bb.agents.configure(ctx => {
    if (ctx.project.kind !== 'standard') return { tools: [], skills: [] };
    const started = startSync.get(ctx.thread.id)?.text;
    const syncRule = started ? `${SYNC_RULE}\n\nИтог при старте треда:\n${started}` : SYNC_RULE;
    const reason = needsDescription(entries.get(ctx.project.id), docHashes.get(ctx.project.id) ?? null, Date.now());
    if (!reason) return { tools: ['project_sync', 'project_isolate', 'project_land'], skills: [], instructions: syncRule };
    const known = categories().slice(0, 14).map(([name]) => name).join(', ');
    return {
      tools: ['project_sync', 'project_isolate', 'project_land'], skills: [],
      instructions: `${syncRule}\n\nProject Catalog: ${reason === 'missing' ? 'this project has no catalog card yet' : "this project's README/AGENTS.md changed since its catalog card was written"}. Once, early in this thread, without asking and without delaying the user's task, run: bb catalog describe --summary "<1-2 sentences in Russian: what the project is and what it is for>" --category "<category>" --tags "<3-6 comma-separated tags>" --aliases "<comma-separated names the user may say aloud, including Russian spellings>". Base it on README/AGENTS.md, the folder contents and the user's first message.${known ? ` Prefer an existing category: ${known}.` : ''} Fields the user edited by hand are kept by the command. Do not mention this unless it fails.`,
    };
  });

  bb.background.schedule('scan', '17 */3 * * *', async () => { await runScan(null); });

  // Every 30 minutes: fetch projects touched in the last week (remote refs only), then rescan them;
  // and drop worktree records whose folder is already gone and that no live thread uses.
  bb.background.schedule('fetch', '*/30 * * * *', async () => {
    const [projects, hostList, all] = await Promise.all([bb.sdk.projects.list(), bb.sdk.hosts.list(), bb.sdk.threads.list({ archived: false, limit: 500 })]);
    const online = new Set(hostList.filter(item => item.status === 'connected').map(item => item.id));
    const rows = (Array.isArray(all) ? all : ((all as { threads?: unknown[] }).threads ?? [])) as { projectId?: string | null; updatedAt: number }[];
    const recent = new Set(rows.filter(row => row.projectId && Date.now() - row.updatedAt < 7 * 24 * 60 * 60_000).map(row => row.projectId!));
    const byHost = new Map<string, string[]>();
    for (const project of projects) {
      if (!recent.has(project.id)) continue;
      for (const source of project.sources) {
        if (source.type !== 'local_path' || !source.hostId || !source.path || !online.has(source.hostId)) continue;
        byHost.set(source.hostId, [...(byHost.get(source.hostId) ?? []), source.path]);
      }
    }
    await Promise.all([...byHost].map(([hostId, paths]) => host.call('fetch', { paths: paths.slice(0, 100) }, { hostId, timeoutMs: 600_000 })
      .catch(error => bb.log.warn(`Project Catalog: background fetch failed: ${String(error)}`))));
    for (const projectId of recent) await runScan(projectId).catch(() => undefined);
    await landPending('плановая проверка');
    if (!cleanupMissing) return;
    for (const item of await worktrees(null, 'exists')) {
      if (item.state !== 'missing' || item.liveThreads > 0 || !online.has(item.hostId)) continue;
      try { await bb.sdk.environments.experimental_cleanup({ environmentId: item.environmentId }); bb.log.info(`Project Catalog: removed record of missing worktree ${item.environmentId}`); }
      catch (error) { bb.log.warn(`Project Catalog: could not remove ${item.environmentId}: ${String(error)}`); }
    }
  });

  // ---------- CLI: compact text for agents, --json for scripts ----------
  const mark: Record<string, string> = { ok: '', info: '', unknown: '?', attention: '!', risk: '!!' };
  const line = (item: ProjectView) => {
    const machines = [...new Set(item.sources.map(source => source.hostName))].join(',') || '—';
    const state = item.verdict.level === 'ok' || item.verdict.level === 'info' ? '' : `  ${mark[item.verdict.level]} ${item.verdict.label}`;
    const summary = item.entry.summary ? ` — ${item.entry.summary.replace(/\s+/g, ' ').slice(0, 140)}` : '';
    return `${item.id}  ${item.name}  [${item.entry.categories.join(', ') || 'без категории'}]  ${machines}${state}${summary}`;
  };
  const card = (item: ProjectView) => {
    const e = item.entry;
    const out = [`${item.name} (${item.id})`, `Категории: ${e.categories.join(', ') || '—'}   Статус: ${e.status}`];
    if (e.summary) out.push(`Описание${e.locked.includes('summary') ? ' (вручную)' : ''}: ${e.summary}`);
    if (e.notes) out.push(`Заметки пользователя: ${e.notes}`);
    if (e.aliases.length) out.push(`Также называют: ${e.aliases.join(', ')}`);
    if (e.tags.length) out.push(`Теги: ${e.tags.join(', ')}`);
    for (const link of e.links) out.push(`Ссылка: ${link.label} — ${link.url}`);
    if (item.remote) out.push(`Git remote: ${item.remote}`);
    if (e.localPaths.length) out.push(`Свои на каждой машине (не сравниваются): ${e.localPaths.join(', ')}`);
    if (e.independent) out.push('Копии на машинах независимы и не сравниваются');
    out.push(`Копии: ${item.verdict.label}`);
    for (const source of item.sources) {
      const scan = source.scan;
      const state = !scan ? 'не проверено' : scan.kind === 'git' && scan.git ? `git ${scan.git.branch ?? 'detached'} ${scan.git.head?.slice(0, 8) ?? 'без коммитов'}` : scan.kind === 'plain' && scan.plain ? `без git, файлов: ${scan.plain.files}${scan.plain.truncated ? '+' : ''}` : scan.kind === 'missing' ? 'папка не найдена' : `ошибка: ${scan.error ?? ''}`;
      out.push(`  ${source.hostName}${source.isDefault ? ' (основная)' : ''}: ${source.path} — ${state}`);
      for (const part of scan?.parts ?? []) out.push(`    ${part.path}/ — свой git ${part.git.branch ?? 'detached'} ${part.git.head?.slice(0, 8) ?? ''}${part.git.dirty + part.git.untracked ? `, не закоммичено: ${part.git.dirty + part.git.untracked}` : ''}${part.git.ahead ? `, не отправлено: ${part.git.ahead}` : ''}`);
    }
    for (const detail of item.verdict.details) out.push(`  • ${detail}`);
    if (item.diff) for (const file of item.diff.sample.slice(0, 15)) {
      out.push(`    ${file.kind === 'changed' ? `изменён${file.newer ? `, новее на ${file.newer === 'a' ? item.diff.a : item.diff.b}` : ''}` : `только на ${file.kind === 'onlyA' ? item.diff.a : item.diff.b}`}: ${file.path}`);
    }
    return out.join('\n');
  };
  async function resolve(ref: string | undefined, ctxProjectId: string | undefined) {
    const { list } = await views();
    if (!ref) {
      const current = list.find(item => item.id === ctxProjectId);
      if (current) return current;
      throw new PluginCliError('укажите проект', { code: 'project_required', hint: 'Передайте ID или название: bb catalog show <project>. Найти: bb catalog find <слова>.' });
    }
    const exact = list.find(item => item.id === ref) ?? list.find(item => item.name.toLowerCase() === ref.toLowerCase());
    if (exact) return exact;
    const hits = search(docsOf(list), ref);
    if (hits.length === 1 || (hits[0] && hits[0].score >= 60 && (!hits[1] || hits[1].score < hits[0].score))) return hits[0]!.doc.view;
    throw new PluginCliError(hits.length ? `«${ref}» подходит к нескольким проектам: ${hits.slice(0, 5).map(hit => hit.doc.name).join(', ')}` : `проект «${ref}» не найден`,
      { code: hits.length ? 'project_ambiguous' : 'project_not_found', hint: 'Уточните по ID из `bb catalog find <слова>`.' });
  }
  const text = (stdout: string) => ({ exitCode: 0, stdout: stdout.endsWith('\n') ? stdout : `${stdout}\n` });
  const json = (value: unknown) => text(JSON.stringify(value, null, 2));
  const jsonFlag = { type: 'boolean', description: 'Вывести JSON' } as const;
  const projectArg = { name: 'project', description: 'ID, название или алиас проекта; по умолчанию проект текущего треда' } as const;
  const fieldOptions = {
    summary: { type: 'string', description: 'Короткое описание, 1–2 предложения (до 600 символов)' },
    category: { type: 'string', aliases: ['categories'], description: 'Категория; несколько — через запятую (до 4), первая основная' },
    tags: { type: 'string', description: 'Теги через запятую (до 12)' },
    aliases: { type: 'string', aliases: ['alias'], description: 'Другие названия через запятую, включая русские написания' },
    links: { type: 'string', aliases: ['link'], description: 'Ссылки через запятую: название=https://…' },
  } as const;
  const patchFrom = (options: { summary?: string; category?: string; tags?: string; aliases?: string; links?: string }): Patch => {
    const patch: Patch = {};
    if (options.summary !== undefined) patch.summary = options.summary;
    if (options.category !== undefined) patch.category = options.category;
    if (options.tags !== undefined) patch.tags = csv(options.tags)!;
    if (options.aliases !== undefined) patch.aliases = csv(options.aliases)!;
    if (options.links !== undefined) patch.links = parseLinks(options.links)!;
    return patch;
  };

  bb.cli.register(defineCli({
    name: 'catalog',
    summary: 'Каталог проектов: найти проект по смыслу, описание, категории, состояние копий на машинах',
    commands: {
      find: cliCommand({
        summary: 'Найти проект по названию, алиасу, тегу, категории или словам из описания',
        positionals: [{ name: 'query', description: 'Слова запроса (русское написание тоже находит латинское название)', required: true, variadic: true }],
        options: { limit: { type: 'integer', default: 8, min: 1, max: 50, description: 'Сколько результатов вывести (1–50)' }, json: jsonFlag },
        async run(input) {
          const query = ([] as string[]).concat(input.positionals.query).join(' ');
          const limit = Number(input.options.limit ?? 8);
          const hits = search(docsOf((await views()).list), query).slice(0, limit);
          if (input.options.json) return json(hits.map(hit => ({ score: Math.round(hit.score), id: hit.doc.id, name: hit.doc.name, category: hit.doc.category, summary: hit.doc.summary, machines: hit.doc.view.sources.map(s => ({ host: s.hostName, path: s.path })) })));
          return text(hits.length ? hits.map(hit => line(hit.doc.view)).join('\n') : `Ничего не найдено по «${query}». Все проекты: bb catalog list`);
        },
      }),
      list: cliCommand({
        summary: 'Список проектов одной строкой на проект, с фильтрами',
        options: {
          category: { type: 'string', description: 'Только эта категория' },
          machine: { type: 'string', aliases: ['host'], description: 'Только проекты с папкой на этой машине (имя или ID)' },
          attention: { type: 'boolean', description: 'Только проекты, где копии требуют внимания или расходятся' },
          undescribed: { type: 'boolean', aliases: ['missing'], description: 'Только проекты без описания' },
          json: jsonFlag,
        },
        async run(input) {
          let { list } = await views();
          const { category, machine, attention, undescribed } = input.options;
          if (category) list = list.filter(item => item.entry.categories.some(name => name.toLowerCase() === category.toLowerCase()));
          if (machine) list = list.filter(item => item.sources.some(source => source.hostId === machine || source.hostName.toLowerCase().includes(machine.toLowerCase())));
          if (attention) list = list.filter(item => item.verdict.level === 'attention' || item.verdict.level === 'risk');
          if (undescribed) list = list.filter(item => !item.entry.summary);
          list.sort((a, b) => (a.entry.category || 'яя').localeCompare(b.entry.category || 'яя') || a.name.localeCompare(b.name));
          if (input.options.json) return json(list.map(item => ({ id: item.id, name: item.name, category: item.entry.category, summary: item.entry.summary, sync: item.verdict.label, machines: item.sources.map(s => s.hostName) })));
          return text(`${list.map(line).join('\n')}\n— проектов: ${list.length}`);
        },
      }),
      show: cliCommand({
        summary: 'Карточка проекта: описание, заметки, ссылки, папки на машинах и состояние копий',
        positionals: [projectArg],
        options: { json: jsonFlag },
        async run(input, ctx) {
          const item = await resolve(input.positionals.project, ctx.projectId);
          return input.options.json ? json(item) : text(card(item));
        },
      }),
      describe: cliCommand({
        summary: 'Автоописание от агента: записывает только поля, которые пользователь не правил вручную',
        positionals: [projectArg],
        options: { ...fieldOptions, json: jsonFlag },
        async run(input, ctx) {
          const item = await resolve(input.positionals.project, ctx.projectId);
          const patch = patchFrom(input.options);
          if (!Object.keys(patch).length) throw new PluginCliError('нечего записывать', { code: 'empty_patch', hint: 'Передайте хотя бы --summary и --category.' });
          const result = applyAuto(entries.get(item.id) ?? emptyEntry(), patch, docHashes.get(item.id) ?? null, Date.now());
          await saveEntry(item.id, result.entry);
          if (input.options.json) return json({ id: item.id, written: result.written, keptManual: result.skipped });
          return text(`Карточка «${item.name}» обновлена: ${result.written.join(', ') || 'ничего'}.${result.skipped.length ? ` Оставлено как у пользователя (правил вручную): ${result.skipped.join(', ')}.` : ''}`);
        },
      }),
      set: cliCommand({
        summary: 'Правка от имени пользователя: изменённые поля закрепляются и не перезаписываются автоописанием',
        positionals: [projectArg],
        options: {
          ...fieldOptions,
          notes: { type: 'string', description: 'Заметки пользователя (автоописание их никогда не трогает)' },
          status: { type: 'enum', values: ['active', 'paused', 'archive'], description: 'Статус проекта' },
          independent: { type: 'enum', values: ['yes', 'no'], description: 'yes — копии на разных машинах независимы и не сравниваются' },
          'local-paths': { type: 'string', aliases: ['local'], description: 'Папки внутри проекта, которые на каждой машине свои и не сравниваются: через запятую, относительно корня; пустая строка очищает' },
          json: jsonFlag,
        },
        async run(input, ctx) {
          const item = await resolve(input.positionals.project, ctx.projectId);
          const patch: Patch = patchFrom(input.options);
          if (input.options.notes !== undefined) patch.notes = input.options.notes;
          if (input.options.status !== undefined) patch.status = input.options.status as Status;
          if (input.options.independent !== undefined) patch.independent = input.options.independent === 'yes';
          if (input.options['local-paths'] !== undefined) patch.localPaths = csv(input.options['local-paths'])!;
          if (!Object.keys(patch).length) throw new PluginCliError('нечего записывать', { code: 'empty_patch', hint: 'Укажите хотя бы одно поле, например --notes "…".' });
          await saveEntry(item.id, applyManual(entries.get(item.id) ?? emptyEntry(), patch, Date.now()));
          if (patch.localPaths !== undefined) await recompare(item.id);
          const saved = await view(item.id);
          return input.options.json ? json(saved) : text(card(saved));
        },
      }),
      unlock: cliCommand({
        summary: 'Снять закрепление с полей, чтобы автоописание снова могло их обновлять',
        positionals: [{ name: 'project', description: 'ID, название или алиас проекта', required: true }],
        options: { fields: { type: 'string', description: `Поля через запятую (${AUTO_FIELDS.join(', ')}); по умолчанию все` } },
        async run(input, ctx) {
          const item = await resolve(input.positionals.project, ctx.projectId);
          const fields = (csv(input.options.fields) ?? [...AUTO_FIELDS]).filter((field): field is AutoField => (AUTO_FIELDS as readonly string[]).includes(field));
          await saveEntry(item.id, unlock(entries.get(item.id) ?? emptyEntry(), fields, Date.now()));
          return text(`Сняты закрепления у «${item.name}»: ${fields.join(', ')}`);
        },
      }),
      group: cliCommand({
        summary: 'Отнести категорию к группе в боковой панели; пустая группа убирает категорию из групп',
        positionals: [{ name: 'category', description: 'Название категории', required: true }, { name: 'group', description: 'Название группы; не указывать, чтобы убрать' }],
        async run(input) {
          await ready;
          await setGroup(input.positionals.category, input.positionals.group ?? '');
          return text(input.positionals.group ? `Категория «${input.positionals.category}» в группе «${input.positionals.group}»` : `Категория «${input.positionals.category}» без группы`);
        },
      }),
      'rename-category': cliCommand({
        summary: 'Переименовать категорию во всех карточках (группа переносится)',
        positionals: [{ name: 'from', description: 'Текущее название', required: true }, { name: 'to', description: 'Новое название', required: true }],
        async run(input) {
          const changed = await renameCategoryEverywhere(input.positionals.from, input.positionals.to);
          return text(`Переименовано в ${changed} карточках`);
        },
      }),
      'rename-group': cliCommand({
        summary: 'Переименовать группу категорий; пустое новое имя удаляет группу, категории остаются',
        positionals: [{ name: 'from', description: 'Текущее название группы', required: true }, { name: 'to', description: 'Новое название; не указывать, чтобы удалить группу' }],
        async run(input) {
          await renameGroupEverywhere(input.positionals.from, input.positionals.to ?? '');
          return text(input.positionals.to ? `Группа переименована в «${input.positionals.to}»` : `Группа «${input.positionals.from}» удалена, её категории без группы`);
        },
      }),
      categories: cliCommand({
        summary: 'Категории каталога с числом проектов',
        options: { json: jsonFlag },
        async run(input) {
          await ready;
          const list = categories();
          return input.options.json ? json(list.map(([name, count]) => ({ name, count, group: groups[name] ?? null }))) : text(list.length ? list.map(([name, count]) => `${count}\t${name}${groups[name] ? `\t(${groups[name]})` : ''}`).join('\n') : 'Категорий пока нет');
        },
      }),
      sync: cliCommand({
        summary: 'Состояние копий на машинах: незакоммиченное, неотправленное, расхождения; --refresh перепроверяет',
        positionals: [{ name: 'project', description: 'ID, название или алиас; без него — все проекты, требующие внимания' }],
        options: { refresh: { type: 'boolean', description: 'Сначала заново проверить машины, которые на связи' }, json: jsonFlag },
        async run(input, ctx) {
          const target = input.positionals.project ? await resolve(input.positionals.project, ctx.projectId) : null;
          if (input.options.refresh) await runScan(target?.id ?? null);
          if (target) { const item = await view(target.id); return input.options.json ? json({ id: item.id, verdict: item.verdict, sources: item.sources, diff: item.diff }) : text(card(item)); }
          const list = (await views()).list.filter(item => item.verdict.level === 'attention' || item.verdict.level === 'risk');
          if (input.options.json) return json(list.map(item => ({ id: item.id, name: item.name, verdict: item.verdict })));
          return text(list.length ? list.map(item => `${mark[item.verdict.level]} ${item.name} (${item.id}): ${item.verdict.label}\n${item.verdict.details.map(detail => `   • ${detail}`).join('\n')}`).join('\n') : 'Все проверенные копии в порядке.');
        },
      }),
      pull: cliCommand({
        summary: 'Подтянуть свежее в папку треда: git fetch и только fast-forward чистой ветки; показать новые коммиты и другие машины',
        options: {
          thread: { type: 'string', description: 'ID треда; внутри треда можно не указывать' },
          check: { type: 'boolean', aliases: ['check-only', 'dry-run'], description: 'Только проверить (fetch), ничего не подтягивать' },
          json: jsonFlag,
        },
        async run(input, ctx) {
          const threadId = input.options.thread ?? ctx.threadId;
          if (!threadId) throw new PluginCliError('не указан тред', { code: 'thread_required', hint: 'Добавьте --thread <id> или запустите команду внутри треда.' });
          const done = await syncThread(threadId, !input.options.check);
          return input.options.json ? json({ result: done.result, event: done.event }) : text(done.text);
        },
      }),
      worktrees: cliCommand({
        summary: 'Worktree-копии, которые BB создал для тредов: где лежат, сколько занимают, есть ли живые треды; забытые — первыми',
        positionals: [{ name: 'project', description: 'ID, название или алиас; без него — все проекты' }],
        options: { 'no-sizes': { type: 'boolean', description: 'Не считать размеры (быстрее)' }, json: jsonFlag },
        async run(input, ctx) {
          const target = input.positionals.project ? await resolve(input.positionals.project, ctx.projectId) : null;
          const list = await worktrees(target?.id ?? null, !input.options['no-sizes']);
          if (input.options.json) return json(list);
          if (!list.length) return text(target ? `${target.name}: worktree-копий нет.` : 'Worktree-копий нет.');
          const names = new Map((await views()).list.map(item => [item.id, item.name]));
          const total = list.reduce((sum, item) => sum + (item.bytes ?? 0), 0);
          const now = Date.now();
          return text([`Worktree: ${list.length}${total ? `, всего ${formatBytes(total)}` : ''}. BB удаляет копию через 5 минут после архивации последнего её треда.`,
            ...list.map(item => `${target ? '' : `[${names.get(item.projectId) ?? item.projectId}] `}${worktreeLine(item, now)}`)].join('\n'));
        },
      }),
      history: cliCommand({
        summary: 'История синхронизаций проекта: кто, где и когда подтягивал или проверял',
        positionals: [projectArg],
        options: { limit: { type: 'integer', default: 15, min: 1, max: 40, description: 'Сколько последних записей (1–40)' }, json: jsonFlag },
        async run(input, ctx) {
          const target = await resolve(input.positionals.project, ctx.projectId);
          const events = (await history(target.id)).slice(0, input.options.limit);
          if (input.options.json) return json(events);
          if (!events.length) return text(`${target.name}: синхронизаций ещё не было.`);
          return text([`${target.name}:`, ...events.map(event => `${new Date(event.at).toISOString().slice(0, 16).replace('T', ' ')} UTC  ${event.hostName}${event.apply ? '' : ' (проверка)'}  ${eventSummary(event)}${event.threadId ? `  @thread:${event.threadId}` : ''}`)].join('\n'));
        },
      }),
    },
  }));
}
