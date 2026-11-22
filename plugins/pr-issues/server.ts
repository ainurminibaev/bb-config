import { PluginCliError, cliCommand, defineCli, type BbPluginApi } from '@get-bb/plugin-sdk';
import { rpcContract, type Board, type BoardQuery, type ItemViewDto } from './contract';
import { clip, dedupeEvents, diffEvents, parseSince, recentEnough, firstSeen, ownerOf, repoDefault, repoMode, orgMode, trackedTargets, visible, type SourceChoices, type SourceContext, type SourceMode, githubRepo, inScope, pageOf, parseRepos, sortViews, view, type FeedEvent, type Item, type Mute, type Seen } from './core';
import { act, fetchAll, ghRunner, myOrgs, type Action, type Runner } from './github';

const STALE_MS = 5 * 60 * 1000;
const EVENTS_LIMIT = 300;
/** Computed views are reused this long unless something changed: opening the page does not recompute everything. */
const VIEWS_TTL_MS = 60 * 1000;
const PROJECTS_TTL_MS = 60 * 1000;

interface Stored { me: string | null; myOrgs?: string[]; items: Record<string, Item>; fetchedAt: number | null; baselineDone: boolean; warnings: string[] }

export default function prIssues(bb: BbPluginApi) { return createServer(bb, ghRunner); }

export function createServer(bb: BbPluginApi, run: Runner) {
  let stored: Stored = { me: null, items: {}, fetchedAt: null, baselineDone: false, warnings: [] };
  let seen: Record<string, Seen> = {};
  let mutes: Record<string, Mute> = {};
  let events: FeedEvent[] = [];
  let fetching: Promise<void> | null = null;
  let lastError: string | null = null;
  let extraRepos: string[] = [];
  let ignoreRepos: string[] = [];
  let since = parseSince('2025-01-01');
  let choices: SourceChoices = {};
  let version = 0;
  let memo: { version: number; at: number; items: ItemViewDto[] } | null = null;
  let projectsMemo: { at: number; map: Map<string, { id: string; name: string }[]> } | null = null;
  const changed = (payload: Record<string, unknown> = {}) => { version++; bb.realtime.publish('changed', payload); };

  const settings = bb.settings.define({
    extraRepos: {
      type: 'string', label: 'Дополнительные репозитории', default: '', experimental_multiline: true,
      description: 'owner/repo или ссылки GitHub через запятую или с новой строки: открытые PR и issue этих репозиториев попадут на страницу, даже если проекта в BB нет.',
    },
    since: {
      type: 'string', label: 'Показывать начиная с даты', default: '2025-01-01',
      description: 'ГГГГ-ММ-ДД. Записи, которые не менялись с этой даты, не загружаются и не показываются. Пусто — без ограничения.',
    },
    ignoreRepos: {
      type: 'string', label: 'Не показывать репозитории', default: '', experimental_multiline: true,
      description: 'owner/repo через запятую: записи из них не показываются нигде.',
    },
  });
  const applySettings = (v: { extraRepos: string; ignoreRepos: string; since: string }) => { extraRepos = parseRepos(v.extraRepos); ignoreRepos = parseRepos(v.ignoreRepos); since = parseSince(v.since); };
  void settings.get().then(applySettings).catch(() => undefined);
  settings.onChange(next => { applySettings(next); changed(); });

  // Items live in SQLite: a KV value is capped at 256 KB and whole organizations exceed it.
  const db = bb.storage.database();
  bb.storage.migrate(db, ['CREATE TABLE IF NOT EXISTS items (key TEXT PRIMARY KEY, json TEXT NOT NULL)']);
  const loadItems = () => Object.fromEntries((db.prepare('SELECT key, json FROM items').all() as { key: string; json: string }[]).map(row => [row.key, JSON.parse(row.json) as Item]));
  const saveItems = (items: Record<string, Item>) => {
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM items').run();
      const insert = db.prepare('INSERT INTO items (key, json) VALUES (?, ?)');
      for (const [key, item] of Object.entries(items)) insert.run(key, JSON.stringify(item));
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const saveState = async () => { saveItems(stored.items); await bb.storage.kv.set('state', { ...stored, items: {} }); };

  const ready = (async () => {
    stored = (await bb.storage.kv.get<Stored>('state')) ?? stored;
    const legacy = stored.items ?? {};
    stored.items = loadItems();
    if (!Object.keys(stored.items).length && Object.keys(legacy).length) { stored.items = legacy; await saveState(); }
    seen = (await bb.storage.kv.get<Record<string, Seen>>('seen')) ?? {};
    mutes = (await bb.storage.kv.get<Record<string, Mute>>('mutes')) ?? {};
    events = dedupeEvents((await bb.storage.kv.get<FeedEvent[]>('events')) ?? []);
    choices = (await bb.storage.kv.get<SourceChoices>('sources')) ?? {};
  })();

  /** BB projects with a GitHub remote, by repository. */
  async function projectRepos(): Promise<Map<string, { id: string; name: string }[]>> {
    if (projectsMemo && Date.now() - projectsMemo.at < PROJECTS_TTL_MS) return projectsMemo.map;
    const list = await bb.sdk.projects.list();
    const map = new Map<string, { id: string; name: string }[]>();
    for (const project of list as { id: string; name: string; gitRemoteUrl?: string | null }[]) {
      const repo = githubRepo(project.gitRemoteUrl)?.toLowerCase();
      if (repo) map.set(repo, [...(map.get(repo) ?? []), { id: project.id, name: project.name }]);
    }
    projectsMemo = { at: Date.now(), map };
    return map;
  }

  const context = (bbRepos: string[], me = stored.me ?? '', orgs = stored.myOrgs ?? []): SourceContext =>
    ({ me, myOrgs: orgs, bbRepos, choices, extra: extraRepos, ignore: ignoreRepos });

  async function sync() {
    await ready;
    const projects = await projectRepos();
    const me = stored.me ?? (await run(['api', 'user', '--jq', '.login'])).trim();
    const orgs = await myOrgs(run).catch(() => stored.myOrgs ?? []);
    const known = Object.values(stored.items).map(item => item.repo.toLowerCase());
    const targets = trackedTargets(context([...projects.keys()], me, orgs), known);
    const now = Date.now();
    const result = await fetchAll(run, targets, now, since);
    const ctx = context([...projects.keys()], result.me, orgs);
    const nextItems: Record<string, Item> = {};
    const fresh: FeedEvent[] = [];
    for (const item of result.items) {
      if (projects.has(item.repo.toLowerCase()) && !item.relations.includes('project')) item.relations.push('project');
      nextItems[item.key] = item;
      if (stored.baselineDone && visible(item, ctx)) fresh.push(...diffEvents(stored.items[item.key], item, result.me, now));
      if (!seen[item.key]) seen[item.key] = firstSeen(item, result.me, stored.baselineDone, now);
    }
    // Items that dropped out of the searches (e.g. closed long ago) stay as they were, so history is kept.
    for (const [key, item] of Object.entries(stored.items)) if (!nextItems[key]) nextItems[key] = item;
    stored = { me: result.me, myOrgs: orgs, items: nextItems, fetchedAt: now, baselineDone: true, warnings: result.errors.slice(0, 5) };
    if (fresh.length) events = dedupeEvents([...fresh, ...events]).slice(0, EVENTS_LIMIT);
    await Promise.all([saveState(), bb.storage.kv.set('seen', seen), bb.storage.kv.set('events', events)]);
  }

  function refresh(): Promise<void> {
    if (fetching) return fetching;
    fetching = sync()
      .then(() => { lastError = null; })
      .catch(error => { lastError = (error as Error).message; bb.log.warn(`PR и Issues: ${lastError}`); })
      .finally(() => { fetching = null; changed(); });
    changed({ fetching: true });
    return fetching;
  }

  /** Every visible item as a view, cached until something changes (or a minute passes, for time-based notices). */
  async function views(): Promise<ItemViewDto[]> {
    await ready;
    if (!fetching && (stored.fetchedAt === null || Date.now() - stored.fetchedAt > STALE_MS)) void refresh();
    if (memo && memo.version === version && Date.now() - memo.at < VIEWS_TTL_MS) return memo.items;
    const projects = await projectRepos().catch(() => new Map<string, { id: string; name: string }[]>());
    const me = stored.me ?? '';
    const ctx = context([...projects.keys()]);
    const now = Date.now();
    const items: ItemViewDto[] = sortViews(Object.values(stored.items)
      .filter(item => visible(item, ctx) && recentEnough(item, since))
      .map(item => view(item, me, seen[item.key], mutes[item.key], now)))
      .map(item => ({ ...item, projects: projects.get(item.repo.toLowerCase()) ?? [] }));
    memo = { version, at: now, items };
    return items;
  }

  async function board(query: BoardQuery): Promise<Board> {
    const all = await views();
    const page = pageOf(all, query.bucket, query, query.offset, query.limit);
    return {
      me: stored.me, ...page, since: since || null,
      fetchedAt: stored.fetchedAt, fetching: Boolean(fetching), error: lastError, warnings: stored.warnings,
    };
  }

  async function feed(kind: 'all' | 'pr' | 'issue', scope: string) {
    await ready;
    const projects = await projectRepos().catch(() => new Map<string, { id: string; name: string }[]>());
    const ctx = context([...projects.keys()]);
    return events.filter(event => event.at >= since && (kind === 'all' || event.kind === kind) && inScope(event.repo, scope)
      && (stored.items[event.key] ? visible(stored.items[event.key]!, ctx) : repoMode(event.repo, ctx) !== 'hidden')).slice(0, 200);
  }

  /** Every organization and repository the user may want to toggle, with current modes. */
  async function sources() {
    await ready;
    const projects = await projectRepos().catch(() => new Map<string, { id: string; name: string }[]>());
    const ctx = context([...projects.keys()]);
    const counts = new Map<string, number>();
    for (const item of Object.values(stored.items)) if (recentEnough(item, since)) counts.set(item.repo.toLowerCase(), (counts.get(item.repo.toLowerCase()) ?? 0) + 1);
    const repoNames = new Map<string, string>();
    for (const item of Object.values(stored.items)) repoNames.set(item.repo.toLowerCase(), item.repo);
    const allRepos = new Set<string>([...projects.keys(), ...counts.keys(), ...extraRepos, ...ignoreRepos, ...Object.keys(choices).filter(k => k.startsWith('repo:')).map(k => k.slice(5))]);
    const orgSet = new Set<string>([ctx.me.toLowerCase(), ...ctx.myOrgs.map(o => o.toLowerCase()), ...[...allRepos].map(ownerOf), ...Object.keys(choices).filter(k => k.startsWith('org:')).map(k => k.slice(4))].filter(Boolean));
    const memberOf = new Set(ctx.myOrgs.map(o => o.toLowerCase()));
    const orgs = [...orgSet].map(login => {
      const repos = [...allRepos].filter(repo => ownerOf(repo) === login).sort().map(repo => ({
        repo: repoNames.get(repo) ?? repo, mode: repoMode(repo, ctx), explicit: Boolean(choices[`repo:${repo}`]), inherited: repoDefault(repo, ctx),
        count: counts.get(repo) ?? 0, projects: (projects.get(repo) ?? []).map(p => p.name),
      }));
      return { login, mode: orgMode(login, ctx), explicit: Boolean(choices[`org:${login}`]), me: login === ctx.me.toLowerCase(), member: memberOf.has(login), count: repos.reduce((sum, r) => sum + r.count, 0), repos };
    }).sort((a, b) => Number(b.me) - Number(a.me) || Number(b.member) - Number(a.member) || b.count - a.count || a.login.localeCompare(b.login));
    return { orgs };
  }

  const find = async (key: string) => {
    await ready;
    const item = stored.items[key];
    if (!item) throw new Error('Запись не найдена — обновите страницу');
    return item;
  };

  bb.rpc.register(rpcContract, {
    board,
    async summary() {
      const all = await views();
      let action = 0; let fresh = 0;
      for (const item of all) if (item.bucket === 'action') { action++; if (item.unread) fresh++; }
      return { action, fresh };
    },
    async feed({ kind, scope }) { return { events: await feed(kind, scope) }; },
    async item({ key }) { return { item: (await views()).find(item => item.key === key) ?? null }; },
    async refresh() { const started = !fetching; void refresh(); return { started }; },
    async mark_seen({ keys }) {
      await ready;
      let count = 0;
      for (const key of keys) {
        const item = stored.items[key];
        if (!item) continue;
        seen[key] = { at: Date.now(), status: view(item, stored.me ?? '', undefined, undefined).status };
        count++;
      }
      await bb.storage.kv.set('seen', seen);
      changed();
      return { changed: count };
    },
    async mute({ key, muted }) {
      await ready;
      if (muted) mutes[key] = { at: Date.now() }; else delete mutes[key];
      await bb.storage.kv.set('mutes', mutes);
      changed();
      return { ok: true };
    },
    async act({ key, action, body }) {
      const item = await find(key);
      const output = await act(run, item, action as Action, body ?? '');
      void refresh();
      return { ok: true, message: clip(output, 300) };
    },
    async delegate({ key, projectId }) {
      const item = await find(key);
      const what = item.kind === 'pr' ? `пулреквест ${item.repo}#${item.number}` : `issue ${item.repo}#${item.number}`;
      const tool = item.kind === 'pr' ? `gh pr view ${item.number} --repo ${item.repo} --comments` : `gh issue view ${item.number} --repo ${item.repo} --comments`;
      const thread = await bb.sdk.threads.spawn({
        projectId, environment: { type: 'project-default' }, title: `${item.kind === 'pr' ? 'PR' : 'Issue'} ${item.repo}#${item.number}: ${clip(item.title, 60)}`,
        prompt: `Разберись, что нужно сделать по ${what}: ${item.url}\n\nСейчас: ${view(item, stored.me ?? '', undefined, undefined).reason}.\n\nПрочитай всё обсуждение и ревью (${tool}${item.kind === 'pr' ? `, замечания в коде: gh api repos/${item.repo}/pulls/${item.number}/comments` : ''}). Коротко перескажи мне, чего от меня ждут, и предложи план. Ничего не отправляй на GitHub (комментарии, пуши, слияние, закрытие) без моего подтверждения.`,
      });
      return { threadId: thread.id };
    },
    sources,
    async set_source({ key, mode }) {
      await ready;
      const normalized = key.toLowerCase();
      if (mode === null) delete choices[normalized]; else choices[normalized] = mode as SourceMode;
      await bb.storage.kv.set('sources', choices);
      changed();
      if (mode === 'all') void refresh();
      return { ok: true };
    },
    async projects() {
      const list = await bb.sdk.projects.list() as { id: string; name: string; gitRemoteUrl?: string | null }[];
      return { projects: list.map(project => ({ id: project.id, name: project.name, repo: githubRepo(project.gitRemoteUrl) })) };
    },
  });

  bb.background.schedule('refresh', '*/10 * * * *', async () => { await refresh(); });

  const text = (stdout: string) => ({ exitCode: 0, stdout: stdout.endsWith('\n') ? stdout : `${stdout}\n` });
  const line = (item: ItemViewDto) => `${item.unread ? '● ' : ''}${item.kind === 'pr' ? 'PR' : 'Issue'} ${item.repo}#${item.number} — ${item.status} — ${item.reason}\n    ${clip(item.title, 100)} ${item.url}`;
  bb.cli.register(defineCli({
    name: 'prs',
    summary: 'PR и Issues: ваши пулреквесты и issue на GitHub, где нужно ваше действие',
    commands: {
      list: cliCommand({
        summary: 'Список: по умолчанию то, что ждёт вашего действия',
        options: {
          bucket: { type: 'enum', values: ['action', 'waiting', 'done', 'all'], default: 'action', description: 'action — нужно ваше действие, waiting — ждут других, done — завершённые, all — всё' },
          limit: { type: 'integer', default: 30, min: 1, max: 300, description: 'Сколько строк вывести' },
          json: { type: 'boolean', description: 'Вывести JSON' },
        },
        async run(input) {
          const all = await views();
          const bucket = input.options.bucket ?? 'action';
          const items = all.filter(item => bucket === 'all' || item.bucket === bucket).slice(0, Number(input.options.limit ?? 30));
          const data = { fetchedAt: stored.fetchedAt, fetching: Boolean(fetching), error: lastError };
          if (input.options.json) return text(JSON.stringify(items.map(({ key, kind, repo, number, title, url, status, reason, bucket: b, unread }) => ({ key, kind, repo, number, title, url, status, reason, bucket: b, unread })), null, 2));
          const head = data.fetchedAt ? `Обновлено ${new Date(data.fetchedAt).toISOString().replace('T', ' ').slice(0, 16)} UTC${data.fetching ? ', идёт обновление' : ''}` : 'Ещё не загружено — идёт первая загрузка';
          return text(`${head}\n${items.length ? items.map(line).join('\n') : 'Пусто'}${data.error ? `\nОшибка последнего обновления: ${data.error}` : ''}`);
        },
      }),
      refresh: cliCommand({
        summary: 'Обновить данные с GitHub сейчас и дождаться результата',
        async run() {
          await refresh();
          if (lastError) throw new PluginCliError(lastError, { code: 'fetch_failed', hint: 'Проверьте `gh auth status` на сервере BB.' });
          const all = await views();
          const count = (b: string) => all.filter(item => item.bucket === b).length;
          return text(`Готово: нужно ваше действие — ${count('action')}, ждут других — ${count('waiting')}, завершено — ${count('done')}.`);
        },
      }),
    },
  }));
}
