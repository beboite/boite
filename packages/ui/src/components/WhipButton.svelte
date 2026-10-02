<script lang="ts">
  import { whip } from '../lib/whip.svelte';
  import { strings } from '../lib/strings';

  let { mobile = false, onthrown }: { mobile?: boolean; onthrown?: () => void } = $props();

  // The click only throws or drops the rope. The window shakes when it cracks.
  function toggle(event: MouseEvent) {
    if (whip.held) { whip.held = false; return; }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    whip.throw(event.clientX || window.innerWidth / 2, event.clientY || window.innerHeight / 2);
    onthrown?.();
  }
</script>

<button type="button" class="ghost icon whip" class:active={whip.held}
  data-testid={mobile ? 'whip-button-mobile' : 'whip-button'}
  title={whip.held ? strings.experiments.whip.drop : strings.experiments.whip.action}
  aria-label={whip.held ? strings.experiments.whip.drop : strings.experiments.whip.action}
  aria-pressed={whip.held} onclick={toggle}>
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="m3 20 5-5 3 3-5 5zM10 16c-3-5-1-12 4-12 6 0 8 7 3 8-3 1-5-2-2-4 3-2 7 1 6 5" />
  </svg>
</button>

<style>
  .whip { position: relative; z-index: calc(var(--z-whip) + 1); flex: none; color: var(--color-muted-foreground); }
  .whip.active { color: var(--color-foreground); background: var(--color-surface-2); }
  @media (max-width: 720px) {
    .whip { width: var(--touch-target); height: var(--touch-target); }
  }
</style>
