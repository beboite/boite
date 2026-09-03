import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTurnQuery } from "$lib/backend/types";
import type { Thread, ThreadStatus } from "$lib/types";

/**
 * The engine itself, driven through its own ticker.
 *
 * Everything it reaches for is replaced: the app store, the panes, the settings,
 * the emulators, the notifier. What is left is the decision, which is the part
 * that has been wrong twice. `settleUnread` is the piece with no way to be
 * observed from outside a tick, so it is asked directly as well.
 */

// Hoisted: `vi.mock` factories run before anything declared at the top level of
// the file exists, so the state they read has to be built with them.
const h = vi.hoisted(() => ({
  threads: [] as Thread[],
  written: [] as Array<{ id: string; status: string }>,
  notified: [] as string[],
  emulators: new Set<string>(),
  turn: null as { state: string; waitingFor?: string | null } | null,
  // Mutable so a test can arm auto-sleep; the default is the setting off.
  settings: { idleTimeoutMinutes: 0, idleAutocloseByIcon: {} as Record<string, boolean> },
  parked: new Map<string, unknown>(),
  killed: [] as string[],
  polled: [] as AgentTurnQuery[][],
  // One fake group per test, holding the browser leaves the sweep reads.
  leaves: [] as Array<{ paneId: string; content: Record<string, unknown> }>,
  shown: new Set<string>(),
  closed: [] as string[],
}));

vi.mock("$lib/app/store.svelte", () => ({
  app: {
    get threads() {
      return h.threads;
    },
    activeThreadId: null,
    threadById: (id: string) => h.threads.find((t) => t.id === id) ?? null,
    projectById: () => null,
    setThreadStatus: (id: string, status: string) => {
      const found = h.threads.find((t) => t.id === id);
      if (found) found.status = status as ThreadStatus;
      h.written.push({ id, status });
    },
    setThreadPtyId: (id: string, ptyId: string | null) => {
      const found = h.threads.find((t) => t.id === id);
      if (found) found.ptyId = ptyId;
    },
    setThreadAutoSlept: () => {},
  },
}));

vi.mock("$lib/backend", () => ({
  workspace: { backendFor: () => ({ caps: { clientStatus: true } }) },
}));

vi.mock("$lib/features/settings/store.svelte", () => ({
  settings: {
    get state() {
      return h.settings;
    },
  },
}));

vi.mock("$lib/features/panes/store.svelte", () => ({
  paneStore: {
    groupOf: () => null,
    get groups() {
      return h.leaves.length > 0 ? [{ id: "g1", root: { leaves: h.leaves } }] : [];
    },
    closePane: (paneId: string) => {
      h.closed.push(paneId);
      h.leaves = h.leaves.filter((l) => l.paneId !== paneId);
      return true;
    },
  },
  threadLeavesOf: () => [],
  leafNodesOf: (root: { leaves: unknown[] }) => root.leaves,
}));

vi.mock("$lib/features/panes/visible", () => ({
  paneIsShown: (paneId: string) => h.shown.has(paneId),
}));

vi.mock("$lib/backend/tauri/parked", () => ({ parkedLocal: h.parked }));

// The case the whole backstop exists for: a thread whose pane is gone has no
// emulator holding its rows, and nothing can be read off it at all.
vi.mock("$lib/shared/terminals", () => ({
  liveTerminal: (id: string) => (h.emulators.has(id) ? { id } : null),
  terminalScreenRows: () => [],
}));

vi.mock("$lib/storage/notify", () => ({
  notifyWhenUnfocused: (_title: string, body: string) => {
    h.notified.push(body);
    return Promise.resolve();
  },
}));

vi.mock("$lib/i18n/index.svelte", () => ({ t: (key: string) => key }));
vi.mock("$lib/shared/icons/detect", () => ({ detectIconKey: () => null }));
vi.mock("$lib/storage/pty", () => ({
  ptyKill: (id: string) => {
    h.killed.push(id);
    return Promise.resolve();
  },
}));
vi.mock("$lib/shared/services/logger.svelte", () => ({
  logger: { debug() {}, info() {}, warn() {}, error() {} },
}));
vi.mock("./agent-turns", () => ({
  agentTurns: {
    stateOf: () => h.turn,
    poll: (_backend: unknown, queries: AgentTurnQuery[]) => {
      h.polled.push(queries);
    },
    wake: () => {},
    cwdOf: () => null,
  },
}));

type Module = typeof import("./statusEngine");

const TICK_MS = 500;
const TTL_MS = 2000;
const T0 = 1_000_000;

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "t1",
    projectId: "p1",
    ptyId: "pty1",
    label: "Cursor #1",
    title: null,
    cmd: "cursor-agent",
    args: [],
    // One of the five that declare nothing: the screen rows are its only source,
    // and with no pane open there are none.
    iconKey: "cursor",
    sessionId: "s1",
    status: "running",
    exitCode: null,
    createdAt: T0,
    ...overrides,
  };
}

// The engine keeps its bookkeeping in module scope, so each test gets its own.
let mod: Module;

beforeEach(async () => {
  h.threads = [];
  h.written = [];
  h.notified = [];
  h.emulators = new Set();
  h.turn = null;
  h.settings = { idleTimeoutMinutes: 0, idleAutocloseByIcon: {} };
  // Cleared rather than replaced: `vi.mock` hands the module this exact map
  // once, and a fresh instance here would never reach it.
  h.parked.clear();
  h.killed = [];
  h.polled = [];
  h.leaves = [];
  h.shown = new Set();
  h.closed = [];
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  vi.resetModules();
  mod = await import("./statusEngine");
});

afterEach(() => {
  mod.statusEngine.stop();
  vi.useRealTimers();
});

describe("settleUnread", () => {
  it("demotes a live status once every stamp has aged out", () => {
    const now = T0 + TTL_MS;
    expect(mod.settleUnread("running", now - TTL_MS, now)).toBe("ready");
    expect(mod.settleUnread("waiting", now - TTL_MS, now)).toBe("ready");
    expect(mod.settleUnread("running", now - TTL_MS + 1, now)).toBeNull();
  });

  it("demotes a thread with no stamp at all", () => {
    // Nothing to measure from is not the same as recent activity. The server
    // reads a missing anchor the same way (`unwrap_or(true)` in `next_status`).
    expect(mod.settleUnread("running", 0, T0)).toBe("ready");
  });

  it("leaves every status that is not this loop's to decide", () => {
    const stale = T0 - TTL_MS;
    for (const status of ["ready", "idle", "done", "exited", "error", "stopped"]) {
      expect(mod.settleUnread(status, stale, T0)).toBeNull();
    }
    expect(mod.settleUnread(undefined, stale, T0)).toBeNull();
  });
});

describe("a thread nothing can be read off", () => {
  it("goes ready once its activity has aged out, rather than staying lit forever", () => {
    // A Terminal unmounting with a live PTY (the thread moved out of a group, its
    // rect or group went away, a respawn key flipped) leaves exactly this: a
    // running thread, an agent that declares nothing, and no emulator. Left
    // alone it stayed Running for the life of the window, which also kept it out
    // of auto-sleep, since only a `ready` thread is ever a candidate.
    const t = thread();
    h.threads = [t];
    mod.statusEngine.markOutput(t.id);
    mod.statusEngine.start();

    vi.advanceTimersByTime(TICK_MS);
    expect(t.status).toBe("running");
    vi.advanceTimersByTime(TICK_MS * 2);
    expect(t.status).toBe("running");

    vi.advanceTimersByTime(TICK_MS);
    expect(t.status).toBe("ready");
    expect(h.written).toEqual([{ id: t.id, status: "ready" }]);
  });

  it("keeps a thread lit for as long as anything is still stamping it", () => {
    const t = thread();
    h.threads = [t];
    mod.statusEngine.start();

    for (let i = 0; i < 20; i += 1) {
      mod.statusEngine.markTranscriptActive(t.id);
      vi.advanceTimersByTime(TICK_MS);
    }
    expect(t.status).toBe("running");
    expect(h.written).toEqual([]);
  });

  it("demotes a waiting thread too, since nothing else could ever clear it", () => {
    // `waiting` is only ever set from an answer, so losing the answer leaves
    // nothing that would ever take it back off.
    const t = thread({ status: "waiting" });
    h.threads = [t];
    mod.statusEngine.start();

    vi.advanceTimersByTime(TICK_MS);
    expect(t.status).toBe("ready");
  });

  it("says nothing about a demotion it inferred", () => {
    // The user is told a turn ended when one ended. This is the absence of
    // evidence, and announcing it would ping for every pane that got closed.
    const t = thread();
    h.threads = [t];
    mod.statusEngine.start();
    vi.advanceTimersByTime(TICK_MS * 8);

    expect(t.status).toBe("ready");
    expect(h.notified).toEqual([]);
  });
});

describe("a thread with no live PTY", () => {
  it("drops a live status back to idle", () => {
    // Nothing is attached, so nothing could ever be read off it again. Any of
    // the three live statuses left on the row would stay there for good.
    for (const status of ["running", "waiting", "ready"] as const) {
      h.threads = [thread({ id: status, ptyId: null, status })];
      h.written = [];
      mod.statusEngine.start();
      vi.advanceTimersByTime(TICK_MS);
      mod.statusEngine.stop();
      expect(h.written).toEqual([{ id: status, status: "idle" }]);
    }
  });

  it("leaves a status that is not this loop's alone", () => {
    const t = thread({ ptyId: null, status: "stopped" });
    h.threads = [t];
    mod.statusEngine.start();
    vi.advanceTimersByTime(TICK_MS * 4);
    expect(h.written).toEqual([]);
    expect(t.status).toBe("stopped");
  });

  it("keeps a parked local thread exactly as it is", () => {
    // A workspace switch detaches the PTY without killing it. Demoting the row
    // would flatten a ping the user is meant to still see when it reattaches.
    const t = thread({ ptyId: null, status: "running" });
    h.threads = [t];
    h.parked.set(t.id, {});
    mod.statusEngine.start();
    vi.advanceTimersByTime(TICK_MS * 4);
    expect(h.written).toEqual([]);
    expect(t.status).toBe("running");
  });
});

describe("a finished thread", () => {
  it("is never judged again", () => {
    const t = thread({ status: "done" });
    h.threads = [t];
    mod.statusEngine.start();
    vi.advanceTimersByTime(TICK_MS * 8);
    expect(h.written).toEqual([]);
    expect(t.status).toBe("done");
  });
});

describe("the poll", () => {
  it("asks only about the threads running an agent", () => {
    h.threads = [
      thread({ id: "agent", iconKey: "cursor", sessionId: "s1" }),
      thread({ id: "shell", iconKey: "terminal" }),
      thread({ id: "unknown", iconKey: null }),
    ];
    mod.statusEngine.start();
    vi.advanceTimersByTime(TICK_MS);

    expect(h.polled).toEqual([[{ kind: "cursor", sessionId: "s1", cwd: "" }]]);
  });

  it("names a session it has not captured yet as null", () => {
    h.threads = [thread({ sessionId: null })];
    mod.statusEngine.start();
    vi.advanceTimersByTime(TICK_MS);

    expect(h.polled).toEqual([[{ kind: "cursor", sessionId: null, cwd: "" }]]);
  });
});

describe("what a waiting thread is blocked on", () => {
  it("is remembered while the dialog is up and dropped when it goes", () => {
    const t = thread({ iconKey: "claude", status: "running" });
    h.threads = [t];
    h.emulators.add(t.id);
    h.turn = { state: "waiting", waitingFor: "  Bash(rm -rf)  " };
    mod.statusEngine.start();

    vi.advanceTimersByTime(TICK_MS);
    expect(mod.waitingReasonFor(t.id)).toBe("Bash(rm -rf)");

    h.turn = { state: "busy" };
    vi.advanceTimersByTime(TICK_MS);
    expect(mod.waitingReasonFor(t.id)).toBeNull();
  });

  it("keeps nothing for a blank label", () => {
    const t = thread({ iconKey: "claude", status: "running" });
    h.threads = [t];
    h.emulators.add(t.id);
    h.turn = { state: "waiting", waitingFor: "   " };
    mod.statusEngine.start();

    vi.advanceTimersByTime(TICK_MS);
    expect(t.status).toBe("waiting");
    expect(mod.waitingReasonFor(t.id)).toBeNull();
  });
});

describe("auto-sleep", () => {
  it("kills the PTY of a settled thread nobody is looking at", () => {
    h.settings = { idleTimeoutMinutes: 1, idleAutocloseByIcon: { cursor: true } };
    const t = thread({ status: "ready" });
    h.threads = [t];
    mod.statusEngine.start();

    // Anchored on the last real activity, not on the pass that noticed it went
    // stale, so a one-minute setting sleeps after one minute.
    vi.advanceTimersByTime(60_000 - TICK_MS);
    expect(h.killed).toEqual([]);
    vi.advanceTimersByTime(TICK_MS * 2);

    expect(t.status).toBe("stopped");
    expect(t.ptyId).toBeNull();
    expect(h.killed).toEqual(["pty1"]);
  });

  it("refuses while anything is still stamping the thread", () => {
    h.settings = { idleTimeoutMinutes: 1, idleAutocloseByIcon: { cursor: true } };
    const t = thread({ status: "ready" });
    h.threads = [t];
    mod.statusEngine.start();

    for (let i = 0; i < 200; i += 1) {
      mod.statusEngine.markOutput(t.id);
      vi.advanceTimersByTime(TICK_MS);
    }
    expect(h.killed).toEqual([]);
    expect(t.status).toBe("ready");
  });

  it("leaves a thread whose icon was never opted in", () => {
    h.settings = { idleTimeoutMinutes: 1, idleAutocloseByIcon: {} };
    const t = thread({ status: "ready" });
    h.threads = [t];
    mod.statusEngine.start();
    vi.advanceTimersByTime(60_000 * 3);

    expect(h.killed).toEqual([]);
    expect(t.status).toBe("ready");
  });
});

describe("notifications", () => {
  it("stays quiet about a prompt that was already there on the first pass", () => {
    // `prevStatus` is empty after a mount, a workspace switch or a `forget`, so
    // the first pass has nothing to compare against. Treating that as a
    // transition pinged for every thread parked on an open dialog, on every app
    // start and every pane remount.
    const t = thread({ iconKey: "claude", status: "waiting" });
    h.threads = [t];
    h.emulators.add(t.id);
    h.turn = { state: "waiting" };
    mod.statusEngine.start();

    vi.advanceTimersByTime(TICK_MS * 4);
    expect(t.status).toBe("waiting");
    expect(h.notified).toEqual([]);
  });

  it("still reports a prompt that went up while it was watching", () => {
    const t = thread({ iconKey: "claude", status: "running" });
    h.threads = [t];
    h.emulators.add(t.id);
    h.turn = { state: "busy" };
    mod.statusEngine.start();
    vi.advanceTimersByTime(TICK_MS);
    expect(h.notified).toEqual([]);

    h.turn = { state: "waiting" };
    vi.advanceTimersByTime(TICK_MS);
    expect(t.status).toBe("waiting");
    expect(h.notified).toEqual(["awareness.detail.waitingForInput"]);
  });

  it("reports a turn that actually ended", () => {
    const t = thread({ iconKey: "claude", status: "running" });
    h.threads = [t];
    h.emulators.add(t.id);
    h.turn = { state: "busy" };
    mod.statusEngine.start();
    vi.advanceTimersByTime(TICK_MS);

    h.turn = { state: "idle" };
    vi.advanceTimersByTime(TICK_MS);
    expect(t.status).toBe("ready");
    expect(h.notified).toEqual(["awareness.detail.completed"]);
  });
});

describe("the browser panes an agent leaves behind", () => {
  const GRACE_MS = 15_000;

  function browserLeaf(paneId: string, drivenBy: string | null) {
    return { paneId, content: { kind: "browser", url: "http://localhost:1/", drivenBy } };
  }

  it("closes one its agent has finished with, once the wait is up", () => {
    const t = thread({ status: "ready" });
    h.threads = [t];
    h.leaves = [browserLeaf("pane1", t.id)];
    mod.statusEngine.start();

    vi.advanceTimersByTime(GRACE_MS - TICK_MS);
    expect(h.closed).toEqual([]);

    vi.advanceTimersByTime(TICK_MS * 2);
    expect(h.closed).toEqual(["pane1"]);
  });

  it("leaves a pane the user is looking at", () => {
    const t = thread({ status: "ready" });
    h.threads = [t];
    h.leaves = [browserLeaf("pane1", t.id)];
    h.shown.add("pane1");
    mod.statusEngine.start();

    vi.advanceTimersByTime(GRACE_MS * 3);
    expect(h.closed).toEqual([]);
  });

  it("leaves a pane the user took back", () => {
    // `drivenBy` cleared is the hand-back button. The pane is the user's from
    // that moment, and nothing here closes a pane the user owns.
    const t = thread({ status: "ready" });
    h.threads = [t];
    h.leaves = [browserLeaf("pane1", null)];
    mod.statusEngine.start();

    vi.advanceTimersByTime(GRACE_MS * 3);
    expect(h.closed).toEqual([]);
  });

  it("starts the wait again when the agent picks the page back up", () => {
    // A turn ending is not the same as the thread being done: an agent that
    // opens a page, answers, then is asked to look again would otherwise lose
    // the pane out from under its next call.
    const t = thread({ status: "ready" });
    h.threads = [t];
    h.leaves = [browserLeaf("pane1", t.id)];
    mod.statusEngine.start();

    vi.advanceTimersByTime(GRACE_MS - TICK_MS);
    t.status = "running";
    vi.advanceTimersByTime(TICK_MS * 2);
    expect(h.closed).toEqual([]);

    t.status = "ready";
    vi.advanceTimersByTime(GRACE_MS - TICK_MS);
    expect(h.closed).toEqual([]);
    vi.advanceTimersByTime(TICK_MS * 2);
    expect(h.closed).toEqual(["pane1"]);
  });
});
