<script lang="ts">
  import { PANEL_DEFAULT, clampPanel, rightPanel } from '../lib/right-panel.svelte';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';

  /**
   * The right panel's left edge: a drag, the arrow keys or a double click set
   * its width. `dragging` is bound so the panel can mark itself while it moves.
   */
  let { store, dragging = $bindable(false) }: { store: Store; dragging?: boolean } = $props();

  function sibling(): number {
    if (window.innerWidth <= 720 || store.sidebarCollapsed) return 0;
    return store.sidebarWidth;
  }

  function onHandleDown(event: PointerEvent): void {
    event.preventDefault();
    dragging = true;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  function onHandleMove(event: PointerEvent): void {
    if (!dragging) return;
    rightPanel.width = clampPanel(window.innerWidth - event.clientX, window.innerWidth, sibling());
  }

  function onHandleUp(event: PointerEvent): void {
    if (!dragging) return;
    dragging = false;
    (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
    // The width reaches localStorage once, on the drag's end.
    rightPanel.saveWidth();
  }

  function onHandleKey(event: KeyboardEvent): void {
    const step = event.key === 'ArrowLeft' ? 16 : event.key === 'ArrowRight' ? -16 : 0;
    if (step === 0) return;
    event.preventDefault();
    rightPanel.width = clampPanel(rightPanel.width + step, window.innerWidth, sibling());
    rightPanel.saveWidth();
  }

  function reset(): void {
    rightPanel.width = clampPanel(PANEL_DEFAULT, window.innerWidth, sibling());
    rightPanel.saveWidth();
  }
</script>

<button
  type="button"
  class="handle"
  aria-label={strings.rightPanel.resize}
  title={strings.rightPanel.resize}
  data-testid="panel-resize"
  onpointerdown={onHandleDown}
  onpointermove={onHandleMove}
  onpointerup={onHandleUp}
  onpointercancel={onHandleUp}
  ondblclick={reset}
  onkeydown={onHandleKey}
></button>

<style>
  .handle {
    position: absolute;
    padding: 0;
    border: none;
    border-radius: 0;
    background: transparent;
    left: -4px;
    top: 0;
    bottom: 0;
    width: 8px;
    z-index: 10;
    cursor: col-resize;
    touch-action: none;
  }

  .handle::after {
    content: '';
    position: absolute;
    left: 3px;
    top: 0;
    bottom: 0;
    width: 1px;
    background: transparent;
    transition: background var(--dur-2) var(--ease-out-quint);
  }

  .handle:hover:not(:disabled),
  .handle:active:not(:disabled) {
    background: transparent;
    transform: none;
  }

  .handle:hover::after,
  .handle:focus-visible::after {
    background: var(--color-border);
  }

  :global(.panel.dragging) .handle::after {
    background: color-mix(in srgb, var(--color-foreground) 60%, transparent);
  }

  /* Under 981 px the panel lies over the chat and keeps the width it has. */
  @media (max-width: 980px) {
    .handle {
      display: none;
    }
  }
</style>
