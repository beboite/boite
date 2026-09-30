<script lang="ts">
  import { onDestroy } from 'svelte';
  import { whip } from '../lib/whip.svelte';
  import { strings } from '../lib/strings';

  let { onerror, mobile = false }: { onerror: (error: unknown) => void; mobile?: boolean } = $props();
  let hitting = $state(false);
  let animation: Animation | undefined;
  let disposed = false;

  onDestroy(() => { disposed = true; animation?.cancel(); });

  async function hit(event: MouseEvent) {
    if (whip.held) { whip.held = false; return; }
    if (hitting || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    whip.throw(event.clientX || window.innerWidth / 2, event.clientY || window.innerHeight / 2);
    hitting = true;
    try {
      if (window.__TAURI_INTERNALS__) {
        const { invoke } = await import('@tauri-apps/api/core');
        if (disposed || await invoke<boolean>('whip_window')) return;
      }
      if (disposed) return;
      const root = document.getElementById('app');
      if (!root) return;
      const cssDuration = getComputedStyle(root).getPropertyValue('--dur-whip').trim();
      const duration = parseFloat(cssDuration) * (cssDuration.endsWith('ms') ? 1 : 1000);
      animation = root.animate([
        { transform: 'translate(0, 0) rotate(0deg)' },
        { transform: 'translate(-12px, 3px) rotate(-0.35deg)' },
        { transform: 'translate(10px, -3px) rotate(0.3deg)' },
        { transform: 'translate(-8px, 2px) rotate(-0.25deg)' },
        { transform: 'translate(6px, -2px) rotate(0.2deg)' },
        { transform: 'translate(-4px, 1px) rotate(-0.1deg)' },
        { transform: 'translate(2px, -1px) rotate(0.05deg)' },
        { transform: 'translate(0, 0) rotate(0deg)' }
      ], { duration, easing: 'ease-out' });
      await animation.finished.catch(() => undefined);
    } catch (error) {
      if (!disposed) onerror(error);
    } finally {
      animation = undefined;
      hitting = false;
    }
  }
</script>

<button type="button" class="ghost icon whip" class:active={whip.held}
  data-testid={mobile ? 'whip-button-mobile' : 'whip-button'} disabled={hitting}
  title={whip.held ? strings.experiments.whip.drop : strings.experiments.whip.action}
  aria-label={whip.held ? strings.experiments.whip.drop : strings.experiments.whip.action}
  aria-pressed={whip.held} onclick={hit}>
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="m3 20 5-5 3 3-5 5zM10 16c-3-5-1-12 4-12 6 0 8 7 3 8-3 1-5-2-2-4 3-2 7 1 6 5" />
  </svg>
</button>

<style>
  .whip { flex: none; color: var(--color-muted-foreground); }
  .whip.active { color: var(--color-foreground); background: var(--color-surface-2); }
  @media (max-width: 720px) {
    .whip { width: var(--touch-target); height: var(--touch-target); }
  }
</style>
