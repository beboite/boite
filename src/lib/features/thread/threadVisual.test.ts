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

  // Grey for all three, `idle` included: after a restart every row is idle, and
  // a thread that ended in a previous session left no word on how it ended.
  it("says nothing about how a sleeping thread got there", () => {
    for (const input of [
      { ...base, status: "stopped" },
      { ...base, status: "done", asleep: true },
      { ...base, status: "idle" },
    ] as const) {
      expect(threadVisual(input)).toEqual({ state: "sleeping", tone: "neutral" });
    }
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
