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

const {
  inboxOf,
  isQuiet,
  liveThreadCount,
  liveThreadsOf,
  QUIET_ORCHESTRATOR_MS,
  recentThreadsOf,
  threadRecency,
  WAITING_INBOX_MS,
} = await import("./store.svelte");

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

describe("isQuiet", () => {
  const now = 10_000_000;

  it("is quiet with no thread and no orchestrator line", () => {
    expect(isQuiet({ threads: [], lastOrchestratorAt: null, now })).toBe(true);
  });

  it("is not quiet while a thread runs or waits", () => {
    expect(
      isQuiet({ threads: [thread({ status: "running" })], lastOrchestratorAt: null, now }),
    ).toBe(false);
    expect(
      isQuiet({ threads: [thread({ status: "waiting" })], lastOrchestratorAt: null, now }),
    ).toBe(false);
  });

  it("stays quiet with only settled threads", () => {
    expect(
      isQuiet({
        threads: [thread({ status: "done" }), thread({ id: "b", status: "idle" })],
        lastOrchestratorAt: null,
        now,
      }),
    ).toBe(true);
  });

  it("waits an hour after the last orchestrator line", () => {
    expect(
      isQuiet({ threads: [], lastOrchestratorAt: now - QUIET_ORCHESTRATOR_MS + 1, now }),
    ).toBe(false);
    expect(
      isQuiet({ threads: [], lastOrchestratorAt: now - QUIET_ORCHESTRATOR_MS, now }),
    ).toBe(true);
  });
});

describe("recentThreadsOf", () => {
  const since = (id: string) => (id === "stamped" ? 900 : null);

  it("orders on the activity stamp, then settledAt, then createdAt", () => {
    const rows = recentThreadsOf({
      threads: [
        thread({ id: "old", createdAt: 100 }),
        thread({ id: "settled", createdAt: 100, settledAt: 500 }),
        thread({ id: "stamped", createdAt: 0 }),
      ],
      since,
    });
    expect(rows.map((row) => row.id)).toEqual(["stamped", "settled", "old"]);
  });

  it("keeps ten rows at most and leaves the input alone", () => {
    const threads = Array.from({ length: 14 }, (_, i) =>
      thread({ id: `t${i}`, createdAt: i }),
    );
    const rows = recentThreadsOf({ threads, since: () => null });
    expect(rows).toHaveLength(10);
    expect(rows[0].id).toBe("t13");
    expect(threads[0].id).toBe("t0");
  });

  it("reads a settled stamp over the creation date", () => {
    expect(threadRecency(thread({ createdAt: 1, settledAt: 7 }), () => null)).toBe(7);
    expect(threadRecency(thread({ createdAt: 1 }), () => 9)).toBe(9);
  });
});
