<script lang="ts">
  import { robotColor, type Robot } from '../../lib/robots';

  /**
   * One robot, drawn in a 64 unit square that its holder crops to a disc. The
   * colors are app.css tokens: the body wears `robotColor`, the background is
   * that color washed out, the trim that color darkened.
   *
   * Only the body is the family's. Each body gives a rig, where its eyes,
   * mouth, cheeks, crown and sides sit, and every shared part is drawn on
   * that rig: a Retro face is lit on its screen, the others are inked. `state`
   * moves the face: a blink at rest, a glance while it works, a hop while it
   * waits on the user, eyes shut and a slow breath asleep, dizzy eyes after a
   * failure. `still` draws it without motion, for pickers.
   */
  export type RobotState = 'idle' | 'working' | 'waiting' | 'asleep' | 'error' | 'still';
  let { robot, state = 'idle' }: { robot: Robot; state?: RobotState } = $props();

  interface Rig {
    /** Eye centers at 32 ± dx, eye and mouth parts scaled by s. */
    eyeY: number; dx: number; s: number;
    mouthY: number;
    /** The top of the head at x = 32, where a top grows; `brow`, where a hat's brim sits. */
    crown: number; brow: number;
    /** Half the head's width at `sideY`, where headphones sit. */
    half: number; sideY: number;
    cheekY: number; cheekDx: number;
    /** Lit on a screen rather than inked on the body. */
    lit: boolean;
  }

  /* Jelly: a blob on two small feet. Per shape: its outline, the top of its head, the crown, its half width and the shine. */
  const JELLY = [
    { d: 'M7 46 C6 29 18 15 32 15 C47 15 58 29 57 46 C56 58 45 62 32 62 C19 62 8 58 7 46Z', head: 16, crown: 15, half: 23, shine: [20, 26] },
    { d: 'M32 8 C38 16 56 28 56 46 C56 58 45 63 32 63 C19 63 8 58 8 46 C8 28 26 16 32 8Z', head: 12, crown: 9, half: 19, shine: [25, 25] },
    { d: 'M3 50 C3 36 16 25 32 25 C48 25 61 36 61 50 C61 59 49 63 32 63 C15 63 3 59 3 50Z', head: 25, crown: 25, half: 27, shine: [16, 35] },
    { d: 'M7 48 C6 34 10 17 21 17 C27 17 29 22 32 22 C35 22 37 17 43 17 C54 17 58 34 57 48 C56 59 45 63 32 63 C19 63 8 59 7 48Z', head: 16, crown: 22, half: 23, shine: [18, 27] },
    { d: 'M32 10 C43 10 50 24 51 38 C52 53 44 62 32 62 C20 62 12 53 13 38 C14 24 21 10 32 10Z', head: 12, crown: 10, half: 17, shine: [22, 22] },
    { d: 'M6 47 C5 37 10 30 17 29 C17 21 24 16 32 16 C40 16 47 21 47 29 C54 30 59 37 58 47 C57 58 46 62 32 62 C18 62 7 58 6 47Z', head: 17, crown: 16, half: 24, shine: [22, 24] },
  ];
  /* Bubble: a round body rising from the bottom of the disc. */
  const BUBBLE = [
    { d: 'M7 42 A25 25 0 1 1 57 42 A25 25 0 1 1 7 42Z', crown: 17, eyeY: 41, half: 24 },
    { d: 'M32 13 C46 24 57 34 57 47 C57 61 45 72 32 72 C19 72 7 61 7 47 C7 34 18 24 32 13Z', crown: 13, eyeY: 42, half: 23 },
    { d: 'M13 34 A19 19 0 0 1 51 34 L51 72 L13 72Z', crown: 15, eyeY: 41, half: 19 },
    { d: 'M9 35 A17 17 0 0 1 26 18 L38 18 A17 17 0 0 1 55 35 L55 74 L9 74Z', crown: 18, eyeY: 41, half: 23 },
    { d: 'M4 50 C4 30 16 21 32 21 C48 21 60 30 60 50 L60 72 L4 72Z', crown: 21, eyeY: 42, half: 27 },
    { d: 'M11 38 C11 23 20 15 32 15 C44 15 53 23 53 38 L53 57 Q48.5 53 44 57 Q39.5 61 35 57 Q32 54 29 57 Q24.5 61 20 57 Q15.5 53 11 57Z', crown: 15, eyeY: 35, half: 21 },
  ];
  /* Capsule: a light face plate on a colored ground, tilted. */
  const CAPSULE = [
    { d: 'M6 36 A26 26 0 1 1 58 36 A26 26 0 1 1 6 36Z', crown: 10, eyeY: 33, half: 26, sideY: 36 },
    { d: 'M9 37 A23 27 0 1 1 55 37 A23 27 0 1 1 9 37Z', crown: 10, eyeY: 33, half: 23, sideY: 37 },
    { d: 'M7 30 A18 18 0 0 1 25 12 L39 12 A18 18 0 0 1 57 30 L57 44 A18 18 0 0 1 39 62 L25 62 A18 18 0 0 1 7 44Z', crown: 12, eyeY: 33, half: 25, sideY: 37 },
    { d: 'M10 34 C10 14 54 12 56 32 C58 50 48 62 32 62 C16 62 10 52 10 34Z', crown: 14, eyeY: 33, half: 23, sideY: 36 },
    { d: 'M32 9 Q34 9 36 10 L53 20 Q56 22 56 25 L56 45 Q56 48 53 50 L36 60 Q32 62 28 60 L11 50 Q8 48 8 45 L8 25 Q8 22 11 20 L28 10 Q30 9 32 9Z', crown: 9, eyeY: 34, half: 24, sideY: 35 },
    { d: 'M4 38 A28 22 0 1 1 60 38 A28 22 0 1 1 4 38Z', crown: 16, eyeY: 36, half: 28, sideY: 38 },
  ];
  /* Retro: a head with a dark screen, on a neck, with ears. */
  const RETRO = [
    { x: 11, y: 16, w: 42, h: 36, r: 11 },
    { x: 10, y: 13, w: 44, h: 42, r: 21 },
    { x: 14, y: 12, w: 36, h: 42, r: 11 },
    { x: 7, y: 19, w: 50, h: 32, r: 11 },
    { x: 12, y: 14, w: 40, h: 40, r: 5 },
    { x: 5, y: 20, w: 54, h: 30, r: 15 },
  ];

  const jelly = $derived(JELLY[robot.shape % JELLY.length]!);
  const bubble = $derived(BUBBLE[robot.shape % BUBBLE.length]!);
  const capsule = $derived(CAPSULE[robot.shape % CAPSULE.length]!);
  const head = $derived(RETRO[robot.shape % RETRO.length]!);
  const screen = $derived({ x: head.x + 5, y: head.y + 6, w: head.w - 10, h: Math.min(head.h - 15, 22) });

  const rig = $derived.by((): Rig => {
    switch (robot.family) {
      case 'jelly': {
        const eyeY = jelly.head + 15;
        return { eyeY, dx: 6, s: 1, mouthY: eyeY + 9, crown: jelly.crown, brow: Math.max(jelly.head + 3, eyeY - 14), half: jelly.half, sideY: eyeY + 2, cheekY: eyeY + 9, cheekDx: Math.min(17, jelly.half - 3), lit: false };
      }
      case 'bubble':
        return { eyeY: bubble.eyeY, dx: 7.5, s: 0.9, mouthY: bubble.eyeY + 7, crown: bubble.crown, brow: Math.max(bubble.crown + 3, bubble.eyeY - 14), half: bubble.half, sideY: bubble.eyeY, cheekY: bubble.eyeY + 7, cheekDx: Math.min(15, bubble.half - 4), lit: false };
      case 'capsule':
        return { eyeY: capsule.eyeY, dx: 8, s: 1, mouthY: capsule.eyeY + 8.5, crown: capsule.crown, brow: Math.max(capsule.crown + 3, capsule.eyeY - 14), half: capsule.half, sideY: capsule.sideY, cheekY: capsule.eyeY + 9, cheekDx: Math.min(16, capsule.half - 6), lit: false };
      default: {
        // A screen with a mouth to show carries the eyes higher.
        const talks = robot.mouth !== 0;
        const s = Math.min(0.8, (screen.h / 22) * 0.8);
        return {
          eyeY: screen.y + screen.h * (talks ? 0.38 : 0.5), dx: screen.w / 4.2, s,
          mouthY: screen.y + screen.h * 0.62, crown: head.y, brow: head.y - 1, half: head.w / 2, sideY: head.y + head.h / 2,
          cheekY: screen.y + screen.h * 0.66, cheekDx: screen.w / 2 - 4.5, lit: true,
        };
      }
    }
  });

  const tilt = $derived(robot.family === 'capsule' ? 'rotate(-11 32 36) translate(3 6)' : undefined);
  /** The eyes it shows this second: shut asleep, dizzy after a failure, its own otherwise. */
  const eyes = $derived(state === 'asleep' ? 6 : state === 'error' ? 14 : robot.eyes);

  const c = $derived(rig.crown);
  /** A tall head nears the disc's edge: what grows straight up starts lower so it is not cropped. */
  const up = $derived(Math.max(c, 15));
  const tip = $derived(Math.max(c - 8, 6));
  /** Which tops sit in front of the head; the others grow from behind it. */
  const FRONT = new Set([9, 10, 11, 13, 14, 16]);
  const petals = [0, 72, 144, 216, 288].map(a => ({ x: 4.2 * Math.cos(a * Math.PI / 180), y: 4.2 * Math.sin(a * Math.PI / 180) }));
  /** The headphones' band peaks at the crown: a cubic's peak is three quarters of the way to its control points. */
  const band = $derived(rig.sideY - (rig.sideY - c + 1.5) / 0.75);
  /** The beanie's brim: above the eyes, on the head's top edge for a screen. */
  const brim = $derived(rig.brow);
  const hat = $derived(Math.min(rig.half - 2, 20));
</script>

{#snippet eye(style: number, side: -1 | 1)}
  {#if style === 0 || (style === 8 && side < 0)}
    <ellipse rx="4.2" ry="6.2" class="ink" /><ellipse cx="1.4" cy="-2.6" rx="1.5" ry="2" class="light" />
  {:else if style === 1}
    <ellipse rx="4.2" ry="6.2" class="ink" /><circle cx="1" cy="-3.8" r="1.6" class="light" /><circle cx="-1.4" cy="2.4" r="0.9" class="light" />
  {:else if style === 2}
    <circle r="3.3" class="ink" />
  {:else if style === 3}
    <rect x="-2.7" y="-5" width="5.4" height="10" rx="2.7" class="ink" />
  {:else if style === 4}
    <circle r="6" class="light ringed" /><circle cx="0.6" cy="1" r="2.7" class="ink" /><circle cx="1.7" cy="-0.2" r="0.9" class="light" />
  {:else if style === 5 || style === 8}
    <path d="M-5 1.5 q5 -7 10 0" class="ink-line" stroke-width="2.8" />
  {:else if style === 6}
    <path d="M-5 -0.5 q5 4.5 10 0" class="ink-line" stroke-width="2.4" />
  {:else if style === 7}
    <circle r={side < 0 ? 4.8 : 5.5} class="light ringed" /><circle cx="1.7" cy="-1.6" r="2.5" class="ink" />
  {:else if style === 9}
    <path d="M0 -6.4 l2.1 4.5 4.9 .6 -3.6 3.3 1 4.9 -4.4 -2.4 -4.4 2.4 1 -4.9 -3.6 -3.3 4.9 -.6Z" class="ink" />
  {:else if style === 10}
    <path d="M0 4.4 l-5.2 -5.2 a3 3 0 0 1 5.2 -3.4 a3 3 0 0 1 5.2 3.4Z" class="heart" />
  {:else if style === 12}
    <ellipse rx="4.8" ry="7" class="ink" /><circle cx="1.5" cy="-2.8" r="2.1" class="light" /><circle cx="-1.6" cy="2.8" r="1" class="light" />
  {:else if style === 13}
    <circle cy="1" r="3.2" class="ink" /><path d="M-4.5 {side < 0 ? -7.5 : -5} L4.5 {side < 0 ? -5 : -7.5}" class="ink-line" stroke-width="2.2" />
  {:else if style === 14}
    <path d="M-3.4 -3.4 l6.8 6.8 M3.4 -3.4 l-6.8 6.8" class="ink-line" stroke-width="2.4" />
  {:else if style === 15}
    <path d="M-4.5 0.5 h9" class="ink-line" stroke-width="2.6" />
  {/if}
{/snippet}

{#snippet mouth(style: number)}
  {#if style === 1}<path d="M-10 0 Q0 10 10 0" class="ink-line" stroke-width="2.4" />
  {:else if style === 2}<path d="M-4 1 q4 3 8 0" class="ink-line" stroke-width="2.2" />
  {:else if style === 3}<path d="M-11 -1 Q0 12 11 -1 Z" class="ink" /><path d="M-5 4 Q0 8 5 4 Z" class="tongue" />
  {:else if style === 4}<ellipse cy="4" rx="3.4" ry="4" class="ink" />
  {:else if style === 5}<path d="M-6 1 q3 3 6 0 q3 3 6 0" class="ink-line" stroke-width="2.2" />
  {:else if style === 6}<path d="M-5 2 Q2 6 8 0" class="ink-line" stroke-width="2.2" />
  {:else if style === 7}<path d="M-8 0 Q0 8 8 0" class="ink-line" stroke-width="2.4" /><ellipse cx="3" cy="4.6" rx="2.6" ry="2.2" class="tongue" />
  {:else if style === 8}<path d="M-4 2 h8" class="ink-line" stroke-width="2.4" />
  {:else if style === 9}<path d="M-8 0 Q0 8 8 0" class="ink-line" stroke-width="2.4" /><path d="M2 3.2 L3.6 6.6 L5.2 2.4 Z" class="light" />
  {:else if style === 10}<ellipse cx="2" cy="3" rx="3.8" ry="4.6" class="ink" /><ellipse cx="2" cy="4.6" rx="2.2" ry="2.3" class="tongue" />
  {:else if style === 11}<rect x="-7" y="-1" width="14" height="7" rx="3" class="light ringed" /><path d="M-7 2.5 h14 M-2.3 -1 v7 M2.3 -1 v7" class="ink-line thin" />
  {/if}
{/snippet}

{#snippet top(front: boolean)}
  {#if FRONT.has(robot.top) === front}
    {#if robot.top === 1}
      <line x1="32" y1={c + 2} x2="32" y2={tip + 1} class="stroke-deep" stroke-width="2.4" stroke-linecap="round" /><circle class="bulb led" cx="32" cy={tip} r="3.4" />
    {:else if robot.top === 2}
      <path d="M26 {c + 2} C24 {c - 4} 21 {tip + 1} 18 {tip} M38 {c + 2} C40 {c - 4} 43 {tip + 1} 46 {tip}" fill="none" class="stroke-deep" stroke-width="2.2" stroke-linecap="round" />
      <circle cx="18" cy={tip} r="2.7" class="halo led" /><circle cx="46" cy={tip} r="2.7" class="halo led" />
    {:else if robot.top === 3}
      <path d="M32 {c + 1} C30 {c - 6} 26 {c - 8} 23 {c - 6}" fill="none" class="stroke-deep" stroke-width="2.4" stroke-linecap="round" />
    {:else if robot.top === 4}
      <path d="M31 {up + 1} C29 {up - 7} 37 {up - 9} 37 {up - 4} C37 {up - 1} 33 {up - 1} 33 {up - 4}" fill="none" class="stroke-deep" stroke-width="2.2" stroke-linecap="round" />
    {:else if robot.top === 5}
      <path d="M32 {up + 1} L32 {up - 5}" class="stroke-leaf" stroke-width="2" />
      {#each petals as petal, i (i)}<circle cx={32 + petal.x} cy={up - 8 + petal.y} r="2.6" class="petal" />{/each}
      <circle cx="32" cy={up - 8} r="2.2" class="halo" />
    {:else if robot.top === 6}
      <path d="M32 {up + 2} L32 {up - 5}" class="stroke-leaf" stroke-width="2.2" stroke-linecap="round" />
      <path d="M32 {up - 4} C27 {up - 11} 21 {up - 8} 22 {up - 4} C25 {up - 2} 29 {up - 2} 32 {up - 4}Z" class="leaf" />
      <path d="M32 {up - 6} C36 {up - 13} 43 {up - 11} 42 {up - 7} C39 {up - 4} 35 {up - 4} 32 {up - 6}Z" class="leaf light-leaf" />
    {:else if robot.top === 7}
      <path d="M27 {c + 3} L25 {c - 4} M32 {c + 2} L32 {c - 6} M37 {c + 3} L39 {c - 4}" fill="none" class="stroke-deep" stroke-width="2.2" stroke-linecap="round" />
    {:else if robot.top === 8}
      <path d="M26 {c + 4} C26 {c - 4} 34 {c - 5} 36 {c} C38 {c - 5} 45 {c - 2} 41 {c + 5}Z" class="deep" />
    {:else if robot.top === 9}
      <path d="M32 {c + 1} L26 {c - 2.6} Q24 {c + 1} 26 {c + 4.6} Z M32 {c + 1} L38 {c - 2.6} Q40 {c + 1} 38 {c + 4.6} Z" class="bow" /><circle cx="32" cy={c + 1} r="2.2" class="bow knot" />
    {:else if robot.top === 10}
      <ellipse cx="32" cy={Math.max(c - 6, 5)} rx="13" ry="3.2" fill="none" class="stroke-halo led" stroke-width="2.6" />
    {:else if robot.top === 11}
      <path d="M{32 - rig.half - 1} {rig.sideY} C{32 - rig.half - 1} {band} {32 + rig.half + 1} {band} {32 + rig.half + 1} {rig.sideY}" fill="none" class="stroke-ink-fixed" stroke-width="3" />
      <rect x={32 - rig.half - 5.5} y={rig.sideY - 7.5} width="9" height="15" rx="4.5" class="ink-fixed" /><rect x={32 + rig.half - 3.5} y={rig.sideY - 7.5} width="9" height="15" rx="4.5" class="ink-fixed" />
      <rect x={32 - rig.half - 3} y={rig.sideY - 4.5} width="3" height="9" rx="1.5" class="deep" /><rect x={32 + rig.half} y={rig.sideY - 4.5} width="3" height="9" rx="1.5" class="deep" />
    {:else if robot.top === 12}
      <line x1="32" y1={c + 1} x2="32" y2={Math.max(c - 6, 5)} class="stroke-deep" stroke-width="2.4" />
      <ellipse cx="24.5" cy={Math.max(c - 7, 4)} rx="7.5" ry="2.2" class="deep" /><ellipse cx="39.5" cy={Math.max(c - 7, 4)} rx="7.5" ry="2.2" class="halo" /><circle cx="32" cy={Math.max(c - 7, 4)} r="2.2" class="ink-fixed" />
    {:else if robot.top === 13}
      <path d="M{32 - hat} {brim + 3} C{32 - hat} {brim - 10} {32 + hat} {brim - 10} {32 + hat} {brim + 3} Z" class="deep" />
      <rect x={32 - hat - 2} y={brim} width={hat * 2 + 4} height="6" rx="3" class="soft" /><circle cx="32" cy={brim - 9} r="4" class="soft" />
    {:else if robot.top === 14}
      {@const k = Math.max(c, 10)}
      <path d="M23 {k + 3} L23 {k - 5} L27.5 {k - 1} L32 {k - 7.5} L36.5 {k - 1} L41 {k - 5} L41 {k + 3} Z" class="halo" /><circle cx="32" cy={k - 0.5} r="1.6" class="heart" />
    {:else if robot.top === 15}
      {@const w = rig.half}
      <path d="M{32 - w * 0.78} {c + 8} L{32 - w * 0.6} {c - 7} L{32 - w * 0.12} {c + 3} Z M{32 + w * 0.78} {c + 8} L{32 + w * 0.6} {c - 7} L{32 + w * 0.12} {c + 3} Z" class={robot.family === 'capsule' ? 'face' : 'base'} />
      <path d="M{32 - w * 0.62} {c + 4} L{32 - w * 0.56} {c - 3} L{32 - w * 0.3} {c + 2} Z M{32 + w * 0.62} {c + 4} L{32 + w * 0.56} {c - 3} L{32 + w * 0.3} {c + 2} Z" class="petal" />
    {:else if robot.top === 16}
      {@const apex = Math.max(c - 14, 2)}
      <path d="M25 {c + 3} L34 {apex} L40 {c + 2} Z" class="halo" />
      <path d="M27.8 {c - 1.6} L37.6 {c - 2.6} M30.6 {c - 6.4} L35.8 {c - 7}" class="stroke-blush" stroke-width="2.2" />
      <circle cx="34" cy={apex} r="2.4" class="petal" />
    {:else if robot.top === 17}
      <rect x={32 - rig.half - 6} y={rig.sideY - 7} width="8" height="14" rx="4" class="deep" /><rect x={32 + rig.half - 2} y={rig.sideY - 7} width="8" height="14" rx="4" class="deep" />
    {/if}
  {/if}
{/snippet}

<svg viewBox="0 0 64 64" class="robot" data-family={robot.family} data-state={state} style:--rb={robotColor(robot)} aria-hidden="true">
  <rect class={robot.family === 'capsule' ? 'base' : 'soft'} width="64" height="64" />
  <g class="whole">
    <g transform={tilt}>
      {@render top(false)}
      {#if robot.family === 'jelly'}
        <ellipse cx="22" cy="62" rx="6" ry="3" class="deep" /><ellipse cx="42" cy="62" rx="6" ry="3" class="deep" />
        <path d={jelly.d} class="base" />
        <ellipse cx={jelly.shine[0]} cy={jelly.shine[1]} rx="6" ry="3.5" class="gloss" transform="rotate(-25 {jelly.shine[0]} {jelly.shine[1]})" />
      {:else if robot.family === 'bubble'}
        <path d={bubble.d} class="base" />
        <ellipse class="shine" cx="22" cy={bubble.crown + 11} rx="7" ry="4.5" transform="rotate(-30 22 {bubble.crown + 11})" />
      {:else if robot.family === 'capsule'}
        <path d={capsule.d} class="face" />
      {:else}
        <rect x="20" y={head.y + head.h - 2} width="24" height="30" rx="7" class="deep" />
        <rect x={head.x - 5} y={head.y + head.h / 2 - 6} width="7" height="12" rx="3" class="deep" />
        <rect x={head.x + head.w - 2} y={head.y + head.h / 2 - 6} width="7" height="12" rx="3" class="deep" />
        <rect x={head.x} y={head.y} width={head.w} height={head.h} rx={head.r} class="base" />
        <rect x={screen.x} y={screen.y} width={screen.w} height={screen.h} rx="6" class="screen" />
        {#if head.h - (screen.y - head.y) - screen.h > 8}<path d="M27 {screen.y + screen.h + 4.5} h10" class="stroke-deep" stroke-width="2" stroke-linecap="round" />{/if}
        <ellipse cx={head.x + 9} cy={head.y + 4} rx="5" ry="2" class="shine" />
      {/if}

      <g class="features" class:lit={rig.lit}>
        {#if robot.cheeks === 1}
          <ellipse class="blush" cx={32 - rig.cheekDx} cy={rig.cheekY} rx={3.6 * rig.s} ry={2.2 * rig.s} /><ellipse class="blush" cx={32 + rig.cheekDx} cy={rig.cheekY} rx={3.6 * rig.s} ry={2.2 * rig.s} />
        {:else if robot.cheeks === 2}
          {#each [-1, 1] as side (side)}
            <g transform="translate({32 + side * rig.cheekDx} {rig.cheekY}) scale({rig.s})"><circle cx="-2.2" cy="-0.6" r="0.9" class="freckle" /><circle cx="0" cy="0.8" r="0.9" class="freckle" /><circle cx="2.2" cy="-0.6" r="0.9" class="freckle" /></g>
          {/each}
        {:else if robot.cheeks === 3}
          {#each [-1, 1] as side (side)}
            <path transform="translate({32 + side * rig.cheekDx} {rig.cheekY - 1}) scale({rig.s * 0.55})" d="M0 4.4 l-5.2 -5.2 a3 3 0 0 1 5.2 -3.4 a3 3 0 0 1 5.2 3.4Z" class="heart" />
          {/each}
        {/if}

        <g class="eyes">
          {#if eyes === 11}
            <rect x={32 - rig.dx - 5.5 * rig.s} y={rig.eyeY - 3 * rig.s} width={2 * rig.dx + 11 * rig.s} height={6 * rig.s} rx={3 * rig.s} class="ink" />
          {:else}
            <g transform="translate({32 - rig.dx} {rig.eyeY}) scale({rig.s})">{@render eye(eyes, -1)}</g>
            <g transform="translate({32 + rig.dx} {rig.eyeY}) scale({rig.s})">{@render eye(eyes, 1)}</g>
          {/if}
        </g>
        {#if robot.mouth !== 0}<g transform="translate(32 {rig.mouthY}) scale({rig.s})">{@render mouth(robot.mouth)}</g>{/if}

        {#if robot.gear === 1}
          <g transform="translate(32 {rig.eyeY}) scale({rig.s})"><circle cx={-rig.dx / rig.s} r="7.4" class="lens" /><circle cx={rig.dx / rig.s} r="7.4" class="lens" /><path d="M{-rig.dx / rig.s + 7.4} -0.5 Q0 -3 {rig.dx / rig.s - 7.4} -0.5" class="stroke-ink-fixed" stroke-width="1.8" fill="none" /></g>
        {:else if robot.gear === 2}
          <g transform="translate(32 {rig.eyeY}) scale({rig.s})">
            <rect x={-rig.dx / rig.s - 7} y="-5" width="14" height="10" rx="4" class="shades" /><rect x={rig.dx / rig.s - 7} y="-5" width="14" height="10" rx="4" class="shades" />
            <path d="M{-rig.dx / rig.s + 7} -2 h{2 * rig.dx / rig.s - 14}" class="stroke-ink-fixed" stroke-width="2" />
            <path d="M{-rig.dx / rig.s - 4} -2.5 l3 -1.5 M{rig.dx / rig.s - 4} -2.5 l3 -1.5" class="glint" stroke-width="1.4" />
          </g>
        {:else if robot.gear === 3}
          <g transform="translate({32 + rig.dx} {rig.eyeY}) scale({rig.s})"><circle r="7.4" class="lens" /><path d="M5.6 4.8 Q9 12 6 18" class="stroke-halo" stroke-width="1.4" fill="none" /></g>
        {:else if robot.gear === 4}
          <g transform="translate({32 - rig.cheekDx} {rig.cheekY - 1.5}) rotate(-28) scale({rig.s})"><rect x="-5" y="-2" width="10" height="4" rx="2" class="bandage" /><rect x="-1.6" y="-2" width="3.2" height="4" class="bandage pad" /></g>
        {/if}
      </g>
      {@render top(true)}
    </g>
  </g>
  {#if state === 'asleep'}
    <g class="snore" aria-hidden="true">
      <path d="M41 15 h4.6 l-4.6 5 h4.6" /><path d="M47.5 8 h3.4 l-3.4 3.8 h3.4" />
    </g>
  {/if}
</svg>

<style>
  .robot { display: block; width: 100%; height: 100%; --ink: var(--robot-ink); --light: var(--robot-shine); }
  /* A Retro face is lit on its screen: the ink turns to the LED's light, the whites to the screen's dark. */
  .lit { --ink: var(--robot-led); --light: var(--robot-screen); }
  .base { fill: var(--rb); }
  .soft { fill: color-mix(in srgb, var(--rb) 30%, var(--robot-shine)); }
  .deep { fill: color-mix(in srgb, var(--rb) 72%, var(--robot-ink)); }
  .stroke-deep { stroke: color-mix(in srgb, var(--rb) 72%, var(--robot-ink)); }
  .ink { fill: var(--ink); }
  .ink-line { fill: none; stroke: var(--ink); stroke-linecap: round; stroke-linejoin: round; }
  .ink-line.thin { stroke-width: 1.1px; }
  .light { fill: var(--light); }
  .ringed { stroke: var(--ink); stroke-width: 1.1px; }
  .ink-fixed { fill: var(--robot-ink); }
  .stroke-ink-fixed { stroke: var(--robot-ink); stroke-linecap: round; }
  .stroke-leaf { stroke: color-mix(in srgb, var(--robot-leaf) 75%, var(--robot-ink)); }
  .stroke-halo { stroke: var(--robot-halo); stroke-linecap: round; }
  .stroke-blush { stroke: var(--robot-blush); stroke-linecap: round; }
  .face { fill: var(--robot-face); }
  .shine { fill: var(--robot-shine); opacity: 0.3; }
  .gloss { fill: var(--robot-shine); opacity: 0.45; }
  .blush { fill: var(--robot-blush); opacity: 0.5; }
  .freckle { fill: color-mix(in srgb, var(--rb) 45%, var(--robot-ink)); }
  .lit .freckle { fill: var(--robot-led); opacity: 0.6; }
  .leaf { fill: var(--robot-leaf); }
  .light-leaf { fill: color-mix(in srgb, var(--robot-leaf) 70%, var(--robot-shine)); }
  .lens { fill: color-mix(in srgb, var(--robot-shine) 14%, transparent); stroke: var(--robot-ink); stroke-width: 2px; }
  .shades { fill: var(--robot-ink); opacity: 0.88; }
  /* On a screen, shades light up like the eyes they cover. */
  .lit .shades { fill: var(--robot-led); opacity: 0.9; }
  .lit .glint { stroke: var(--robot-screen); }
  /* Glasses and a monocle on a screen: their rims and bridge lit too, not dark on dark. */
  .lit .lens { stroke: var(--robot-led); }
  .lit .stroke-ink-fixed { stroke: var(--robot-led); }
  .glint { stroke: var(--robot-shine); stroke-linecap: round; opacity: 0.7; }
  .bandage { fill: var(--robot-bandage); }
  .bandage.pad { fill: var(--robot-bandage-pad); }
  .bow { fill: var(--robot-blush); }
  .bow.knot { fill: color-mix(in srgb, var(--robot-blush) 80%, var(--robot-ink)); }
  .bulb { fill: var(--robot-bulb); }
  .halo { fill: var(--robot-halo); }
  .screen { fill: var(--robot-screen); }
  .heart, .petal, .tongue { fill: var(--robot-blush); }
  .snore path { fill: none; stroke: var(--robot-ink); stroke-width: 1.8px; stroke-linecap: round; stroke-linejoin: round; opacity: 0.55; }

  /* A blink at rest, a glance while working, a hop while it waits on the user, a slow breath asleep. */
  .eyes { transform-box: fill-box; transform-origin: center; }
  [data-state='idle'] .eyes { animation: robot-blink 4.6s infinite var(--loops); }
  [data-state='working'] .eyes { animation: robot-glance 2.4s ease-in-out infinite var(--loops); }
  [data-state='working'] .led { animation: pulse 1.2s ease-in-out infinite var(--loops); }
  [data-state='waiting'] .whole { animation: robot-hop 1.8s ease-in-out infinite var(--loops); }
  [data-state='asleep'] .whole { transform-origin: 32px 62px; animation: robot-breathe 4s ease-in-out infinite var(--loops); }
  [data-state='asleep'] .snore { animation: robot-snore 4s ease-in-out infinite var(--loops); }
  /* A jelly at work squishes on the spot. */
  [data-family='jelly'][data-state='working'] .whole { transform-origin: 32px 62px; animation: robot-squish 0.9s ease-in-out infinite var(--loops); }
  @keyframes robot-squish { 0%, 100% { transform: scale(1, 1); } 40% { transform: scale(1.07, 0.93); } 70% { transform: scale(0.96, 1.04); } }
  @keyframes robot-blink { 0%, 92%, 100% { transform: scaleY(1); } 95% { transform: scaleY(0.12); } }
  @keyframes robot-glance { 0%, 20% { transform: translateX(0); } 30%, 50% { transform: translateX(-2.2px); } 60%, 80% { transform: translateX(2.2px); } 90%, 100% { transform: translateX(0); } }
  @keyframes robot-hop { 0%, 70%, 100% { transform: translateY(0); } 80% { transform: translateY(-3px); } 90% { transform: translateY(0.5px); } }
  @keyframes robot-breathe { 0%, 100% { transform: scale(1, 1); } 50% { transform: scale(1.025, 0.975); } }
  @keyframes robot-snore { 0%, 100% { opacity: 0.25; transform: translateY(1px); } 50% { opacity: 1; transform: translateY(-1.5px); } }
  @media (prefers-reduced-motion: reduce) {
    .eyes, .led, .whole, .snore { animation: none !important; }
  }
  :global(html[data-motion='reduced']) .robot :is(.eyes, .led, .whole, .snore) { animation: none; }
</style>
