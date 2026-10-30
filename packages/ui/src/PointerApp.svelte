<script lang="ts">
  import { onMount } from 'svelte';
  import { startTheme } from './lib/theme';
  import { pointerRing, type PointerLayout } from './lib/pointer-layout';

  /**
   * The box `boite window point` shows the user, in a transparent,
   * click-through window of its own above every other (`pointer_window.rs`).
   * The shell says where the control is in this page's pixels; the page draws
   * a ring around it in the user's accent and a label tab on the ring's
   * corner. One entrance, then one echo that keeps widening and fading: the
   * only motion, and none with reduced motion. Nothing here is clickable.
   */
  let layout = $state<PointerLayout | null>(null);
  /** Counts each box, so a new one plays the entrance and a move does not. */
  let shown = $state(0);
  let size = $state({ width: window.innerWidth, height: window.innerHeight });
  const ring = $derived(layout ? pointerRing(layout, size) : null);

  function place(next: PointerLayout): void {
    if (layout === null) shown += 1;
    layout = next;
  }

  onMount(() => {
    const stopTheme = startTheme();
    const resize = () => { size = { width: window.innerWidth, height: window.innerHeight }; };
    window.addEventListener('resize', resize);
    const stops: (() => void)[] = [];
    let disposed = false;
    void (async () => {
      const [{ invoke }, { listen }] = await Promise.all([import('@tauri-apps/api/core'), import('@tauri-apps/api/event')]);
      const moved = await listen<PointerLayout>('pointer://layout', (event) => place(event.payload));
      const hidden = await listen('pointer://hide', () => { layout = null; });
      if (disposed) { moved(); hidden(); return; }
      stops.push(moved, hidden);
      // A box placed before this page ran is read once here.
      const current = await invoke<PointerLayout | null>('pointer_layout');
      if (current && layout === null) place(current);
    })();
    return () => { disposed = true; stopTheme(); window.removeEventListener('resize', resize); for (const stop of stops) stop(); };
  });
</script>

{#if layout && ring}
  {#key shown}
    <div class="pointer" data-testid="pointer" data-below={layout.below}>
      <div class="ring" style:left="{ring.left}px" style:top="{ring.top}px" style:width="{ring.width}px" style:height="{ring.height}px">
        <span class="echo"></span>
      </div>
      {#if layout.label}
        <div class="tag" data-testid="pointer-label" style:left="{ring.left}px" style:top={layout.below ? `${ring.top + ring.height}px` : 'auto'}
          style:bottom={layout.below ? 'auto' : `${size.height - ring.top}px`} style:max-width="{size.width - ring.left - 4}px">{layout.label}</div>
      {/if}
    </div>
  {/key}
{/if}

<style>
  :global(html[data-view='pointer']), :global(html[data-view='pointer'] body) {
    background: transparent;
    overflow: hidden;
  }

  .pointer {
    position: fixed;
    inset: 0;
    pointer-events: none;
    user-select: none;
    font-family: var(--font-sans);
  }

  /* The ring: the accent between two hairlines, dark outside and light inside,
     so it reads on a white settings page and on a dark editor alike. */
  .ring {
    position: absolute;
    box-sizing: border-box;
    border: 2.5px solid var(--color-accent);
    border-radius: var(--radius-md);
    box-shadow: 0 0 0 1px var(--pointer-halo), inset 0 0 0 1px var(--pointer-inner), 0 0 18px 2px var(--color-accent-soft);
    transition: left var(--dur-2) var(--ease-out-quint), top var(--dur-2) var(--ease-out-quint),
      width var(--dur-2) var(--ease-out-quint), height var(--dur-2) var(--ease-out-quint);
    animation: settle var(--dur-3) var(--ease-out-quint) both;
  }

  .echo {
    position: absolute;
    inset: -2.5px;
    border: 2px solid var(--color-accent);
    border-radius: var(--radius-md);
    opacity: 0;
    animation: echo var(--dur-flash) var(--ease-out-quint) var(--dur-3) infinite;
  }

  /* The tab sits on the ring's corner and shares its edge, so it reads as the ring's own label. */
  .tag {
    position: absolute;
    box-sizing: border-box;
    padding: 5px 10px 6px;
    font-size: var(--text-sm);
    font-weight: 600;
    line-height: 1.25;
    letter-spacing: -0.005em;
    color: var(--color-accent-ink);
    background: var(--color-accent);
    border-radius: var(--radius-md) var(--radius-md) var(--radius-md) 2px;
    box-shadow: 0 0 0 1px var(--pointer-halo), var(--shadow-e2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    transition: left var(--dur-2) var(--ease-out-quint), top var(--dur-2) var(--ease-out-quint), bottom var(--dur-2) var(--ease-out-quint);
    animation: lift var(--dur-3) var(--ease-out-quint) var(--dur-1) both;
  }

  [data-below='true'] .tag {
    border-radius: 2px var(--radius-md) var(--radius-md) var(--radius-md);
    animation-name: drop;
  }

  @keyframes settle {
    from { opacity: 0; transform: scale(1.14); }
    to { opacity: 1; transform: scale(1); }
  }

  @keyframes echo {
    0% { opacity: 0.7; transform: scale(1); }
    70%, 100% { opacity: 0; transform: scale(1.18); }
  }

  @keyframes lift {
    from { opacity: 0; transform: translateY(4px); }
    to { opacity: 1; transform: none; }
  }

  @keyframes drop {
    from { opacity: 0; transform: translateY(-4px); }
    to { opacity: 1; transform: none; }
  }

  @media (prefers-reduced-motion: reduce) {
    .ring, .tag { animation: none; transition: none; }
    .echo { display: none; }
  }

  :global(html[data-motion='reduced']) .ring, :global(html[data-motion='reduced']) .tag { animation: none; transition: none; }
  :global(html[data-motion='reduced']) .echo { display: none; }
</style>
