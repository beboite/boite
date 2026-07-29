import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DUR, EASE, easeOutQuint, easeSpring } from "./motion";

const css = readFileSync(
  fileURLToPath(new URL("../../app.css", import.meta.url)),
  "utf8",
);

function cssVar(name: string): string {
  // Custom properties are declared one per line in app.css; the value runs to
  // the semicolon so a multi-line cubic-bezier would still be captured whole.
  const m = css.match(new RegExp(`${name}:\\s*([^;]+);`));
  if (!m) throw new Error(`${name} is not declared in app.css`);
  return m[1].trim().replace(/\s+/g, " ");
}

// The whole point of DUR/EASE is that CSS and Svelte transitions agree about
// how long arriving takes. Nothing at runtime can notice them drifting apart —
// one half of the app would simply animate at a different speed from the other
// — so it is asserted here instead.
describe("motion tokens match app.css", () => {
  it("pairs every duration with its custom property", () => {
    const pairs: [string, number][] = [
      ["--dur-1", DUR.fast],
      ["--dur-2", DUR.base],
      ["--dur-3", DUR.slow],
      ["--dur-4", DUR.page],
      ["--dur-5", DUR.celebrate],
    ];
    for (const [name, ms] of pairs) {
      expect(cssVar(name), name).toBe(`${ms}ms`);
    }
  });

  it("pairs every curve with its custom property", () => {
    const pairs: [string, readonly number[]][] = [
      ["--ease-out-quint", EASE.outQuint],
      ["--ease-in-out-quad", EASE.inOutQuad],
      ["--ease-spring", EASE.spring],
    ];
    for (const [name, points] of pairs) {
      expect(cssVar(name), name).toBe(`cubic-bezier(${points.join(", ")})`);
    }
  });
});

describe("easing functions", () => {
  it("is pinned at both ends", () => {
    for (const ease of [easeOutQuint, easeSpring]) {
      expect(ease(0)).toBe(0);
      expect(ease(1)).toBe(1);
      expect(ease(-1)).toBe(0);
      expect(ease(2)).toBe(1);
    }
  });

  it("front-loads out-quint", () => {
    // The curve exists to put most of the distance in the first third; a
    // linear fallback slipping in here would be invisible on screen but would
    // make every "arrival" in the app feel mechanical.
    expect(easeOutQuint(0.33)).toBeGreaterThan(0.75);
    expect(easeOutQuint(0.5)).toBeGreaterThan(0.9);
  });

  it("lets spring overshoot before it settles", () => {
    const peak = Math.max(
      ...Array.from({ length: 99 }, (_, i) => easeSpring((i + 1) / 100)),
    );
    expect(peak).toBeGreaterThan(1);
  });

  it("stays monotonic where it is not meant to overshoot", () => {
    let prev = 0;
    for (let i = 1; i <= 100; i++) {
      const v = easeOutQuint(i / 100);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});
