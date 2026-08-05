import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const logged = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("$lib/shared/services/logger.svelte", () => ({
  logger: logged,
}));

import {
  SpawnTiming,
  SLOW_SPAWN_MS,
  SPAWN_STALL_MS,
  FIRST_OUTPUT_DEADLINE_MS,
} from "./spawn-timing";

/** The clock under our control: the whole point is what the numbers say, and a
 *  real one cannot be asked for a launch that took four seconds. */
let clock = 0;
const advance = (ms: number) => {
  clock += ms;
  vi.advanceTimersByTime(ms);
};

beforeEach(() => {
  clock = 0;
  logged.debug.mockClear();
  logged.info.mockClear();
  logged.warn.mockClear();
  logged.error.mockClear();
  vi.useFakeTimers();
  vi.spyOn(performance, "now").mockImplementation(() => clock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("spawn timing", () => {
  it("names the phase that cost the time, not when it ended", () => {
    const timing = new SpawnTiming("Claude #1");
    timing.start();
    advance(900);
    timing.mark("worktree");
    advance(20);
    timing.mark("resume");
    advance(60);
    timing.mark("pty");

    expect(timing.spans()).toEqual([
      { name: "worktree", tookMs: 900 },
      { name: "resume", tookMs: 20 },
      { name: "pty", tookMs: 60 },
    ]);
  });

  it("writes one line for a normal launch and keeps it off the timeline", () => {
    const timing = new SpawnTiming("Claude #1");
    timing.start();
    advance(120);
    timing.mark("pty");
    timing.report("spawned", { reattaching: false });

    expect(logged.warn).not.toHaveBeenCalled();
    expect(logged.info).toHaveBeenCalledTimes(1);
    const [scope, message] = logged.info.mock.calls[0];
    expect(scope).toBe("spawn");
    expect(message).toContain("Claude #1: spawned in 120ms");
    expect(message).toContain("pty 120ms");
  });

  it("puts a slow launch on the timeline with its phases", () => {
    const timing = new SpawnTiming("Codex #2");
    timing.start();
    advance(SLOW_SPAWN_MS);
    timing.mark("worktree");
    timing.report("spawned");

    expect(logged.info).not.toHaveBeenCalled();
    expect(logged.warn).toHaveBeenCalledTimes(1);
    const [, , detail] = logged.warn.mock.calls[0];
    expect(detail).toMatchObject({
      totalMs: SLOW_SPAWN_MS,
      phases: [{ name: "worktree", tookMs: SLOW_SPAWN_MS }],
    });
  });

  it("says a launch is stuck while it is still stuck, and says on what", () => {
    const timing = new SpawnTiming("Claude #1");
    timing.start();
    advance(10);
    timing.mark("worktree");

    advance(SPAWN_STALL_MS);

    expect(logged.warn).toHaveBeenCalledTimes(1);
    const [, message, detail] = logged.warn.mock.calls[0];
    expect(message).toContain("still opening");
    // The phase it is waiting on, not only the fact that it is waiting: the
    // difference is which file to open next.
    expect(detail).toMatchObject({ waitingOn: "what follows worktree" });
  });

  it("does not call a launch stuck once its pty came back", () => {
    const timing = new SpawnTiming("Claude #1");
    timing.start();
    advance(50);
    timing.mark("pty");
    timing.opened(() => {});

    advance(SPAWN_STALL_MS);
    expect(logged.warn).not.toHaveBeenCalled();
  });

  it("writes the line without a first byte rather than never writing it", () => {
    const timing = new SpawnTiming("bash");
    timing.start();
    advance(30);
    timing.mark("pty");
    const onDeadline = vi.fn();
    timing.opened(onDeadline);

    advance(FIRST_OUTPUT_DEADLINE_MS);
    expect(onDeadline).toHaveBeenCalledTimes(1);
  });

  it("a launch that reported drops its deadline, so the line is written once", () => {
    const timing = new SpawnTiming("bash");
    timing.start();
    timing.mark("pty");
    const onDeadline = vi.fn();
    timing.opened(onDeadline);
    timing.report("spawned");

    advance(FIRST_OUTPUT_DEADLINE_MS);
    expect(onDeadline).not.toHaveBeenCalled();
    expect(logged.info).toHaveBeenCalledTimes(1);
  });

  it("a failed launch is an error carrying the phases it got through", () => {
    const timing = new SpawnTiming("Claude #1");
    timing.start();
    advance(40);
    timing.mark("worktree");
    timing.report("failed", { error: "this directory is not there" });

    expect(logged.error).toHaveBeenCalledTimes(1);
    const [, , detail] = logged.error.mock.calls[0];
    expect(detail).toMatchObject({
      totalMs: 40,
      error: "this directory is not there",
      phases: [{ name: "worktree", tookMs: 40 }],
    });
  });

  it("an abandoned launch stays out of the log a release build keeps", () => {
    const timing = new SpawnTiming("Claude #1");
    timing.start();
    timing.report("abandoned", { because: "relaunched" });

    expect(logged.info).not.toHaveBeenCalled();
    expect(logged.warn).not.toHaveBeenCalled();
    expect(logged.error).not.toHaveBeenCalled();
    expect(logged.debug).toHaveBeenCalledTimes(1);
  });

  it("reports once, so a relaunch cannot make an older launch write again", () => {
    const timing = new SpawnTiming("Claude #1");
    timing.start();
    timing.mark("pty");
    timing.report("spawned");
    timing.report("abandoned");
    expect(logged.info).toHaveBeenCalledTimes(1);
    expect(logged.debug).not.toHaveBeenCalled();
    expect(timing.pendingReport).toBe(false);
  });

  it("a mark before the clock starts is dropped rather than measured from zero", () => {
    const timing = new SpawnTiming("Claude #1");
    advance(5_000);
    timing.mark("orphan");
    timing.report("spawned");

    expect(timing.spans()).toEqual([]);
    expect(logged.info).not.toHaveBeenCalled();
    expect(logged.warn).not.toHaveBeenCalled();
  });

  it("a disposed launch writes nothing and stops watching", () => {
    const timing = new SpawnTiming("Claude #1");
    timing.start();
    timing.dispose();

    advance(SPAWN_STALL_MS);
    timing.report("spawned");

    expect(logged.info).not.toHaveBeenCalled();
    expect(logged.warn).not.toHaveBeenCalled();
    expect(logged.debug).not.toHaveBeenCalled();
  });
});
