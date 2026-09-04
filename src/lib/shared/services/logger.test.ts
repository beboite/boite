/**
 * The shim's translation, and nothing else.
 *
 * `$lib/shared/log` is mocked, so what is asserted here is the mapping alone:
 * which target a legacy scope becomes, which fields a legacy `data` argument
 * becomes, and that one call in produces exactly one record out. The batching,
 * the queue cap and the flush are `log.test.ts`'s.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const spy = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  print: vi.fn(),
}));

vi.mock("$lib/shared/log", () => ({
  log: { debug: spy.debug, info: spy.info, warn: spy.warn, error: spy.error },
  printUnmirrored: spy.print,
  shortStack: (stack: string | undefined) => stack?.split("\n")[0]?.trim(),
}));

const { logger, logFields, logTarget } = await import("./logger.svelte");

beforeEach(() => {
  for (const fn of Object.values(spy)) fn.mockReset();
});

describe("the target a scope becomes", () => {
  it("prefixes a bare scope, so `target=app.` finds every legacy line", () => {
    expect(logTarget("worktree")).toBe("app.worktree");
    expect(logTarget("agent-request")).toBe("app.agent-request");
  });

  it("leaves a scope that already reads as a path alone", () => {
    expect(logTarget("backend.call")).toBe("backend.call");
  });

  it("answers something for a scope that is nothing", () => {
    expect(logTarget("")).toBe("app");
    expect(logTarget("   ")).toBe("app");
  });
});

describe("the fields a data argument becomes", () => {
  it("has none when there was nothing to say", () => {
    expect(logFields(undefined)).toBeUndefined();
    expect(logFields(null)).toBeUndefined();
    expect(logFields("")).toBeUndefined();
    expect(logFields({})).toBeUndefined();
  });

  it("keeps a string under `details` rather than as the message", () => {
    expect(logFields("read_dir: access denied")).toEqual({ details: "read_dir: access denied" });
  });

  it("takes an Error apart, stack included", () => {
    const err = new TypeError("nope");
    err.stack = "TypeError: nope\n  at one\n  at two";
    expect(logFields(err)).toEqual({
      kind: "TypeError",
      error: "nope",
      stack: "TypeError: nope",
    });
  });

  /**
   * The whole point of the move. The old writer serialized this to one JSON
   * string, so a thread id in it was invisible to `thread=`; here it reaches
   * the top level of the record, where a filter matches it.
   */
  it("renames `threadId`, which is what the call sites spell it", () => {
    expect(logFields({ threadId: "t-7", status: "running" })).toEqual({
      thread: "t-7",
      status: "running",
    });
  });

  it("passes a thread that was already named through untouched", () => {
    expect(logFields({ thread: "t-7" })).toEqual({ thread: "t-7" });
  });

  it("drops a `threadId` that is not one rather than filing a record under it", () => {
    expect(logFields({ threadId: 12, reason: "gone" })).toEqual({ reason: "gone" });
  });

  it("drops the undefined keys an object literal picks up", () => {
    expect(logFields({ id: "a", label: undefined })).toEqual({ id: "a" });
  });

  it("says what a value it does not understand was", () => {
    expect(logFields(404)).toEqual({ details: "404" });
  });
});

describe("a call", () => {
  it("writes one record, with the target and the fields", () => {
    logger.warn("worktree", "prepare failed", { threadId: "t-7" });
    expect(spy.warn).toHaveBeenCalledTimes(1);
    expect(spy.warn).toHaveBeenCalledWith("app.worktree", "prepare failed", { thread: "t-7" });
  });

  it("goes to the level it was called at", () => {
    logger.info("app", "loaded");
    logger.error("app", "failed");
    expect(spy.info).toHaveBeenCalledWith("app.app", "loaded", undefined);
    expect(spy.error).toHaveBeenCalledWith("app.app", "failed", undefined);
  });

  /**
   * `captureWebviewErrors` mirrors `console.error` and `console.warn` into the
   * log. A plain `console.warn` here would file the same call site twice, once
   * with its target and once under `webview.console` with the sentence
   * flattened.
   */
  it("prints around the console mirror, so nothing is written twice", () => {
    logger.error("ipc", "refused", "disk full");
    expect(spy.print).toHaveBeenCalledWith("error", "[ipc]", "refused", "disk full");
    expect(spy.error).toHaveBeenCalledTimes(1);
  });

  /** Off in a release build: two callers sit on timers. */
  it("writes a debug line only in a dev build", () => {
    logger.debug("status", "tick");
    if (import.meta.env.DEV) expect(spy.debug).toHaveBeenCalledTimes(1);
    else expect(spy.debug).not.toHaveBeenCalled();
  });
});
