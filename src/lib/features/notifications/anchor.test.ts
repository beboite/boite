import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Who gets to push the toast stack down, now that the info box is one mount
 * per terminal rather than one per window.
 *
 * Every group in the window keeps its boxes mounted and hides the ones nobody
 * is looking at with `visibility`, which lays them out anyway: they have a real
 * height, they fire their ResizeObserver, and before this they took turns
 * writing a single shared number. No DOM here, only the arithmetic that
 * decides, so the element is whatever answers `getBoundingClientRect`.
 */
import { toastAnchor, toastInset } from "./anchor.svelte";

type Rect = { top: number; right: number; width: number; height: number };

// The measured `<main>`: 1000px window, work area ending 20px short of its
// right edge and starting 100px down. A box in that corner therefore sits at
// top 112 / right 968, one 0.75rem gutter inside it, exactly where the first
// toast card would have gone.
const ANCHOR_TOP = 100;
const ANCHOR_RIGHT = 20;
const CORNER_TOP = 112;
const CORNER_RIGHT = 968;

const observerCallbacks = new Set<() => void>();

class FakeResizeObserver {
  constructor(private readonly cb: () => void) {}
  observe() {
    observerCallbacks.add(this.cb);
  }
  disconnect() {
    observerCallbacks.delete(this.cb);
  }
}

/** What the browser does after a reflow, for the boxes still observing. */
function reflow() {
  for (const cb of observerCallbacks) cb();
}

/** A box whose rectangle the test can move and resize under it. */
function box(rect: Rect) {
  const live = { ...rect };
  const el = {
    getBoundingClientRect: () => ({ ...live }),
  } as unknown as HTMLElement;
  return {
    el,
    resizeTo(height: number) {
      live.height = height;
      reflow();
    },
  };
}

function cornerBox(height: number) {
  return box({ top: CORNER_TOP, right: CORNER_RIGHT, width: 320, height });
}

const mounted: Array<{ destroy(): void }> = [];

function mount(el: HTMLElement, standing = true) {
  const handle = toastInset(el, standing);
  mounted.push(handle);
  return handle;
}

beforeEach(() => {
  observerCallbacks.clear();
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver;
  (globalThis as { window?: unknown }).window = { innerWidth: 1000 };
  toastAnchor.set(ANCHOR_TOP, ANCHOR_RIGHT);
});

afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.destroy();
  toastAnchor.clear();
});

describe("the toast corner and who is standing in it", () => {
  it("drops the stack below a box that is in the corner", () => {
    mount(cornerBox(84).el);
    expect(toastAnchor.inset).toBe(84);
  });

  it("ignores a box belonging to another pane of a split", () => {
    // Same top, half a viewport to the left: the toasts land nowhere near it.
    mount(box({ top: CORNER_TOP, right: 500, width: 320, height: 84 }).el);
    expect(toastAnchor.inset).toBe(0);

    // And the pane under a horizontal split, which is in the right column but
    // far below where the stack starts.
    mount(box({ top: 520, right: CORNER_RIGHT, width: 320, height: 84 }).el);
    expect(toastAnchor.inset).toBe(0);
  });

  it("ignores a box under a view drawn over the terminals", () => {
    // `display: none` measures zero everywhere, so nothing is in the corner.
    mount(box({ top: 0, right: 0, width: 0, height: 0 }).el);
    expect(toastAnchor.inset).toBe(0);
  });

  it("does not let an offscreen group's box speak for the corner", () => {
    const onscreen = cornerBox(84);
    const offscreen = cornerBox(60);
    mount(onscreen.el);
    mount(offscreen.el);
    expect(toastAnchor.inset).toBe(84);

    // The offscreen box resizing was what used to overwrite the whole thing.
    offscreen.resizeTo(40);
    expect(toastAnchor.inset).toBe(84);
  });

  it("takes no room for a box whose group nobody is looking at", () => {
    // Hidden with `visibility`, so it is laid out in the same corner and
    // measures a real height. The taller of the two used to set the inset,
    // which is a stack sitting a row below the box it is meant to touch.
    mount(cornerBox(84).el);
    mount(cornerBox(160).el, false);
    expect(toastAnchor.inset).toBe(84);
  });

  it("hands the corner over when the group on screen changes", () => {
    const wasOnScreen = mount(cornerBox(84).el);
    const comingUp = mount(cornerBox(160).el, false);
    wasOnScreen.update(false);
    comingUp.update(true);
    expect(toastAnchor.inset).toBe(160);
  });

  it("keeps the inset when one of several boxes unmounts", () => {
    const staying = cornerBox(84);
    const closing = cornerBox(60);
    mount(staying.el);
    const closingHandle = mount(closing.el);

    // Closing a pane, or narrowing it past the width the box needs. The box
    // left standing never resized, so nothing would have restored an inset
    // zeroed here and the stack would have sat on it for good.
    closingHandle.destroy();
    expect(toastAnchor.inset).toBe(84);
  });

  it("gives the corner back once the last box is gone", () => {
    const only = mount(cornerBox(84).el);
    only.destroy();
    expect(toastAnchor.inset).toBe(0);
  });

  it("follows the box as its log unfolds", () => {
    // The whole card is measured, not the folded rows: the log expands into
    // the room the stack was pushed into and draws under it.
    const card = cornerBox(84);
    mount(card.el);
    card.resizeTo(268);
    expect(toastAnchor.inset).toBe(268);
    card.resizeTo(84);
    expect(toastAnchor.inset).toBe(84);
  });

  it("re-asks every box when the work area itself moves", () => {
    const wasInTheCorner = cornerBox(84);
    // Where the corner lands once a panel is docked beside the terminals.
    const takesOver = box({ top: CORNER_TOP, right: 668, width: 320, height: 120 });
    mount(wasInTheCorner.el);
    mount(takesOver.el);
    expect(toastAnchor.inset).toBe(84);

    // Nothing resized, so no ResizeObserver fires: the anchor moving is the
    // only thing that can tell these two the answer has changed hands.
    toastAnchor.set(ANCHOR_TOP, 320);
    expect(toastAnchor.inset).toBe(120);
  });
});
