import type { ThreadStatus } from "$lib/types";
import { isFinished } from "$lib/domain/thread-status";
import { noteThreadActivity, resetThreadActivity } from "./activity.svelte";
import { consumeWaking, noteProjectWork, noteWorkStarted } from "./work-activity.svelte";

/**
 * The mark has no clock.
 *
 * It used to expire after six seconds, which put the whole burden on the user
 * being at the screen: a turn that ended while they were in another window left
 * a row indistinguishable from one that ended an hour ago, and the sidebar's
 * one job is telling those two apart. So the mark is laid and stays laid, and
 * three things take it back, each of them evidence the news was received or has
 * gone stale — the user opening the thread, the thread going back to work, and
 * the idle timer reclaiming its PTY.
 *
 * A plain record rather than `TransientMark`: with no TTL there is no timer to
 * keep, and the class is all timer.
 */
let marked = $state<Record<string, true>>({});

function lay(id: string) {
  // Reassign rather than mutate when the key is new: a fresh key on a $state
  // record is tracked, but a component that read `justFinished(id)` while the
  // key was absent is only re-run by a new object identity.
  if (!marked[id]) marked = { ...marked, [id]: true };
}

function lift(id: string) {
  if (!marked[id]) return;
  const next = { ...marked };
  delete next[id];
  marked = next;
}

/**
 * Record a status change, and say whether it was a thread crossing the finish
 * line.
 *
 * The transition is what matters, not the state: every thread in the sidebar
 * reads `done` after a reload, and lighting all of them up on boot would say
 * nothing. So a mark is only laid when the previous status was not already a
 * finished one, which also means the twice-a-second status sweep re-asserting
 * `done` cannot keep a row already read glowing again.
 *
 * `stopped` lifts the mark rather than laying one, and that is the reverse of
 * what it used to do. A thread the idle timer parked has had its PTY reclaimed,
 * which takes minutes of nothing happening: whatever it finished is no longer
 * news by then, and a row still blinking after a sleep is a row blinking for
 * good.
 */
export function noteStatusChange(
  threadId: string,
  previous: ThreadStatus,
  next: ThreadStatus,
  projectId: string | null = null,
) {
  if (previous === next) return;
  // Every change, not only the finishing ones: "working for 3 min" needs the
  // moment it started as much as "idle for 2 h" needs the moment it stopped,
  // and this is the one call both the local and the remote path make.
  noteThreadActivity(threadId);
  // An agent picking up a task, which is the one thing the sidebar's order
  // moves for. A transition by construction: the guard above already turned
  // away the sweep re-asserting `running` twice a second through a whole turn.
  //
  // Unless the thread is coming back rather than starting: a resume replays its
  // conversation, the replay draws a spinner, and from out here that spinner
  // reads exactly like a turn. `consumeWaking` is the mark the pane armed when
  // it spawned onto an existing session, and it answers once.
  if (next === "running" && !consumeWaking(threadId)) {
    noteWorkStarted(threadId);
    if (projectId) noteProjectWork(projectId);
  }
  // Back at work, or parked. Either way the last turn is not what the row has
  // to say any more.
  if (next === "running" || next === "stopped") {
    lift(threadId);
    return;
  }
  if (isFinished(previous) || !isFinished(next)) return;
  lay(threadId);
}

/** Whether this thread finished and nobody has looked at it since. */
export function justFinished(threadId: string): boolean {
  return marked[threadId] === true;
}

/** The user has opened the thread, so the news has been delivered. */
export function clearFinished(threadId: string) {
  lift(threadId);
}

/** A workspace switch replaces every thread; no mark survives it. */
export function resetFinished() {
  marked = {};
  resetThreadActivity();
}
