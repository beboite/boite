import { describe, expect, it } from "vitest";
import { shape, worthSending, type Screen } from "./screen.svelte";
import type { PageState } from "$lib/features/browser/state.svelte";

function screen(
  at: number,
  panes: Array<{ id: string; w: number; url?: string; page?: PageState; visible?: boolean }>,
): Screen {
  return {
    at,
    projectId: "p1",
    window: { width: 1280, height: 720, focused: true },
    panes: panes.map((p) => ({
      id: p.id,
      kind: p.url ? "browser" : "thread",
      title: p.id,
      threadId: p.url ? null : p.id,
      url: p.url ?? null,
      page: p.page ?? null,
      drivenBy: null,
      rect: { x: 0, y: 0, w: p.w, h: 600 },
      focused: false,
      visible: p.visible ?? true,
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

  /**
   * `browser_wait_for` is a poll of what this pushes, so a page that finished
   * loading has to count as movement. If it did not, an agent would wait out
   * its whole budget on a page that came up in a second, and the only thing
   * that would ever release it is the thirty second heartbeat.
   */
  it("says it the moment a page stops loading", () => {
    const first = screen(1000, [{ id: "b", w: 640, url: "http://localhost:1/", page: "loading" }]);
    const last = { shape: shape(first), at: first.at };
    expect(
      worthSending(last, screen(1100, [
        { id: "b", w: 640, url: "http://localhost:1/", page: "loaded" },
      ])),
    ).toBe(true);
  });

  it("says it the moment a pane is pointed somewhere else", () => {
    const first = screen(1000, [{ id: "b", w: 640, url: "http://localhost:1/", page: "loaded" }]);
    const last = { shape: shape(first), at: first.at };
    expect(
      worthSending(last, screen(1100, [
        { id: "b", w: 640, url: "http://localhost:2/", page: "loaded" },
      ])),
    ).toBe(true);
  });

  /**
   * The user moving to another thread takes an agent's pane off the screen
   * without changing anything about the pane, and the agent asking for a
   * screenshot has to be told before it acts on somebody else's pixels.
   */
  it("says it when a pane stops being the one on screen", () => {
    const first = screen(1000, [{ id: "b", w: 640, url: "http://localhost:1/", page: "loaded" }]);
    const last = { shape: shape(first), at: first.at };
    expect(
      worthSending(last, screen(1100, [
        { id: "b", w: 640, url: "http://localhost:1/", page: "loaded", visible: false },
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
