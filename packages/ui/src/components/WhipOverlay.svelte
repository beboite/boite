<script lang="ts">
  import { onMount } from "svelte";
  import { whip } from '../lib/whip.svelte';
  import { playCrack, closeCrackAudio, primeCrackSound } from '../lib/whip/crack';
  import { WhipRope, WHIP, segmentBezier, type Point } from '../lib/whip/physics';

  // The frame loop exists only while a rope is visible.
  let { onerror }: { onerror: (error: unknown) => void } = $props();
  let ink = '';
  let outline = '';
  let motion: MediaQueryList;

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

  function stopForReducedMotion() {
    if (!motion.matches) return;
    rope = null;
    whip.held = false;
    cancelAnimationFrame(frame);
    frame = 0;
  }

  onMount(() => {
    motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    motion.addEventListener('change', stopForReducedMotion);
    const onMove = (e: PointerEvent) => {
      pointerX = e.clientX;
      pointerY = e.clientY;
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !rope || !whip.held) return;
      whip.held = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("keydown", onKey, true);
      if (frame) cancelAnimationFrame(frame);
      closeCrackAudio();
      whip.held = false;
      motion.removeEventListener("change", stopForReducedMotion);
    };
  });

  $effect(() => {
    if (!whip.held) {
      if (rope) rope.dropping = true;
      return;
    }
    if (rope && !rope.dropping) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      whip.held = false;
      return;
    }
    pointerX = whip.x;
    pointerY = whip.y;
    const colors = getComputedStyle(document.documentElement);
    ink = colors.getPropertyValue('--color-foreground').trim();
    outline = colors.getPropertyValue('--color-background').trim();
    primeCrackSound();
    rope = new WhipRope(pointerX, pointerY, performance.now(), { width: window.innerWidth, height: window.innerHeight });
    start();
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
        whip.held = false;
        cancelAnimationFrame(frame);
        frame = 0;
        return;
      }
      try { draw(current, bounds); }
      catch (error) {
        rope = null;
        whip.held = false;
        cancelAnimationFrame(frame);
        frame = 0;
        onerror(error);
      }
    };
    frame = requestAnimationFrame(tick);
  }

  /** Two passes: contrasting theme colors, thicker over the handle. */
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

    ctx.strokeStyle = outline;
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

    ctx.strokeStyle = ink;
    for (let i = 0; i < pts.length - 1; i++) {
      const t = i / Math.max(1, pts.length - 2);
      const extra = i < WHIP.handleThickSegments ? WHIP.handleExtraWidth : 0;
      ctx.lineWidth =
        WHIP.lineWidthHandle +
        (WHIP.lineWidthTip - WHIP.lineWidthHandle) * t +
        extra;
      const { cp1x, cp1y, cp2x, cp2y, x2, y2 } = segmentBezier(pts, i);
      ctx.beginPath();
      ctx.moveTo(pts[i]!.x, pts[i]!.y);
      ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x2, y2);
      ctx.stroke();
    }
  }

  function trace(ctx: CanvasRenderingContext2D, pts: Point[], links: number) {
    ctx.beginPath();
    ctx.moveTo(pts[0]!.x, pts[0]!.y);
    for (let i = 0; i < links; i++) {
      const { cp1x, cp1y, cp2x, cp2y, x2, y2 } = segmentBezier(pts, i);
      ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x2, y2);
    }
  }
</script>

<!-- Mouse clicks release the rope. Touch drags hold the handle until release. -->
{#if rope}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <canvas bind:this={canvas} class="whip-canvas" data-testid="whip-canvas" aria-hidden="true"
    onpointerdown={(event) => {
      if (event.pointerType === 'touch') {
        pointerX = event.clientX;
        pointerY = event.clientY;
        canvas?.setPointerCapture(event.pointerId);
      } else { whip.held = false; }
    }}
    onpointerup={(event) => { if (event.pointerType === 'touch') whip.held = false; }}
    onpointercancel={() => { whip.held = false; }}
    oncontextmenu={(event) => { event.preventDefault(); whip.held = false; }}
  ></canvas>
{/if}

<style>
  .whip-canvas {
    position: fixed;
    inset: 0;
    z-index: var(--z-whip);
    width: 100%;
    height: 100%;
    cursor: none;
    touch-action: none;
  }
</style>
