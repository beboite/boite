<script lang="ts">
  /**
   * One picture over the whole window. A click on the backdrop, Escape, the close
   * button or a phone's Back closes it, and the keyboard goes back to what
   * held it. The node moves under `<body>` so no scrolling list clips it.
   */
  import { onMount } from 'svelte';
  import { Download, Maximize2, Minus, Plus, X } from '@lucide/svelte';
  import { focusedElement, restoreFocus } from '../lib/focus';
  import { mobileOverlay } from '../lib/mobile-history';
  import { strings } from '../lib/strings';

  let { src, alt, onclose, ondownload }: { src: string; alt: string; onclose: () => void; ondownload?: () => void } = $props();
  let close = $state<HTMLButtonElement | undefined>(undefined);
  let dialog: HTMLDivElement;
  let stage: HTMLDivElement;
  let zoom = $state(1);
  let natural = $state({ width: 0, height: 0 });
  let viewport = $state({ width: 0, height: 0 });
  const fit = $derived(natural.width ? Math.min(1, (viewport.width - 32) / natural.width, (viewport.height - 32) / natural.height) : 1);
  const width = $derived(natural.width ? Math.max(1, natural.width * fit * zoom) : undefined);
  function loaded(event: Event): void {
    const image = event.currentTarget as HTMLImageElement;
    natural = { width: image.naturalWidth, height: image.naturalHeight };
  }

  function portal(node: HTMLElement) {
    document.body.append(node);
    return { destroy: () => node.remove() };
  }

  onMount(() => {
    const previous = focusedElement();
    close?.focus({ preventScroll: true });
    const leave = mobileOverlay(onclose);
    const measure = () => viewport = { width: stage.clientWidth, height: stage.clientHeight };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(stage);
    return () => { observer.disconnect(); leave(); restoreFocus(previous); };
  });

  function onkeydown(event: KeyboardEvent): void {
    if (event.key === 'Tab') {
      const controls = [...dialog.querySelectorAll<HTMLButtonElement>('button:not(:disabled):not([tabindex="-1"])')];
      const index = controls.indexOf(document.activeElement as HTMLButtonElement);
      event.preventDefault();
      controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus();
      return;
    }
    if (['+', '=', '-', '0'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      zoom = event.key === '0' ? 1 : Math.max(1, Math.min(4, zoom + (event.key === '-' ? -0.5 : 0.5)));
      return;
    }
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    onclose();
  }
</script>

<svelte:window onkeydowncapture={onkeydown} />

<div class="viewer" bind:this={dialog} use:portal role="dialog" aria-modal="true" aria-label={alt} data-testid="image-viewer">
  <div class="toolbar">
    <span class="name ui-label" title={alt}>{alt}</span>
    <button type="button" class="ghost icon" onclick={() => zoom = Math.max(1, zoom - 0.5)} disabled={zoom === 1} aria-label={strings.artifacts.zoomOut} title={strings.artifacts.zoomOut}><Minus size={17} /></button>
    <button type="button" class="ghost small fit" onclick={() => zoom = 1} aria-label={strings.artifacts.fitImage} title={strings.artifacts.fitImage}><Maximize2 size={16} /><span class="ui-label">{Math.round(zoom * 100)}%</span></button>
    <button type="button" class="ghost icon" onclick={() => zoom = Math.min(4, zoom + 0.5)} disabled={zoom === 4} aria-label={strings.artifacts.zoomIn} title={strings.artifacts.zoomIn}><Plus size={17} /></button>
    {#if ondownload}<button type="button" class="ghost icon" onclick={ondownload} aria-label={strings.artifacts.download} title={strings.artifacts.download}><Download size={17} /></button>{/if}
    <button type="button" class="ghost icon" bind:this={close} aria-label={strings.artifacts.closeImage} title={strings.artifacts.closeImage} onclick={onclose} data-testid="image-viewer-close"><X size={18} /></button>
  </div>
  <div class="stage" bind:this={stage}>
    <div class="canvas">
      <button type="button" class="backdrop" tabindex="-1" aria-label={strings.artifacts.closeImage} onclick={onclose}></button>
      <img {src} {alt} style:width={width ? `${width}px` : undefined} draggable="false" onload={loaded} />
    </div>
  </div>
</div>

<style>
  .viewer {
    position: fixed;
    inset: 0;
    z-index: 55;
    display: flex;
    flex-direction: column;
    /* Near opaque instead of a blur: a window-wide blur is redrawn on every
       frame something moves under it (docs/performance.md, "What a frame costs"). */
    background: color-mix(in oklch, var(--color-background) 94%, transparent);
    animation: appear var(--dur-2) ease-out;
  }
  .toolbar { flex: none; display: flex; align-items: center; gap: 4px; min-height: 56px; padding: 8px 12px; border-bottom: 1px solid var(--color-border); background: var(--color-surface); }
  .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-right: 12px; font-size: var(--text-sm); }
  .fit { font-variant-numeric: tabular-nums; }
  .stage { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; }
  .canvas { position: relative; display: grid; place-items: center; width: max-content; height: max-content; min-width: 100%; min-height: 100%; padding: 16px; box-sizing: border-box; }
  .backdrop { position: absolute; inset: 0; width: 100%; height: 100%; padding: 0; border: 0; border-radius: 0; background: none; cursor: zoom-out; }
  .backdrop:hover:not(:disabled) { background: none; }
  img { position: relative; height: auto; max-width: none; object-fit: contain; border-radius: var(--radius-sm); box-shadow: var(--shadow-e2); }
  @keyframes appear { from { opacity: 0; } }
  @media (max-width: 720px) { .toolbar { flex-wrap: wrap; padding: 8px; } .name { flex-basis: 100%; margin: 0 0 4px; } .toolbar button { min-height: 40px; min-width: 40px; } }
</style>
