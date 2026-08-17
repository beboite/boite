import { describe, expect, it } from "vitest";
import { canSettle, countSettled, isSettled, splitSettled } from "./thread-settle";
import type { Thread, ThreadStatus } from "$lib/types";

function thread(over: Partial<Thread> = {}): Thread {
  return {
    id: "t",
    projectId: "p",
    ptyId: null,
    label: "l",
    title: null,
    cmd: "c",
    args: [],
    iconKey: "claude",
    sessionId: null,
    status: "idle",
    exitCode: null,
    createdAt: 0,
    ...over,
  };
}

describe("canSettle", () => {
  it("refuses a turn in flight and a dialog waiting for an answer", () => {
    expect(canSettle("running")).toBe(false);
    expect(canSettle("waiting")).toBe(false);
  });

  /**
   * `ready` is the one that would quietly kill the feature: it is what a
   * finished agent at its prompt reads as, and what a plain shell reads as.
   */
  it("allows every status that is finished business", () => {
    const ok: ThreadStatus[] = ["idle", "ready", "done", "exited", "error", "stopped"];
    for (const status of ok) expect(canSettle(status), status).toBe(true);
  });
});

describe("isSettled", () => {
  it("reads the timestamp, and treats null and absent alike", () => {
    expect(isSettled(thread())).toBe(false);
    expect(isSettled(thread({ settledAt: null }))).toBe(false);
    expect(isSettled(thread({ settledAt: 1 }))).toBe(true);
  });

  /** Zero is a real instant, and a row carrying it is a row that was put away. */
  it("counts the epoch as put away rather than as absent", () => {
    expect(isSettled(thread({ settledAt: 0 }))).toBe(true);
  });
});

describe("countSettled", () => {
  it("counts only the ones that carry a timestamp", () => {
    expect(
      countSettled([
        thread({ id: "a" }),
        thread({ id: "b", settledAt: 5 }),
        thread({ id: "c", settledAt: null }),
        thread({ id: "d", settledAt: 9 }),
      ]),
    ).toBe(2);
  });

  it("answers zero on an empty list", () => {
    expect(countSettled([])).toBe(0);
  });
});

describe("splitSettled", () => {
  it("keeps each pile in the order the list already had", () => {
    const a = thread({ id: "a" });
    const b = thread({ id: "b", settledAt: 1 });
    const c = thread({ id: "c" });
    const d = thread({ id: "d", settledAt: 2 });
    expect(splitSettled([a, b, c, d])).toEqual({
      live: [a, c],
      settled: [b, d],
    });
  });

  it("answers two empty piles on an empty list", () => {
    expect(splitSettled([])).toEqual({ live: [], settled: [] });
  });
});
