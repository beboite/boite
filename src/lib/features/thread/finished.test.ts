import { beforeEach, describe, expect, it } from "vitest";
import { noteStatusChange } from "./finished.svelte";
import { isThreadUnread, resetUnread, setUnreadWatcher } from "./unread.svelte";

/** Nothing is on screen, which is the case the marks exist for. */
beforeEach(() => {
  resetUnread();
  setUnreadWatcher(() => false);
});

describe("which transitions are worth telling", () => {
  /**
   * The headline case, and the one the feature was built around. A live agent
   * thread never reaches a finished status: those mean the PTY process died,
   * and an agent that writes its answer and sits back at its prompt reads
   * `ready`. Marking only on the finished ones left this scenario silent.
   */
  it("marks a turn that ended", () => {
    noteStatusChange("a", "running", "ready");
    expect(isThreadUnread("a")).toBe(true);
  });

  /**
   * `ready` is also what a thread reads while sitting at an untouched prompt,
   * so reaching it from anywhere else is the sweep settling rather than a turn
   * finishing, and there is nothing to tell.
   */
  it("says nothing about ready reached from anywhere else", () => {
    noteStatusChange("a", "waiting", "ready");
    noteStatusChange("b", "idle", "ready");
    expect(isThreadUnread("a")).toBe(false);
    expect(isThreadUnread("b")).toBe(false);
  });

  it("marks a dialog going up, from wherever", () => {
    noteStatusChange("a", "running", "waiting");
    noteStatusChange("b", "ready", "waiting");
    expect(isThreadUnread("a")).toBe(true);
    expect(isThreadUnread("b")).toBe(true);
  });

  /**
   * The idle reaper only ever sleeps a settled `ready` thread nobody is looking
   * at, so this mark was guaranteed: the dot claimed something happened while
   * the user was away when the only thing that happened was the app tidying up.
   */
  it("says nothing about a thread put to sleep for being idle", () => {
    noteStatusChange("a", "ready", "stopped");
    expect(isThreadUnread("a")).toBe(false);
  });

  /** The process dying under a thread that was working is not housekeeping. */
  it("marks a process that ended on its own", () => {
    noteStatusChange("a", "running", "exited");
    noteStatusChange("b", "running", "error");
    expect(isThreadUnread("a")).toBe(true);
    expect(isThreadUnread("b")).toBe(true);
  });

  /**
   * Every thread reads `done` after a reload and the twice-a-second sweep
   * re-asserts it, so the state cannot be what decides.
   */
  it("says nothing when one finished status follows another", () => {
    noteStatusChange("a", "done", "exited");
    expect(isThreadUnread("a")).toBe(false);
  });

  it("says nothing when the status did not move", () => {
    noteStatusChange("a", "running", "running");
    expect(isThreadUnread("a")).toBe(false);
  });
});
