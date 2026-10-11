import type { ThreadSummary } from '@boite/contracts';

/*
 * Pin and archive change the row the moment they are asked, and the core's
 * answer confirms it: on a phone the round trip is a few hundred milliseconds
 * of a tap that seemed to do nothing. A refusal puts back what is still this
 * change's, and the store says why.
 */

/** Rows an archive hides while the core has not answered: an older `thread.updated` must not show them again. */
const archiving = new WeakSet<object>();

/** Sets `pinned` on each target now; the undo restores only a target nothing newer has set since. */
export function pinNow(targets: ({ pinned?: boolean } | null | undefined)[], pinned: boolean): () => void {
  const before = targets.filter((t) => t != null).map((target) => ({ target, was: target.pinned }));
  for (const { target } of before) target.pinned = pinned;
  return () => { for (const { target, was } of before) if (target.pinned === pinned) target.pinned = was; };
}

/**
 * Flags the row archived while `call` is out, as a thread archived from another
 * client is, so every list drops it at once. A refusal shows it again in its
 * place, unless an event already did, and the rejection goes on to the caller.
 */
export async function archiveWhile<T>(rows: () => ThreadSummary[], threadId: string, call: Promise<T>): Promise<T> {
  const row = rows().find((t) => t.id === threadId);
  const hidden = row !== undefined && !row.archived;
  if (hidden) { row.archived = true; archiving.add(row); }
  try {
    return await call;
  } catch (error) {
    const kept = rows().find((t) => t.id === threadId);
    if (hidden && kept?.archived) kept.archived = false;
    throw error;
  } finally {
    if (row) archiving.delete(row);
  }
}

/** What an incoming summary may write on a row an archive is hiding. */
export function keepArchived<T extends { archived?: boolean }>(row: object, summary: T): T {
  return archiving.has(row) && !summary.archived ? { ...summary, archived: true } : summary;
}
