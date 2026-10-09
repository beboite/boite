<!--
  The accessory a box robot wears on its lid (`lib/robots.ts`, family `box`),
  drawn by the companion and by `RobotFace`. Local units: the origin is the
  middle of the lid's top edge, the lid 80 wide and 13 tall, y up negative.
  Everything stays within x -38..38 and below y 13: the companion turns its lid
  around the lid group's box, which the accessory must not widen. The outline
  is `--box-line` from the holder; flat fills are app.css robot colours.
-->
<svelte:options namespace="svg" />

<script lang="ts">
  let { top, x = 0, y = 0, scale = 1 }: { top: number; x?: number; y?: number; scale?: number } = $props();

  /** The flower's five petals round its heart. */
  const petals = [0, 1, 2, 3, 4].map(i => {
    const a = (-90 + 72 * i) * Math.PI / 180;
    return { x: 5 * Math.cos(a), y: -15 + 5 * Math.sin(a) };
  });
</script>

{#if top > 0}
  <g class="box-top" transform="translate({x} {y}) scale({scale})" data-top={top}>
    {#if top === 1}
      <!-- An antenna with a ball. -->
      <path class="line" d="M0 0 V-13" />
      <circle class="red" cy="-17" r="4.5" />
    {:else if top === 2}
      <!-- A top hat, a little askew. -->
      <g transform="rotate(-7)">
        <rect class="dark" x="-10" y="-21" width="20" height="19" rx="2.5" />
        <rect class="red" x="-10" y="-8" width="20" height="4.5" />
        <rect class="dark" x="-16" y="-3.5" width="32" height="4" rx="2" />
      </g>
    {:else if top === 3}
      <!-- A gift bow. -->
      <path class="pink" d="M-2 -6 L-10 3 L-5 3.5 L0 -4Z M2 -6 L10 3 L5 3.5 L0 -4Z" />
      <path class="pink" d="M0 -7 C-5 -17 -19 -17 -18 -8 C-17 -1 -6 -2 0 -7Z M0 -7 C5 -17 19 -17 18 -8 C17 -1 6 -2 0 -7Z" />
      <rect class="knot" x="-4" y="-11" width="8" height="8" rx="3" />
    {:else if top === 4}
      <!-- A cap, its visor to the side. -->
      <path class="visor" d="M10 0 Q21 -6 30 0Z" />
      <path class="blue" d="M-15 0 C-15 -19 15 -19 15 0Z" />
      <circle class="blue" cy="-14" r="2" />
    {:else if top === 5}
      <!-- A crown with a gem. -->
      <path class="gold" d="M-15 0 V-15 L-8 -8 L0 -19 L8 -8 L15 -15 V0Z" />
      <circle class="red" cy="-5.5" r="2.6" />
    {:else if top === 6}
      <!-- A flower on a stem. -->
      <path class="line" d="M0 0 C0 -4 -1 -7 0 -10" />
      <path class="leaf" d="M0 -3 C4 -9 10 -8 11 -6 C8 -2 3 -2 0 -3Z" />
      {#each petals as petal, i (i)}<circle class="pink" cx={petal.x} cy={petal.y} r="4.2" />{/each}
      <circle class="gold" cy="-15" r="3.4" />
    {:else if top === 7}
      <!-- A sprout of two leaves. -->
      <path class="line" d="M0 0 V-9" />
      <path class="leaf" d="M0 -8 C-4 -17 -15 -18 -16 -12 C-13 -7 -5 -6 0 -8Z" />
      <path class="leaf light" d="M0 -10 C3 -20 16 -22 17 -15 C14 -10 5 -8 0 -10Z" />
    {:else if top === 8}
      <!-- A propeller cap. -->
      <path class="yellow" d="M-14 0 C-14 -16 14 -16 14 0Z" />
      <path class="red" d="M-5 0 C-5 -8 -3 -11.8 0 -12 C3 -11.8 5 -8 5 0Z" />
      <path class="line" d="M0 -12 V-17" />
      <ellipse class="blue" cx="-7" cy="-18" rx="7" ry="2.5" /><ellipse class="blue" cx="7" cy="-18" rx="7" ry="2.5" />
      <circle class="red" cy="-18" r="2" />
    {:else if top === 9}
      <!-- A party hat with a pompom. -->
      <g transform="rotate(8)">
        <path class="purple" d="M-11 0 L0 -21 L11 0Z" />
        <circle class="dot" cx="-3" cy="-5" r="1.8" /><circle class="dot" cx="4" cy="-8.5" r="1.6" /><circle class="dot" cx="-1" cy="-13" r="1.4" />
        <circle class="gold" cy="-22" r="3.6" />
      </g>
    {:else if top === 10}
      <!-- A beanie with a pompom. -->
      <path class="coral" d="M-16 -4 C-16 -21 16 -21 16 -4Z" />
      <rect class="rib" x="-17" y="-6" width="34" height="6" rx="3" />
      <circle class="white" cy="-19" r="4.5" />
    {:else}
      <!-- A halo floating over the lid. -->
      <ellipse class="halo under" cy="-15" rx="16" ry="4.5" />
      <ellipse class="halo" cy="-15" rx="16" ry="4.5" />
    {/if}
  </g>
{/if}

<style>
  .box-top * { stroke: var(--box-line); stroke-width: 3; stroke-linejoin: round; stroke-linecap: round; }
  .line { fill: none; }
  .dark { fill: color-mix(in srgb, var(--robot-ink) 88%, var(--robot-shine)); }
  .red { fill: var(--robot-bulb); }
  .gold { fill: var(--robot-halo); }
  .pink { fill: var(--robot-blush); }
  .knot { fill: color-mix(in srgb, var(--robot-blush) 78%, var(--robot-ink)); }
  .blue { fill: var(--jelly-6); }
  .visor { fill: color-mix(in srgb, var(--jelly-6) 70%, var(--robot-ink)); }
  .yellow { fill: var(--jelly-1); }
  .purple { fill: var(--jelly-5); }
  .coral { fill: var(--jelly-3); }
  .rib { fill: color-mix(in srgb, var(--jelly-3) 65%, var(--robot-shine)); }
  .white { fill: var(--robot-shine); }
  .leaf { fill: var(--robot-leaf); }
  .leaf.light { fill: color-mix(in srgb, var(--robot-leaf) 70%, var(--robot-shine)); }
  .box-top .dot { fill: var(--robot-halo); stroke: none; }
  .box-top .halo { fill: none; stroke: var(--robot-halo); stroke-width: 4; }
  .box-top .halo.under { stroke: var(--box-line); stroke-width: 7; }
</style>
