<script lang="ts">
  import { onDestroy } from 'svelte';

  /**
   * The edge a drag resizes, shared by the thread list, the right panel and
   * the terminal drawer. Invisible at rest; a short hover draws a thin line
   * with a grip in its middle, a drag turns both to the accent. While it
   * drags, the whole document keeps the resize cursor, selects no text and
   * lets no frame under the pointer take it.
   *
   * The parent owns the size: `onmove` gets the pointer's distance from where
   * the drag began along the axis (right and down are positive) and its
   * position, `onend` persists once, `onstep` takes the arrow keys' 16 px,
   * `onreset` a double click and Home. Escape puts the drag back where it began.
   */
  let {
    orientation,
    edge,
    label,
    testid,
    value,
    min,
    max,
    dragging = $bindable(false),
    onstart,
    onmove,
    onend,
    onstep,
    onreset
  }: {
    /** `vertical` separates left from right and drags along x; `horizontal` along y. */
    orientation: 'vertical' | 'horizontal';
    /**
     * Where it sits: centred in the frame gap past this edge of its positioned
     * parent (`--resize-gap`, the frame gap by default), or `center` on a line
     * inside it.
     */
    edge: 'left' | 'right' | 'top' | 'center';
    label: string;
    testid?: string;
    value: number;
    min: number;
    max: number;
    dragging?: boolean;
    /** Before a drag; false cancels it. */
    onstart?: (handle: HTMLElement) => boolean | void;
    onmove: (delta: number, at: number) => void;
    onend?: () => void;
    onstep: (delta: number, handle: HTMLElement) => void;
    onreset: () => void;
  } = $props();

  const STEP = 16;
  let origin = 0;
  let pointer: number | null = null;
  let handle = $state<HTMLElement | undefined>(undefined);

  function axis(event: PointerEvent): number {
    return orientation === 'vertical' ? event.clientX : event.clientY;
  }

  function mark(on: boolean): void {
    const root = document.documentElement;
    if (on) root.dataset.resizing = orientation === 'vertical' ? 'col' : 'row';
    else delete root.dataset.resizing;
  }

  function down(event: PointerEvent): void {
    if (event.button !== 0 || dragging) return;
    const target = event.currentTarget as HTMLElement;
    if (onstart?.(target) === false) return;
    event.preventDefault();
    origin = axis(event);
    pointer = event.pointerId;
    target.setPointerCapture?.(event.pointerId);
    dragging = true;
    mark(true);
  }

  function move(event: PointerEvent): void {
    if (!dragging || event.pointerId !== pointer) return;
    onmove(axis(event) - origin, axis(event));
  }

  function finish(): void {
    if (!dragging) return;
    if (pointer !== null && handle?.hasPointerCapture?.(pointer)) handle.releasePointerCapture(pointer);
    pointer = null;
    dragging = false;
    mark(false);
    onend?.();
  }

  function up(event: PointerEvent): void {
    if (event.pointerId === pointer) finish();
  }

  function key(event: KeyboardEvent): void {
    if (dragging && event.key === 'Escape') {
      event.preventDefault();
      onmove(0, origin);
      finish();
      return;
    }
    const back = orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp';
    const forth = orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown';
    if (event.key === back || event.key === forth) {
      event.preventDefault();
      onstep(event.key === back ? -STEP : STEP, event.currentTarget as HTMLElement);
    } else if (event.key === 'Home') {
      event.preventDefault();
      onreset();
    }
  }

  // Unmounted mid-drag (the panel closed, the phone width reached): the
  // document must not keep the resize cursor.
  onDestroy(() => {
    if (dragging) mark(false);
  });
</script>

<!-- A focusable separator with a value is a widget in ARIA 1.2; Svelte lists the role as static. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  bind:this={handle}
  class="resize {orientation} {edge}"
  class:dragging
  role="separator"
  tabindex="0"
  aria-orientation={orientation}
  aria-label={label}
  aria-valuenow={Math.round(value)}
  aria-valuemin={Math.round(min)}
  aria-valuemax={Math.round(max)}
  title={label}
  data-testid={testid}
  onpointerdown={down}
  onpointermove={move}
  onpointerup={up}
  onpointercancel={up}
  onlostpointercapture={up}
  ondblclick={onreset}
  onkeydown={key}
>
  <span class="line"></span>
  <span class="grip"></span>
</div>

<style>
  /* The hit area spans the frame gap and the 1 px edge of each card beside it. */
  .resize {
    --hit: 10px;
    --gap: var(--resize-gap, var(--frame-gap));
    --reveal: 160ms;
    position: absolute;
    z-index: 10;
    display: grid;
    place-items: center;
    touch-action: none;
    outline: none;
  }

  .vertical { top: 0; bottom: 0; width: var(--hit); cursor: col-resize; }
  .horizontal { left: 0; right: 0; height: var(--hit); cursor: row-resize; }
  /* `--resize-inset`: a border on the parent, which moves its padding box in. */
  .right { right: calc(var(--gap) / -2 - var(--hit) / 2 - var(--resize-inset, 0px)); }
  .left { left: calc(var(--gap) / -2 - var(--hit) / 2 - var(--resize-inset, 0px)); }
  .top { top: calc(var(--gap) / -2 - var(--hit) / 2 - var(--resize-inset, 0px)); }
  .center.vertical { left: calc(50% - var(--hit) / 2); }
  .center.horizontal { top: calc(50% - var(--hit) / 2); }

  .line,
  .grip {
    grid-area: 1 / 1;
    border-radius: var(--radius-full);
    opacity: 0;
    pointer-events: none;
    /* Out at once: only the way in waits, so a pointer passing by draws nothing. */
    transition:
      opacity var(--dur-2) var(--ease-out-quint),
      transform var(--dur-3) var(--ease-out-quint),
      background var(--dur-2) var(--ease-out-quint),
      box-shadow var(--dur-2) var(--ease-out-quint);
  }

  .line { background: color-mix(in oklch, var(--color-accent) 30%, var(--color-edge)); }
  .vertical .line { width: 2px; height: 100%; transform: scaleY(0.4); }
  .horizontal .line { height: 2px; width: 100%; transform: scaleX(0.4); }

  .grip {
    background: color-mix(in oklch, var(--color-accent) 45%, var(--color-foreground));
    box-shadow: 0 0 0 2px var(--color-background);
  }
  .vertical .grip { width: 4px; height: 28px; transform: scale(0.5, 0.3); }
  .horizontal .grip { height: 4px; width: 28px; transform: scale(0.3, 0.5); }

  .resize:hover .line,
  .resize:hover .grip,
  .resize:focus-visible .line,
  .resize:focus-visible .grip,
  .resize.dragging .line,
  .resize.dragging .grip {
    opacity: 1;
    transform: none;
  }

  .resize:hover:not(.dragging) :is(.line, .grip) { transition-delay: var(--reveal); }

  .resize.dragging .line { background: var(--color-accent); }
  .resize.dragging .grip {
    background: var(--color-accent);
    box-shadow: 0 0 0 2px var(--color-background), 0 0 12px 1px color-mix(in oklch, var(--color-accent) 65%, transparent);
  }
  .resize.dragging.vertical .grip { transform: scaleY(1.3); }
  .resize.dragging.horizontal .grip { transform: scaleX(1.3); }

  .resize:focus-visible .grip {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }

  @media (prefers-reduced-motion: reduce) {
    .line,
    .grip,
    .resize.dragging .grip { transform: none !important; }
  }
  :global(html[data-motion='reduced']) :is(.line, .grip) { transform: none !important; }

  /* The whole document while a handle drags. */
  :global(html[data-resizing]),
  :global(html[data-resizing] *) {
    user-select: none !important;
    -webkit-user-select: none !important;
  }
  :global(html[data-resizing='col']),
  :global(html[data-resizing='col'] *) { cursor: col-resize !important; }
  :global(html[data-resizing='row']),
  :global(html[data-resizing='row'] *) { cursor: row-resize !important; }
  :global(html[data-resizing] :is(iframe, webview, embed, object)) { pointer-events: none !important; }
</style>
