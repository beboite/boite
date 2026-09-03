import { describe, expect, it } from "vitest";
import { WHIP, WhipRope, segmentLength } from "./physics";

const BOUNDS = { width: 1600, height: 900 };

/**
 * Swings the pointer the way a hand does: a few hundred px either side, a few
 * frames per pass. A square wave is not the same thing and cracks nothing —
 * a handle teleported back every frame cancels the wave before it reaches the
 * tip, which is the shape the aim spring is there to reward.
 */
function flick(rope: WhipRope, steps: number, startedAt: number): number {
  let cracks = 0;
  for (let i = 0; i < steps; i++) {
    const x = 800 + Math.sin(i / 1.5) * 200;
    const now = startedAt + i * (1000 / 60);
    if (rope.step(x, 500, BOUNDS, now)) cracks++;
  }
  return cracks;
}

describe("whip rope", () => {
  it("spawns an arc of tapered links above the handle", () => {
    const rope = new WhipRope(400, 600, 0);
    expect(rope.points).toHaveLength(WHIP.segments);
    expect(rope.points[0]).toMatchObject({ x: 400, y: 600 });
    // The arc goes up and to the right, so every other point is higher.
    expect(rope.points.slice(1).every((p) => p.y < 600)).toBe(true);
    expect(segmentLength(0)).toBeGreaterThan(segmentLength(WHIP.segments - 1));
  });

  it("never stretches a link past the cap, however hard it is thrown", () => {
    const rope = new WhipRope(800, 500, 0);
    flick(rope, 120, 0);
    for (let i = 0; i < rope.points.length - 1; i++) {
      const a = rope.points[i];
      const b = rope.points[i + 1];
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      expect(dist).toBeLessThanOrEqual(segmentLength(i) * WHIP.maxStretchRatio + 0.01);
    }
  });

  it("cracks on a flick, but not inside the opening grace", () => {
    const graceSteps = Math.ceil((WHIP.firstCrackGraceMs / 1000) * 60);
    const early = new WhipRope(800, 500, 0);
    expect(flick(early, graceSteps - 1, 0)).toBe(0);

    const thrown = new WhipRope(800, 500, 0);
    expect(flick(thrown, 240, 0)).toBeGreaterThan(0);
  });

  it("holds still enough not to crack when the pointer does not move", () => {
    const rope = new WhipRope(800, 500, 0);
    let cracks = 0;
    for (let i = 0; i < 600; i++) {
      if (rope.step(800, 500, BOUNDS, i * (1000 / 60))) cracks++;
    }
    expect(cracks).toBe(0);
  });

  it("stays inside the window until it is dropped, then leaves through the bottom", () => {
    const rope = new WhipRope(800, 500, 0);
    flick(rope, 90, 0);
    for (const p of rope.points) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(BOUNDS.width);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(BOUNDS.height);
    }

    rope.dropping = true;
    expect(rope.gone(BOUNDS)).toBe(false);
    let steps = 0;
    while (!rope.gone(BOUNDS) && steps < 3000) {
      rope.step(800, 500, BOUNDS, 2000 + steps * (1000 / 60));
      steps++;
    }
    expect(rope.gone(BOUNDS)).toBe(true);
  });

  it("makes no noise once dropped", () => {
    const rope = new WhipRope(800, 500, 0);
    flick(rope, 240, 0);
    rope.dropping = true;
    expect(flick(rope, 240, 10_000)).toBe(0);
  });

  it("is spent once the throw has run restMs", () => {
    const rope = new WhipRope(800, 500, 1000);
    expect(rope.spent(1000)).toBe(false);
    expect(rope.spent(1000 + WHIP.restMs - 1)).toBe(false);
    expect(rope.spent(1000 + WHIP.restMs)).toBe(true);
    expect(rope.spent(1000 + WHIP.restMs * 10)).toBe(true);
  });

  it("leaves the crack room to happen before it is spent", () => {
    expect(WHIP.firstCrackGraceMs).toBeLessThan(WHIP.restMs);
  });

  it("is spent on its own clock, whatever the pointer did", () => {
    const rope = new WhipRope(800, 500, 0);
    flick(rope, 240, 0);
    expect(rope.spent(WHIP.restMs)).toBe(true);
  });
});
