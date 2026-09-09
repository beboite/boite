<script lang="ts">
  import { Brain } from '@lucide/svelte';
  import type { EffortLevel } from '@boite/contracts';
  import { Closing } from '../lib/closing.svelte';
  import { strings } from '../lib/strings';

  /**
   * The reasoning chip and its popover: one dot per level of the model's scale,
   * filled up to the active one. A click on a dot or its name, a drag along the
   * track, or the arrows move it, and none of them close the popover: the level
   * is a setting of the model the composer already runs.
   */
  let {
    levels,
    active,
    onpick
  }: {
    levels: EffortLevel[];
    /** The level the thread or draft runs, the model's own default when it picked none. */
    active: string | null;
    onpick: (id: string) => void;
  } = $props();

  const popover = new Closing();
  let root = $state<HTMLDivElement | undefined>(undefined);
  let trigger = $state<HTMLButtonElement | undefined>(undefined);
  let track = $state<HTMLDivElement | undefined>(undefined);
  let line = $state<HTMLDivElement | undefined>(undefined);
  let dragging = $state(false);

  let index = $derived(Math.max(0, levels.findIndex((level) => level.id === active)));
  let current = $derived(levels[index] ?? null);
  let last = $derived(Math.max(0, levels.length - 1));

  /** The dots are evenly spaced over the line, so a level sits at a plain percentage. */
  function offset(at: number): string {
    return last === 0 ? '50%' : `${(at / last) * 100}%`;
  }

  /** The keyboard lands on the track the moment it is there, so the arrows work at once. */
  $effect(() => {
    if (!popover.open) return;
    track?.focus({ preventScroll: true });
  });

  function toggle(event: MouseEvent) {
    event.stopPropagation();
    popover.toggle();
  }

  function pick(at: number) {
    const level = levels[Math.min(Math.max(at, 0), last)];
    if (!level || level.id === current?.id) return;
    onpick(level.id);
  }

  /** The dot the pointer is nearest, out of the line's own width. */
  function nearest(clientX: number): number {
    const box = line?.getBoundingClientRect();
    if (!box || box.width === 0 || last === 0) return index;
    const ratio = (clientX - box.left) / box.width;
    return Math.round(Math.min(Math.max(ratio, 0), 1) * last);
  }

  function onpointerdown(event: PointerEvent) {
    if (event.button !== 0) return;
    event.preventDefault();
    dragging = true;
    track?.focus({ preventScroll: true });
    track?.setPointerCapture(event.pointerId);
    pick(nearest(event.clientX));
  }

  function onpointermove(event: PointerEvent) {
    if (!dragging) return;
    pick(nearest(event.clientX));
  }

  function onpointerup(event: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    if (track?.hasPointerCapture(event.pointerId)) track.releasePointerCapture(event.pointerId);
  }

  function ontrackkeydown(event: KeyboardEvent) {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') pick(index - 1);
    else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') pick(index + 1);
    else if (event.key === 'Home') pick(0);
    else if (event.key === 'End') pick(last);
    else return;
    event.preventDefault();
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      if (!popover.open) return;
      event.stopPropagation();
      popover.hide();
      trigger?.focus({ preventScroll: true });
      return;
    }
    if (!popover.open && event.key === 'ArrowUp') {
      event.preventDefault();
      popover.show();
    }
  }

  function onWindowPointerdown(event: PointerEvent) {
    if (!popover.open) return;
    if (root && event.target instanceof Node && root.contains(event.target)) return;
    popover.hide();
  }
</script>

<svelte:window onpointerdown={onWindowPointerdown} />

<div class="effort" bind:this={root}>
  <button
    type="button"
    class="chip trigger"
    aria-haspopup="dialog"
    aria-expanded={popover.open}
    aria-label={strings.composer.effortTitle}
    title={strings.composer.effortTitle}
    data-testid="composer-effort"
    bind:this={trigger}
    onclick={toggle}
    {onkeydown}
  >
    <Brain size={14} strokeWidth={1.75} />
    {current?.label ?? ''}
  </button>

  {#if popover.shown}
    <div
      class="popover"
      class:closing={popover.closing}
      role="dialog"
      tabindex="-1"
      aria-label={strings.composer.effortTitle}
      data-testid="composer-effort-menu"
      use:popover.attach
      onanimationend={popover.end}
      {onkeydown}
    >
      <span class="title">{strings.composer.effortTitle}</span>

      <div
        class="track"
        bind:this={track}
        role="slider"
        tabindex="0"
        aria-label={strings.composer.effortTitle}
        aria-valuemin={0}
        aria-valuemax={last}
        aria-valuenow={index}
        aria-valuetext={current?.label ?? ''}
        data-testid="effort-track"
        onkeydown={ontrackkeydown}
        {onpointerdown}
        {onpointermove}
        {onpointerup}
        onpointercancel={onpointerup}
      >
        <div class="line" bind:this={line}>
          {#each levels as level, at (level.id)}
            <span class="dot" class:on={at <= index} data-dot={level.id} style="left: {offset(at)}"></span>
          {/each}
        </div>
      </div>

      <!-- Past four levels the names cannot share one row in 226 px, so they
           alternate between two: every name stays whole and under its own dot. -->
      <div class="ticks" class:stagger={levels.length > 4}>
        {#each levels as level, at (level.id)}
          <button
            type="button"
            class="tick"
            class:on={at === index}
            data-value={level.id}
            title={level.label}
            style="left: {offset(at)}"
            onclick={() => pick(at)}
          >
            {level.label}
          </button>
        {/each}
      </div>

      <p class="description" data-testid="effort-description">{current?.description ?? ''}</p>
    </div>
  {/if}
</div>

<style>
  .effort {
    position: relative;
    display: inline-flex;
  }

  .trigger {
    cursor: pointer;
    height: var(--control-sm);
    transition:
      background var(--dur-2) var(--ease-out-quint),
      color var(--dur-2) var(--ease-out-quint);
  }

  .trigger:hover,
  .trigger[aria-expanded='true'] {
    background: var(--color-surface-3);
    color: var(--color-foreground);
  }

  .popover {
    position: absolute;
    bottom: calc(100% + 6px);
    left: 0;
    z-index: 40;
    display: flex;
    flex-direction: column;
    width: 260px;
    padding: 10px 12px 8px;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-e3);
    animation: pop var(--dur-2) var(--ease-out-quint);
    transform-origin: bottom left;
  }

  .popover.closing {
    animation-name: pop-out;
    pointer-events: none;
  }

  .title {
    font-size: var(--text-sm);
    color: var(--color-muted-foreground);
  }

  /* The whole band takes the pointer, so a click anywhere near the line lands
     on the nearest dot instead of asking for a 10 px target. */
  .track {
    padding: 14px 5px 6px;
    cursor: pointer;
    touch-action: none;
  }

  .track:focus-visible {
    outline: none;
  }

  .track:focus-visible .line {
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--color-foreground) 16%, transparent);
  }

  .line {
    position: relative;
    height: 2px;
    border-radius: 999px;
    background: var(--color-surface-3);
  }

  .dot {
    position: absolute;
    top: 50%;
    width: 10px;
    height: 10px;
    margin-left: -5px;
    margin-top: -5px;
    border-radius: 50%;
    border: 1px solid var(--color-edge);
    background: var(--color-surface-3);
    transition:
      background var(--dur-2) var(--ease-out-quint),
      border-color var(--dur-2) var(--ease-out-quint);
  }

  .dot.on {
    background: var(--color-foreground);
    border-color: var(--color-foreground);
  }

  /* The names ride the same percentages as the dots, so each one sits under its own. */
  .ticks {
    position: relative;
    height: 16px;
    margin: 0 5px;
  }

  .ticks.stagger {
    height: 30px;
  }

  .tick {
    position: absolute;
    top: 0;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
    max-width: 68px;
    height: auto;
    padding: 0;
    transform: translateX(-50%);
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--color-muted-foreground);
    font-size: var(--text-xs);
    font-weight: 500;
    line-height: 1.15;
    text-align: center;
    white-space: normal;
    transition: color var(--dur-2) var(--ease-out-quint);
  }

  /* One name in two drops to the second row, and the extra room lets the long
     ones ("Extra high", "Ultrathink") stay whole. One point smaller so the two
     that meet in the middle of a row keep a gap. */
  .ticks.stagger .tick {
    max-width: 84px;
    font-size: calc(var(--text-xs) - 1px);
  }

  .ticks.stagger .tick:nth-child(even) {
    top: 16px;
  }

  /* The ends stay inside the popover instead of centring off its edge. */
  .tick:first-child {
    transform: none;
    text-align: left;
  }

  .tick:last-child {
    transform: translateX(-100%);
    text-align: right;
  }

  .tick:hover:not(:disabled),
  .tick:focus-visible {
    background: transparent;
    color: var(--color-foreground);
    outline: none;
  }

  .tick.on {
    color: var(--color-foreground);
  }

  /* Held at one line whatever the level says, so the popover never jumps. */
  .description {
    min-height: 18px;
    margin-top: 8px;
    font-size: var(--text-sm);
    line-height: 1.4;
    color: var(--color-muted-foreground);
  }
</style>
