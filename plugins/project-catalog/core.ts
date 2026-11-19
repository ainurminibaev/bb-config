// Pure catalog logic: entry merging with manual locks, search, and the
// cross-machine sync verdict. No BB or Node APIs, so it is unit-tested directly.

export const AUTO_FIELDS = ['summary', 'category', 'tags', 'aliases', 'links'] as const;
export type AutoField = (typeof AUTO_FIELDS)[number];
export type Status = 'active' | 'paused' | 'archive';
export type Link = { label: string; url: string };
export type Entry = {
  summary: string;
  /** The user's own text. Never written by automatic description. */
  notes: string;
  /** Primary category: the first of `categories`. */
  category: string;
  categories: string[];
  tags: string[];
  aliases: string[];
  links: Link[];
  status: Status;
  /** Copies on different machines are separate on purpose and are not compared. */
  independent: boolean;
  /** Sub-folders that are meant to differ on every machine; left out of the comparison. */
  localPaths: string[];
  /** Fields the user edited by hand; automatic description skips them. */
  locked: AutoField[];
  describedAt: number | null;
  describedDocHash: string | null;
  updatedAt: number;
};
export type Patch = Partial<Pick<Entry, AutoField | 'notes' | 'status' | 'independent' | 'localPaths'>>;

export const REDESCRIBE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

export function emptyEntry(): Entry {
  return { summary: '', notes: '', category: '', categories: [], tags: [], aliases: [], links: [], status: 'active', independent: false, localPaths: [], locked: [], describedAt: null, describedDocHash: null, updatedAt: 0 };
}

const clean = (value: string, max: number) => value.replace(/\s+/g, ' ').trim().slice(0, max);
function cleanList(values: string[], max: number) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = clean(raw, 60);
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= max) break;
  }
  return out;
}
function cleanLinks(links: Link[]) {
  return links
    .map(link => ({ label: clean(link.label, 60), url: link.url.trim().slice(0, 500) }))
    .filter(link => /^https?:\/\//i.test(link.url))
    .map(link => ({ label: link.label || link.url.replace(/^https?:\/\//i, '').replace(/\/$/, ''), url: link.url }))
    .slice(0, 12);
}
/** A project may sit in several categories; the text form is comma-separated, the first is primary. */
export function splitCategories(text: string) {
  return cleanList(text.split(','), 4).map(item => item.slice(0, 40));
}
/** Rename one category inside an entry; the order is kept and a duplicate collapses. */
export function renameCategory(entry: Entry, from: string, to: string, now: number): Entry | null {
  const list = entry.categories.length ? entry.categories : entry.category ? [entry.category] : [];
  if (!list.includes(from)) return null;
  const categories = cleanList(list.map(name => name === from ? to : name), 4);
  return { ...entry, categories, category: categories[0] ?? '', updatedAt: now };
}
/** Entries saved before multi-category support carry only `category`. */
export function hydrate(stored: Partial<Entry> | undefined): Entry {
  const entry = { ...emptyEntry(), ...stored };
  if (!entry.categories.length && entry.category) entry.categories = [entry.category];
  entry.category = entry.categories[0] ?? '';
  return entry;
}
function assign(entry: Entry, field: AutoField, value: unknown) {
  if (field === 'category') { entry.categories = splitCategories(String(value)); entry.category = entry.categories[0] ?? ''; }
  else (entry as Record<AutoField, unknown>)[field] = value;
}
const current = (entry: Entry, field: AutoField) => field === 'category' ? (entry.categories.length ? entry.categories : entry.category ? [entry.category] : []).join(', ') : entry[field];
function normalizePatch(patch: Patch): Patch {
  const out: Patch = {};
  if (patch.summary !== undefined) out.summary = patch.summary.trim().slice(0, 600);
  if (patch.notes !== undefined) out.notes = patch.notes.trim().slice(0, 4000);
  if (patch.category !== undefined) out.category = splitCategories(patch.category).join(', ');
  if (patch.tags !== undefined) out.tags = cleanList(patch.tags, 12);
  if (patch.aliases !== undefined) out.aliases = cleanList(patch.aliases, 12);
  if (patch.links !== undefined) out.links = cleanLinks(patch.links);
  if (patch.status !== undefined) out.status = patch.status;
  if (patch.independent !== undefined) out.independent = patch.independent;
  if (patch.localPaths !== undefined) out.localPaths = [...new Set(patch.localPaths.map(item => item.trim().replace(/^\.?\/+|\/+$/g, '')).filter(Boolean))].slice(0, 20);
  return out;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Automatic description: writes only fields the user has not edited by hand. */
export function applyAuto(entry: Entry, raw: Patch, docHash: string | null, now: number) {
  const patch = normalizePatch(raw);
  const next: Entry = { ...entry, categories: [...(entry.categories ?? [])] };
  const written: AutoField[] = [];
  const skipped: AutoField[] = [];
  for (const field of AUTO_FIELDS) {
    const value = patch[field];
    if (value === undefined) continue;
    if (entry.locked.includes(field)) { skipped.push(field); continue; }
    assign(next, field, value);
    written.push(field);
  }
  next.describedAt = now;
  next.describedDocHash = docHash;
  next.updatedAt = now;
  return { entry: next, written, skipped };
}

/** A manual edit: changed auto-writable fields become locked. */
export function applyManual(entry: Entry, raw: Patch, now: number): Entry {
  const patch = normalizePatch(raw);
  const next: Entry = { ...entry, locked: [...entry.locked] };
  for (const field of AUTO_FIELDS) {
    const value = patch[field];
    if (value === undefined || same(value, current(entry, field))) continue;
    assign(next, field, value);
    if (!next.locked.includes(field)) next.locked.push(field);
  }
  if (patch.notes !== undefined) next.notes = patch.notes;
  if (patch.status !== undefined) next.status = patch.status;
  if (patch.independent !== undefined) next.independent = patch.independent;
  if (patch.localPaths !== undefined) next.localPaths = patch.localPaths;
  next.updatedAt = now;
  return next;
}

export function unlock(entry: Entry, fields: AutoField[], now: number): Entry {
  return { ...entry, locked: entry.locked.filter(field => !fields.includes(field)), updatedAt: now };
}

/**
 * Whether a thread in this project should be asked to (re)describe it:
 * never described, or its README/AGENTS changed and the last description is
 * older than the cool-down. Nothing to do when every auto field is locked.
 */
export function needsDescription(entry: Entry | undefined, docHash: string | null, now: number): 'missing' | 'stale' | null {
  if (!entry || entry.describedAt === null) {
    if (entry && entry.locked.includes('summary') && entry.locked.includes('category')) return null;
    return 'missing';
  }
  if (AUTO_FIELDS.every(field => entry.locked.includes(field))) return null;
  if (!docHash || docHash === entry.describedDocHash) return null;
  return now - entry.describedAt >= REDESCRIBE_AFTER_MS ? 'stale' : null;
}

// ---------- search ----------

const RU: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};
export function normalize(text: string) {
  return text.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
export function translit(text: string) {
  return normalize(text).replace(/[а-я]/g, char => RU[char] ?? char);
}
/** Consonant skeleton, so «манибокс» and "moneybox" compare equal. */
export function skeleton(text: string) {
  return translit(text)
    .replace(/x/g, 'ks').replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/c(?=[eiy])/g, 's').replace(/c/g, 'k')
    .replace(/w/g, 'v').replace(/[aeiouy\s]/g, '').replace(/(.)\1+/g, '$1');
}

export type SearchDoc = { id: string; name: string; aliases: string[]; category: string; tags: string[]; summary: string; notes: string; paths: string[] };

function scoreToken(token: string, doc: SearchDoc) {
  const lat = translit(token);
  const forms = lat === token ? [token] : [token, lat];
  let best = 0;
  const bump = (value: number) => { if (value > best) best = value; };
  const names = [doc.name, ...doc.aliases];
  for (const name of names) {
    for (const hay of [normalize(name), translit(name)]) {
      for (const form of forms) {
        if (!form) continue;
        if (hay === form) bump(100);
        else if (hay.startsWith(form) || hay.split(' ').some(word => word.startsWith(form))) bump(70);
        else if (hay.includes(form)) bump(45);
      }
    }
    const a = skeleton(token);
    const b = skeleton(name);
    if (a.length >= 3 && b.length >= 3) {
      if (a === b) bump(60);
      else if (b.startsWith(a) || a.startsWith(b)) bump(35);
    }
  }
  const mid = [doc.category, ...doc.tags].map(normalize);
  const low = [doc.summary, doc.notes, ...doc.paths].map(normalize);
  for (const form of forms) {
    if (!form) continue;
    if (mid.some(hay => hay.includes(form))) bump(30);
    if (low.some(hay => hay.includes(form))) bump(15);
  }
  return best;
}

/** Every query word must match somewhere; results are ranked by total weight. */
export function search<T extends SearchDoc>(docs: T[], query: string): { doc: T; score: number }[] {
  const tokens = normalize(query).split(' ').filter(Boolean);
  if (!tokens.length) return docs.map(doc => ({ doc, score: 0 }));
  const whole = normalize(query);
  const out: { doc: T; score: number }[] = [];
  for (const doc of docs) {
    let total = 0;
    let ok = true;
    for (const token of tokens) {
      const score = scoreToken(token, doc);
      if (!score) { ok = false; break; }
      total += score;
    }
    if (!ok && tokens.length > 1) {
      const score = scoreToken(whole, doc);
      if (score) { ok = true; total = score; }
    }
    if (ok) out.push({ doc, score: total / tokens.length });
  }
  return out.sort((a, b) => b.score - a.score || a.doc.name.localeCompare(b.doc.name));
}

// ---------- sync ----------

export type GitState = { branch: string | null; head: string | null; headTime: number | null; dirty: number; untracked: number; ahead: number; behind: number; hasUpstream: boolean; remote: string | null; stash: number };
export type PlainState = { files: number; bytes: number; latestMtime: number | null; digest: string | null; truncated: boolean };
export type Scan = {
  scannedAt: number;
  kind: 'git' | 'plain' | 'missing' | 'error';
  error?: string;
  git?: GitState;
  plain?: PlainState;
  /** Git repositories nested inside a folder that is not a repository itself. */
  parts?: { path: string; git: GitState }[];
  docHash: string | null;
};
export type Manifest = Record<string, [hash: string, mtime: number]>;
export type CopyDiff = { changed: number; onlyA: number; onlyB: number; sample: { path: string; kind: 'changed' | 'onlyA' | 'onlyB'; newer: 'a' | 'b' | null }[] };
export type SourceView = { id: string; hostId: string; hostName: string; path: string; connected: boolean; scan: Scan | null };
export type Level = 'ok' | 'info' | 'attention' | 'risk' | 'unknown';
export type Verdict = { level: Level; label: string; details: string[] };

export const isLocal = (path: string, localPaths: string[]) => localPaths.some(local => path === local || path.startsWith(`${local}/`));

export function diffManifests(fullA: Manifest, fullB: Manifest, sampleSize = 40, localPaths: string[] = []): CopyDiff {
  const keep = (manifest: Manifest) => localPaths.length ? Object.fromEntries(Object.entries(manifest).filter(([path]) => !isLocal(path, localPaths))) as Manifest : manifest;
  const a = keep(fullA);
  const b = keep(fullB);
  const out: CopyDiff = { changed: 0, onlyA: 0, onlyB: 0, sample: [] };
  const add = (item: CopyDiff['sample'][number]) => { if (out.sample.length < sampleSize) out.sample.push(item); };
  for (const path of Object.keys(a).sort()) {
    const left = a[path]!;
    const right = b[path];
    if (!right) { out.onlyA++; add({ path, kind: 'onlyA', newer: null }); }
    else if (left[0] !== right[0]) { out.changed++; add({ path, kind: 'changed', newer: left[1] === right[1] ? null : left[1] > right[1] ? 'a' : 'b' }); }
  }
  for (const path of Object.keys(b).sort()) {
    if (!a[path]) { out.onlyB++; add({ path, kind: 'onlyB', newer: null }); }
  }
  return out;
}

const LEVELS: Level[] = ['ok', 'info', 'unknown', 'attention', 'risk'];
const plural = (n: number, one: string, few: string, many: string) => {
  const d = n % 10;
  const h = n % 100;
  return `${n} ${d === 1 && h !== 11 ? one : d >= 2 && d <= 4 && (h < 12 || h > 14) ? few : many}`;
};

/**
 * One line of truth per project. `risk` is reserved for the case where work
 * can actually be lost: copies on several machines that have gone apart.
 * A folder without git on a single machine is a normal state, not a warning.
 */
export function verdict(sources: SourceView[], diff: CopyDiff | null = null, options: { independent?: boolean; localPaths?: string[] } = {}): Verdict {
  const independent = options.independent ?? false;
  const localPaths = options.localPaths ?? [];
  const partsOf = (source: SourceView) => (source.scan?.parts ?? []).filter(part => !isLocal(part.path, localPaths));
  let level = 'ok' as Level;
  const details: string[] = [];
  const raise = (next: Level, text: string) => {
    if (LEVELS.indexOf(next) > LEVELS.indexOf(level)) level = next;
    details.push(text);
  };
  if (!sources.length) return { level: 'unknown', label: 'Нет папки', details: ['У проекта нет ни одной папки на машинах'] };
  const scanned = sources.filter(source => source.scan);
  for (const source of sources) {
    const scan = source.scan;
    if (!scan) { raise('unknown', `${source.hostName}: ещё не проверено${source.connected ? '' : ' (машина офлайн)'}`); continue; }
    if (scan.kind === 'error') { raise('unknown', `${source.hostName}: не удалось проверить — ${scan.error ?? 'ошибка'}`); continue; }
    if (scan.kind === 'missing') { raise('attention', `${source.hostName}: папка не найдена`); continue; }
    const git = scan.git;
    if (scan.kind === 'git' && git) {
      const local = git.dirty + git.untracked;
      if (local) raise('attention', `${source.hostName}: ${plural(local, 'незакоммиченный файл', 'незакоммиченных файла', 'незакоммиченных файлов')}`);
      if (git.ahead) raise('attention', `${source.hostName}: ${plural(git.ahead, 'коммит не отправлен', 'коммита не отправлено', 'коммитов не отправлено')}`);
      if (git.behind) raise('info', `${source.hostName}: отстаёт на ${plural(git.behind, 'коммит', 'коммита', 'коммитов')}`);
      if (git.stash) raise('info', `${source.hostName}: ${plural(git.stash, 'запись', 'записи', 'записей')} в stash`);
      if (!git.hasUpstream && git.head) raise(sources.length > 1 && !independent ? 'attention' : 'info', `${source.hostName}: ветка без удалённой копии`);
    }
    // Unsaved work matters even in a folder that is local to this machine.
    for (const part of source.scan?.parts ?? []) {
      const local = part.git.dirty + part.git.untracked;
      if (local) raise('attention', `${source.hostName}: ${part.path} — ${plural(local, 'незакоммиченный файл', 'незакоммиченных файла', 'незакоммиченных файлов')}`);
      if (part.git.ahead) raise('attention', `${source.hostName}: ${part.path} — ${plural(part.git.ahead, 'коммит не отправлен', 'коммита не отправлено', 'коммитов не отправлено')}`);
      if (part.git.behind) raise('info', `${source.hostName}: ${part.path} отстаёт на ${plural(part.git.behind, 'коммит', 'коммита', 'коммитов')}`);
    }
  }
  const live = scanned.filter(source => source.scan!.kind === 'git' || source.scan!.kind === 'plain');
  if (independent && live.length > 1) details.push('Копии независимы и не сравниваются');
  if (live.length > 1 && !independent) {
    const gits = live.filter(source => source.scan!.kind === 'git');
    const plains = live.filter(source => source.scan!.kind === 'plain');
    if (gits.length && plains.length) raise('attention', `Разный тип копий: git на ${gits.map(s => s.hostName).join(', ')}, без git на ${plains.map(s => s.hostName).join(', ')}`);
    if (gits.length > 1) {
      const heads = new Set(gits.map(source => source.scan!.git!.head));
      if (heads.size > 1) {
        const newest = [...gits].sort((a, b) => (b.scan!.git!.headTime ?? 0) - (a.scan!.git!.headTime ?? 0))[0]!;
        const unsafe = gits.some(source => { const g = source.scan!.git!; return g.dirty + g.untracked + g.ahead > 0 || !g.hasUpstream; });
        raise(unsafe ? 'risk' : 'attention', `Разные коммиты на машинах; новее на ${newest.hostName}`);
      }
    }
    if (plains.length > 1) {
      const digests = new Set(plains.map(source => source.scan!.plain!.digest));
      const differs = diff ? diff.changed + diff.onlyA + diff.onlyB > 0 : digests.size > 1;
      if (!diff && digests.has(null)) raise('unknown', 'Копии без git ещё не сравнивались');
      else if (differs) {
        const newest = [...plains].sort((a, b) => (b.scan!.plain!.latestMtime ?? 0) - (a.scan!.plain!.latestMtime ?? 0))[0]!;
        const count = diff ? diff.changed + diff.onlyA + diff.onlyB : 0;
        raise('risk', `Копии без git расходятся${count ? `: ${plural(count, 'файл', 'файла', 'файлов')}` : ''}; последние правки на ${newest.hostName}${plains.some(source => source.scan!.plain!.truncated) ? ' (сравнение неполное: в папке больше 4000 файлов)' : ''}`);
      } else details.push(localPaths.length ? 'Копии без git совпадают (кроме папок, помеченных как свои на каждой машине)' : 'Копии без git совпадают');
      const names = [...new Set(plains.flatMap(source => partsOf(source).map(part => part.path)))];
      for (const name of names) {
        const having = plains.filter(source => partsOf(source).some(part => part.path === name));
        if (having.length < plains.length) { raise('info', `${name}: есть только на ${having.map(s => s.hostName).join(', ')}`); continue; }
        const states = having.map(source => ({ source, git: partsOf(source).find(part => part.path === name)!.git }));
        if (new Set(states.map(item => item.git.head)).size > 1) {
          const newest = [...states].sort((x, y) => (y.git.headTime ?? 0) - (x.git.headTime ?? 0))[0]!;
          const unsafe = states.some(({ git }) => git.dirty + git.untracked + git.ahead > 0 || !git.hasUpstream);
          raise(unsafe ? 'risk' : 'attention', `${name}: разные коммиты на машинах; новее на ${newest.source.hostName}`);
        }
      }
    }
  }
  const stale = scanned.filter(source => !source.connected);
  if (stale.length && level !== 'unknown') details.push(`Данные с ${stale.map(s => s.hostName).join(', ')} — последние известные (машина офлайн)`);
  const kinds = live.map(source => source.scan!.kind);
  const label =
    level === 'risk' ? 'Расходится'
    : level === 'attention' ? 'Нужно внимание'
    : level === 'unknown' ? 'Не проверено'
    : live.length > 1 && !independent ? 'Синхронизировано'
    : kinds[0] === 'plain' ? 'Без git'
    : 'В порядке';
  return { level, label, details };
}

// ---------- Safe pull on the thread's machine, and its history ----------

export type SyncReason = 'dirty' | 'diverged' | 'ahead' | 'no-upstream' | 'no-remote' | 'detached' | 'fetch-failed' | 'merge-failed' | 'error';
export type RepoSync = {
  /** Path relative to the project folder; '' is the folder itself. */
  path: string; branch: string | null; before: string | null; after: string | null;
  fetched: boolean; fetchError: string | null;
  action: 'pulled' | 'up-to-date' | 'skipped'; reason: SyncReason | null;
  ahead: number; behind: number; dirty: number; commits: string[]; stat: string | null;
};
export type PullResult = { kind: 'git' | 'plain' | 'missing' | 'hands-off' | 'error'; repos: RepoSync[]; error: string | null };
export type SyncEvent = {
  at: number; hostId: string; hostName: string; path: string; threadId: string | null;
  apply: boolean; kind: PullResult['kind'];
  repos: { path: string; branch: string | null; action: RepoSync['action']; reason: SyncReason | null; commits: number; behind: number; ahead: number; dirty: number }[];
};
export const HISTORY_LIMIT = 40;

const REASON_TEXT: Record<SyncReason, string> = {
  dirty: 'есть незакоммиченные правки — свежее не подтянуто, чтобы ничего не потерять',
  diverged: 'ветки разошлись: здесь есть свои коммиты и на сервере новые — нужно решить вручную',
  ahead: 'здесь есть коммиты, которых нет на сервере (не отправлены)',
  'no-upstream': 'у ветки нет пары на сервере (например, ветка задачи) — подтягивать нечего',
  'no-remote': 'у репозитория нет сервера (remote) — синхронизировать не с чем',
  detached: 'не на ветке (detached HEAD) — не трогаю',
  'fetch-failed': 'не удалось связаться с сервером (сеть или авторизация)',
  'merge-failed': 'git отказался подтягивать (вероятно, мешают неотслеживаемые файлы)',
  error: 'не удалось прочитать состояние git',
};

export function describeRepo(repo: RepoSync): string {
  const name = repo.path ? `${repo.path}/` : 'папка';
  const where = `${name}${repo.branch ? ` (${repo.branch})` : ''}`;
  const lines: string[] = [];
  if (repo.action === 'pulled') {
    lines.push(`${where}: подтянуто ${repo.commits.length}${repo.commits.length === 15 ? '+' : ''} коммит(ов)${repo.stat ? `, ${repo.stat}` : ''}`);
  } else if (repo.action === 'up-to-date') {
    lines.push(`${where}: актуально${repo.reason ? `; ${REASON_TEXT[repo.reason]}${repo.ahead ? ` (${repo.ahead})` : ''}` : ''}`);
  } else {
    const waiting = repo.behind > 0 ? `на сервере ${repo.behind} новых коммит(ов); ` : '';
    lines.push(`${where}: ${waiting}${repo.reason ? REASON_TEXT[repo.reason] : 'только проверка, ничего не менял'}${repo.dirty ? ` (изменённых файлов: ${repo.dirty})` : ''}`);
  }
  if (repo.fetchError && (repo.reason === 'fetch-failed' || repo.reason === 'merge-failed')) lines.push(`  git: ${repo.fetchError}`);
  for (const commit of repo.commits.slice(0, 10)) lines.push(`  ${commit}`);
  return lines.join('\n');
}

export function describePull(result: PullResult, place: string): string {
  if (result.kind === 'missing') return `${place}: папка не найдена.`;
  if (result.kind === 'hands-off') return `${place}: папка помечена .bb/hands-off — автоматика её не трогает.`;
  if (result.kind === 'error') return `${place}: ошибка — ${result.error ?? 'неизвестно'}.`;
  if (result.repos.length === 0) return `${place}: папка без git. Синхронизировать нечем; если она нужна на нескольких машинах — держите её на одной (Tru) или сделайте git-репозиторий.`;
  const head = result.kind === 'plain' ? `${place}: сама папка без git, внутри репозитории:` : `${place}:`;
  return [head, ...result.repos.map(describeRepo)].join('\n');
}

export function syncEvent(result: PullResult, base: Omit<SyncEvent, 'kind' | 'repos'>): SyncEvent {
  return { ...base, kind: result.kind, repos: result.repos.map(repo => ({
    path: repo.path, branch: repo.branch, action: repo.action, reason: repo.reason,
    commits: repo.action === 'pulled' ? repo.commits.length : 0, behind: repo.behind, ahead: repo.ahead, dirty: repo.dirty,
  })) };
}

export function pushHistory(history: SyncEvent[], event: SyncEvent, limit = HISTORY_LIMIT): SyncEvent[] {
  return [event, ...history].slice(0, limit);
}

export function eventSummary(event: SyncEvent): string {
  if (event.kind === 'missing') return 'папка не найдена';
  if (event.kind === 'hands-off') return 'не трогать (.bb/hands-off)';
  if (event.kind === 'error') return 'ошибка проверки';
  if (event.repos.length === 0) return 'без git';
  return event.repos.map(repo => {
    const name = repo.path ? `${repo.path}: ` : '';
    if (repo.action === 'pulled') return `${name}подтянуто ${repo.commits}`;
    if (repo.action === 'up-to-date') return `${name}актуально${repo.reason === 'ahead' ? `, не отправлено ${repo.ahead}` : ''}`;
    return `${name}${repo.reason ? ({ dirty: 'есть правки', diverged: 'расхождение', ahead: 'не отправлено', 'no-upstream': 'ветка задачи', 'no-remote': 'нет сервера', detached: 'detached', 'fetch-failed': 'нет связи', 'merge-failed': 'git отказал', error: 'ошибка' } as const)[repo.reason] : 'проверено'}${repo.behind ? `, отстаёт на ${repo.behind}` : ''}`;
  }).join('; ');
}

/** Other machines' copies, from the last scan, as one line each for an agent. */
export function otherCopies(sources: SourceView[], currentHostId: string, now: number): string[] {
  return sources.filter(source => source.hostId !== currentHostId).map(source => {
    const scan = source.scan;
    const age = scan ? ` (проверено ${Math.max(1, Math.round((now - scan.scannedAt) / 60_000))} мин назад)` : '';
    if (!scan) return `${source.hostName}: ещё не проверялась`;
    if (scan.kind === 'git' && scan.git) {
      const g = scan.git;
      const bits = [g.branch ?? 'detached', g.head?.slice(0, 8) ?? 'без коммитов'];
      if (g.dirty + g.untracked) bits.push(`не закоммичено: ${g.dirty + g.untracked}`);
      if (g.ahead) bits.push(`не отправлено: ${g.ahead}`);
      if (g.behind) bits.push(`отстаёт: ${g.behind}`);
      return `${source.hostName}${source.connected ? '' : ' (не на связи)'}: ${bits.join(', ')}${age}`;
    }
    if (scan.kind === 'plain') {
      const parts = (scan.parts ?? []).map(part => `${part.path}/ ${part.git.branch ?? 'detached'}${part.git.dirty + part.git.untracked ? `, не закоммичено: ${part.git.dirty + part.git.untracked}` : ''}${part.git.ahead ? `, не отправлено: ${part.git.ahead}` : ''}${part.git.behind ? `, отстаёт: ${part.git.behind}` : ''}`);
      return `${source.hostName}${source.connected ? '' : ' (не на связи)'}: без git${parts.length ? `; внутри: ${parts.join('; ')}` : ''}${age}`;
    }
    return `${source.hostName}: ${scan.kind === 'missing' ? 'папка не найдена' : 'ошибка проверки'}${age}`;
  });
}

// ---------- Worktrees: extra copies BB made for threads ----------

export type WorktreeState = 'active' | 'idle' | 'orphan' | 'retiring' | 'missing';
export type WorktreeView = {
  environmentId: string; projectId: string; hostId: string; hostName: string; path: string; branch: string | null;
  liveThreads: number; archivedThreads: number; lastActivity: number | null; retireAt: number | null;
  bytes: number | null; exists: boolean | null; state: WorktreeState;
};
export const IDLE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** Orphan: no live thread keeps it, yet BB is not removing it. Idle: live threads, but nothing for a week. */
export function worktreeState(w: { liveThreads: number; lastActivity: number | null; retireAt: number | null; exists?: boolean | null }, now: number): WorktreeState {
  if (w.exists === false) return 'missing';
  if (w.retireAt !== null) return 'retiring';
  if (w.liveThreads === 0) return 'orphan';
  if (w.lastActivity !== null && now - w.lastActivity > IDLE_AFTER_MS) return 'idle';
  return 'active';
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return 'размер неизвестен';
  if (bytes === 0) return '0 КБ';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
  if (bytes < 1024 ** 3) return `${Math.round(bytes / 1024 ** 2)} МБ`;
  return `${(bytes / 1024 ** 3).toFixed(1)} ГБ`;
}

export const WORKTREE_STATE_TEXT: Record<WorktreeState, string> = {
  active: 'в работе',
  idle: 'не трогали больше недели — если тред не нужен, архивируйте его, и BB удалит копию',
  orphan: 'живых тредов нет, но копия не удаляется — проверьте и удалите через bb environment cleanup',
  retiring: 'BB скоро удалит',
  missing: 'папки уже нет, а запись в BB осталась — её можно убрать: bb environment cleanup <id>',
};

export function worktreeLine(w: WorktreeView, now: number): string {
  const ago = w.lastActivity === null ? 'активности нет' : `активность ${Math.max(0, Math.round((now - w.lastActivity) / 86_400_000))} дн назад`;
  return `${w.hostName}: ${w.branch ?? 'без ветки'} — ${w.state === 'missing' ? 'папки нет' : formatBytes(w.bytes)}, тредов ${w.liveThreads}${w.archivedThreads ? ` (+${w.archivedThreads} в архиве)` : ''}, ${ago}; ${WORKTREE_STATE_TEXT[w.state]}\n  ${w.path}  (${w.environmentId})`;
}

/** Another active thread in the same folder: pulling under it could change files it is reading. */
export function neighbourNote(neighbours: { id: string; title: string }[]): string | null {
  if (!neighbours.length) return null;
  return `в этой папке сейчас работает ${neighbours.length === 1 ? 'тред' : 'треды'} ${neighbours.slice(0, 3).map(n => `«${n.title}» (${n.id})`).join(', ')} — свежее не подтягиваю, только проверяю`;
}
