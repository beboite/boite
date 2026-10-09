<!--
  One line of text that scrolls when it is longer than its room, and stops
  at an ellipsis with reduced motion.
-->
<script lang="ts">
  let { text, strong = false }: { text: string; strong?: boolean } = $props();

  /** Space between the end of the text and its copy, in pixels. */
  const GAP = 28;
  /** Pixels a second. */
  const SPEED = 28;
  /** The left fade's room, outside the text's: still, the first letter shows whole. */
  const FADE = 6;

  let room = $state(0);
  let width = $state(0);

  const moving = $derived(room > 0 && width > room - FADE + 1);
  const shift = $derived(width + GAP);
</script>

<span class="marquee" class:strong class:moving style="--fade: {FADE}px" bind:clientWidth={room}>
  <span class="track" style="--gap: {GAP}px; --shift: {-shift}px; --time: {(shift / SPEED + 2).toFixed(1)}s">
    <span class="copy" bind:offsetWidth={width}>{text}</span>
    {#if moving}<span class="copy again" aria-hidden="true">{text}</span>{/if}
  </span>
</span>

<style>
  .marquee {
    display: block;
    min-width: 0;
    margin-left: calc(var(--fade) * -1);
    padding-left: var(--fade);
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .strong {
    font-weight: 600;
  }
  .track {
    display: inline-flex;
  }
  /* A box, so its width can be measured. */
  .copy {
    display: inline-block;
  }
  .moving .track {
    animation: roll var(--time) linear infinite;
  }
  .moving {
    /* The text fades at the edges as it goes by. */
    mask-image: linear-gradient(90deg, transparent, currentColor var(--fade), currentColor calc(100% - 10px), transparent);
  }
  .again {
    padding-left: var(--gap);
  }
  /* A pause at the start, then one turn. */
  @keyframes roll {
    0%,
    18% {
      transform: translateX(0);
    }
    100% {
      transform: translateX(var(--shift));
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .track,
    .copy {
      display: inline;
    }
    .moving .track {
      animation: none;
    }
    .moving {
      mask-image: none;
    }
    .again {
      display: none;
    }
  }
</style>
