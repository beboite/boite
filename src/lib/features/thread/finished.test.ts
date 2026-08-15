import { beforeEach, describe, expect, it } from "vitest";
import {
  clearFinished,
  justFinished,
  noteStatusChange,
  resetFinished,
} from "./finished.svelte";

beforeEach(() => {
  resetFinished();
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
