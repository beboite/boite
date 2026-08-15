/**
 * Whether a thread is put away, and the one rule that keeps putting it away
 * safe.
 *
 * `lib/domain`: no runes, no Svelte imports, no store behind it, so the context
 * menu, the sidebar's own filter and the store's mutator all answer the same
 * question the same way. The twin of `boite_core::settle`, which enforces the
 * same refusal at the bus. Two copies on purpose and for the same reason
 * `browser.ts` has three: the desktop's live status is derived in the window, so
 * the menu that draws the action has to decide before the bus can.
 */

import type { Thread, ThreadStatus } from "$lib/types";

/**
 * The statuses that refuse to be put away.
 *
 * `running` is a turn in flight. `waiting` is a dialog on screen with nothing
 * moving until it is answered, which is the one status that must never leave the
 * list. `ready` is deliberately absent: it is what a finished agent sitting at
 * its prompt reads as, and what a plain shell reads as, so refusing it would
 * leave the gesture with almost nothing to act on.
 */
const BUSY: ThreadStatus[] = ["running", "waiting"];

export function canSettle(status: ThreadStatus): boolean {
  return !BUSY.includes(status);
}

export function isSettled(thread: Thread): boolean {
  return thread.settledAt != null;
}

/** How many of these are put away, for the count a project's card shows. */
export function countSettled(threads: Thread[]): number {
  let n = 0;
  for (const thread of threads) {
    if (isSettled(thread)) n += 1;
  }
  return n;
}
