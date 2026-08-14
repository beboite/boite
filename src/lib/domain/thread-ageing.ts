/**
 * Where the sidebar keeps a thread, and the one rule that keeps filing safe.
 *
 * `lib/domain`: no runes, no Svelte imports, no store behind it, so the context
 * menu, the auto-settle sweep and the sidebar's own filter all answer the same
 * question the same way. The twin of `boite_core::ageing`, which enforces the
 * same refusal at the bus. Two copies on purpose and for the same reason
 * `browser.ts` has three: the desktop's live status is derived in the window,
 * so the menu that draws the action has to decide before the bus can.
 */

import type { Thread, ThreadStatus } from "$lib/types";

/**
 * The statuses that refuse to be filed away.
 *
 * `running` is a turn in flight. `waiting` is a dialog on screen with nothing
 * moving until it is answered, which is the one status that must never leave the
 * list. `ready` is deliberately absent: it is what a finished agent sitting at
 * its prompt reads as, and what a plain shell reads as, so refusing it would
 * leave settle with almost nothing to act on.
 */
const BUSY: ThreadStatus[] = ["running", "waiting"];

export function canFileAway(status: ThreadStatus): boolean {
  return !BUSY.includes(status);
}

export function isPinned(thread: Thread): boolean {
  return thread.pinOrder != null;
}

export function isSettled(thread: Thread): boolean {
  return thread.settledAt != null;
}

/**
 * Still snoozed at this instant.
 *
 * The wake time is read rather than scheduled: a thread whose hour has passed is
 * simply not snoozed any more, which is what makes it come back without anything
 * having had to be running while the app was closed.
 */
export function isSnoozed(thread: Thread, now: number): boolean {
  return thread.snoozedUntil != null && thread.snoozedUntil > now;
}

/** Filed away in either sense: out of the main list, not out of the app. */
export function isFiled(thread: Thread, now: number): boolean {
  return isSettled(thread) || isSnoozed(thread, now);
}

/**
 * The next instant anything on this list changes where it belongs.
 *
 * Null when nothing is snoozed, which is what lets the wake clock stay stopped
 * rather than ticking for a state no thread is in.
 */
export function nextWake(threads: Thread[], now: number): number | null {
  let soonest: number | null = null;
  for (const thread of threads) {
    const until = thread.snoozedUntil;
    if (until == null || until <= now) continue;
    if (soonest === null || until < soonest) soonest = until;
  }
  return soonest;
}

/** A day in milliseconds, which is the unit auto-settle is set in. */
export const DAY_MS = 86_400_000;

/**
 * Which threads have been quiet long enough to file themselves away.
 *
 * `activityOf` is when the thread last changed what it was doing; the caller
 * supplies it because the registry that knows is in-memory and per-session.
 * A pinned thread is exempt — pinning is the user saying they want it there —
 * and so is anything already filed, and anything the refusal rule covers.
 */
export function dueForAutoSettle(
  threads: Thread[],
  opts: {
    now: number;
    days: number;
    statusOf: (thread: Thread) => ThreadStatus;
    activityOf: (thread: Thread) => number;
  },
): Thread[] {
  if (opts.days <= 0) return [];
  const cutoff = opts.now - opts.days * DAY_MS;
  return threads.filter(
    (thread) =>
      !isPinned(thread) &&
      !isFiled(thread, opts.now) &&
      canFileAway(opts.statusOf(thread)) &&
      opts.activityOf(thread) <= cutoff,
  );
}

/**
 * The pinned threads, in the order the user put them in.
 *
 * A row whose `pinOrder` was written by a Boite that ordered differently, or by
 * two devices racing, still lands somewhere deterministic: ties break on
 * `createdAt` and then on id, so every device draws the same list.
 */
export function pinnedInOrder(threads: Thread[]): Thread[] {
  return threads
    .filter(isPinned)
    .slice()
    .sort(
      (a, b) =>
        (a.pinOrder ?? 0) - (b.pinOrder ?? 0) ||
        a.createdAt - b.createdAt ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
}

/**
 * The order that results from moving one pinned thread by `delta` places.
 *
 * Returns the ids to send, or null when the move would fall off either end —
 * so a caller can disable the action rather than send a write that changes
 * nothing.
 */
export function movePinned(
  pinned: Thread[],
  id: string,
  delta: number,
): string[] | null {
  const from = pinned.findIndex((t) => t.id === id);
  if (from < 0) return null;
  const to = from + delta;
  if (to < 0 || to >= pinned.length) return null;
  const ids = pinned.map((t) => t.id);
  ids.splice(to, 0, ids.splice(from, 1)[0]);
  return ids;
}
