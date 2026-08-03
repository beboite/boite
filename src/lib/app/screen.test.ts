import { describe, expect, it } from "vitest";
import { shape, worthSending, type Screen } from "./screen.svelte";

function screen(at: number, panes: Array<{ id: string; w: number }>): Screen {
  return {
    at,
    projectId: "p1",
    window: { width: 1280, height: 720, focused: true },
    panes: panes.map((p) => ({
      id: p.id,
      kind: "thread",
      title: p.id,
      threadId: p.id,
      rect: { x: 0, y: 0, w: p.w, h: 600 },
      focused: false,
    })),
    overlays: [],
  };
}

describe("what the window bothers to say again", () => {
  it("says the first thing it sees", () => {
    expect(worthSending(null, screen(1000, [{ id: "a", w: 640 }]))).toBe(true);
  });

  it("says nothing while nothing has moved", () => {
    const first = screen(1000, [{ id: "a", w: 640 }]);
    const last = { shape: shape(first), at: first.at };
    // A second later, identical.
    expect(worthSending(last, screen(2000, [{ id: "a", w: 640 }]))).toBe(false);
  });

  it("says it again on the heartbeat, so a silent window is visible as silent", () => {
    const first = screen(1000, [{ id: "a", w: 640 }]);
    const last = { shape: shape(first), at: first.at };
    expect(worthSending(last, screen(1000 + 29_999, [{ id: "a", w: 640 }]))).toBe(false);
    expect(worthSending(last, screen(1000 + 30_000, [{ id: "a", w: 640 }]))).toBe(true);
  });

  /**
   * A pane that lost its width is the bug this exists to make visible, so a
   * size change counts as movement even when the list of panes is the same.
   */
  it("says it the moment a pane changes size", () => {
    const first = screen(1000, [{ id: "a", w: 640 }]);
    const last = { shape: shape(first), at: first.at };
    expect(worthSending(last, screen(1100, [{ id: "a", w: 4 }]))).toBe(true);
  });

  it("says it when a pane appears or goes", () => {
    const first = screen(1000, [{ id: "a", w: 640 }]);
    const last = { shape: shape(first), at: first.at };
    expect(
      worthSending(last, screen(1100, [
        { id: "a", w: 320 },
        { id: "b", w: 320 },
      ])),
    ).toBe(true);
  });

  /** The clock is not part of the comparison, or nothing would ever match. */
  it("does not treat the clock as movement", () => {
    const a = screen(1000, [{ id: "a", w: 640 }]);
    const b = screen(9999, [{ id: "a", w: 640 }]);
    expect(shape(a)).toBe(shape(b));
  });
});
