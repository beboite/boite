<script lang="ts">
  import { onMount } from "svelte";
  import { whip } from "$lib/features/whip/store.svelte";
  import { playCrack, closeCrackAudio } from "$lib/features/whip/crack";
  import { WhipRope, WHIP, segmentBezier, type Point } from "$lib/features/whip/physics";

  /**
   * The whip experiment, over the whole window.
   *
   * Nothing here talks to a terminal: no interrupt, no keystroke, no prompt.
   * OpenWhip's crack sends Ctrl-C to whatever has focus, and that half is
   * deliberately absent — an agent's turn is not a thing a cosmetic toy gets to
   * end.
   *
   * The canvas exists only while a rope does. Between cracks this component is
   * a pointer listener and nothing else, so the experiment left on costs a
   * `pointermove` handler rather than a frame loop.
   */

  let canvas = $state<HTMLCanvasElement | null>(null);
  let rope = $state.raw<WhipRope | null>(null);

  // Not $state: read sixty times a second by the loop and never by the markup,
  // so a signal would only buy a re-render nobody asked for.
  let pointerX = 0;
  let pointerY = 0;
  let frame = 0;
  let carried = 0;

  const STEP_MS = 1000 / 60;
  /** A tab that was hidden comes back with a huge delta; three steps is the cap. */
  const MAX_STEPS = 3;

  onMount(() => {
    const onMove = (e: PointerEvent) => {
      pointerX = e.clientX;
      pointerY = e.clientY;
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      if (frame) cancelAnimationFrame(frame);
      closeCrackAudio();
    };
  });

  // Where each counter stood last time it was acted on. An effect runs once on
  // mount as well as on every change, and without these the overlay would
  // throw a rope the moment the experiment is switched on.
  let seenSpawns = whip.spawns;
  let seenDrops = whip.drops;

  // The button asks; this answers. Reading the counter is what subscribes.
  $effect(() => {
    const asked = whip.spawns;
    if (asked === seenSpawns) return;
    seenSpawns = asked;
    if (rope) return;
    // Centre is the fallback for a pointer that has not moved since boot,
    // which is every launch driven by the keyboard.
    rope = new WhipRope(
      pointerX || window.innerWidth / 2,
      pointerY || window.innerHeight / 2,
      performance.now(),
    );
    whip.active = true;
    start();
  });

  $effect(() => {
    const asked = whip.drops;
    if (asked === seenDrops) return;
    seenDrops = asked;
    if (rope) rope.dropping = true;
  });

  function start() {
    if (frame) return;
    carried = 0;
    let last = performance.now();
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      const current = rope;
      if (!current) return;

      // Fixed steps: every number in WHIP is tuned per 60Hz frame, and read
      // raw on a 144Hz screen the same flick throws the rope less than half as
      // far and gravity pulls it down at a third of the speed.
      carried = Math.min(carried + (now - last), STEP_MS * MAX_STEPS);
      last = now;
      const bounds = { width: window.innerWidth, height: window.innerHeight };
      let cracked = false;
      while (carried >= STEP_MS) {
        carried -= STEP_MS;
        if (current.step(pointerX, pointerY, bounds, now)) cracked = true;
      }
      if (cracked) playCrack();

      if (current.gone(bounds)) {
        rope = null;
        whip.active = false;
        cancelAnimationFrame(frame);
        frame = 0;
        return;
      }
      draw(current, bounds);
    };
    frame = requestAnimationFrame(tick);
  }

  /** Two passes: a white halo under the dark rope, thicker over the handle. */
  function draw(current: WhipRope, bounds: { width: number; height: number }) {
    const el = canvas;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(bounds.width * dpr);
    const h = Math.round(bounds.height * dpr);
    if (el.width !== w || el.height !== h) {
      el.width = w;
      el.height = h;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, bounds.width, bounds.height);

    const pts: Point[] = current.points;
    if (pts.length < 2) return;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    ctx.strokeStyle = "#fff";
    trace(ctx, pts, pts.length - 1);
    ctx.lineWidth = WHIP.lineWidthTip + WHIP.outlineWidth * 2;
    ctx.stroke();

    const thick = Math.min(WHIP.handleThickSegments, pts.length - 1);
    if (thick > 0) {
      trace(ctx, pts, thick);
      ctx.lineWidth =
        WHIP.lineWidthHandle + WHIP.handleExtraWidth + WHIP.outlineWidth * 2;
      ctx.stroke();
    }

    ctx.strokeStyle = "#111";
    for (let i = 0; i < pts.length - 1; i++) {
      const t = i / Math.max(1, pts.length - 2);
      const extra = i < WHIP.handleThickSegments ? WHIP.handleExtraWidth : 0;
      ctx.lineWidth =
        WHIP.lineWidthHandle +
        (WHIP.lineWidthTip - WHIP.lineWidthHandle) * t +
        extra;
      const { cp1x, cp1y, cp2x, cp2y, x2, y2 } = segmentBezier(pts, i);
      ctx.beginPath();
      ctx.moveTo(pts[i].x, pts[i].y);
      ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x2, y2);
      ctx.stroke();
    }
  }

  function trace(ctx: CanvasRenderingContext2D, pts: Point[], links: number) {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 0; i < links; i++) {
      const { cp1x, cp1y, cp2x, cp2y, x2, y2 } = segmentBezier(pts, i);
      ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x2, y2);
    }
  }
</script>

<!-- Only while a rope is out, and it swallows that one click on purpose:
     letting go of the whip is what the click is for, the same as upstream. The
     app is untouched the rest of the time, since nothing is rendered at all. -->
{#if rope}
  <canvas
    bind:this={canvas}
    class="whip-canvas"
    aria-hidden="true"
    onpointerdown={() => {
      if (rope) rope.dropping = true;
    }}
  ></canvas>
{/if}

<style>
  .whip-canvas {
    position: fixed;
    inset: 0;
    z-index: var(--z-whip);
    width: 100%;
    height: 100%;
    /* The hand holding it is the pointer, so the pointer stops being drawn. */
    cursor: none;
  }
</style>
