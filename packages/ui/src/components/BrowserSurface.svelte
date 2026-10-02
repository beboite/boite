<script lang="ts">
  import { untrack } from 'svelte';
  import { ArrowLeft, ArrowRight, ExternalLink, RotateCw, MousePointer2, PictureInPicture2 } from '@lucide/svelte';
  import { rightPanel } from '../lib/right-panel.svelte';
  import { browserBridge, normalizeUrl } from '../lib/browser-bridge';
  import { linuxShell } from '../lib/shell-platform';
  import { watchBrowserBounds } from '../lib/browser-bounds';
  import { browserPresentation } from '../lib/browser-presentation';
  import { openExternal } from '../lib/links';
  import { fill, strings } from '../lib/strings';
  import { focusComposer } from '../lib/focus';
  import { ZOOM_DEFAULT, stepZoom, zoomKey } from '../lib/zoom';
  import type { BoundPanel, Surface } from '../lib/right-panel.svelte';
  import type { Store } from '../lib/store.svelte';
  import { experimentOn } from '../lib/experiments.svelte';
  import { validPreviewSelection } from '../lib/preview-comments';
  import BrowserTools from './BrowserTools.svelte';
  import { runBrowserAction } from '../lib/browser-tools.svelte';
  const previewStrings = $derived(strings.previewComments);

  let { surface, panel, store }: { surface: Surface; panel: BoundPanel; store: Store } = $props();

  let request = $state<string | null>(null);
  let notice = $state('');
  let loading = $state(false);
  let problem = $state('');
  let viewport = $state<{ width: number; height: number } | null>(null);
  $effect(() => {
    const surfaceId = id;
    viewport = browserBridge.viewport?.(surfaceId) ?? null;
    loading = untrack(() => !!url && !browserBridge.isReady(surfaceId));
    problem = '';
    return browserBridge.on(event => {
      if (event.id !== surfaceId) return;
      if (event.type === 'viewport') viewport = event.size;
      if (event.type === 'loading') {
        loading = event.loading;
        if (loading) problem = '';
      } else if (event.type === 'failed') {
        loading = false;
        problem = fill(strings.browser.failed, { reason: event.reason });
      }
    });
  });
  let selectionOwner: { store: Store; threadId: string; client: Store['client']; machineId: string } | null = null;
  const enabled = $derived(experimentOn('preview-comments'));

  function cancelSelection(): void {
    request = null;
    browserBridge.annotate(id, null);
  }

  function beginSelection(): void {
    if (request) { cancelSelection(); return; }
    const threadId = store.openThread?.id;
    if (!enabled || !threadId) return;
    selectionOwner = { store, threadId, client: store.client, machineId: store.machineId };
    notice = '';
    request = crypto.randomUUID();
    browserBridge.annotate(id, request);
  }

  $effect(() => {
    const surfaceId = id;
    const on = enabled;
    if (!on) untrack(cancelSelection);
    const off = browserBridge.on(event => {
      if (!on || event.id !== surfaceId) return;
      if (event.type === 'selection' && event.requestId === request) {
        request = null;
        if (event.selection !== null && !validPreviewSelection(event.selection)) {
          notice = previewStrings.failed;
          return;
        }
        if (event.selection && selectionOwner && selectionOwner.store.client === selectionOwner.client && selectionOwner.store.machineId === selectionOwner.machineId) {
          const added = selectionOwner.store.addPreviewReference(selectionOwner.threadId, {
            ...event.selection, id: crypto.randomUUID(), surfaceId
          });
          notice = added ? previewStrings.added : '';
          if (added && window.innerWidth <= 980) panel.toggle();
        }
      } else if (event.type === 'selection-failed' && event.requestId === request) {
        request = null;
        notice = event.reason === 'inaccessible' || event.reason === 'unavailable' ? previewStrings.unavailable : previewStrings.failed;
      // WebView2 finishes the refused picker callback navigation by reporting
      // the unchanged page URL and loading=false. Keep its returned selection.
      } else if ((event.type === 'loading' && event.loading) ||
        (event.type === 'url' && event.url !== surface.url)) {
        cancelSelection();
        notice = '';
      }
    });
    return () => {
      off();
      browserBridge.annotate(surfaceId, null);
    };
  });

  let slot = $state<HTMLDivElement | undefined>(undefined);
  let preview = $state<string | null>(null);
  let field = $state<HTMLInputElement | undefined>(undefined);
  let root = $state<HTMLDivElement | undefined>(undefined);
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

    return watchBrowserBounds(node, browserPresentation(browserBridge, surfaceId, image => { preview = image; }));
  });

  function submit(event: Event): void {
    event.preventDefault();
    const next = normalizeUrl(draft ?? '');
    if (!next) { problem = strings.browser.invalidUrl; return; }
    problem = '';
    loading = true;
    draft = null;
    leaveField();
    browserBridge.navigate(id, next);
    panel.update(id, { url: next });
  }

  function onkeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    if (request) cancelSelection();
    event.stopPropagation();
    draft = null;
    leaveField();
  }

  /** Out of the address field onto the composer: left on the page, the next Escape would stop the running turn. */
  function leaveField(): void {
    if (!focusComposer()) field?.blur();
  }

  /**
   * `Ctrl+=`, `Ctrl+-` and `Ctrl+0` while the keyboard is in this surface's
   * chrome (the address field, its buttons). Anywhere else the keys zoom the
   * interface in the shell (`App.svelte`) and the tab in a browser.
   */
  function onZoomKey(event: KeyboardEvent): void {
    if (event.key === 'Escape' && request) {
      event.preventDefault();
      cancelSelection();
      return;
    }
    const direction = zoomKey(event);
    if (direction === null || !(event.target instanceof Node && root?.contains(event.target))) return;
    const next = direction === 0 ? ZOOM_DEFAULT : stepZoom(zoom, direction);
    event.preventDefault();
    if (next === zoom) return;
    browserBridge.setZoom(id, next);
    panel.update(id, { zoom: next });
  }
</script>

<svelte:window onkeydown={onZoomKey} />

<div class="browser-surface" data-testid="browser-surface" data-surface-id={id} bind:this={root}>
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
      <RotateCw size={13} strokeWidth={1.75} class={loading ? 'spin' : ''} />
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
        autocapitalize="none"
        inputmode="url"
        aria-invalid={problem !== ''}
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
    {#if browserBridge.protocol && /Windows/.test(navigator.userAgent)}
      <BrowserTools {id} onerror={message => { problem = message; }} />
    {/if}
    {#if browserBridge.paints && !rightPanel.floating}
      <button type="button" class="ghost small icon" data-testid="browser-detach"
        title={strings.browser.detach} aria-label={strings.browser.detach}
        onclick={() => { rightPanel.floating = true; rightPanel.maximized = false; }}>
        <PictureInPicture2 size={14} />
      </button>
    {/if}
    {#if viewport}
      <button type="button" class="ghost small zoom" title={strings.browser.resetViewport} aria-label={strings.browser.resetViewport}
        onclick={() => void runBrowserAction(id, { kind: 'reset-viewport' }).catch(error => { problem = String(error); })}>{viewport.width}×{viewport.height}</button>
    {/if}
    {#if zoom !== ZOOM_DEFAULT}
      <button type="button" class="ghost small zoom" data-testid="browser-zoom"
        title={strings.browser.resetZoom} aria-label={strings.browser.resetZoom}
        onclick={() => { browserBridge.setZoom(id, ZOOM_DEFAULT); panel.update(id, { zoom: ZOOM_DEFAULT }); }}>{Math.round(zoom * 100)}%</button>
    {/if}
    {#if enabled}
      <button type="button" class="ghost small icon" title={previewStrings.annotate}
        aria-label={previewStrings.annotate} aria-pressed={!!request}
        disabled={!store.openThread} data-testid="preview-annotate" onclick={beginSelection}>
        <MousePointer2 size={14} strokeWidth={1.75} />
      </button>
    {/if}
  </div>

  {#if loading}<span class="loading" role="status" aria-label={strings.browser.loading} data-testid="browser-loading"></span>{/if}
  {#if problem}<p class="problem" role="alert" data-testid="browser-error">{problem}</p>{/if}

  {#if enabled && (request || notice)}
    <p class="annotation-notice" role="status">{request ? previewStrings.picking : notice}</p>
  {/if}

  <div class="slot" bind:this={slot} data-testid="browser-slot">
    {#if preview}<img class="overlay-preview" data-testid="browser-overlay-preview" src={preview} alt="" />{/if}
    {#if !browserBridge.paints}
      <p class="muted note">{linuxShell() ? strings.browser.slotLinux : strings.browser.slotEmpty}</p>
    {/if}
  </div>
</div>

<style>
  .annotation-notice { margin: 0; padding: 8px 12px; font-size: var(--text-sm); color: var(--color-muted-foreground); border-bottom: 1px solid var(--color-border); }
  .chrome button[aria-pressed="true"] { color: var(--color-accent); background: var(--color-accent-soft); }
  .browser-surface {
    position: relative;
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
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    text-align: center;
    background: var(--color-background);
  }

  .overlay-preview { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; pointer-events: none; }

  .note {
    font-size: var(--text-sm);
    max-width: 260px;
  }

  .loading { position: absolute; top: 42px; left: 0; right: 0; height: 2px; z-index: 1; background: var(--color-accent); }
  .problem { margin: 0; padding: 8px 12px; color: var(--color-danger); font-size: var(--text-sm); overflow-wrap: anywhere; }
  .zoom { flex: none; font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
  .chrome :global(.spin) { animation: reload-spin 1s linear infinite; }
  @keyframes reload-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .chrome :global(.spin) { animation: none; } }
  @media (hover: none) { .external { opacity: 1; } }
</style>
