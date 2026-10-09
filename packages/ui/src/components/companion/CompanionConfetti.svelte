<!--
  A short burst of confetti around the character, when another thread's
  tests pass. Each change of `burst` throws a new one. Nothing with reduced
  motion: the character's joyful pose says it alone.
-->
<script lang="ts">
  let { burst }: { burst: number } = $props();

  const COUNT = 26;
  const COLORS = ['var(--color-accent)', 'var(--color-success)', 'var(--color-live)', 'var(--color-danger)', 'var(--color-steward)'];

  interface Bit {
    x: number;
    y: number;
    turn: number;
    delay: number;
    color: string;
    round: boolean;
  }

  // Thrown up and out in a fan, then falling: the end point of each bit.
  function throwBits(): Bit[] {
    return Array.from({ length: COUNT }, (_, index) => {
      const angle = -Math.PI / 2 + (index / (COUNT - 1) - 0.5) * Math.PI * 1.3 + (Math.random() - 0.5) * 0.25;
      const reach = 46 + Math.random() * 40;
      return {
        x: Math.cos(angle) * reach,
        y: Math.sin(angle) * reach * 0.8 + 30 + Math.random() * 20,
        turn: (Math.random() - 0.5) * 900,
        delay: Math.random() * 120,
        color: COLORS[index % COLORS.length]!,
        round: index % 3 === 0
      };
    });
  }

  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const bits = $derived(burst > 0 && !reduced ? throwBits() : []);
</script>

{#if bits.length > 0}
  {#key burst}
    <span class="confetti" aria-hidden="true" data-testid="companion-confetti">
      {#each bits as bit, index (index)}
        <i class:round={bit.round} style="--x: {bit.x.toFixed(1)}px; --y: {bit.y.toFixed(1)}px; --turn: {bit.turn.toFixed(0)}deg; --delay: {bit.delay.toFixed(0)}ms; background: {bit.color}"></i>
      {/each}
    </span>
  {/key}
{/if}

<style>
  .confetti {
    position: absolute;
    left: 50%;
    top: 40%;
    width: 0;
    height: 0;
    pointer-events: none;
  }
  i {
    position: absolute;
    left: -2.5px;
    top: -4px;
    width: 5px;
    height: 8px;
    border-radius: 1px;
    opacity: 0;
    animation: fly 1.5s cubic-bezier(0.2, 0.7, 0.4, 1) var(--delay) forwards;
  }
  i.round {
    width: 5px;
    height: 5px;
    border-radius: var(--radius-full);
  }
  /* Out fast, then a slower fall as it fades. */
  @keyframes fly {
    0% {
      opacity: 1;
      transform: translate(0, 0) rotate(0) scale(0.6);
    }
    45% {
      opacity: 1;
      transform: translate(calc(var(--x) * 0.85), calc(var(--y) * 0.35 - 30px)) rotate(calc(var(--turn) * 0.5)) scale(1);
    }
    100% {
      opacity: 0;
      transform: translate(var(--x), var(--y)) rotate(var(--turn)) scale(0.9);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .confetti {
      display: none;
    }
  }
</style>
