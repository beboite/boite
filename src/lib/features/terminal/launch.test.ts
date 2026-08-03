import { describe, expect, it } from "vitest";
import { decideSpawn, launchPlan, type SpawnConditions } from "./launch";

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
