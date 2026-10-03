<script lang="ts">
  /**
   * Pictures and videos over the whole window, one at a time, with the others
   * of the thread a swipe or an arrow away (`lib/media-gallery.ts`). A picture
   * zooms with a pinch, a double tap, the toolbar or `+ - 0`, and pans once
   * zoomed; dragged down on a phone, the viewer fades and closes. Share hands
   * the file to the system sheet where the browser can (Save Image on an
   * iPhone), and downloads it elsewhere. A click on the backdrop, Escape, the
   * close button or a phone's Back closes it, and the keyboard goes back to
   * what held it. The node moves under `<body>` so no scrolling list clips it.
   */
  import { onMount } from 'svelte';
  import { ChevronLeft, ChevronRight, Download, Maximize2, Minus, Plus, Share, X } from '@lucide/svelte';
  import { focusedElement, restoreFocus } from '../lib/focus';
  import { mobileOverlay } from '../lib/mobile-history';
  import { canShareFiles, mediaFile, saveMedia, type MediaItem } from '../lib/media-gallery';
  import { fill, strings } from '../lib/strings';
  import {
    FITTED, MAX_SCALE, SLOP, bounded, dragAxis, dragFade, isDoubleTap, released, toggledZoom, zoomAround,
    type Point, type Tap, type View
  } from '../lib/viewer-gestures';

  let { items, index: start = 0, onclose }: { items: MediaItem[]; index?: number; onclose: () => void } = $props();
  // svelte-ignore state_referenced_locally
  let index = $state(Math.min(Math.max(start, 0), Math.max(items.length - 1, 0)));
  const item = $derived(items[index]!);
  const isImage = $derived(item.kind === 'image');
  let close = $state<HTMLButtonElement | undefined>(undefined);
  let dialog: HTMLDivElement;
  let stage: HTMLDivElement;
  let view = $state<View>(FITTED);
  /** The finger's pull while it swipes sideways or drags down; zero at rest. */
  let pull = $state({ x: 0, y: 0 });
  /** Springing back or zooming from a button: the transform animates instead of following a finger. */
  let settling = $state(false);
  let natural = $state({ width: 0, height: 0 });
  let viewport = $state({ width: 0, height: 0 });
  let notice = $state('');
  const shareable = canShareFiles() && window.__TAURI_INTERNALS__ === undefined;
  /** Files fetched for the share sheet, by URL: iOS opens the sheet only when it is asked straight from the tap. */
  const files = new Map<string, File>();

  const fit = $derived(natural.width && viewport.width > 32 && viewport.height > 32
    ? Math.min(1, (viewport.width - 32) / natural.width, (viewport.height - 32) / natural.height) : 1);
  const fitted = $derived({ width: natural.width * fit, height: natural.height * fit });
  const transform = $derived(`translate(${view.x + pull.x}px, ${view.y + pull.y}px) scale(${view.scale})`);
  const fade = $derived(dragFade(pull.y, viewport));

  function loaded(event: Event): void {
    const image = event.currentTarget as HTMLImageElement;
    natural = { width: image.naturalWidth, height: image.naturalHeight };
  }

  function portal(node: HTMLElement) {
    document.body.append(node);
    return { destroy: () => node.remove() };
  }

  function show(next: number): void {
    if (next < 0 || next >= items.length || next === index) return;
    index = next;
    natural = { width: 0, height: 0 };
    view = FITTED;
    pull = { x: 0, y: 0 };
    notice = '';
  }

  function zoomTo(scale: number, focus: Point = { x: 0, y: 0 }): void {
    settling = true;
    view = bounded(scale <= 1 ? FITTED : zoomAround(view, scale, focus), fitted, viewport);
  }

  /** A point of the page, from the stage's centre. */
  function fromCentre(x: number, y: number): Point {
    const box = stage.getBoundingClientRect();
    return { x: x - box.left - box.width / 2, y: y - box.top - box.height / 2 };
  }

  // Gestures. Pointer events cover fingers, pens and the mouse alike; the
  // stage has `touch-action: none` so the browser neither scrolls nor zooms
  // the page under them.
  const pointers = new Map<number, Point>();
  let gesture: {
    kind: 'pan' | 'pinch' | 'drag';
    from: Point; view: View; at: number; touch: boolean;
    axis: 'x' | 'y' | null; distance: number; moved: boolean;
  } | null = null;
  let lastTap: Tap | null = null;
  /** A drag ends with a click on what is under it: that click must not close the viewer. */
  let swallowClick = false;

  function midpoint(): Point {
    const [a, b] = [...pointers.values()];
    return { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 };
  }

  function spread(): number {
    const [a, b] = [...pointers.values()];
    return Math.hypot(a!.x - b!.x, a!.y - b!.y);
  }

  function begin(): void {
    const touch = gesture?.touch ?? true;
    settling = false;
    if (pointers.size >= 2 && isImage) {
      gesture = { kind: 'pinch', from: midpoint(), view: { ...view }, at: performance.now(), touch, axis: null, distance: spread(), moved: true };
      pull = { x: 0, y: 0 };
      return;
    }
    const [point] = [...pointers.values()];
    gesture = { kind: view.scale > 1 ? 'pan' : 'drag', from: point!, view: { ...view }, at: performance.now(), touch, axis: null, distance: 0, moved: false };
  }

  function pointerdown(event: PointerEvent): void {
    if (event.button !== 0 || (event.target as Element).closest('video, .nav')) return;
    swallowClick = false;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    begin();
    if (gesture) gesture.touch = event.pointerType !== 'mouse';
    if (pointers.size === 1) {
      window.addEventListener('pointermove', pointermove);
      window.addEventListener('pointerup', pointerup);
      window.addEventListener('pointercancel', pointerup);
    }
  }

  function pointermove(event: PointerEvent): void {
    if (!pointers.has(event.pointerId) || !gesture) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (gesture.kind === 'pinch' && pointers.size >= 2) {
      const scale = Math.min(MAX_SCALE * 1.15, Math.max(0.6, gesture.view.scale * spread() / Math.max(gesture.distance, 1)));
      const mid = midpoint();
      const focus = fromCentre(gesture.from.x, gesture.from.y);
      const zoomed = zoomAround(gesture.view, scale, focus);
      view = { scale, x: zoomed.x + mid.x - gesture.from.x, y: zoomed.y + mid.y - gesture.from.y };
      return;
    }
    const [point] = [...pointers.values()];
    const dx = point!.x - gesture.from.x;
    const dy = point!.y - gesture.from.y;
    if (!gesture.moved && Math.hypot(dx, dy) >= SLOP) gesture.moved = true;
    if (gesture.kind === 'pan') {
      view = bounded({ scale: gesture.view.scale, x: gesture.view.x + dx, y: gesture.view.y + dy }, fitted, viewport);
      return;
    }
    // Fitted: a finger swipes to the next picture or drags the viewer closed; the mouse has arrows for that.
    if (!gesture.touch) return;
    gesture.axis ??= dragAxis(dx, dy);
    if (gesture.axis === 'x') pull = { x: items.length > 1 ? dx : dx / 4, y: 0 };
    else if (gesture.axis === 'y') pull = { x: 0, y: Math.max(0, dy) };
  }

  function pointerup(event: PointerEvent): void {
    if (!pointers.has(event.pointerId)) return;
    const point = pointers.get(event.pointerId)!;
    pointers.delete(event.pointerId);
    const ended = gesture;
    if (pointers.size > 0) {
      // One finger of a pinch lifted: the other pans on from where it is.
      if (ended?.kind === 'pinch') view = bounded(view, fitted, viewport);
      begin();
      if (gesture && ended) gesture.moved = true;
      return;
    }
    window.removeEventListener('pointermove', pointermove);
    window.removeEventListener('pointerup', pointerup);
    window.removeEventListener('pointercancel', pointerup);
    gesture = null;
    if (!ended) return;
    settling = true;
    if (ended.kind === 'pinch') {
      view = view.scale < 1.05 ? FITTED : bounded(view, fitted, viewport);
      swallowClick = true;
      return;
    }
    if (ended.moved) {
      swallowClick = true;
      lastTap = null;
      if (ended.kind === 'drag' && ended.axis !== null && event.type === 'pointerup') {
        const outcome = released(ended.axis, point.x - ended.from.x, point.y - ended.from.y, performance.now() - ended.at, viewport);
        if (outcome === 'close') { onclose(); return; }
        if (outcome === 'next') show(index + 1);
        if (outcome === 'previous') show(index - 1);
      }
      pull = { x: 0, y: 0 };
      return;
    }
    // A tap. Two in a row on the picture zoom in there, or back out.
    const tap = { x: point.x, y: point.y, at: performance.now() };
    const onPicture = (event.target as Element).closest?.('img') !== null;
    if (isImage && onPicture && isDoubleTap(lastTap, tap)) {
      lastTap = null;
      view = bounded(toggledZoom(view, fromCentre(tap.x, tap.y)), fitted, viewport);
      swallowClick = true;
      return;
    }
    lastTap = tap;
  }

  function backdrop(): void {
    if (swallowClick) { swallowClick = false; return; }
    onclose();
  }

  /** A trackpad pinch arrives as a wheel with Ctrl; a plain wheel pans a zoomed picture. */
  function wheel(event: WheelEvent): void {
    if (!isImage) return;
    if (event.ctrlKey) {
      event.preventDefault();
      settling = false;
      view = bounded(zoomAround(view, Math.min(MAX_SCALE, Math.max(1, view.scale * Math.exp(-event.deltaY / 100))), fromCentre(event.clientX, event.clientY)), fitted, viewport);
    } else if (view.scale > 1) {
      event.preventDefault();
      settling = false;
      view = bounded({ ...view, x: view.x - event.deltaX, y: view.y - event.deltaY }, fitted, viewport);
    }
  }

  /**
   * Hands the file to the share sheet. iOS opens the sheet only when it is
   * called straight from the tap, so a file already fetched is shared at once;
   * one fetched now may come too late for that, and is then ready for the next
   * tap. Without a share sheet, or for a file it refuses, the file downloads.
   */
  async function share(): Promise<void> {
    const current = item;
    notice = '';
    if (!shareable) { saveMedia(current); return; }
    let file = files.get(current.src);
    try {
      if (!file) {
        file = await mediaFile(current);
        files.set(current.src, file);
      }
      if (!navigator.canShare({ files: [file] })) { saveMedia(current); return; }
      await navigator.share({ files: [file], title: current.name });
    } catch (error) {
      const name = error instanceof DOMException ? error.name : '';
      if (name === 'AbortError') return;
      if (name === 'NotAllowedError' && file) { notice = fill(strings.media.shareReady, { name: current.name }); return; }
      if (!file) { notice = fill(strings.media.shareFailed, { name: current.name }); return; }
      saveMedia(current);
    }
  }

  // A file already in memory (an attachment, a pasted picture) is read ahead,
  // so Share can open the sheet from the tap itself.
  $effect(() => {
    const current = item;
    if (!shareable || files.has(current.src) || !/^(blob|data):/.test(current.src)) return;
    void mediaFile(current).then((file) => files.set(current.src, file), () => {});
  });

  onMount(() => {
    const previous = focusedElement();
    close?.focus({ preventScroll: true });
    const leave = mobileOverlay(onclose);
    const measure = () => viewport = { width: stage.clientWidth, height: stage.clientHeight };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(stage);
    stage.addEventListener('wheel', wheel, { passive: false });
    return () => {
      observer.disconnect();
      stage.removeEventListener('wheel', wheel);
      window.removeEventListener('pointermove', pointermove);
      window.removeEventListener('pointerup', pointerup);
      window.removeEventListener('pointercancel', pointerup);
      leave();
      restoreFocus(previous);
    };
  });

  function onkeydown(event: KeyboardEvent): void {
    if (event.key === 'Tab') {
      const controls = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled):not([tabindex="-1"]), video')];
      const at = controls.indexOf(document.activeElement as HTMLElement);
      event.preventDefault();
      controls[(at + (event.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus();
      return;
    }
    if (isImage && ['+', '=', '-', '0'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      zoomTo(event.key === '0' ? 1 : view.scale + (event.key === '-' ? -0.5 : 0.5));
      return;
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      if ((event.target as Element | null)?.closest?.('video')) return;
      event.preventDefault(); event.stopPropagation();
      show(index + (event.key === 'ArrowLeft' ? -1 : 1));
      return;
    }
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    onclose();
  }
</script>

<svelte:window onkeydowncapture={onkeydown} />

<div class="viewer" class:shareable bind:this={dialog} use:portal role="dialog" aria-modal="true" aria-label={item.name || strings.media.viewer} data-testid="image-viewer">
  <div class="shade" style:opacity={1 - fade}></div>
  <div class="toolbar" style:opacity={1 - fade}>
    <span class="name ui-label" title={item.name}>{item.name}</span>
    {#if items.length > 1}<span class="position" data-testid="image-viewer-position">{fill(strings.media.position, { index: String(index + 1), total: String(items.length) })}</span>{/if}
    {#if isImage}
      <button type="button" class="ghost icon zoom" onclick={() => zoomTo(view.scale - 0.5)} disabled={view.scale <= 1} aria-label={strings.artifacts.zoomOut} title={strings.artifacts.zoomOut}><Minus size={17} /></button>
      <button type="button" class="ghost small fit zoom" onclick={() => zoomTo(1)} aria-label={strings.artifacts.fitImage} title={strings.artifacts.fitImage}><Maximize2 size={16} /><span class="ui-label">{Math.round(view.scale * 100)}%</span></button>
      <button type="button" class="ghost icon zoom" onclick={() => zoomTo(view.scale + 0.5)} disabled={view.scale >= MAX_SCALE} aria-label={strings.artifacts.zoomIn} title={strings.artifacts.zoomIn}><Plus size={17} /></button>
    {/if}
    {#if shareable}<button type="button" class="ghost icon" onclick={share} aria-label={strings.media.share} title={strings.media.share} data-testid="image-viewer-share"><Share size={17} /></button>{/if}
    <button type="button" class="ghost icon download" onclick={() => saveMedia(item)} aria-label={strings.artifacts.download} title={strings.artifacts.download} data-testid="image-viewer-download"><Download size={17} /></button>
    <button type="button" class="ghost icon" bind:this={close} aria-label={strings.artifacts.closeImage} title={strings.artifacts.closeImage} onclick={onclose} data-testid="image-viewer-close"><X size={18} /></button>
  </div>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="stage" bind:this={stage} onpointerdown={pointerdown} data-testid="image-viewer-stage">
    <button type="button" class="backdrop" tabindex="-1" aria-label={strings.artifacts.closeImage} onclick={backdrop}></button>
    {#key index}
      {#if isImage}
        <img src={item.src} alt={item.name} draggable="false" onload={loaded} class:settling class:sized={fitted.width > 0} class:zoomed={view.scale > 1}
          style:width={fitted.width ? `${fitted.width}px` : undefined} style:height={fitted.height ? `${fitted.height}px` : undefined}
          style:transform ontransitionend={() => settling = false} />
      {:else}
        <!-- svelte-ignore a11y_media_has_caption -->
        <video src={item.src} aria-label={item.name} controls playsinline preload="metadata" class:settling style:transform ontransitionend={() => settling = false}></video>
      {/if}
    {/key}
    {#if items.length > 1}
      <button type="button" class="nav previous" onclick={() => show(index - 1)} disabled={index === 0} aria-label={strings.media.previous} title={strings.media.previous} data-testid="image-viewer-previous"><ChevronLeft size={22} /></button>
      <button type="button" class="nav next" onclick={() => show(index + 1)} disabled={index === items.length - 1} aria-label={strings.media.next} title={strings.media.next} data-testid="image-viewer-next"><ChevronRight size={22} /></button>
    {/if}
  </div>
  {#if notice}<p class="notice" role="status" data-testid="image-viewer-notice">{notice}</p>{/if}
</div>

<style>
  .viewer {
    position: fixed;
    inset: 0;
    z-index: 55;
    display: flex;
    flex-direction: column;
    animation: appear var(--dur-2) ease-out;
  }
  /* Near opaque instead of a blur: a window-wide blur is redrawn on every
     frame something moves under it (docs/performance.md, "What a frame costs"). */
  .shade { position: absolute; inset: 0; background: color-mix(in oklch, var(--color-background) 94%, transparent); }
  .toolbar { position: relative; flex: none; display: flex; align-items: center; gap: 4px; min-height: 56px; padding: 8px 12px; padding-top: max(8px, env(safe-area-inset-top)); border-bottom: 1px solid var(--color-border); background: var(--color-surface); }
  .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-right: 12px; font-size: var(--text-sm); }
  .position { flex: none; margin-right: 8px; color: var(--color-muted-foreground); font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
  .fit { font-variant-numeric: tabular-nums; }
  .stage { position: relative; flex: 1; min-height: 0; display: grid; place-items: center; overflow: hidden; touch-action: none; overscroll-behavior: contain; padding-bottom: env(safe-area-inset-bottom); }
  .backdrop { position: absolute; inset: 0; width: 100%; height: 100%; padding: 0; border: 0; border-radius: 0; background: none; cursor: zoom-out; }
  .backdrop:hover:not(:disabled) { background: none; }
  img, video { position: relative; grid-area: 1 / 1; max-width: calc(100% - 32px); max-height: calc(100% - 32px); object-fit: contain; border-radius: var(--radius-sm); box-shadow: var(--shadow-e2); transform-origin: center; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; }
  /* Once its size is known the picture is sized to fit, and a zoom may take it past the stage. */
  img.sized { max-width: none; max-height: none; }
  img.zoomed { cursor: grab; }
  .settling { transition: transform var(--dur-3) var(--ease-out-quint); }
  .nav { position: absolute; top: 50%; translate: 0 -50%; display: grid; place-items: center; width: var(--control-touch); height: var(--control-touch); padding: 0; border-radius: var(--radius-lg); background: var(--color-surface); box-shadow: var(--shadow-e1); }
  .nav:disabled { opacity: 0; pointer-events: none; }
  .previous { left: 12px; }
  .next { right: 12px; }
  .notice { position: absolute; left: 50%; bottom: max(16px, env(safe-area-inset-bottom)); translate: -50% 0; max-width: calc(100% - 32px); margin: 0; padding: 8px 12px; border-radius: var(--radius-md); background: var(--color-surface); box-shadow: var(--shadow-e2); font-size: var(--text-sm); }
  @keyframes appear { from { opacity: 0; } }
  @media (max-width: 720px) {
    .toolbar { flex-wrap: wrap; padding: 8px; padding-top: max(8px, env(safe-area-inset-top)); }
    .name { flex-basis: 100%; margin: 0 0 4px; }
    .toolbar button { min-height: var(--control-touch); min-width: var(--control-touch); }
    /* A finger pinches and double-taps; the zoom buttons would only crowd the bar. */
    .zoom { display: none; }
    /* The share sheet saves too (Save Image, Save to Files): one button is enough. */
    .shareable .download { display: none; }
    .position { margin-right: auto; }
  }
  @media (hover: none) and (max-width: 720px) { .nav { display: none; } }
</style>
