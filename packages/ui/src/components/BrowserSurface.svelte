<script lang="ts">
  import { untrack } from 'svelte';
  import { ArrowLeft, ArrowRight, ExternalLink, RotateCw } from '@lucide/svelte';
  import { browserBridge, normalizeUrl } from '../lib/browser-bridge';
  import { openExternal } from '../lib/links';
  import { strings } from '../lib/strings';
  import { ZOOM_DEFAULT, stepZoom } from '../lib/right-panel.svelte';
  import type { BoundPanel, Surface } from '../lib/right-panel.svelte';

  let { surface, panel }: { surface: Surface; panel: BoundPanel } = $props();

  let slot = $state<HTMLDivElement | undefined>(undefined);
  let field = $state<HTMLInputElement | undefined>(undefined);
  let draft = $state<string | null>(null);

  let id = $derived(surface.id);
  let url = $derived(surface.url ?? '');
  let shown = $derived(draft ?? url);
  let zoom = $derived(surface.zoom ?? ZOOM_DEFAULT);

  // The page is not a child of this tree: the slot is measured and the bridge
  // parks its view over that rectangle, which is what a Tauri child webview does.
  //
  // Only the slot and the surface id are read reactively. The url and the zoom
  // are read once, untracked: the page reports its own address as it navigates,
  // and a view torn down and rebuilt on every one of those would hide, show and
  // lose its history for nothing.
  $effect(() => {
    const node = slot;
    const surfaceId = id;
    if (!node) return;
    untrack(() => {
      browserBridge.create(surfaceId, surface.url ?? '');
      // The tab remembered a zoom; the view it is about to get has not.
      if (zoom !== ZOOM_DEFAULT) browserBridge.setZoom(surfaceId, zoom);
    });

    // The slot moves for more reasons than it resizes: the sidebar folds, the
    // panel is dragged or maximized, a sheet slides in, the window is resized.
    // A `ResizeObserver` misses every move that keeps the size, so the frame is
    // what drives this. One `getBoundingClientRect` per frame, and the bridge
    // only hears about a rectangle that actually changed.
    // jsdom without a visual pretence has no frames; the surface still renders.
    const framed = typeof requestAnimationFrame === 'function';
    let last = '';
    let frame = 0;
    const report = (): void => {
      const rect = node.getBoundingClientRect();
      const key = `${rect.x},${rect.y},${rect.width},${rect.height}`;
      if (key !== last) {
        last = key;
        browserBridge.setBounds(surfaceId, {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height
        });
      }
      if (framed) frame = requestAnimationFrame(report);
    };
    report();

    return () => {
      if (framed && frame !== 0) cancelAnimationFrame(frame);
      // The tab lives on; it is only this surface that stopped showing.
      browserBridge.setBounds(surfaceId, null);
    };
  });

  function submit(event: Event): void {
    event.preventDefault();
    const next = normalizeUrl(draft ?? '');
    draft = null;
    field?.blur();
    if (!next) return;
    browserBridge.navigate(id, next);
    panel.update(id, { url: next });
  }

  function onkeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    draft = null;
    field?.blur();
  }

  /** `Ctrl+=`, `Ctrl+-` and `Ctrl+0` while this surface is the one showing. */
  function onZoomKey(event: KeyboardEvent): void {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = event.key;
    let next: number | null = null;
    if (key === '=' || key === '+') next = stepZoom(zoom, 1);
    else if (key === '-' || key === '_') next = stepZoom(zoom, -1);
    else if (key === '0') next = ZOOM_DEFAULT;
    if (next === null) return;
    event.preventDefault();
    if (next === zoom) return;
    browserBridge.setZoom(id, next);
    panel.update(id, { zoom: next });
  }
</script>

<svelte:window onkeydown={onZoomKey} />

<div class="browser-surface" data-testid="browser-surface" data-surface-id={id}>
  <div class="chrome">
    <button
      type="button"
      class="ghost small icon"
      title={strings.browser.back}
      aria-label={strings.browser.back}
      data-testid="browser-back"
      onclick={() => browserBridge.back(id)}
    >
      <ArrowLeft size={14} strokeWidth={1.75} />
    </button>
    <button
      type="button"
      class="ghost small icon"
      title={strings.browser.forward}
      aria-label={strings.browser.forward}
      data-testid="browser-forward"
      onclick={() => browserBridge.forward(id)}
    >
      <ArrowRight size={14} strokeWidth={1.75} />
    </button>
    <button
      type="button"
      class="ghost small icon"
      title={strings.browser.reload}
      aria-label={strings.browser.reload}
      data-testid="browser-reload"
      onclick={() => browserBridge.reload(id)}
    >
      <RotateCw size={13} strokeWidth={1.75} />
    </button>

    <form class="address" onsubmit={submit}>
      <input
        bind:this={field}
        class="url"
        type="text"
        value={shown}
        placeholder={strings.browser.urlPlaceholder}
        aria-label={strings.browser.urlPlaceholder}
        data-testid="browser-url"
        spellcheck="false"
        autocomplete="off"
        oninput={(event) => (draft = event.currentTarget.value)}
        onfocus={(event) => {
          draft = event.currentTarget.value;
          event.currentTarget.select();
        }}
        onblur={() => (draft = null)}
        {onkeydown}
      />
      <button
        type="button"
        class="ghost small icon external"
        title={strings.browser.openExternal}
        aria-label={strings.browser.openExternal}
        data-testid="browser-external"
        disabled={url === ''}
        onclick={() => void openExternal(url)}
      >
        <ExternalLink size={13} strokeWidth={1.75} />
      </button>
    </form>
  </div>

  <div class="slot" bind:this={slot} data-testid="browser-slot">
    {#if !browserBridge.paints}
      <p class="muted note">{strings.browser.slotEmpty}</p>
    {/if}
  </div>
</div>

<style>
  .browser-surface {
    display: flex;
    flex-direction: column;
    min-height: 0;
    height: 100%;
  }

  .chrome {
    display: flex;
    align-items: center;
    gap: 4px;
    height: 44px;
    padding: 0 8px;
    border-bottom: 1px solid var(--color-border);
    flex: none;
  }

  .address {
    position: relative;
    display: flex;
    align-items: center;
    flex: 1;
    min-width: 0;
    margin: 0;
  }

  .url {
    height: var(--control);
    width: 100%;
    padding: 0 30px 0 10px;
    border-color: transparent;
    background: var(--color-surface-2);
    font-size: var(--text-sm);
    text-overflow: ellipsis;
  }

  .url:hover {
    border-color: var(--color-border);
  }

  .url:focus {
    border-color: color-mix(in srgb, var(--color-foreground) 35%, var(--color-edge));
  }

  .external {
    position: absolute;
    right: 2px;
    opacity: 0;
    transition: opacity var(--dur-2) var(--ease-out-quint);
  }

  .address:hover .external,
  .address:focus-within .external,
  .external:focus-visible {
    opacity: 1;
  }

  .slot {
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    text-align: center;
    background: var(--color-background);
  }

  .note {
    font-size: var(--text-sm);
    max-width: 260px;
  }
</style>
