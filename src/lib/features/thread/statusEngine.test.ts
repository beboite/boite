import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  turn: null as { state: string } | null,
  // One fake group per test, holding the browser leaves the sweep reads.
  leaves: [] as Array<{ paneId: string; content: Record<string, unknown> }>,
  shown: new Set<string>(),
  closed: [] as string[],
  // Auto-sleep is off by default, the way a fresh install is. The one test that
  // wants it turns it on.
  settings: {
    idleTimeoutMinutes: 0,
    idleAutocloseByIcon: {} as Record<string, boolean>,
  },
  /** The chat sessions `pilot.stop` was asked for. */
  stopped: [] as string[],
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
  workspace: {
    backendFor: () => ({
      caps: { clientStatus: true },
      pilot: {
        stop: (id: string) => {
          h.stopped.push(id);
          return Promise.resolve();
        },
      },
    }),
  },
}));

vi.mock("$lib/features/settings/store.svelte", () => ({
  settings: { state: h.settings },
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
  leavesOf: () => [],
  threadLeavesOf: () => [],
  leafNodesOf: (root: { leaves: unknown[] }) => root.leaves,
}));

vi.mock("$lib/features/panes/visible", () => ({
  paneIsShown: (paneId: string) => h.shown.has(paneId),
}));

vi.mock("$lib/backend/tauri/parked", () => ({ parkedLocal: new Map() }));

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
vi.mock("$lib/storage/pty", () => ({ ptyKill: () => Promise.resolve() }));
vi.mock("$lib/shared/services/logger.svelte", () => ({
  logger: { debug() {}, info() {}, warn() {}, error() {} },
}));
vi.mock("./agent-turns", () => ({
  agentTurns: { stateOf: () => h.turn, poll: () => {}, cwdOf: () => null },
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
  h.leaves = [];
  h.shown = new Set();
  h.closed = [];
  h.settings.idleTimeoutMinutes = 0;
  h.settings.idleAutocloseByIcon = {};
  h.stopped = [];
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

describe("a chat thread", () => {
  // Its status is the protocol's, pushed by the host: the sweep must not touch
  // it, and every arm below would (no PTY reads as `idle`, no rows read as
  // nothing to say at all). Auto-sleep is the one thing that still applies, and
  // it stops the session rather than killing a process that does not exist.
  it("keeps the status the host pushed, and is auto-slept politely", () => {
    h.settings.idleTimeoutMinutes = 10;
    h.settings.idleAutocloseByIcon = { claude: true };
    const t = thread({
      id: "c1",
      runtime: "pilot",
      ptyId: null,
      iconKey: "claude",
      cmd: "claude",
      status: "ready",
    });
    h.threads = [t];
    mod.statusEngine.start();

    vi.advanceTimersByTime(TICK_MS * 4);
    expect(t.status).toBe("ready");
    expect(h.stopped).toEqual([]);

    vi.advanceTimersByTime(11 * 60_000);
    expect(h.stopped).toEqual(["c1"]);
    expect(t.status).toBe("stopped");
  });

  it("is left alone while it is working", () => {
    h.settings.idleTimeoutMinutes = 10;
    h.settings.idleAutocloseByIcon = { claude: true };
    const t = thread({
      id: "c1",
      runtime: "pilot",
      ptyId: null,
      iconKey: "claude",
      cmd: "claude",
      status: "running",
    });
    h.threads = [t];
    mod.statusEngine.start();

    vi.advanceTimersByTime(11 * 60_000);
    expect(t.status).toBe("running");
    expect(h.stopped).toEqual([]);
  });
});
