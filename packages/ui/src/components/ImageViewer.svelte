<script lang="ts">
  /**
   * One picture over the whole window. A click anywhere, Escape, the close
   * button or a phone's Back closes it, and the keyboard goes back to what
   * held it. The node moves under `<body>` so no scrolling list clips it.
   */
  import { onMount } from 'svelte';
  import { X } from '@lucide/svelte';
  import { focusedElement, restoreFocus } from '../lib/focus';
  import { mobileOverlay } from '../lib/mobile-history';
  import { strings } from '../lib/strings';

  let { src, alt, onclose }: { src: string; alt: string; onclose: () => void } = $props();
  let close = $state<HTMLButtonElement | undefined>(undefined);

  function portal(node: HTMLElement) {
    document.body.append(node);
    return { destroy: () => node.remove() };
  }

  onMount(() => {
    const previous = focusedElement();
    close?.focus({ preventScroll: true });
    const leave = mobileOverlay(onclose);
    return () => { leave(); restoreFocus(previous); };
  });

  function onkeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    onclose();
  }
</script>

<svelte:window onkeydowncapture={onkeydown} />

<div class="viewer" use:portal role="dialog" aria-modal="true" aria-label={alt} data-testid="image-viewer">
  <button type="button" class="backdrop" tabindex="-1" aria-label={strings.artifacts.closeImage} onclick={onclose}></button>
  <img {src} {alt} />
  <button type="button" class="ghost icon close" bind:this={close} aria-label={strings.artifacts.closeImage} title={strings.artifacts.closeImage} onclick={onclose} data-testid="image-viewer-close"><X size={18} /></button>
</div>

<style>
  .viewer {
    position: fixed;
    inset: 0;
    z-index: 55;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: color-mix(in oklch, var(--color-scrim), var(--color-background) 35%);
    backdrop-filter: blur(6px);
    animation: appear var(--dur-2) ease-out;
  }
  .backdrop { position: absolute; inset: 0; width: 100%; height: 100%; padding: 0; border: 0; border-radius: 0; background: none; cursor: zoom-out; }
  .backdrop:hover:not(:disabled) { background: none; }
  img { position: relative; max-width: 100%; max-height: 100%; object-fit: contain; border-radius: var(--radius-md); box-shadow: var(--shadow-e2); pointer-events: none; }
  .close { position: absolute; top: 12px; right: 12px; background: var(--color-surface); box-shadow: var(--shadow-e1); }
  .close:hover:not(:disabled) { background: var(--color-surface-2); }
  @keyframes appear { from { opacity: 0; } }
  @media (max-width: 720px) { .viewer { padding: 8px; } }
</style>
