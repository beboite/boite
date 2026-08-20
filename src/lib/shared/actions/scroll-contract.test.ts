import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The two scroll actions write into CSS rather than into style the way an
 * ordinary action would: `edgeFade` sets `--fade-start` and `--fade-end`, and
 * the `edge-fade` utility in `app.css` is the only thing that reads them. The
 * tooltip is the same shape, its node built here and its whole appearance
 * declared there.
 *
 * Nothing at runtime notices either pairing coming apart. A renamed utility or
 * a renamed custom property leaves the action running, the listeners attached
 * and the numbers written, with no mask and no box on screen and no error
 * anywhere, which is exactly the kind of silence `motion.test.ts` was written
 * for. Asserted here for the same reason.
 *
 * The test run has no DOM, so this reads the stylesheet as text: what is being
 * checked is that two files still name the same things, not that a browser
 * paints them.
 */

const css = readFileSync(
  fileURLToPath(new URL("../../../app.css", import.meta.url)),
  "utf8",
);
const edgeFade = readFileSync(
  fileURLToPath(new URL("./edgeFade.ts", import.meta.url)),
  "utf8",
);
const tooltip = readFileSync(
  fileURLToPath(new URL("./tooltip.ts", import.meta.url)),
  "utf8",
);

describe("edge-fade", () => {
  it("declares the utility the action's call sites wear", () => {
    expect(css).toContain("@utility edge-fade");
  });

  it("reads both custom properties the action writes", () => {
    for (const prop of ["--fade-start", "--fade-end"]) {
      expect(edgeFade).toContain(prop);
      // Declared with a fallback of 0 and read by the mask, so a strip wearing
      // the class with no action attached is a strip with no mask rather than
      // one masked to nothing.
      expect(css).toContain(`${prop}: 0;`);
      expect(css).toContain(`var(${prop})`);
    }
  });
});

describe("scroll-pane", () => {
  it("declares the utility, with both properties it exists for", () => {
    const block = css.match(/@utility scroll-pane \{([^}]*)\}/);
    expect(block, "@utility scroll-pane is not declared in app.css").toBeTruthy();
    expect(block?.[1]).toContain("overscroll-behavior: contain");
    expect(block?.[1]).toContain("scrollbar-gutter: stable");
  });
});

describe("tooltip", () => {
  it("declares the class and the id the action builds its node with", () => {
    expect(tooltip).toContain('el.className = "boite-tip"');
    expect(css).toContain(".boite-tip");
    // The action reveals the box by setting this and hides it by removing it,
    // so the rule that makes it visible has to key off the same attribute.
    expect(tooltip).toContain("el.dataset.open");
    expect(css).toContain(".boite-tip[data-open]");
  });

  it("hangs the box under the popover layer", () => {
    const block = css.match(/\.boite-tip \{([^}]*)\}/);
    expect(block?.[1]).toContain("z-index: var(--z-popover)");
    // A box explaining a control must not become the thing the pointer is on.
    expect(block?.[1]).toContain("pointer-events: none");
  });
});

describe("the resting scrollbar", () => {
  /**
   * The thumb is transparent until the pointer or the keyboard is inside the
   * scrolling element. Dropping either selector leaves a pane whose bar can
   * never appear, and a scrollbar that is invisible in every state looks
   * exactly like one that was styled on purpose.
   */
  it("has both ways of bringing the thumb back", () => {
    expect(css).toContain("*:hover::-webkit-scrollbar-thumb");
    expect(css).toContain("*:focus-within::-webkit-scrollbar-thumb");
  });
});
