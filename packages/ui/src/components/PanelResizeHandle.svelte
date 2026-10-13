<script lang="ts">
  import { innerWidth } from 'svelte/reactivity/window';
  import { PANEL_DEFAULT, PANEL_MIN, clampPanel, rightPanel } from '../lib/right-panel.svelte';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import ResizeHandle from './ResizeHandle.svelte';

  /**
   * The right panel's left edge: a drag, the arrow keys or a double click set
   * its width. `dragging` is bound so the panel can mark itself while it moves.
   */
  let { store, dragging = $bindable(false) }: { store: Store; dragging?: boolean } = $props();

  let from = 0;
  let viewport = $derived(innerWidth.current ?? window.innerWidth);

  function sibling(): number {
    if (window.innerWidth <= 720 || store.sidebarCollapsed) return 0;
    return store.sidebarWidth;
  }

  function clamp(width: number): number {
    return clampPanel(width, window.innerWidth, sibling());
  }

  function step(delta: number): void {
    // The handle is on the panel's left: moving it right narrows the panel.
    rightPanel.width = clamp(rightPanel.width - delta);
    rightPanel.saveWidth();
  }

  function reset(): void {
    rightPanel.width = clamp(PANEL_DEFAULT);
    rightPanel.saveWidth();
  }
</script>

<div class="edge">
  <ResizeHandle
    orientation="vertical"
    edge="left"
    label={strings.rightPanel.resize}
    testid="panel-resize"
    value={rightPanel.width}
    min={PANEL_MIN}
    max={clampPanel(Number.MAX_SAFE_INTEGER, viewport, store.sidebarCollapsed || viewport <= 720 ? 0 : store.sidebarWidth)}
    bind:dragging
    onstart={() => { from = rightPanel.width; }}
    onmove={(delta) => (rightPanel.width = clamp(from - delta))}
    onend={() => rightPanel.saveWidth()}
    onstep={step}
    onreset={reset}
  />
</div>

<style>
  /* The panel's 1 px frame edge moves the handle's origin in. */
  .edge { display: contents; --resize-inset: 1px; }

  /* Under 981 px the panel lies over the chat and keeps the width it has. */
  @media (max-width: 980px) {
    .edge { display: none; }
  }
</style>
