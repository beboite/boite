/**
 * What a thread's status means, in one place.
 *
 * The first file of `lib/domain`: rules the features share, with no runes, no
 * Svelte imports and no store behind them, so a component and a store answer
 * the same question the same way and either can be tested without mounting
 * anything.
 *
 * This one exists because the question "is this thread finished" was written
 * out by hand in seven places, and one of them disagreed with the other six.
 */

import type { ThreadStatus } from "$lib/types";

/**
 * The process is over, rather than merely quiet.
 *
 * `stopped` belongs here. A thread put to sleep has ended: its PTY was killed,
 * and the only difference from `done` is the colour of the dot. The copy that
 * left it out was on the remote control-event path, where it meant a slept
 * thread kept a `ptyId` pointing at a process the server had already reaped.
 */
export function isFinished(status: ThreadStatus): boolean {
  return (
    status === "done" ||
    status === "exited" ||
    status === "error" ||
    status === "stopped"
  );
}

/**
 * The thread holds no live process, so a `ptyId` on it is stale.
 *
 * The same set as {@link isFinished} plus `idle`, which is a thread that has a
 * row and has never been started. Both are "there is nothing to attach to".
 */
export function hasNoProcess(status: ThreadStatus): boolean {
  return status === "idle" || isFinished(status);
}

/**
 * Parked rather than gone: the row is still worth offering a relaunch on.
 *
 * `idle` never started, `stopped` was auto-slept. Neither is a failure, which
 * is why they are grouped apart from `exited` and `error`.
 */
export function isParked(status: ThreadStatus): boolean {
  return status === "idle" || status === "stopped";
}

/**
 * What the dot should say, which is not always what the row stores.
 *
 * A thread parked by a workspace switch keeps its PTY alive while its status
 * reads `idle` or `stopped`; it is attachable, so it shows as ready. Anything
 * else shows what it is.
 *
 * The rule was written out identically in the sidebar, the mobile project page
 * and the mobile thread sheet. Which of the three would have been updated the
 * next time it changed is not a question worth having.
 */
export function visibleStatus(
  status: ThreadStatus,
  hasLivePty: boolean,
): ThreadStatus {
  return hasLivePty && isParked(status) ? "ready" : status;
}
