import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DispatchLine } from "$lib/backend/types";
import type { Thread } from "$lib/types";

const world = vi.hoisted(() => ({
  threads: [] as unknown[],
  lines: [] as unknown[],
  settles: [] as Record<string, unknown>[],
  /** What the boite answers a settle with: false is another device first. */
  settled: true,
  orchestratorOn: true,
}));
const log = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }));

const conduct = vi.hoisted(() => ({
  drainDispatches: vi.fn(),
  settleDispatch: vi.fn(),
  acceptDispatch: vi.fn(),
}));

vi.mock("$lib/app/store.svelte", () => ({
  app: {
    get threads() {
      return world.threads;
    },
    threadById: (id: string) =>
      (world.threads as Thread[]).find((t) => t.id === id) ?? null,
  },
}));
vi.mock("$lib/backend/active.svelte", () => ({ backend: () => ({ conduct }) }));
vi.mock("$lib/features/settings/store.svelte", () => ({
  settings: {
    get state() {
      return { experimentOrchestrator: world.orchestratorOn };
    },
  },
}));
vi.mock("$lib/shared/services/logger.svelte", () => ({ logger: log }));
vi.mock("$lib/i18n/index.svelte", () => ({ t: (key: string) => key }));

const { flushDispatches, registerDispatchSink } = await import("./dispatches");

const TARGET = "t-worker";

function thread(over: Partial<Thread> = {}): Thread {
  return {
    id: TARGET,
    projectId: "p-1",
    label: "Claude #1",
    status: "ready",
    ptyId: "pty-1",
    ...over,
  } as Thread;
}

function line(over: Partial<DispatchLine> = {}): DispatchLine {
  return {
    id: "d-1",
    fromThreadId: "t-orch",
    toThreadId: TARGET,
    text: "carry on",
    mode: "queue",
    ...over,
  } as DispatchLine;
}

/** A terminal whose write answers whatever the test says the link is doing. */
function sink(landed: boolean, order: string[]) {
  return {
    notices: [] as string[],
    typed: [] as string[],
    register(this: { notices: string[]; typed: string[] }) {
      return registerDispatchSink(TARGET, {
        notice: (l: string) => {
          this.notices.push(l);
        },
        type: async (text: string) => {
          this.typed.push(text);
          order.push("type");
          return landed;
        },
      });
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  world.threads = [thread()];
  world.settled = true;
  world.orchestratorOn = true;
  log.warn.mockReset();
  conduct.drainDispatches.mockReset().mockResolvedValue([line()]);
  conduct.settleDispatch.mockReset().mockImplementation((params: Record<string, unknown>) => {
    world.settles.push(params);
    return Promise.resolve({ settled: world.settled });
  });
  world.settles = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a line whose write never left the device", () => {
  /**
   * The settle used to happen first, which reads as safe and is not:
   * `settle_dispatch` only moves a row out of `queued`, so a line marked
   * delivered can never come back. Over a boite whose socket had just dropped,
   * the orchestrator was told its instruction had landed in a terminal that
   * never saw a byte.
   */
  it("is never settled delivered", async () => {
    const order: string[] = [];
    const term = sink(false, order);
    const stop = term.register();
    await flushDispatches();
    stop();

    expect(world.settles).toEqual([
      { dispatchId: "d-1", state: "dropped", reason: "write_failed" },
    ]);
    expect(world.settles.some((s) => s.state === "delivered")).toBe(false);
  });

  /** The pane says it too, rather than leaving a notice above nothing. */
  it("tells the terminal the line did not land", async () => {
    const order: string[] = [];
    const term = sink(false, order);
    const stop = term.register();
    await flushDispatches();
    stop();
    expect(term.notices).toEqual(["dispatch.notice", "orchestrator.postFailed"]);
  });

  it("retries the write when reporting its failure also fails", async () => {
    const order: string[] = [];
    const term = sink(false, order);
    const stop = term.register();
    conduct.settleDispatch.mockRejectedValueOnce(new Error("settle failed"));

    await flushDispatches();
    await flushDispatches();
    stop();

    expect(term.typed).toEqual(["carry on\r", "carry on\r"]);
    expect(conduct.settleDispatch).toHaveBeenCalledTimes(2);
    expect(conduct.settleDispatch).toHaveBeenNthCalledWith(1, {
      dispatchId: "d-1",
      state: "dropped",
      reason: "write_failed",
    });
    expect(conduct.settleDispatch).toHaveBeenNthCalledWith(2, {
      dispatchId: "d-1",
      state: "dropped",
      reason: "write_failed",
    });
  });
});

describe("a line that did land", () => {
  it("is typed first and settled delivered afterwards", async () => {
    const order: string[] = [];
    const term = sink(true, order);
    const stop = term.register();
    conduct.settleDispatch.mockImplementation((params: Record<string, unknown>) => {
      world.settles.push(params);
      order.push("settle");
      return Promise.resolve({ settled: true });
    });
    await flushDispatches();
    stop();

    expect(term.typed).toEqual(["carry on\r"]);
    expect(order).toEqual(["type", "settle"]);
    expect(world.settles).toEqual([{ dispatchId: "d-1", state: "delivered" }]);
  });

  it("retries only the settle when its response fails after the write", async () => {
    const order: string[] = [];
    const term = sink(true, order);
    const stop = term.register();
    conduct.settleDispatch.mockRejectedValueOnce(new Error("settle failed"));

    await flushDispatches();
    stop();
    world.threads = [thread({ status: "running" })];
    await flushDispatches();

    expect(term.typed).toEqual(["carry on\r"]);
    expect(term.notices).toEqual(["dispatch.notice"]);
    expect(conduct.settleDispatch).toHaveBeenCalledTimes(2);
    expect(conduct.settleDispatch).toHaveBeenNthCalledWith(1, {
      dispatchId: "d-1",
      state: "delivered",
    });
    expect(conduct.settleDispatch).toHaveBeenNthCalledWith(2, {
      dispatchId: "d-1",
      state: "delivered",
    });
  });

  /** Newlines would split the prompt; the submit is the one \r. */
  it("flattens the text to one line", async () => {
    const order: string[] = [];
    const term = sink(true, order);
    conduct.drainDispatches.mockResolvedValue([line({ text: "do this\n  then that" })]);
    const stop = term.register();
    await flushDispatches();
    stop();
    expect(term.typed).toEqual(["do this then that\r"]);
  });

  /**
   * Settling after the write is what gives this up: a second device attached to
   * the same thread can have typed it too, and the loser finds out only here.
   */
  it("says so when another device settled it first", async () => {
    const order: string[] = [];
    const term = sink(true, order);
    world.settled = false;
    const stop = term.register();
    await flushDispatches();
    stop();
    expect(log.warn).toHaveBeenCalledWith(
      "dispatch",
      "another device settled this line first",
      { id: "d-1" },
    );
  });
});

describe("a target this window cannot type into", () => {
  it("leaves the row queued when no terminal here owns it", async () => {
    await flushDispatches();
    expect(world.settles).toEqual([]);
  });

  it("settles a refusal without typing when the thread is waiting on the user", async () => {
    world.threads = [thread({ status: "waiting" })];
    const order: string[] = [];
    const term = sink(true, order);
    const stop = term.register();
    await flushDispatches();
    stop();
    expect(term.typed).toEqual([]);
    expect(world.settles).toEqual([
      { dispatchId: "d-1", state: "refused", reason: "WAITING_ON_USER" },
    ]);
  });
});
