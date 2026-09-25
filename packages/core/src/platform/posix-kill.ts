/**
 * How a registered child is stopped on Linux and macOS. The registry spawns each
 * child detached there, which calls setsid(): the child leads a process group of
 * its own, whose id is its pid, and everything it starts joins that group unless
 * it leaves on purpose. Signalling the negative pid reaches the whole group, so a
 * turn's `sleep`, dev server or test runner goes with the agent that started it.
 *
 * SIGTERM first so a tool can clean up, then SIGKILL two seconds later for what
 * ignored it, sent to the group even when its leader already exited: a member
 * that ignored SIGTERM outlives the leader that obeyed it. A group id is not given
 * to a new group while a member of the old one is alive, so that late signal
 * reaches either what is left of this group or nothing.
 *
 * No native code and no timers of its own: the signaller is given, so
 * `test/posix-kill.test.ts` runs every case on a fake, on any platform.
 */

export const KILL_GRACE_MS = 2000;

export interface Signaller {
  /** `process.kill`: a negative pid names a process group. Throws like it. */
  kill(pid: number, signal: NodeJS.Signals): void;
  /** Runs `run` once after `ms`, without keeping the core alive for it. */
  later(run: () => void, ms: number): void;
}

const system: Signaller = {
  kill: (pid, signal) => {
    process.kill(pid, signal);
  },
  later: (run, ms) => {
    const timer = setTimeout(run, ms);
    timer.unref();
  },
};

/**
 * Signals the group `pid` leads, or the process alone when it leads none (a spawn
 * that could not setsid). The process alone only while `running` says it was not
 * reaped: a reaped pid can already belong to someone else. False when nothing
 * was signalled.
 */
function signal(signaller: Signaller, pid: number, name: NodeJS.Signals, running: () => boolean): boolean {
  try {
    signaller.kill(-pid, name);
    return true;
  } catch {
    // No such group: fall back to the process itself.
  }
  if (!running()) return false;
  try {
    signaller.kill(pid, name);
    return true;
  } catch {
    return false;
  }
}

/**
 * SIGTERM to the child's group now, SIGKILL to it after `KILL_GRACE_MS`.
 * `running` is the spawner's own view: true until the child was reaped.
 */
export function stopGroup(pid: number, running: () => boolean, signaller: Signaller = system): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (!signal(signaller, pid, 'SIGTERM', running)) return;
  signaller.later(() => {
    signal(signaller, pid, 'SIGKILL', running);
  }, KILL_GRACE_MS);
}
