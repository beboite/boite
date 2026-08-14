/**
 * The rope simulation behind the whip experiment.
 *
 * Ported from OpenWhip's `overlay.html`
 * (https://github.com/GitFrog1111/OpenWhip, MIT), whose tuning is what makes
 * the thing read as a whip rather than as a chain: a Verlet rope with the
 * handle pinned to the pointer, per-joint bend limits that go from stiff at the
 * handle to floppy at the tip, and a crack raised when the tip breaks a speed
 * threshold.
 *
 * It is kept out of the component on purpose. The numbers are the feature, and
 * a module is what lets them be asserted (`physics.test.ts`) without a canvas,
 * a window or a frame clock.
 */

/** Every tunable, with OpenWhip's values. */
export const WHIP = {
  // Rope structure
  segments: 28,
  /** Base length of a link, px. */
  segmentLength: 25,
  /** The tip link is this fraction of the base length. */
  taper: 0.6,

  // Physics, per 60Hz step
  gravity: 1.2,
  dropGravity: 0.95,
  /** Velocity retained per step, 1 being lossless. */
  damping: 0.96,
  constraintIters: 20,
  /** Hard cap on per-link stretch, which fast whips would otherwise blow past. */
  maxStretchRatio: 1.2,

  // Handle aim: a target angle with a restoring spring, not a static lock
  baseTargetAngle: -1.12,
  handleAimByMouseX: 0.4,
  handleAimByMouseY: 0.2,
  handleAimClamp: 2.0,
  handleSpring: 0.7,
  handleAngularDamping: 0.078,
  basePoseSegments: 2,
  basePoseStiffStart: 0.9,
  basePoseStiffEnd: 0.8,

  // Elastic bend limits along the chain
  handleMaxBendDeg: 16,
  tipMaxBendDeg: 130,
  bendRigidityStart: 0.8,
  bendRigidityEnd: 0.12,

  // Screen-edge slap
  wallBounce: 0.42,
  wallFriction: 0.86,

  // Crack detection
  /** Tip speed, px per step, above which the whip cracks. */
  crackSpeed: 340,
  crackCooldownMs: 200,
  /** No crack this soon after a spawn: the opening snap is the arc unfurling. */
  firstCrackGraceMs: 350,

  // Initial arc
  arcWidth: 260,
  arcHeight: 185,

  // Drawing
  lineWidthHandle: 7,
  lineWidthTip: 5,
  outlineWidth: 3,
  handleExtraWidth: 5,
  handleThickSegments: 2,
} as const;

/** A rope point, carrying its previous position: Verlet keeps velocity there. */
export type Point = { x: number; y: number; px: number; py: number };

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function wrapPi(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/** Links taper towards the tip, so each one has its own rest length. */
export function segmentLength(i: number): number {
  const t = i / (WHIP.segments - 1);
  return WHIP.segmentLength * (1 - t * (1 - WHIP.taper));
}

export type WhipBounds = { width: number; height: number };

export class WhipRope {
  points: Point[];
  /** Once dropped the handle is free too, and the rope falls off screen. */
  dropping = false;

  // Annotated: WHIP is `as const`, so the initialiser alone would type this as
  // the literal -1.12 and refuse every angle the spring produces.
  private handleAngle: number = WHIP.baseTargetAngle;
  private handleAngVel = 0;
  private prevAimX: number;
  private prevAimY: number;
  private lastCrackAt = 0;

  constructor(
    x: number,
    y: number,
    /** Wall-clock ms at spawn. Passed in so nothing here reads a clock. */
    private spawnedAt: number,
  ) {
    this.prevAimX = x;
    this.prevAimY = y;
    this.points = [];
    for (let i = 0; i < WHIP.segments; i++) {
      const t = i / (WHIP.segments - 1);
      const px = x + t * WHIP.arcWidth;
      const py = y - Math.sin(t * Math.PI * 0.75) * WHIP.arcHeight;
      this.points.push({ x: px, y: py, px, py });
    }
  }

  get tip(): Point {
    return this.points[this.points.length - 1];
  }

  /** True once every point has fallen past the bottom edge. */
  gone(bounds: WhipBounds): boolean {
    return this.dropping && this.points.every((p) => p.y > bounds.height + 60);
  }

  /**
   * One fixed 60Hz step. Returns true on the step that cracked, which is the
   * caller's cue to make a noise.
   */
  step(pointerX: number, pointerY: number, bounds: WhipBounds, now: number): boolean {
    const g = this.dropping ? WHIP.dropGravity : WHIP.gravity;
    this.aimHandle(pointerX, pointerY);

    // Verlet integration. The handle moves with the pointer rather than with
    // the physics until it is dropped.
    const start = this.dropping ? 0 : 1;
    for (let i = start; i < this.points.length; i++) {
      const p = this.points[i];
      const vx = (p.x - p.px) * WHIP.damping;
      const vy = (p.y - p.py) * WHIP.damping;
      p.px = p.x;
      p.py = p.y;
      p.x += vx;
      p.y += vy + g;
    }

    if (!this.dropping) {
      const handle = this.points[0];
      handle.x = pointerX;
      handle.y = pointerY;
      handle.px = pointerX;
      handle.py = pointerY;
    }

    // Before the constraints, so a fast pointer sweep cannot rubber-band.
    this.capStretch();
    this.collideWalls(bounds);
    this.poseBase();

    for (let iter = 0; iter < WHIP.constraintIters; iter++) {
      this.solveDistances();
      this.limitBend();
      this.poseBase();
      this.capStretch();
      this.collideWalls(bounds);
    }

    this.prevAimX = pointerX;
    this.prevAimY = pointerY;

    const tip = this.tip;
    const tipSpeed = Math.hypot(tip.x - tip.px, tip.y - tip.py);
    if (this.dropping || tipSpeed <= WHIP.crackSpeed) return false;
    if (now - this.spawnedAt < WHIP.firstCrackGraceMs) return false;
    if (now - this.lastCrackAt <= WHIP.crackCooldownMs) return false;
    this.lastCrackAt = now;
    return true;
  }

  /**
   * Where the handle points. The pointer's own movement bends the target angle
   * and a spring pulls it back, so a flick throws the rope instead of dragging
   * a shape that never changes.
   */
  private aimHandle(pointerX: number, pointerY: number) {
    if (this.dropping) return;
    const delta = clamp(
      (pointerX - this.prevAimX) * WHIP.handleAimByMouseX +
        (pointerY - this.prevAimY) * WHIP.handleAimByMouseY,
      -WHIP.handleAimClamp,
      WHIP.handleAimClamp,
    );
    const err = wrapPi(WHIP.baseTargetAngle + delta - this.handleAngle);
    this.handleAngVel += err * WHIP.handleSpring;
    this.handleAngVel *= WHIP.handleAngularDamping;
    this.handleAngle = wrapPi(this.handleAngle + this.handleAngVel);
  }

  /** Keeps the first links pointing away from the handle at the aimed angle. */
  private poseBase() {
    if (this.dropping) return;
    const dx = Math.cos(this.handleAngle);
    const dy = Math.sin(this.handleAngle);
    const guided = Math.min(WHIP.basePoseSegments, this.points.length - 1);
    for (let i = 1; i <= guided; i++) {
      const t = (i - 1) / Math.max(guided - 1, 1);
      const stiff = lerp(WHIP.basePoseStiffStart, WHIP.basePoseStiffEnd, t);
      const prev = this.points[i - 1];
      const p = this.points[i];
      const len = segmentLength(i - 1);
      p.x = lerp(p.x, prev.x + dx * len, stiff);
      p.y = lerp(p.y, prev.y + dy * len, stiff);
    }
  }

  private solveDistances() {
    for (let i = 0; i < this.points.length - 1; i++) {
      const a = this.points[i];
      const b = this.points[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.hypot(dx, dy) || 0.0001;
      const diff = ((dist - segmentLength(i)) / dist) * 0.5;
      const ox = dx * diff;
      const oy = dy * diff;
      if (i === 0 && !this.dropping) {
        // The handle is pinned, so the whole correction goes to the next point.
        b.x -= ox * 2;
        b.y -= oy * 2;
      } else {
        a.x += ox;
        a.y += oy;
        b.x -= ox;
        b.y -= oy;
      }
    }
  }

  /**
   * The bend allowed at a joint, stiff near the handle and floppy near the tip.
   * This is what stores the crack: the tip is the only part free enough to
   * overtake the wave running down the rope.
   */
  private limitBend() {
    if (this.points.length < 3) return;
    for (let i = 1; i < this.points.length - 1; i++) {
      const a = this.points[i - 1];
      const b = this.points[i];
      const c = this.points[i + 1];

      const v1x = a.x - b.x;
      const v1y = a.y - b.y;
      const v2x = c.x - b.x;
      const v2y = c.y - b.y;
      const l1 = Math.hypot(v1x, v1y) || 0.0001;
      const l2 = Math.hypot(v2x, v2y) || 0.0001;
      const n1x = v1x / l1;
      const n1y = v1y / l1;
      const n2x = v2x / l2;
      const n2y = v2y / l2;

      const angle = Math.acos(clamp(n1x * n2x + n1y * n2y, -1, 1));
      const t = i / (this.points.length - 2);
      const maxBend = (lerp(WHIP.handleMaxBendDeg, WHIP.tipMaxBendDeg, t) * Math.PI) / 180;
      const bend = Math.PI - angle;
      if (bend <= maxBend) continue;

      // Clamped to the limit while keeping the side the joint was bent towards.
      const sign = n1x * n2y - n1y * n2x >= 0 ? 1 : -1;
      const target = Math.atan2(n1y, n1x) + sign * (Math.PI - maxBend);
      const rigidity = lerp(WHIP.bendRigidityStart, WHIP.bendRigidityEnd, t);
      c.x = lerp(c.x, b.x + Math.cos(target) * l2, rigidity);
      c.y = lerp(c.y, b.y + Math.sin(target) * l2, rigidity);
    }
  }

  private capStretch() {
    for (let i = 0; i < this.points.length - 1; i++) {
      const a = this.points[i];
      const b = this.points[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.hypot(dx, dy) || 0.0001;
      const max = segmentLength(i) * WHIP.maxStretchRatio;
      if (dist <= max) continue;
      const k = max / dist;
      b.x = a.x + dx * k;
      b.y = a.y + dy * k;
    }
  }

  /** Off while dropping, which is how the rope leaves through the bottom. */
  private collideWalls(bounds: WhipBounds) {
    if (this.dropping) return;
    for (let i = 1; i < this.points.length; i++) {
      const p = this.points[i];
      let vx = p.x - p.px;
      let vy = p.y - p.py;
      let hit = false;

      if (p.x < 0) {
        p.x = 0;
        if (vx < 0) vx = -vx * WHIP.wallBounce;
        vy *= WHIP.wallFriction;
        hit = true;
      } else if (p.x > bounds.width) {
        p.x = bounds.width;
        if (vx > 0) vx = -vx * WHIP.wallBounce;
        vy *= WHIP.wallFriction;
        hit = true;
      }

      if (p.y < 0) {
        p.y = 0;
        if (vy < 0) vy = -vy * WHIP.wallBounce;
        vx *= WHIP.wallFriction;
        hit = true;
      } else if (p.y > bounds.height) {
        p.y = bounds.height;
        if (vy > 0) vy = -vy * WHIP.wallBounce;
        vx *= WHIP.wallFriction;
        hit = true;
      }

      if (hit) {
        p.px = p.x - vx;
        p.py = p.y - vy;
      }
    }
  }
}

/**
 * Cubic Bézier control points from `i` to `i+1` matching a uniform
 * Catmull-Rom through the neighbours, with the ends extrapolated.
 *
 * The rope is 28 points; drawn as line segments it reads as a chain, and the
 * spline is what costs nothing and makes it a rope.
 */
export function segmentBezier(pts: Point[], i: number) {
  const p0 = neighbour(pts, i - 1);
  const p1 = pts[i];
  const p2 = pts[i + 1];
  const p3 = neighbour(pts, i + 2);
  return {
    cp1x: p1.x + (p2.x - p0.x) / 6,
    cp1y: p1.y + (p2.y - p0.y) / 6,
    cp2x: p2.x - (p3.x - p1.x) / 6,
    cp2y: p2.y - (p3.y - p1.y) / 6,
    x2: p2.x,
    y2: p2.y,
  };
}

function neighbour(pts: Point[], i: number): { x: number; y: number } {
  const n = pts.length;
  if (i >= 0 && i < n) return pts[i];
  if (n < 2) return { x: pts[0].x, y: pts[0].y };
  if (i < 0) return { x: 2 * pts[0].x - pts[1].x, y: 2 * pts[0].y - pts[1].y };
  const a = pts[n - 2];
  const b = pts[n - 1];
  return { x: 2 * b.x - a.x, y: 2 * b.y - a.y };
}
