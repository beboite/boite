/**
 * How a registered child is stopped on Linux and macOS. The registry spawns each
 * child detached there, which calls setsid(): the child leads a process group of
 * its own, whose id is its pid, and everything it starts joins that group unless
 * it leaves on purpose. Signalling the negative pid reaches the whole group, so a
 * turn's `sleep`, dev server or test runner goes with the agent that started it.
 *
 * SIGTERM first so a tool can clean up, then SIGKILL two seconds later for what
 * ignored it, sent to the group even when its leader already exited: a member
 * that ignored SIGTERM outlives the leader that obeyed it.
 *
 * That late signal is only safe while the group id is still this group's. The
 * kernel does not hand a pid out while a process, or a group, still uses it, but
 * once the leader was reaped and the last member exited, the id is free: a new
 * process that calls setsid, the core's own next detached spawn included, can
 * get it and lead a group of its own. So the group is probed with signal 0 every
 * `GROUP_POLL_MS` during the grace. The first probe that finds it empty ends the
 * stop with no SIGKILL. What is left is a group that emptied and an id that was
 * given to a new session leader inside one poll interval, which takes the pid
 * counter wrapping around within a tenth of a second.
 *
 * No native code and no timers of its own: the signaller is given, so
 * `test/posix-kill.test.ts` runs every case on a fake, on any platform.
 */

export const KILL_GRACE_MS = 2000;
/** How often a stopping group is checked for members during the grace. */
export const GROUP_POLL_MS = 100;

export interface Signaller {
  /** `process.kill`: a negative pid names a process group, signal 0 only probes. Throws like it. */
  kill(pid: number, signal: NodeJS.Signals | 0): void;
  /**
   * Runs `run` once after `ms`. The timer holds the process open: a shutdown
   * awaits the stop, and the stop is bounded by the grace.
   */
  later(run: () => void, ms: number): void;
}

const system: Signaller = {
  kill: (pid, signal) => {
    process.kill(pid, signal);
  },
  later: (run, ms) => {
    setTimeout(run, ms);
  },
};

function answers(signaller: Signaller, pid: number): boolean {
  try {
    signaller.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means something answers that this user may not signal: it exists.
    return (error as { code?: unknown }).code === 'EPERM';
  }
}

function send(signaller: Signaller, pid: number, name: NodeJS.Signals): boolean {
  try {
    signaller.kill(pid, name);
    return true;
  } catch {
    return false;
  }
}

/**
 * SIGTERM to the child's group now, SIGKILL to it after `graceMs` if it still
 * has members then. A child that leads no group (a spawn that could not setsid)
 * is signalled alone, and only while `running`, the spawner's own view, says it
 * was not reaped: a reaped pid can already belong to someone else.
 *
 * Resolves as soon as nothing is left to stop, or right after the SIGKILL, so a
 * shutdown can wait for it instead of exiting with the SIGKILL still pending.
 */
export function stopGroup(
  pid: number,
  running: () => boolean,
  signaller: Signaller = system,
  graceMs: number = KILL_GRACE_MS,
): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve();
  const grouped = send(signaller, -pid, 'SIGTERM');
  if (!grouped && !(running() && send(signaller, pid, 'SIGTERM'))) return Promise.resolve();

  // A group is there while a probe of it answers; a lone process while it was not reaped.
  const alive = (): boolean => (grouped ? answers(signaller, -pid) : running());
  return new Promise<void>((resolve) => {
    let waited = 0;
    const poll = (): void => {
      if (!alive()) {
        resolve();
        return;
      }
      if (waited < graceMs) {
        const step = Math.min(GROUP_POLL_MS, graceMs - waited);
        waited += step;
        signaller.later(poll, step);
        return;
      }
      send(signaller, grouped ? -pid : pid, 'SIGKILL');
      resolve();
    };
    poll();
  });
}
