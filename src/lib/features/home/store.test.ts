import { describe, expect, it, vi } from "vitest";
import type { Thread, ThreadStatus } from "$lib/types";

vi.mock("$lib/app/store.svelte", () => ({
  app: {
    threads: [],
    threadById: () => null,
    selectedProjectId: null,
    sortedProjects: [],
    view: "terminal",
    mobileTab: "terminal",
    activeThreadId: null,
  },
}));

vi.mock("$lib/features/approvals/store.svelte", () => ({
  approvals: { items: [], pending: [] },
}));

vi.mock("$lib/features/thread/activity.svelte", () => ({
  threadActivitySince: () => null,
}));

vi.mock("$lib/shared/utils/clock.svelte", () => ({
  relativeClock: { now: 0, subscribe: () => () => {} },
}));

vi.mock("$lib/features/project/dashboard", () => ({
  openProjectDashboard: () => {},
}));

const { inboxOf, liveThreadCount, liveThreadsOf, WAITING_INBOX_MS } = await import("./store.svelte");

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

describe("liveThreadCount", () => {
  it("counts running and waiting only", () => {
    const statuses: ThreadStatus[] = [
      "idle",
      "running",
      "waiting",
      "ready",
      "done",
      "exited",
      "error",
      "stopped",
    ];
    const threads = statuses.map((status, i) => thread({ id: `t${i}`, status }));
    expect(liveThreadCount(threads)).toBe(2);
    expect(liveThreadsOf(threads).map((t) => t.status)).toEqual(["running", "waiting"]);
  });

  it("counts nothing when the list is empty or quiet", () => {
    expect(liveThreadCount([])).toBe(0);
    expect(liveThreadCount([thread({ status: "ready" }), thread({ id: "b", status: "idle" })])).toBe(
      0,
    );
  });

  it("counts every live agent, including several of one status", () => {
    expect(
      liveThreadCount([
        thread({ id: "a", status: "running" }),
        thread({ id: "b", status: "running" }),
        thread({ id: "c", status: "waiting" }),
      ]),
    ).toBe(3);
  });
});

describe("inboxOf", () => {
  const now = 10_000_000;
  const since = (_id: string) => null;

  it("lists settled delegations", () => {
    const items = inboxOf({
      threads: [
        thread({ id: "child", parentThreadId: "parent", settledAt: now - 1 }),
        thread({ id: "plain", settledAt: now - 1 }),
        thread({ id: "live", parentThreadId: "parent" }),
      ],
      approvals: [],
      since,
      now,
    });
    expect(items.map((item) => item.id)).toEqual(["delegation:child"]);
  });

  it("lists pending approvals", () => {
    const items = inboxOf({
      threads: [],
      approvals: [{ id: "a1", source: "local", ask: { title: "t", message: "m" } }],
      since,
      now,
    });
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("approval");
  });

  it("lists a waiting thread only after two minutes", () => {
    const waiting = thread({ id: "w", status: "waiting", createdAt: now - WAITING_INBOX_MS });
    const fresh = thread({ id: "f", status: "waiting", createdAt: now - WAITING_INBOX_MS + 1 });
    const items = inboxOf({
      threads: [waiting, fresh],
      approvals: [],
      since,
      now,
    });
    expect(items.map((item) => item.id)).toEqual(["waiting:w"]);
  });

  it("uses the activity stamp when one exists", () => {
    const waiting = thread({ id: "w", status: "waiting", createdAt: 0 });
    const items = inboxOf({
      threads: [waiting],
      approvals: [],
      since: (id) => (id === "w" ? now - WAITING_INBOX_MS : null),
      now,
    });
    expect(items.map((item) => item.id)).toEqual(["waiting:w"]);
  });
});
