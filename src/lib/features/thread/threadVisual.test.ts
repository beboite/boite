import { describe, expect, it } from "vitest";
import { threadVisual } from "./threadVisual";

const base = { asleep: false, keepAwake: false } as const;

describe("threadVisual", () => {
  it("separates a thread that just finished from one that fell asleep", () => {
    expect(threadVisual({ ...base, status: "done" }).state).toBe("finished");
    expect(threadVisual({ ...base, status: "done", asleep: true }).state).toBe(
      "sleeping",
    );
    expect(threadVisual({ ...base, status: "stopped" }).state).toBe("sleeping");
  });

  it("gives the idle timer's sleep its own green, and only for this session", () => {
    // Put to sleep by the timer, here and now.
    expect(threadVisual({ ...base, status: "stopped", asleep: true }).tone).toBe(
      "dormant",
    );
    // Killed by hand, or back from a previous run: `asleep` lives in memory, so
    // it is false and the row cannot claim a sleep this run never watched.
    expect(threadVisual({ ...base, status: "stopped" }).tone).toBe("parked");
  });

  it("keeps the amber of a turn in flight whatever keep-awake says", () => {
    for (const status of ["running", "waiting"] as const) {
      expect(threadVisual({ ...base, status, keepAwake: true }).tone).toBe("warning");
    }
  });

  it("paints a parked thread violet when it is being kept awake", () => {
    expect(threadVisual({ ...base, status: "ready", keepAwake: true }).tone).toBe(
      "awake",
    );
    expect(threadVisual({ ...base, status: "done", keepAwake: true }).tone).toBe(
      "awake",
    );
    expect(threadVisual({ ...base, status: "ready" }).tone).toBe("success");
  });

  it("treats both ways of ending badly as one failure", () => {
    expect(threadVisual({ ...base, status: "exited" })).toEqual({
      state: "failed",
      tone: "danger",
    });
    expect(threadVisual({ ...base, status: "error" })).toEqual({
      state: "failed",
      tone: "danger",
    });
  });

  // `stopped` without the flag is a thread that was killed, or one the last run
  // of the app was cut off with. It completed nothing, so it does not earn the
  // success green, and it is not grey either: grey read as a row that had failed
  // to draw.
  it("paints a sleeping thread that never reported an ending green, not grey", () => {
    expect(threadVisual({ ...base, status: "stopped" })).toEqual({
      state: "sleeping",
      tone: "parked",
    });
  });

  // The rule the sidebar opens on. A row nothing has run behind says nothing at
  // all, which is only an answer because the table now marks a thread that was
  // launched: `idle` at boot means never started, where it used to mean "the app
  // restarted" and put a sleeping badge on every row on screen.
  it("draws a thread that has never run as nothing", () => {
    expect(threadVisual({ ...base, status: "idle" }).state).toBe("cold");
  });

  // The one sleeping row that keeps the bright colour. It is dimmed by `--lit`
  // rather than by its tone, so "it is done" survives the idle timer and "it is
  // done and it just happened" does not.
  it("keeps the green of a finished thread once the idle timer parks it", () => {
    expect(threadVisual({ ...base, status: "done", asleep: true })).toEqual({
      state: "sleeping",
      tone: "success",
    });
    expect(
      threadVisual({ status: "done", asleep: true, keepAwake: true }),
    ).toEqual({ state: "sleeping", tone: "awake" });
  });
});
