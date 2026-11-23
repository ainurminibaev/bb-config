// What to do with a limit note that reaches dispatch after the turn it was meant
// for has ended. It must never start a turn of its own, and it must not stay in
// the queue as a failed row: bb would draw the thread's error glyph although
// nothing went wrong. The plugin parks the row (`wait`) and deletes it right away;
// only if that row comes back (the delete failed) is it refused, with words that
// do not suggest the thread stopped working.

export const STALE_NOTE_TEXT = 'ход уже закончился — напоминание о лимите не понадобилось';

export type StaleNoteDecision =
  | { action: 'drop'; ids: string[]; reason: string; sendAt: number }
  | { action: 'reject'; message: string };

export function staleNoteDecision(rowIds: readonly string[], alreadyDropping: ReadonlySet<string>, now: number): StaleNoteDecision {
  const ids = rowIds.filter((id) => typeof id === 'string' && id.length > 0);
  if (ids.length > 0 && !ids.some((id) => alreadyDropping.has(id))) {
    return { action: 'drop', ids, reason: STALE_NOTE_TEXT, sendAt: now + 60_000 };
  }
  return { action: 'reject', message: `limit-guard: ${STALE_NOTE_TEXT}` };
}
