import { describe, expect, it } from "vitest";
import { stateGlyphOf, threadVisual } from "./threadVisual";

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

  it("reads a row with no process behind it as asleep, and says nothing about how it ended", () => {
    expect(threadVisual({ ...base, status: "idle" })).toEqual({
      state: "sleeping",
      tone: "neutral",
    });
  });

  it("only sleeping and waiting take the glyph over from the logo", () => {
    expect(stateGlyphOf("sleeping")).toBe("sleep");
    expect(stateGlyphOf("waiting")).toBe("ask");
    for (const state of ["working", "finished", "ready", "failed"] as const) {
      expect(stateGlyphOf(state)).toBeNull();
    }
  });
});
