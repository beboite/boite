import type { ThreadSummary } from '@boite/contracts';

/*
 * Pin and archive change the row the moment they are asked, and the core's
 * answer confirms it: on a phone the round trip is a few hundred milliseconds
 * of a tap that seemed to do nothing. A refusal puts back what is still this
 * change's, and the store says why.
 */

/** Rows an archive hides while the core has not answered: an older `thread.updated` must not show them again. */
const archiving = new WeakSet<object>();

/** Per row or open thread: the last flag the core confirmed and the newest pin still out. */
const pins = new WeakMap<object, { confirmed: boolean | undefined; newest: number; out: number }>();

/**
 * Sets `pinned` on each target while `call` is out. Only the newest pin of a
 * target puts anything back on a refusal, and what it puts back is the last
 * flag the core confirmed, so two opposite taps both refused end where they
 * started. The rejection goes on to the caller, whichever connection it was.
 */
export async function pinWhile<T>(targets: ({ pinned?: boolean } | null | undefined)[], pinned: boolean, call: Promise<T>): Promise<T> {
  const mine = targets.filter((t) => t != null).map((target) => {
    const state = pins.get(target) ?? { confirmed: target.pinned, newest: 0, out: 0 };
    if (state.out === 0) state.confirmed = target.pinned;
    state.out++;
    pins.set(target, state);
    target.pinned = pinned;
    return { target, state, token: ++state.newest };
  });
  try {
    const answer = await call;
    for (const { state } of mine) state.confirmed = pinned;
    return answer;
  } catch (error) {
    for (const { target, state, token } of mine) if (token === state.newest) target.pinned = state.confirmed;
    throw error;
  } finally {
    for (const { state } of mine) state.out--;
  }
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
