import { beforeEach, describe, expect, it } from "vitest";
import {
  clearFinished,
  justFinished,
  noteStatusChange,
  resetFinished,
} from "./finished.svelte";
import { forgetWorkStarted, workStartedSince } from "./work-activity.svelte";

beforeEach(() => {
  resetFinished();
  for (const id of ["a", "b"]) forgetWorkStarted(id);
});

describe("which transitions light a row up", () => {
  /**
   * The transition is what matters, not the state. A process that died under a
   * thread which was working is the case the flash exists for.
   */
  it("marks a thread crossing the finish line", () => {
    noteStatusChange("a", "running", "exited");
    noteStatusChange("b", "running", "error");
    expect(justFinished("a")).toBe(true);
    expect(justFinished("b")).toBe(true);
  });

  /** A thread put to sleep has ended too; the colour is the caller's business. */
  it("marks a thread stopped from anywhere alive", () => {
    noteStatusChange("a", "ready", "stopped");
    expect(justFinished("a")).toBe(true);
  });

  /**
   * Every thread reads `done` after a reload and the twice-a-second sweep
   * re-asserts it, so the state cannot be what decides: one finished status
   * following another would keep a row glowing forever.
   */
  it("says nothing when one finished status follows another", () => {
    noteStatusChange("a", "done", "exited");
    expect(justFinished("a")).toBe(false);
  });

  it("says nothing about a thread that is still alive", () => {
    noteStatusChange("a", "running", "ready");
    noteStatusChange("b", "running", "waiting");
    expect(justFinished("a")).toBe(false);
    expect(justFinished("b")).toBe(false);
  });

  it("says nothing when the status did not move", () => {
    noteStatusChange("a", "exited", "exited");
    expect(justFinished("a")).toBe(false);
  });
});

describe("which transitions the sidebar's order follows", () => {
  /** An agent picking up a task, which is the whole signal. */
  it("stamps a thread entering running", () => {
    noteStatusChange("a", "ready", "running");
    expect(workStartedSince("a")).not.toBeNull();
  });

  it("stamps a thread whose first turn starts", () => {
    noteStatusChange("a", "idle", "running");
    expect(workStartedSince("a")).not.toBeNull();
  });

  /**
   * The rest of a thread's life says nothing about new work: finishing, going
   * quiet, being answered, dying. Ranking on any of them is what made the
   * sidebar rearrange itself around nothing.
   */
  it("says nothing about a thread leaving running", () => {
    noteStatusChange("a", "running", "ready");
    noteStatusChange("b", "running", "exited");
    expect(workStartedSince("a")).toBeNull();
    expect(workStartedSince("b")).toBeNull();
  });

  it("says nothing about a thread putting a dialog up", () => {
    noteStatusChange("a", "running", "waiting");
    expect(workStartedSince("a")).toBeNull();
  });

  /** The sweep re-asserts `running` twice a second for as long as a turn
      lasts, and a stamp moved by each would rank a long task above a fresh
      one. */
  it("says nothing while a turn is merely still going", () => {
    noteStatusChange("a", "running", "running");
    expect(workStartedSince("a")).toBeNull();
  });
});

describe("clearing", () => {
  /** Opening the thread is the news being delivered. */
  it("clears one thread without touching the others", () => {
    noteStatusChange("a", "running", "exited");
    noteStatusChange("b", "running", "exited");
    clearFinished("a");
    expect(justFinished("a")).toBe(false);
    expect(justFinished("b")).toBe(true);
  });

  /** A workspace switch replaces every thread, so no mark survives it. */
  it("clears everything on a reset", () => {
    noteStatusChange("a", "running", "exited");
    noteStatusChange("b", "running", "exited");
    resetFinished();
    expect(justFinished("a")).toBe(false);
    expect(justFinished("b")).toBe(false);
  });
});
