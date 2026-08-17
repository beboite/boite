import { beforeEach, describe, expect, it } from "vitest";

import { browserPanes } from "./state.svelte";

/**
 * The load state of a pane, which is the whole of what the container knows
 * about a cross-origin frame and therefore the whole of what `browser_status`
 * and `browser_wait_for` have to go on.
 *
 * What is NOT asserted here, because these tests run without the compiler's
 * client output and so without a reactive graph: that `note` takes no
 * dependency on the state it writes. It cannot, now — it reads nothing. That
 * is what the comment on it is for, and it is the bug that made every pane say
 * `loading` for ever.
 */
beforeEach(() => {
  browserPanes.forget("pane-a");
  browserPanes.forget("pane-b");
});

describe("browserPanes", () => {
  it("says nothing about a pane it has not seen", () => {
    expect(browserPanes.pageOf("pane-a")).toBe(null);
    expect(browserPanes.nonceOf("pane-a")).toBe(0);
  });

  it("keeps one answer per pane", () => {
    browserPanes.note("pane-a", "loading");
    browserPanes.note("pane-b", "loaded");
    browserPanes.note("pane-a", "stalled");

    expect(browserPanes.pageOf("pane-a")).toBe("stalled");
    expect(browserPanes.pageOf("pane-b")).toBe("loaded");
  });

  /**
   * Reloading is remounting: a frame pointed at the address it is already on
   * does not re-fetch, and `contentWindow.location.reload()` is a cross-origin
   * call the browser refuses. The count is what `{#key}` remounts on.
   */
  it("counts a reload per pane", () => {
    browserPanes.reload("pane-a");
    browserPanes.reload("pane-a");
    browserPanes.reload("pane-b");

    expect(browserPanes.nonceOf("pane-a")).toBe(2);
    expect(browserPanes.nonceOf("pane-b")).toBe(1);
  });

  /** Dropped with the frame, which is what keeps this from growing all session. */
  it("forgets a pane whole", () => {
    browserPanes.note("pane-a", "loaded");
    browserPanes.reload("pane-a");
    browserPanes.forget("pane-a");

    expect(browserPanes.pageOf("pane-a")).toBe(null);
    expect(browserPanes.nonceOf("pane-a")).toBe(0);
  });
});
