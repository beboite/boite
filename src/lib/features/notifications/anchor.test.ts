import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Which standing info box the toaster must not cover.
 *
 * Every group in the window keeps its boxes mounted and hides the ones nobody
 * is looking at with `visibility`, which lays them out anyway: they have a real
 * height, they fire their ResizeObserver, and before this they took turns
 * writing a single shared number. No DOM here, only the arithmetic that
 * decides, so the element is whatever answers `getBoundingClientRect`.
 */
import { toastAnchor, toastInset, type ToastInsetParams } from "./anchor.svelte";

type Rect = { top: number; left: number; right: number; width: number; height: number };

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
    getBoundingClientRect: () => ({
      top: live.top,
      left: live.left,
      right: live.right,
      bottom: live.top + live.height,
      width: live.width,
      height: live.height,
    }),
  } as unknown as HTMLElement;
  return {
    el,
    moveTo(next: Partial<Rect>) {
      Object.assign(live, next);
      reflow();
    },
    resizeTo(height: number) {
      live.height = height;
      reflow();
    },
  };
}

const mounted: Array<{ destroy(): void; update(next: ToastInsetParams): void }> = [];

function mount(
  el: HTMLElement,
  params: Partial<ToastInsetParams> & { standing?: boolean } = {},
) {
  const handle = toastInset(el, {
    standing: params.standing ?? true,
    focused: params.focused ?? false,
  });
  mounted.push(handle);
  return handle;
}

beforeEach(() => {
  observerCallbacks.clear();
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver;
  (globalThis as { window?: unknown }).window = { innerWidth: 1000 };
  toastAnchor.set(100, 20);
});

afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.destroy();
  toastAnchor.clear();
});

describe("the toast stack and who it attaches to", () => {
  it("attaches to a standing box anywhere in the work area", () => {
    mount(box({ top: 200, left: 40, right: 360, width: 320, height: 84 }).el);
    expect(toastAnchor.inset).toBe(84);
    expect(toastAnchor.claim).toMatchObject({
      top: 200,
      left: 40,
      height: 84,
    });
  });

  it("ignores a box under a view drawn over the terminals", () => {
    mount(box({ top: 0, left: 0, right: 0, width: 0, height: 0 }).el);
    expect(toastAnchor.claim).toBeNull();
  });

  it("does not let an offscreen group's box speak for the stack", () => {
    const onscreen = box({ top: 112, left: 648, right: 968, width: 320, height: 84 });
    const offscreen = box({ top: 112, left: 648, right: 968, width: 320, height: 60 });
    mount(onscreen.el, { focused: true });
    mount(offscreen.el, { standing: false });
    expect(toastAnchor.inset).toBe(84);

    offscreen.resizeTo(40);
    expect(toastAnchor.inset).toBe(84);
  });

  it("takes no room for a box whose group nobody is looking at", () => {
    mount(box({ top: 112, left: 648, right: 968, width: 320, height: 84 }).el);
    mount(box({ top: 112, left: 648, right: 968, width: 320, height: 160 }).el, {
      standing: false,
    });
    expect(toastAnchor.inset).toBe(84);
  });

  it("prefers the focused pane when several boxes are standing", () => {
    mount(box({ top: 112, left: 40, right: 360, width: 320, height: 160 }).el);
    mount(box({ top: 112, left: 648, right: 968, width: 320, height: 84 }).el, {
      focused: true,
    });
    expect(toastAnchor.claim).toMatchObject({ left: 648, height: 84 });
  });

  it("hands the stack over when the group on screen changes", () => {
    const wasOnScreen = mount(
      box({ top: 112, left: 648, right: 968, width: 320, height: 84 }).el,
    );
    const comingUp = mount(
      box({ top: 112, left: 648, right: 968, width: 320, height: 160 }).el,
      { standing: false },
    );
    wasOnScreen.update({ standing: false });
    comingUp.update({ standing: true });
    expect(toastAnchor.inset).toBe(160);
  });

  it("keeps the claim when one of several boxes unmounts", () => {
    const staying = box({ top: 112, left: 648, right: 968, width: 320, height: 84 });
    const closing = box({ top: 112, left: 648, right: 968, width: 320, height: 60 });
    mount(staying.el);
    const closingHandle = mount(closing.el);

    closingHandle.destroy();
    expect(toastAnchor.inset).toBe(84);
  });

  it("gives the stack back once the last box is gone", () => {
    const only = mount(box({ top: 112, left: 648, right: 968, width: 320, height: 84 }).el);
    only.destroy();
    expect(toastAnchor.claim).toBeNull();
  });

  it("follows the box as its log unfolds", () => {
    const card = box({ top: 112, left: 648, right: 968, width: 320, height: 84 });
    mount(card.el);
    card.resizeTo(268);
    expect(toastAnchor.inset).toBe(268);
    card.resizeTo(84);
    expect(toastAnchor.inset).toBe(84);
  });

  it("still reports a box docked on a bottom edge, without asking the stack to follow", () => {
    mount(box({ top: 500, left: 648, right: 968, width: 320, height: 84 }).el);
    expect(toastAnchor.claim).toMatchObject({ top: 500, left: 648 });
  });

  it("follows a drag that only moved the box", () => {
    const card = box({ top: 112, left: 648, right: 968, width: 320, height: 84 });
    mount(card.el);
    card.moveTo({ top: 300, left: 40, right: 360 });
    expect(toastAnchor.claim).toMatchObject({ top: 300, left: 40 });
  });
});
