import type { ThreadStatus } from "$lib/types";
import { isFinished } from "$lib/domain/thread-status";
import { withPowershellFastFlags } from "$lib/features/thread/shell-wrap";

/**
 * The decisions inside opening a terminal, taken out of the opening.
 *
 * `spawn()` in Terminal.svelte is long because it sequences side effects on a
 * dozen pieces of component state, and most of that cannot move without
 * inventing a class to hold them. What is here is the part that can: verdicts
 * rather than effects, no DOM, no store and no clock, which is what makes them
 * the only part of a launch a test can reach at all. The component keeps the
 * ordering and the writes; every question it asks on the way through is
 * answered here.
 *
 * Whether to open, and whether opening means attaching to something already
 * running, has been wrong in three distinguishable ways: a remote thread the
 * server already had live was skipped and left a black pane on first click, a
 * local PTY parked by a workspace switch was respawned on top of itself, and a
 * finished thread was auto-restarted. Each of those is one line of the verdict
 * below.
 */

/** Everything the decision is made from. No DOM, no store, no clock. */
export interface SpawnConditions {
  /** This component already has a PTY. */
  spawned: boolean;
  /** An attempt is in flight. */
  spawning: boolean;
  destroyed: boolean;
  /** What the row says now, or null when the row is gone. */
  status: ThreadStatus | null;
  /** The caller asked for an attach: a remote thread detached for visibility. */
  reattach: boolean;
  /**
   * Whether this thread's backend derives status on the client. False means the
   * server owns the thread's runtime state, which is what makes an already
   * running remote thread something to attach to rather than to start.
   */
  clientStatus: boolean;
  /** A local PTY parked by a workspace switch, still alive. */
  parked: boolean;
}

export type SpawnVerdict = SpawnRefusal | { go: true; reattaching: boolean };

export type SpawnRefusal = {
  go: false;
  /**
   * `debug` for a refusal that is transient by construction, `info` for one
   * that is not. The difference matters more than it looks: `debug` is
   * compiled out of a release build, and a terminal that never opens and says
   * nothing about it is the one failure the log could not explain, which is how
   * it went three releases without being found.
   */
  level: "debug" | "info";
  why: string;
};

/**
 * Whether to open a terminal for this thread, and whether that means attaching.
 *
 * Three shapes of attach, and they are three because they arrive from three
 * different places. The caller asking is an explicit reattach. A remote thread
 * the server reports as anything but idle is one the server owns, so opening it
 * means replaying its ring rather than starting a second process. A local PTY
 * parked by a workspace switch is still alive on this machine.
 *
 * A remote thread that is idle still spawns fresh, because the wrap-shell launch
 * input has to be typed and an attach never types it.
 */
export function decideSpawn(c: SpawnConditions): SpawnVerdict {
  if (c.spawned || c.spawning || c.destroyed) {
    return {
      go: false,
      level: "debug",
      why: `spawned=${c.spawned} spawning=${c.spawning} destroyed=${c.destroyed}`,
    };
  }
  // Finished threads never auto-respawn. Relaunch is explicit, through
  // reloadThread and a remount.
  const finished = c.status !== null && isFinished(c.status);
  const liveRemote = !c.clientStatus && !finished && c.status !== "idle";
  const reattaching = c.reattach || liveRemote || (c.clientStatus && c.parked);
  const attachable = reattaching && c.status !== "idle";
  if (c.status === null || finished || (c.status !== "idle" && !attachable)) {
    return {
      go: false,
      level: "info",
      why: `missing=${c.status === null} status=${c.status} reattach=${c.reattach} attachable=${attachable}`,
    };
  }
  return { go: true, reattaching };
}

export interface LaunchInput {
  cmd: string;
  /** What `buildResumeArgsAsync` worked out, MCP flags included. */
  userArgs: string[];
  /** `terminal` means the pane is the shell itself. */
  iconKey: string | null;
  defaultShellId: string | null;
  powershellNoProfile: boolean;
}

export interface LaunchPlan {
  cmd: string;
  args: string[];
  /**
   * The shell to launch through, when there is one. Absent means a direct
   * spawn.
   */
  wrap?: { shellId: string; noProfile: boolean };
}

/**
 * What to actually run, and whether to run it through a shell.
 *
 * A blank terminal *is* the shell, so it is never wrapped. Anything else may be
 * a shell function or an alias, which only exists once a profile has been
 * sourced. Whether it really is one is decided by the machine that owns the PTY:
 * for a remote thread the server's PATH and profile are the ones that count, and
 * an id it does not have falls through to a direct spawn on that side.
 */
export function launchPlan(input: LaunchInput): LaunchPlan {
  const isBlankTerminal = input.iconKey === "terminal";
  const plan: LaunchPlan = {
    cmd: input.cmd,
    args: withPowershellFastFlags(input.cmd, input.userArgs, input.powershellNoProfile),
  };
  if (!isBlankTerminal && input.defaultShellId) {
    plan.wrap = {
      shellId: input.defaultShellId,
      noProfile: input.powershellNoProfile,
    };
  }
  return plan;
}

/**
 * Where a launch stands against the pane it started from.
 *
 * A launch awaits three times before it has anything to install: the thread's
 * directory, the resume lookup, the PTY itself. The pane can be unmounted, the
 * row can be stopped and a relaunch can claim the pane in any of those gaps, so
 * what finally comes back may have nowhere to go. `spawn()` asks about that at
 * three moments and gets three different answers, which is why this is three
 * predicates over one shape rather than one flag. Collapsing them is the
 * refactor to resist: each one is the exact set of states in which its own side
 * effect is still wanted, and they are not the same set.
 */
export interface LaunchStanding {
  /** The pane was unmounted while this launch was in flight. */
  destroyed: boolean;
  /** A newer launch claimed the pane: the generation moved under this one. */
  superseded: boolean;
  /** What the row says now, or null when the row is gone. */
  status: ThreadStatus | null;
}

/**
 * Whether the PTY that just came back has to be killed rather than installed.
 *
 * Installing it would leave the pane on a process the user asked to replace and
 * the newer launch with nowhere to go, or hand a live process to a component
 * that is already gone — which is a PTY nothing will ever kill.
 *
 * The emulator is part of it and the row's absence is too: without a screen
 * there is nothing to attach the output to, and a row that has gone or been
 * stopped is a thread whose process was already decided against.
 */
export function discardOpenedPty(
  c: LaunchStanding & { /** The pane still has its emulator. */ hasScreen: boolean },
): boolean {
  return (
    c.destroyed ||
    !c.hasScreen ||
    c.status === null ||
    c.status === "stopped" ||
    c.superseded
  );
}

/**
 * Whether a launch that threw leaves the row `error`.
 *
 * Not for a launch that has already been superseded: an error status is a
 * finished thread, and the relaunch waiting behind this one would be refused for
 * the failure of the attempt it replaced.
 *
 * A row that has gone is deliberately not a refusal here, unlike above. Writing
 * a status onto a thread that no longer exists changes nothing anyone can
 * observe, and the check would only claim to guard something.
 */
export function launchFailureShows(c: LaunchStanding): boolean {
  return !c.destroyed && !c.superseded && c.status !== "stopped";
}

/**
 * Whether this attempt owes the pane one more launch on its way out.
 *
 * A relaunch that landed mid-flight is a launch the user is waiting for that has
 * not started yet: this attempt read its own generation as stale, dropped
 * whatever it had opened, and is the only thing left that can hand over. Not
 * when it did install a PTY (`spawned`), which is the newer launch's own job to
 * replace, and not into a pane that is gone.
 */
export function handsOffToRelaunch(c: {
  destroyed: boolean;
  /** This attempt installed a PTY after all. */
  spawned: boolean;
  superseded: boolean;
}): boolean {
  return !c.destroyed && !c.spawned && c.superseded;
}

/** A terminal grid, in cells. */
export interface Grid {
  cols: number;
  rows: number;
}

/**
 * The grid the process is told to open on.
 *
 * xterm reports zero for both until it has measured a cell, and a PTY opened at
 * zero columns is a process wrapping every line onto itself. The floors are the
 * smallest grid a pseudoconsole accepts rather than anything meaningful to look
 * at: this is the fallback for a pane that answered nothing, not a size to lay
 * out for.
 */
export function ptyGrid(cols: number, rows: number): Grid {
  return { cols: Math.max(2, cols || 80), rows: Math.max(1, rows || 24) };
}

/**
 * Whether the pane has re-measured onto a different grid than the one the
 * process was told about.
 *
 * The grid is read before the resume lookup, and the worktree wait in front of
 * that is seconds now rather than the instant a symlink took, so the pane has
 * time to finish laying out and re-measure while the launch is still on its way.
 * Every `onResize` firing in that window is dropped for want of a pty id to
 * match, and nothing reconciled afterwards: the process spent its life drawing
 * to a narrower grid than the one on screen, which looks like a strip of dead
 * pane down the right-hand side that only a window resize clears.
 */
export function gridDrifted(told: Grid, now: Grid): boolean {
  return now.cols !== told.cols || now.rows !== told.rows;
}

/**
 * How far back the session scan looks for the conversation this launch opened.
 *
 * A thread that already carries a session id is being resumed, and the CLI
 * touches that transcript as it starts, so a second is enough and a wider window
 * only offers older files to mistake it for. A thread carrying none is a fresh
 * conversation whose first file may take several seconds to land, and a window
 * that closes before it does leaves the thread unbound for the rest of its life
 * — which means its next relaunch opens a blank agent.
 *
 * Clamped at zero because the argument is a clock reading, and a machine whose
 * clock sits near the epoch would otherwise ask for a negative stamp.
 */
export function sessionScanSince(spawnedAt: number, hasSession: boolean): number {
  return Math.max(0, spawnedAt - (hasSession ? 1000 : 5000));
}
