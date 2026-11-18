import { readFile, stat } from "node:fs/promises";
import { historySnapshot, type HistoryPeriod } from "./contract.ts";

const maxArchiveBytes = 4 * 1024 * 1024;

export async function readHistory(days: HistoryPeriod, path: string) {
  let text: string;
  try {
    if ((await stat(path)).size > maxArchiveBytes) throw new Error("Thread Spend snapshot is too large");
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new Error("Invalid Thread Spend snapshot"); }
  const inspected = historySnapshot.safeParse(data);
  if (!inspected.success) throw new Error("Invalid Thread Spend snapshot");
  return { capturedAt: inspected.data.capturedAt, rows: inspected.data.windows[days] };
}
