import { describe, expect, it } from "vitest";
import {
  stateTokenOf,
  threadVisual,
  type ThreadVisualState,
} from "./threadVisual";

const base = { asleep: false, keepAwake: false } as const;

describe("threadVisual", () => {
  it("separates a thread that just finished from one that fell asleep", () => {
    expect(threadVisual({ ...base, status: "done" }).state).toBe("finished");
    expect(threadVisual({ ...base, status: "done", asleep: true }).state).toBe(
      "sleeping",
    );
    expect(threadVisual({ ...base, status: "stopped" }).state).toBe("sleeping");
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

  // Dormant for both, `idle` included: after a restart every row is idle, and a
  // thread that ended in a previous session left no word on how it ended.
  // `stopped` is a thread that was killed, which completed nothing. Neither
  // earns the success green, and neither is grey: grey read as a row that had
  // failed to draw, on a launch where every row is one of these two.
  it("paints a sleeping thread that never reported an ending dormant, not grey", () => {
    for (const input of [
      { ...base, status: "stopped" },
      { ...base, status: "idle" },
    ] as const) {
      expect(threadVisual(input)).toEqual({ state: "sleeping", tone: "dormant" });
    }
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

  it("gives every state a token, so hiding the logos never empties the glyph", () => {
    const states: ThreadVisualState[] = [
      "working",
      "waiting",
      "finished",
      "ready",
      "sleeping",
      "failed",
    ];
    const tokens = states.map(stateTokenOf);
    expect(tokens.every(Boolean)).toBe(true);
    // Distinct, because two states sharing a mark is the same hole in a
    // different shape: the row would show something and still not say which.
    expect(new Set(tokens).size).toBe(states.length);
  });
});
