/**
 * Seam for wave 3. Windows Job Objects reached with `bun:ffi` land here:
 * `assignToThreadJob` creates the thread's job on first use (nested in the
 * global `boite-agents` job, KILL_ON_JOB_CLOSE on both, never BREAKAWAY_OK)
 * and assigns the freshly spawned child before its first instruction;
 * `terminateThreadJob` becomes TerminateJobObject and replaces the pid walk in
 * `procs.killTree`. Until then both are no-ops and `procs` reports
 * `mode: 'poll'` so nothing claims an accuracy it does not have.
 */
export function assignToThreadJob(_threadId: string, _pid: number): boolean {
  return false;
}

export function terminateThreadJob(_threadId: string): boolean {
  return false;
}
