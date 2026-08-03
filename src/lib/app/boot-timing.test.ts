import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const logged = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("$lib/shared/services/logger.svelte", () => ({
  logger: logged,
}));

import { BootTiming, SLOW_BOOT_MS } from "./boot-timing";

/**
 * `performance.now()` under our control, because the whole point of these tests
 * is what the numbers say and a real clock cannot be asked for a slow boot.
 */
let clock = 0;
const advance = (ms: number) => {
  clock += ms;
};

beforeEach(() => {
  clock = 0;
  logged.info.mockClear();
  logged.warn.mockClear();
  vi.spyOn(performance, "now").mockImplementation(() => clock);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("boot timing", () => {
  it("names the phase that cost the time, not when it ended", () => {
    const timing = new BootTiming();
    timing.start();
    advance(10);
    timing.mark("settings+platform");
    advance(300);
    timing.mark("rows");
    advance(5);
    timing.mark("roots");

    // The marks are moments; a reader wants durations. A phase that took 300ms
    // sitting after one that took 10 reads as 310 if the cumulative number is
    // reported, which points at the wrong phase.
    expect(timing.spans()).toEqual([
      { name: "settings+platform", tookMs: 10 },
      { name: "rows", tookMs: 300 },
      { name: "roots", tookMs: 5 },
    ]);
  });

  it("writes one line for a normal boot and keeps it off the timeline", () => {
    const timing = new BootTiming();
    timing.start();
    advance(120);
    timing.mark("rows");
    timing.report();

    expect(logged.warn).not.toHaveBeenCalled();
    expect(logged.info).toHaveBeenCalledTimes(1);
    const [scope, message] = logged.info.mock.calls[0];
    expect(scope).toBe("boot");
    expect(message).toContain("boot 120ms");
    expect(message).toContain("rows 120ms");
  });

  it("puts a slow boot on the timeline, which is what warn means here", () => {
    const timing = new BootTiming();
    timing.start();
    advance(SLOW_BOOT_MS);
    timing.mark("rows");
    timing.report();

    expect(logged.info).not.toHaveBeenCalled();
    expect(logged.warn).toHaveBeenCalledTimes(1);
    // The detail carries the phases, so the line that reaches the timeline says
    // which one was slow rather than only that the boot was.
    const [, , detail] = logged.warn.mock.calls[0];
    expect(detail).toEqual({
      totalMs: SLOW_BOOT_MS,
      phases: [{ name: "rows", tookMs: SLOW_BOOT_MS }],
    });
  });

  it("reports once, so a re-entered boot does not write a second line", () => {
    const timing = new BootTiming();
    timing.start();
    timing.mark("rows");
    timing.report();
    timing.report();
    expect(logged.info).toHaveBeenCalledTimes(1);
  });

  it("a mark before the clock starts is dropped rather than measured from zero", () => {
    const timing = new BootTiming();
    advance(5_000);
    timing.mark("orphan");
    expect(timing.empty).toBe(true);

    // And nothing is written, because a report with no clock behind it would
    // claim the boot took as long as the window had been open.
    timing.report();
    expect(logged.info).not.toHaveBeenCalled();
    expect(logged.warn).not.toHaveBeenCalled();
  });

  it("a workspace switch is measured on its own", () => {
    const timing = new BootTiming();
    timing.start();
    advance(400);
    timing.mark("rows");
    timing.report();
    logged.info.mockClear();

    // The window has now been open for an hour. Without the restart the switch
    // below reports an hour and lands on the timeline as a slow boot.
    advance(3_600_000);
    timing.restart();
    timing.start();
    advance(80);
    timing.mark("rows");
    timing.report();

    expect(logged.warn).not.toHaveBeenCalled();
    expect(logged.info.mock.calls[0][1]).toContain("boot 80ms");
  });
});
