// Tokens the Antigravity CLI spent, read from its own conversation stores.
// Each conversation is an SQLite file conversations/<id>.db; table gen_metadata
// holds one protobuf per model call. Field 1 is the generation, inside it
// 19 = model id and 4 = usage (Codeium ModelUsageStats): 2 input (uncached),
// 3 output (thinking + answer), 4 cache write, 5 cache read. Read-only: the
// files are opened with readOnly and never written; unchanged files are cached.
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export type TokenTotals = { input: number; cacheRead: number; cacheWrite: number; output: number; generations: number };
export type GroupTotals = Record<'gemini' | 'claude-gpt', TokenTotals>;
const empty = (): TokenTotals => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, generations: 0 });

type Field = { field: number; value: number | Uint8Array };
function varint(bytes: Uint8Array, at: number): [number, number] {
  let result = 0, shift = 0, i = at;
  for (;;) {
    if (i >= bytes.length) throw new RangeError('truncated');
    const b = bytes[i++]!;
    result += (b & 0x7f) * 2 ** shift;
    if (b < 0x80) return [result, i];
    shift += 7;
    if (shift > 63) throw new RangeError('varint');
  }
}
/** Top-level fields of one protobuf message; null when it is not one. */
export function fields(bytes: Uint8Array): Field[] | null {
  const out: Field[] = [];
  let i = 0;
  try {
    while (i < bytes.length) {
      const [key, next] = varint(bytes, i); i = next;
      const field = Math.floor(key / 8), type = key % 8;
      if (field === 0) return null;
      if (type === 0) { const [v, n] = varint(bytes, i); i = n; out.push({ field, value: v }); }
      else if (type === 1) i += 8;
      else if (type === 5) i += 4;
      else if (type === 2) {
        const [len, n] = varint(bytes, i); i = n;
        if (i + len > bytes.length) return null;
        out.push({ field, value: bytes.subarray(i, i + len) }); i += len;
      } else return null;
    }
  } catch { return null; }
  return out;
}
const sub = (f: Field[] | null, n: number) => { const v = f?.find(x => x.field === n)?.value; return v instanceof Uint8Array ? v : null; };
const num = (f: Field[] | null, n: number) => (f ?? []).filter(x => x.field === n && typeof x.value === 'number').reduce((a, x) => a + (x.value as number), 0);

/** One gen_metadata row → its model and usage, or null. Exported for tests. */
export function generation(row: Uint8Array): { model: string; input: number; cacheRead: number; cacheWrite: number; output: number } | null {
  const genBytes = sub(fields(row), 1);
  const gen = genBytes ? fields(genBytes) : null;
  const usageBytes = sub(gen, 4);
  const usage = usageBytes ? fields(usageBytes) : null;
  if (!gen || !usage) return null;
  const model = new TextDecoder().decode(sub(gen, 19) ?? new Uint8Array());
  return { model, input: num(usage, 2), output: num(usage, 3), cacheWrite: num(usage, 4), cacheRead: num(usage, 5) };
}
export const groupOf = (model: string): keyof GroupTotals => /claude|gpt/i.test(model) ? 'claude-gpt' : 'gemini';

type Sqlite = { DatabaseSync: new (path: string, options: { readOnly: boolean }) => {
  prepare(sql: string): { all(): { data: Uint8Array }[] }; close(): void } };
let sqlite: Promise<Sqlite | null> | null = null;

export function createAgyTokenReader(dir: string) {
  const files = new Map<string, { size: number; mtime: number; totals: GroupTotals }>();
  return async (): Promise<GroupTotals | null> => {
    sqlite ??= import('node:sqlite').then(m => m as unknown as Sqlite).catch(() => null);
    const lib = await sqlite;
    if (!lib) return null;
    const folder = join(dir, 'conversations');
    const names = await readdir(folder).catch(() => null);
    if (!names) return null;
    const seen = new Set<string>();
    for (const name of names.filter(n => n.endsWith('.db'))) {
      const path = join(folder, name);
      const info = await stat(path).catch(() => null);
      if (!info) continue;
      seen.add(path);
      const known = files.get(path);
      if (known && known.size === info.size && known.mtime === info.mtimeMs) continue;
      const totals: GroupTotals = { gemini: empty(), 'claude-gpt': empty() };
      try {
        const db = new lib.DatabaseSync(path, { readOnly: true });
        try {
          for (const { data } of db.prepare('SELECT data FROM gen_metadata').all()) {
            const g = generation(data);
            if (!g) continue;
            const t = totals[groupOf(g.model)];
            t.input += g.input; t.cacheRead += g.cacheRead; t.cacheWrite += g.cacheWrite; t.output += g.output; t.generations++;
          }
        } finally { db.close(); }
      } catch { /* busy or another schema: keep the previous figure for this file */ if (known) { seen.add(path); continue; } }
      files.set(path, { size: info.size, mtime: info.mtimeMs, totals });
    }
    for (const path of [...files.keys()]) if (!seen.has(path)) files.delete(path);
    const sum: GroupTotals = { gemini: empty(), 'claude-gpt': empty() };
    for (const f of files.values()) for (const g of ['gemini', 'claude-gpt'] as const)
      for (const k of Object.keys(sum[g]) as (keyof TokenTotals)[]) sum[g][k] += f.totals[g][k];
    return sum;
  };
}
