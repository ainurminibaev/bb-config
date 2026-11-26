// Codex volume measured from its own session logs on this machine.
// Every `token_count` event carries the tokens of one request and the weekly
// window's used percent at that moment. Tokens spent while the percent rose
// by N points give tokens per point. Files are cached by size and mtime, so
// a rescan only reads what changed; at most once per half hour.
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

export type CodexWindowVolume = {
  plan: string | null; resetsAt: string; samples: number; percentSpan: number;
  input: number; cached: number; output: number;
};
type Part = { plan: string | null; reset: number; n: number; input: number; cached: number; output: number; min: number; max: number };

const scanInterval = 30 * 60_000;
const maxAgeMs = 9 * 24 * 3_600_000;

/** One token_count line → its window share, or null. Exported for tests. */
export function tokenCountEvent(line: string): Part | null {
  if (!line.includes('"token_count"')) return null;
  try {
    const payload = JSON.parse(line).payload ?? {};
    const limits = payload.rate_limits ?? {};
    const primary = limits.primary ?? {};
    const usage = payload.info?.last_token_usage;
    if (!usage || primary.window_minutes !== 10080 || typeof primary.used_percent !== 'number' || typeof primary.resets_at !== 'number') return null;
    const cached = Number(usage.cached_input_tokens) || 0;
    return { plan: typeof limits.plan_type === 'string' ? limits.plan_type : null,
      // resets_at jitters by a second between requests of one window.
      reset: Math.round(primary.resets_at / 60) * 60, n: 1,
      input: Math.max(0, (Number(usage.input_tokens) || 0) - cached), cached, output: Number(usage.output_tokens) || 0,
      min: primary.used_percent, max: primary.used_percent };
  } catch { return null; }
}

function merge(into: Map<string, Part>, part: Part) {
  const key = `${part.plan}:${part.reset}`;
  const known = into.get(key);
  if (!known) { into.set(key, { ...part }); return; }
  known.n += part.n; known.input += part.input; known.cached += part.cached; known.output += part.output;
  known.min = Math.min(known.min, part.min); known.max = Math.max(known.max, part.max);
}

async function filesUnder(root: string, now: number): Promise<{ path: string; size: number; mtime: number }[]> {
  const found: { path: string; size: number; mtime: number }[] = [];
  async function walk(dir: string, depth: number) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && depth < 3) await walk(path, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const info = await stat(path).catch(() => null);
        if (info && now - info.mtimeMs < maxAgeMs) found.push({ path, size: info.size, mtime: info.mtimeMs });
      }
    }
  }
  await walk(root, 0);
  return found;
}

async function scanFile(path: string): Promise<Map<string, Part>> {
  const parts = new Map<string, Part>();
  const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    const part = tokenCountEvent(line);
    if (part) merge(parts, part);
  }
  return parts;
}

export function createCodexVolumeReader(root = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions'), now = Date.now) {
  const files = new Map<string, { size: number; mtime: number; parts: Map<string, Part> }>();
  let cached: { at: number; value: CodexWindowVolume[] } | null = null;
  let pending: Promise<CodexWindowVolume[]> | null = null;
  async function scan(): Promise<CodexWindowVolume[]> {
    const current = await filesUnder(root, now());
    const seen = new Set<string>();
    for (const file of current) {
      seen.add(file.path);
      const known = files.get(file.path);
      if (known && known.size === file.size && known.mtime === file.mtime) continue;
      files.set(file.path, { size: file.size, mtime: file.mtime, parts: await scanFile(file.path).catch(() => new Map()) });
    }
    for (const path of [...files.keys()]) if (!seen.has(path)) files.delete(path);
    const total = new Map<string, Part>();
    for (const file of files.values()) for (const part of file.parts.values()) merge(total, part);
    return [...total.values()].sort((a, b) => b.reset - a.reset).map(p => ({
      plan: p.plan, resetsAt: new Date(p.reset * 1000).toISOString(), samples: p.n,
      percentSpan: Math.max(0, p.max - p.min), input: p.input, cached: p.cached, output: p.output,
    }));
  }
  return (): Promise<CodexWindowVolume[]> => {
    if (cached && now() - cached.at < scanInterval) return Promise.resolve(cached.value);
    pending ??= scan().then(value => { cached = { at: now(), value }; return value; }).finally(() => { pending = null; });
    return pending;
  };
}
