import type { ThreadSummary } from '@boite/contracts';

/*
 * Pin and archive change the row the moment they are asked, and the core's
 * answer confirms it: on a phone the round trip is a few hundred milliseconds
 * of a tap that seemed to do nothing. A refusal puts back what is still this
 * change's, and the store says why.
 */

/** Rows an archive hides while the core has not answered: an older `thread.updated` must not show them again. */
const archiving = new WeakSet<object>();

/** Per row: the flag the core last confirmed, the newest pin asked and the pins still to answer, in order. */
const pins = new WeakMap<object, { confirmed: boolean | undefined; newest: number; out: number; queue: Promise<unknown> }>();

/**
 * Shows `pinned` on each target at once and sends the pins of one row one
 * after the other, so the core takes them in the order they were tapped and
 * each answer lands after the one before. A refusal of the newest pin puts back
 * the flag the core last confirmed; an older refusal leaves the newer tap shown.
 * The rejection goes on to the caller, whichever connection it was.
 */
export async function pinWhile<T>(targets: ({ pinned?: boolean } | null | undefined)[], pinned: boolean, send: () => Promise<T>): Promise<T> {
  const shown = targets.filter((t) => t != null);
  const key = shown[0];
  if (!key) return send();
  const state = pins.get(key) ?? { confirmed: key.pinned, newest: 0, out: 0, queue: Promise.resolve() };
  pins.set(key, state);
  const token = ++state.newest;
  for (const target of shown) target.pinned = pinned;
  // Nothing out for this row: it leaves now, not a microtask later.
  const turn = state.out === 0 ? send() : state.queue.then(send, send);
  state.out++;
  state.queue = turn.catch(() => undefined);
  try {
    const answer = await turn;
    state.confirmed = pinned;
    return answer;
  } catch (error) {
    if (token === state.newest) for (const target of shown) target.pinned = state.confirmed;
    throw error;
  } finally {
    state.out--;
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
    // An event that reported the archive in the meantime has the last word.
    const kept = rows().find((t) => t.id === threadId);
    if (hidden && row && archiving.has(row) && kept?.archived) kept.archived = false;
    throw error;
  } finally {
    if (row) archiving.delete(row);
  }
}

/** What an incoming summary may write on a row an archive is hiding. */
export function keepArchived<T extends { archived?: boolean }>(row: object, summary: T): T {
  if (summary.archived) archiving.delete(row);
  return archiving.has(row) && !summary.archived ? { ...summary, archived: true } : summary;
}
