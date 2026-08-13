import type { ThreadStatus } from "$lib/types";
import { isFinished } from "$lib/domain/thread-status";
import { TransientMark } from "$lib/shared/utils/transientMark.svelte";
import { noteThreadActivity, resetThreadActivity } from "./activity.svelte";
import { noteUnread, resetUnread } from "./unread.svelte";

// Long enough that a glance a few seconds after the agent stopped still catches
// it, short enough that a row is never still claiming to be fresh news by the
// time the user comes back from the kitchen.
const FINISH_WINDOW_MS = 6000;

const marks = new TransientMark(FINISH_WINDOW_MS);

/**
 * Record a status change, and say whether it was a thread crossing the finish
 * line.
 *
 * The transition is what matters, not the state: every thread in the sidebar
 * reads `done` after a reload, and lighting all of them up on boot would say
 * nothing. So a mark is only laid when the previous status was not already a
 * finished one, which also means the twice-a-second status sweep re-asserting
 * `done` cannot keep a row glowing forever.
 *
 * `stopped` counts. A thread put to sleep has ended too, and the row saying so
 * is the same information — the colour is what differs, and that is the caller's
 * business.
 */
export function noteStatusChange(
  threadId: string,
  previous: ThreadStatus,
  next: ThreadStatus,
) {
  if (previous === next) return;
  // Every change, not only the finishing ones: "working for 3 min" needs the
  // moment it started as much as "idle for 2 h" needs the moment it stopped,
  // and this is the one call both the local and the remote path make.
  noteThreadActivity(threadId);
  // Two transitions are news, and they are the two the user would want to be
  // told about from another window: a turn that ended, and a dialog that went
  // up and is holding the agent still. `noteUnread` drops it on the floor if
  // the thread is on screen, so this stays a statement about the transition
  // rather than about who was looking.
  if (next === "waiting" || (!isFinished(previous) && isFinished(next))) {
    noteUnread(threadId);
  }
  if (isFinished(previous) || !isFinished(next)) return;
  marks.mark(threadId);
}

/** Whether this thread crossed the finish line inside the last few seconds. */
export function justFinished(threadId: string): boolean {
  return marks.has(threadId);
}

/** The user has opened the thread, so the news has been delivered. */
export function clearFinished(threadId: string) {
  marks.clear(threadId);
}

/** A workspace switch replaces every thread; no mark survives it. */
export function resetFinished() {
  marks.reset();
  resetThreadActivity();
  resetUnread();
}
