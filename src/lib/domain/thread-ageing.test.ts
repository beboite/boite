import { describe, expect, it } from "vitest";
import {
  DAY_MS,
  canFileAway,
  dueForAutoSettle,
  isFiled,
  isSnoozed,
  movePinned,
  nextWake,
  pinnedInOrder,
} from "./thread-ageing";
import type { Thread, ThreadStatus } from "$lib/types";

const NOW = 1_700_000_000_000;

function thread(over: Partial<Thread> = {}): Thread {
  return {
    id: "t1",
    projectId: "p1",
    label: "one",
    cmd: "bash",
    args: [],
    status: "ready",
    createdAt: NOW - 30 * DAY_MS,
    ...over,
  } as Thread;
}

describe("the refusal", () => {
  it("keeps a working thread and a waiting one where they can be seen", () => {
    expect(canFileAway("running")).toBe(false);
    expect(canFileAway("waiting")).toBe(false);
  });

  it("lets the rest be filed, ready included", () => {
    const rest: ThreadStatus[] = ["ready", "stopped", "error"];
    for (const status of rest) expect(canFileAway(status)).toBe(true);
  });
});

describe("snooze", () => {
  it("ends by the clock rather than by anything having run", () => {
    const t = thread({ snoozedUntil: NOW + 1000 });
    expect(isSnoozed(t, NOW)).toBe(true);
    expect(isSnoozed(t, NOW + 1001)).toBe(false);
    expect(isFiled(t, NOW + 1001)).toBe(false);
  });

  it("names the soonest wake, and nothing when none is pending", () => {
    const list = [
      thread({ id: "a", snoozedUntil: NOW + 5000 }),
      thread({ id: "b", snoozedUntil: NOW + 100 }),
      thread({ id: "c", snoozedUntil: NOW - 1 }),
      thread({ id: "d" }),
    ];
    expect(nextWake(list, NOW)).toBe(NOW + 100);
    expect(nextWake([thread({ id: "e" })], NOW)).toBeNull();
    expect(nextWake([thread({ id: "c", snoozedUntil: NOW - 1 })], NOW)).toBeNull();
  });
});

describe("auto-settle", () => {
  const opts = (days: number, status: ThreadStatus = "ready") => ({
    now: NOW,
    days,
    statusOf: () => status,
    activityOf: (t: Thread) => t.createdAt,
  });

  it("does nothing at zero, which is off", () => {
    expect(dueForAutoSettle([thread()], opts(0))).toEqual([]);
  });

  it("takes what has been quiet longer than the setting", () => {
    const old = thread({ id: "old", createdAt: NOW - 10 * DAY_MS });
    const fresh = thread({ id: "fresh", createdAt: NOW - 1 * DAY_MS });
    const due = dueForAutoSettle([old, fresh], opts(7));
    expect(due.map((t) => t.id)).toEqual(["old"]);
  });

  it("never takes a pinned thread, a filed one, or one that is working", () => {
    const pinned = thread({ id: "pinned", pinOrder: 0 });
    const settled = thread({ id: "settled", settledAt: NOW - DAY_MS });
    const snoozed = thread({ id: "snoozed", snoozedUntil: NOW + DAY_MS });
    const list = [pinned, settled, snoozed];
    expect(dueForAutoSettle(list, opts(7))).toEqual([]);
    expect(dueForAutoSettle([thread({ id: "busy" })], opts(7, "running"))).toEqual([]);
  });
});

describe("the pinned order", () => {
  it("is deterministic when two devices wrote the same position", () => {
    const a = thread({ id: "a", pinOrder: 1, createdAt: 2 });
    const b = thread({ id: "b", pinOrder: 1, createdAt: 1 });
    const c = thread({ id: "c", pinOrder: 0, createdAt: 9 });
    expect(pinnedInOrder([a, b, c]).map((t) => t.id)).toEqual(["c", "b", "a"]);
  });

  it("leaves the unpinned out and does not sort its input in place", () => {
    const list = [thread({ id: "b", pinOrder: 1 }), thread({ id: "a", pinOrder: 0 }), thread({ id: "z" })];
    const before = list.map((t) => t.id);
    expect(pinnedInOrder(list).map((t) => t.id)).toEqual(["a", "b"]);
    expect(list.map((t) => t.id)).toEqual(before);
  });

  it("refuses a move off either end rather than clamping it", () => {
    const pinned = [
      thread({ id: "a", pinOrder: 0 }),
      thread({ id: "b", pinOrder: 1 }),
    ];
    expect(movePinned(pinned, "a", -1)).toBeNull();
    expect(movePinned(pinned, "b", 1)).toBeNull();
    expect(movePinned(pinned, "nobody", 1)).toBeNull();
    expect(movePinned(pinned, "a", 1)).toEqual(["b", "a"]);
  });
});
