import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LogRecordInput } from "$lib/backend/types";

const written: LogRecordInput[][] = [];
let writeFails = false;

vi.mock("$lib/backend", () => ({
  backend: () => ({
    logs: {
      write: (records: LogRecordInput[]) => {
        if (writeFails) return Promise.reject(new Error("no host"));
        written.push(records);
        return Promise.resolve();
      },
    },
  }),
}));

const { log, flush, captureWebviewErrors, resetLogForTest, shortStack, FLUSH_INTERVAL_MS, MAX_BATCH } =
  await import("./log");

beforeEach(() => {
  written.length = 0;
  writeFails = false;
  resetLogForTest();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  resetLogForTest();
});

/** Lets the flush's `await` settle without advancing the fake clock. */
async function settle(turns = 4) {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

/**
 * The three listeners the capture installs, and nothing else.
 *
 * The suite runs on `node` by design (see `vitest.config.ts`: what is worth
 * testing here is pure logic, so nothing pulls a DOM in). What the module
 * actually needs of `window` is `addEventListener`, so that is what is stood
 * up rather than a browser.
 */
function fakeWindow() {
  const handlers = new Map<string, ((event: unknown) => void)[]>();
  const win = {
    addEventListener(name: string, handler: (event: unknown) => void) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
  };
  vi.stubGlobal("window", win);
  return (name: string, event: unknown = {}) => {
    for (const handler of handlers.get(name) ?? []) handler(event);
  };
}

describe("the batch", () => {
  /**
   * The whole reason this module exists. One IPC hop per line was measured as a
   * couple of file writes a second, forever, for a thread that had simply got
   * stuck, and the callers that produce the most lines are the ones on timers.
   */
  it("holds a record for the window rather than sending it at once", async () => {
    log.info("ui.pane", "pane.opened");
    await settle();
    expect(written).toHaveLength(0);

    vi.advanceTimersByTime(FLUSH_INTERVAL_MS - 1);
    await settle();
    expect(written).toHaveLength(0);

    vi.advanceTimersByTime(1);
    await settle();
    expect(written).toHaveLength(1);
    expect(written[0]).toHaveLength(1);
    expect(written[0][0]).toMatchObject({ level: "info", target: "ui.pane", msg: "pane.opened" });
  });

  /**
   * Fifty is a cut, not a delay: a burst is what a stall looks like, and making
   * the fiftieth line wait out the window would be the one time the batch costs
   * the reader something.
   */
  it("goes at fifty without waiting out the window", async () => {
    for (let i = 0; i < MAX_BATCH; i++) log.debug("t", `m${i}`);
    await settle();
    expect(written).toHaveLength(1);
    expect(written[0]).toHaveLength(MAX_BATCH);
  });

  /** A window going away is exactly when its last lines matter most. */
  it("flushes on pagehide", async () => {
    const fire = fakeWindow();
    captureWebviewErrors();
    log.warn("app", "about.to.go");
    await settle();
    expect(written).toHaveLength(0);

    fire("pagehide");
    await settle();
    expect(written).toHaveLength(1);
    expect(written[0][0].msg).toBe("about.to.go");
  });

  /**
   * `thread`, `turn` and `request` are top level on purpose, so a filter never
   * parses `fields`. Everything else goes in `fields`.
   */
  it("lifts the three ids out of the fields", async () => {
    log.info("app.thread", "thread.created", { thread: "t-7", turn: "u1", project: "p1" });
    await flush();
    expect(written[0][0]).toMatchObject({ thread: "t-7", turn: "u1" });
    expect(written[0][0].fields).toEqual({ project: "p1" });
  });

  /**
   * A host that is down rejects every flush. Reporting that would put the
   * report in the batch that just failed, and the next flush would carry the
   * report of the flush before it.
   */
  it("says nothing about a flush that failed", async () => {
    writeFails = true;
    log.error("app", "boom");
    await flush();
    expect(written).toHaveLength(0);
    writeFails = false;
    // And it did not wedge: the next record still goes.
    log.error("app", "again");
    await flush();
    expect(written).toHaveLength(1);
  });
});

describe("what the window throws on its own", () => {
  it("turns an unhandled error into a record with the first frames only", async () => {
    const fire = fakeWindow();
    captureWebviewErrors();
    const err = new Error("kaboom");
    err.stack = [
      "Error: kaboom",
      " at a (x.js:1)",
      " at b (y.js:2)",
      " at c (z.js:3)",
      " at d (w.js:4)",
    ].join("\n");
    fire("error", { error: err, message: "kaboom" });
    await flush();
    const record = written[0][0];
    expect(record.level).toBe("error");
    expect(record.target).toBe("webview.unhandled");
    expect(record.msg).toBe("kaboom");
    const stack = String(record.fields?.stack ?? "");
    expect(stack).toContain("x.js:1");
    expect(stack).not.toContain("w.js:4");
  });

  it("turns an unhandled rejection into a record too", async () => {
    const fire = fakeWindow();
    captureWebviewErrors();
    fire("unhandledrejection", { reason: new Error("nobody caught this") });
    await flush();
    expect(written[0][0]).toMatchObject({
      level: "error",
      target: "webview.unhandled",
      msg: "nobody caught this",
    });
  });

  /**
   * Mirrored, never replaced: replacing the console costs the devtools their
   * source location, which is the one thing a console line is good for.
   */
  it("mirrors console.error and console.warn at their own level", async () => {
    fakeWindow();
    const seen: unknown[][] = [];
    const original = console.error;
    const originalWarn = console.warn;
    console.error = (...args: unknown[]) => seen.push(args);
    captureWebviewErrors();
    console.error("something", { a: 1 });
    console.warn("careful");
    await flush();
    console.error = original;
    console.warn = originalWarn;

    expect(seen).toEqual([["something", { a: 1 }]]);
    const targets = written[0].map((r) => r.target);
    expect(targets).toEqual(["webview.console", "webview.console"]);
    expect(written[0].map((r) => r.level)).toEqual(["error", "warn"]);
    expect(written[0][0].msg).toBe('something {"a":1}');
  });
});

describe("the stack", () => {
  it("keeps three frames and nothing else", () => {
    expect(shortStack(["a", "b", "c", "d"].join("\n"))).toBe("a | b | c");
    expect(shortStack(undefined)).toBeUndefined();
  });
});
