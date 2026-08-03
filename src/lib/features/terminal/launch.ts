import type { ThreadStatus } from "$lib/types";
import { isFinished } from "$lib/domain/thread-status";
import { withPowershellFastFlags } from "$lib/features/thread/shell-wrap";

/**
 * The two decisions inside opening a terminal, taken out of the opening.
 *
 * `spawn()` in Terminal.svelte is long because it sequences side effects on a
 * dozen pieces of component state, and most of that cannot move without
 * inventing a class to hold them. These two can, and they are the two worth
 * moving: they are decisions rather than effects, they are where every bug in
 * that function has been, and until now neither could be tested at all.
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

export type SpawnVerdict =
  | {
      go: false;
      /**
       * `debug` for a refusal that is transient by construction, `info` for one
       * that is not. The difference matters more than it looks: `debug` is
       * compiled out of a release build, and a terminal that never opens and
       * says nothing about it is the one failure the log could not explain,
       * which is how it went three releases without being found.
       */
      level: "debug" | "info";
      why: string;
    }
  | { go: true; reattaching: boolean };

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
