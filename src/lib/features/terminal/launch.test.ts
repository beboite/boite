import { describe, expect, it } from "vitest";
import {
  decideSpawn,
  discardOpenedPty,
  gridDrifted,
  handsOffToRelaunch,
  launchFailureShows,
  launchPlan,
  ptyGrid,
  sessionScanSince,
  type LaunchStanding,
  type SpawnConditions,
} from "./launch";

const idle: SpawnConditions = {
  spawned: false,
  spawning: false,
  destroyed: false,
  status: "idle",
  reattach: false,
  clientStatus: true,
  parked: false,
};

const at = (over: Partial<SpawnConditions>) => decideSpawn({ ...idle, ...over });

describe("whether a terminal opens", () => {
  it("opens an idle thread, fresh", () => {
    expect(at({})).toEqual({ go: true, reattaching: false });
  });

  /**
   * Transient by construction: a retry is already scheduled, or the pane is
   * going away. Written at debug, which a release build compiles out.
   */
  it("says nothing loud about a pane that is already busy", () => {
    for (const over of [{ spawned: true }, { spawning: true }, { destroyed: true }]) {
      const verdict = at(over);
      expect(verdict.go).toBe(false);
      expect(verdict.go === false && verdict.level).toBe("debug");
    }
  });

  /**
   * The refusal that leaves a pane black for good. It is written at info for
   * exactly that reason: it went three releases without being found because
   * nothing in a release build said it had happened.
   */
  it("says loudly when it will not open at all", () => {
    const gone = at({ status: null });
    expect(gone.go).toBe(false);
    expect(gone.go === false && gone.level).toBe("info");
    expect(gone.go === false && gone.why).toContain("missing=true");
  });

  it("never auto-restarts a thread that finished", () => {
    for (const status of ["done", "exited", "error"] as const) {
      expect(at({ status }).go).toBe(false);
      // Not even when the caller asked for an attach: there is nothing running
      // to attach to.
      expect(at({ status, reattach: true }).go).toBe(false);
    }
  });
});

describe("whether opening means attaching", () => {
  it("attaches when the caller asked, to a thread that is running", () => {
    expect(at({ status: "ready", reattach: true })).toEqual({
      go: true,
      reattaching: true,
    });
  });

  /**
   * The black-pane-on-first-click bug. A remote thread the server already has
   * live is the server's, so opening it replays its ring; the old guard skipped
   * it entirely and drew nothing.
   */
  it("attaches to a remote thread the server already has running", () => {
    expect(at({ clientStatus: false, status: "ready" })).toEqual({
      go: true,
      reattaching: true,
    });
  });

  /** A remote thread that is idle spawns fresh, or the wrap-shell launch input
   * is never typed. */
  it("starts a remote thread that is idle rather than attaching", () => {
    expect(at({ clientStatus: false, status: "idle" })).toEqual({
      go: true,
      reattaching: false,
    });
  });

  /** A local PTY parked by a workspace switch is still alive. Spawning on top
   * of it would leave two processes for one pane. */
  it("attaches to a local PTY parked by a workspace switch", () => {
    expect(at({ parked: true, status: "ready" })).toEqual({
      go: true,
      reattaching: true,
    });
    // Parked and idle at the same time is a mark left on a thread whose PTY is
    // gone, and it still counts as an attach: the row says nothing is running,
    // so opening is allowed, but the launch input is not typed again. Pinned
    // because it is the one combination where the two halves of the verdict
    // disagree, and it is easy to "fix" into typing a prompt twice.
    expect(at({ parked: true, status: "idle" })).toEqual({
      go: true,
      reattaching: true,
    });
  });

  /** Parking is a local mechanism. A remote thread's `parked` entry means
   * nothing, and the server's own status decides. */
  it("ignores a parked mark on a thread the server owns", () => {
    expect(at({ clientStatus: false, parked: true, status: "idle" })).toEqual({
      go: true,
      reattaching: false,
    });
  });
});

describe("what gets launched", () => {
  const base = {
    cmd: "claude",
    userArgs: ["--resume", "abc"],
    iconKey: "claude",
    defaultShellId: "pwsh",
    powershellNoProfile: false,
  };

  it("runs an agent through the user's shell, so its aliases resolve", () => {
    expect(launchPlan(base)).toEqual({
      cmd: "claude",
      args: ["--resume", "abc"],
      wrap: { shellId: "pwsh", noProfile: false },
    });
  });

  /** A blank terminal *is* the shell. Wrapping it would open one inside another. */
  it("never wraps a blank terminal", () => {
    const plan = launchPlan({ ...base, cmd: "pwsh", iconKey: "terminal", userArgs: [] });
    expect(plan.wrap).toBeUndefined();
  });

  it("does not wrap when the user has chosen no shell", () => {
    expect(launchPlan({ ...base, defaultShellId: null }).wrap).toBeUndefined();
  });

  it("keeps PowerShell's own fast flags on the command it wraps", () => {
    const plan = launchPlan({
      ...base,
      cmd: "pwsh",
      iconKey: "terminal",
      userArgs: [],
      powershellNoProfile: true,
    });
    expect(plan.args).toEqual(["-NoProfile", "-NoLogo"]);
  });
});

/**
 * A launch that came back to a pane that has moved on. Every case here is a
 * gap between two awaits inside one spawn, which is why none of them was
 * reachable from a test until the verdicts moved out of the component.
 */
describe("what a launch still in flight is allowed to do", () => {
  const live: LaunchStanding = {
    destroyed: false,
    superseded: false,
    status: "idle",
  };
  const landed = (over: Partial<LaunchStanding & { hasScreen: boolean }> = {}) =>
    discardOpenedPty({ ...live, hasScreen: true, ...over });

  it("installs the PTY it opened on a pane that is still there", () => {
    expect(landed()).toBe(false);
    expect(landed({ status: "ready" })).toBe(false);
  });

  /** Handing a live process to a component that is gone is a PTY nothing will
   * ever kill. */
  it("kills a PTY that came back to a pane with nobody in it", () => {
    expect(landed({ destroyed: true })).toBe(true);
    expect(landed({ hasScreen: false })).toBe(true);
  });

  /** Installing it would leave the pane on the process the user asked to
   * replace, and the newer launch with nowhere to go. */
  it("kills a PTY a relaunch has already superseded", () => {
    expect(landed({ superseded: true })).toBe(true);
  });

  it("kills a PTY whose row has gone or been stopped", () => {
    expect(landed({ status: null })).toBe(true);
    expect(landed({ status: "stopped" })).toBe(true);
  });
});

describe("whether a failed launch is the thread's failure", () => {
  const live: LaunchStanding = {
    destroyed: false,
    superseded: false,
    status: "idle",
  };
  const failed = (over: Partial<LaunchStanding> = {}) =>
    launchFailureShows({ ...live, ...over });

  it("marks the row when the thread is still the one that failed", () => {
    expect(failed()).toBe(true);
  });

  /**
   * `error` is a finished thread, and a finished thread never auto-respawns:
   * writing it here would refuse the relaunch waiting behind this attempt for
   * the failure of the attempt it replaced.
   */
  it("says nothing about a launch a relaunch had already replaced", () => {
    expect(failed({ superseded: true })).toBe(false);
  });

  it("says nothing about a pane that is gone, or a thread already stopped", () => {
    expect(failed({ destroyed: true })).toBe(false);
    expect(failed({ status: "stopped" })).toBe(false);
  });

  /**
   * Deliberately different from `discardOpenedPty`, which refuses a missing
   * row. Nothing is being handed to a row here, only a status written onto one
   * that is not there, and that changes nothing anybody can observe. Pinned
   * because the two look like one predicate and are not.
   */
  it("does not treat a missing row as a reason to stay quiet", () => {
    expect(failed({ status: null })).toBe(true);
  });
});

describe("who starts the launch waiting behind this one", () => {
  const at = (over: Partial<Parameters<typeof handsOffToRelaunch>[0]>) =>
    handsOffToRelaunch({
      destroyed: false,
      spawned: false,
      superseded: false,
      ...over,
    });

  it("hands over when a relaunch landed and this attempt opened nothing", () => {
    expect(at({ superseded: true })).toBe(true);
  });

  it("does nothing when it was never superseded", () => {
    expect(at({})).toBe(false);
  });

  /** This attempt installed a PTY after all: replacing it is the newer
   * launch's own job, and starting one here is two PTYs on one pane. */
  it("does not hand over a pane it left a process on", () => {
    expect(at({ superseded: true, spawned: true })).toBe(false);
  });

  it("does not launch into a pane that is gone", () => {
    expect(at({ superseded: true, destroyed: true })).toBe(false);
  });
});

describe("the grid the process opens on", () => {
  it("uses the grid the pane measured", () => {
    expect(ptyGrid(120, 40)).toEqual({ cols: 120, rows: 40 });
  });

  /** xterm answers zero until it has measured a cell, and a PTY opened at zero
   * columns wraps every line onto itself. */
  it("falls back to a real size when the pane measured nothing", () => {
    expect(ptyGrid(0, 0)).toEqual({ cols: 80, rows: 24 });
  });

  /** Below the floor a pseudoconsole refuses the size outright. */
  it("never goes under the smallest grid a pseudoconsole takes", () => {
    expect(ptyGrid(1, 0.4)).toEqual({ cols: 2, rows: 1 });
  });

  it("notices a pane that re-measured while the launch was in flight", () => {
    expect(gridDrifted({ cols: 80, rows: 24 }, { cols: 80, rows: 24 })).toBe(false);
    expect(gridDrifted({ cols: 80, rows: 24 }, { cols: 120, rows: 24 })).toBe(true);
    expect(gridDrifted({ cols: 80, rows: 24 }, { cols: 80, rows: 40 })).toBe(true);
  });
});

describe("how far back the session scan looks", () => {
  /** A resume touches its transcript as the CLI starts; a wider window only
   * offers older files to mistake it for. */
  it("looks back a second for a thread that already has a session", () => {
    expect(sessionScanSince(10_000, true)).toBe(9_000);
  });

  /** A fresh conversation's first file can take seconds to land, and a window
   * that closes before it does leaves the thread unbound for good. */
  it("looks back five seconds for a thread that has none", () => {
    expect(sessionScanSince(10_000, false)).toBe(5_000);
  });

  it("never asks for a stamp before the epoch", () => {
    expect(sessionScanSince(200, false)).toBe(0);
  });
});
