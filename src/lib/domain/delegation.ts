/**
 * Whether a thread is working for another one, and when that work is over.
 *
 * `lib/domain`: no runes, no store, so the sidebar menu, the mobile row and
 * the status writer all ask the same question. Closing a finished delegation
 * is a process that has actually ended, never a turn that went back to
 * `ready`: that is an agent waiting for the next prompt, and treating it as
 * done is how a live terminal would vanish after five seconds.
 */

import type { DelegationStatus, Thread, ThreadStatus } from "$lib/types";

export function isDelegated(thread: Pick<Thread, "delegationMode" | "parentThreadId">): boolean {
  return thread.delegationMode === "delegation" || !!thread.parentThreadId;
}

/** What the delegation lifecycle should read for this process status. */
export function delegationOutcome(
  status: ThreadStatus,
  exitCode: number | null,
): DelegationStatus | null {
  if (status === "running" || status === "waiting" || status === "ready") {
    return "running";
  }
  const failed =
    status === "error" || (status === "exited" && exitCode !== null && exitCode !== 0);
  if (failed) return "failed";
  if (status === "done" || status === "exited") return "completed";
  return null;
}

export function shouldCloseDelegation(outcome: DelegationStatus | null): boolean {
  return outcome === "completed";
}
