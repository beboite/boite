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
 * Whether this transition is something the user would want told to them from
 * another window.
 *
 * The headline case is a turn that ended, and in this codebase that transition
 * is `running -> ready`, which is exactly what `announceStatus` notifies on for
 * the same reason. It is worth spelling out because the finished statuses are a
 * trap here: `isFinished` is the PTY process having died, and the read behind
 * the sweep only ever answers `running`, `waiting` or `ready`, so an agent that
 * writes its answer and sits back at its prompt, the whole scenario the mark
 * exists for, never reaches one of them.
 *
 * A dialog going up counts from wherever, since it is the agent saying it
 * cannot continue without you.
 */
function worthTelling(previous: ThreadStatus, next: ThreadStatus): boolean {
  if (next === "waiting") return true;
  if (next === "ready") return previous === "running";
  // Not the idle reaper. It only ever sleeps a settled `ready` thread that is
  // off screen, so this transition would lay a mark every single time and the
  // dot would be claiming something happened while you were away when the only
  // thing that happened was the app tidying up after you.
  if (previous === "ready" && next === "stopped") return false;
  return !isFinished(previous) && isFinished(next);
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
 *
 * The unread mark asks a narrower question than the flash does, which is why
 * `worthTelling` is separate: the flash is a row the user is plausibly looking
 * at right now, and the mark is a claim about something they missed.
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
  // `noteUnread` drops it on the floor if the thread is on screen, so what is
  // decided here stays a statement about the transition rather than about who
  // was looking.
  if (worthTelling(previous, next)) noteUnread(threadId);
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
