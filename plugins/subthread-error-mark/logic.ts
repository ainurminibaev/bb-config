/** The fields of a sidebar thread this plugin reads; anything else is ignored. */
export type RowThread = {
  parentThreadId?: string | null;
  status?: string | null;
  isArchived?: boolean | null;
};

/**
 * bb's thread list draws its red error glyph only on unread top-level threads,
 * while the parent counts every child in `error` (`↳ ⊗ N`). Mark exactly those
 * children so the count can be traced to rows.
 */
export function showsErrorMark(thread: RowThread | null | undefined): boolean {
  if (!thread || typeof thread !== 'object') return false;
  const parent = thread.parentThreadId;
  return typeof parent === 'string' && parent.length > 0
    && thread.status === 'error'
    && thread.isArchived !== true;
}
