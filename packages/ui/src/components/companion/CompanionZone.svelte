<!--
  Picking what to show: the window covers the screen under the pointer
  (`coverScreen`), dimmed but for the part the user drags over. A click
  without a drag shows the whole screen; a right click cancels, and Escape in
  the companion's window. The shell carries the cover to another screen when
  the pointer goes there with no button down.
-->
<script lang="ts">
  import { strings } from '../../lib/strings';
  import type { HitRect } from '../../lib/companion/shell';

  interface Props {
    /** More than one screen: the hint says the cover follows the pointer. */
    screens: number;
    /** The part picked, in CSS pixels of the window: the whole of it for a click. */
    onpick: (area: HitRect) => void;
    oncancel: () => void;
  }

  let { screens, onpick, oncancel }: Props = $props();

  /** A press that moves less than this, both ways, is a click. */
  const CLICK = 6;

  let from = $state<{ x: number; y: number } | null>(null);
  let to = $state<{ x: number; y: number } | null>(null);
  const box = $derived(from && to ? { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), w: Math.abs(to.x - from.x), h: Math.abs(to.y - from.y) } : null);

  function onpointerdown(event: PointerEvent) {
    if (event.button !== 0) return oncancel();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    from = to = { x: event.clientX, y: event.clientY };
  }

  function onpointermove(event: PointerEvent) {
    if (from) to = { x: event.clientX, y: event.clientY };
  }

  function onpointerup() {
    const picked = box;
    from = to = null;
    if (!picked) return;
    if (picked.w < CLICK && picked.h < CLICK) onpick({ x: 0, y: 0, w: window.innerWidth, h: window.innerHeight });
    // A sliver, thin one way, is no part: the user picks again.
    else if (picked.w >= CLICK && picked.h >= CLICK) onpick(picked);
  }
</script>

<div
  class="zone"
  class:dragging={box !== null}
  role="application"
  aria-label={strings.companion.zoneLabel}
  tabindex="-1"
  data-hit
  data-testid="companion-zone"
  {onpointerdown}
  {onpointermove}
  {onpointerup}
  oncontextmenu={(event) => event.preventDefault()}
>
  {#if box}
    <div class="box" style:left="{box.x}px" style:top="{box.y}px" style:width="{box.w}px" style:height="{box.h}px"></div>
  {:else}
    <p class="hint" role="status">{strings.companion.zoneHint}{#if screens > 1}<br />{strings.companion.zoneOtherScreen}{/if}</p>
  {/if}
</div>

<style>
  .zone {
    position: fixed;
    inset: 0;
    z-index: 10;
    background: var(--color-scrim);
    cursor: crosshair;
    touch-action: none;
    user-select: none;
    animation: dim var(--dur-2) var(--ease-out-quint);
  }
  /* While dragging, the dimming is the box's shadow, with the part left clear. */
  .zone.dragging {
    background: transparent;
  }
  .box {
    position: absolute;
    border: 2px solid var(--color-accent);
    border-radius: var(--radius-sm);
    box-shadow: 0 0 0 100vmax var(--color-scrim);
  }
  .hint {
    position: absolute;
    top: 32px;
    left: 50%;
    transform: translateX(-50%);
    margin: 0;
    padding: 10px 16px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    background: var(--color-surface);
    color: var(--color-foreground);
    box-shadow: var(--shadow-e2);
    font-size: var(--text-sm);
    line-height: 1.5;
    text-align: center;
    pointer-events: none;
  }

  @keyframes dim {
    from {
      opacity: 0;
    }
  }
</style>
