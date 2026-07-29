import type { ThreadStatus } from "$lib/types";
import { TransientMark } from "$lib/shared/utils/transientMark.svelte";

// Long enough that a glance a few seconds after the agent stopped still catches
// it, short enough that a row is never still claiming to be fresh news by the
// time the user comes back from the kitchen.
const FINISH_WINDOW_MS = 6000;

const marks = new TransientMark(FINISH_WINDOW_MS);

/** Statuses that mean the process is over rather than merely quiet. */
function isFinished(status: ThreadStatus): boolean {
  return (
    status === "done" ||
    status === "exited" ||
    status === "error" ||
    status === "stopped"
  );
}

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
}
