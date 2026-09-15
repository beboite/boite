<script lang="ts">
  import { Brain, Zap } from '@lucide/svelte';
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
    onpick,
    speeds = [],
    speed = null,
    onspeed = () => {}
  }: {
    levels: EffortLevel[];
    /** The level the thread or draft runs, the model's own default when it picked none. */
    active: string | null;
    onpick: (id: string) => void;
    speeds?: { id: string; label: string; description?: string }[];
    speed?: string | null;
    onspeed?: (id: string | null) => void;
  } = $props();

  const popover = new Closing();
  let root = $state<HTMLDivElement | undefined>(undefined);
  let trigger = $state<HTMLButtonElement | undefined>(undefined);
  let track = $state<HTMLDivElement | undefined>(undefined);
  let line = $state<HTMLDivElement | undefined>(undefined);
  let dragging = $state(false);
  let preview = $state<number | null>(null);

  let index = $derived(preview ?? Math.max(0, levels.findIndex((level) => level.id === active)));
  let current = $derived(levels[index] ?? null);
  const selectedSpeed = $derived(speeds.find(entry => entry.id === speed));
  function cycleSpeed() { const next = speeds.findIndex(entry => entry.id === speed) + 1; onspeed(next >= speeds.length ? null : speeds[next]!.id); }
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
    preview = nearest(event.clientX);
  }

  function onpointermove(event: PointerEvent) {
    if (!dragging) return;
    preview = nearest(event.clientX);
  }

  function onpointerup(event: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    const chosen = preview;
    preview = null;
    if (chosen !== null) pick(chosen);
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
    {current?.label ?? selectedSpeed?.label ?? strings.composer.standardSpeed}
  </button>

  {#if speeds.length > 0}
    <button type="button" class="chip speed" class:active={!!selectedSpeed} data-testid="effort-speed" aria-label={strings.composer.speed} aria-pressed={!!selectedSpeed} title={selectedSpeed?.description ?? selectedSpeed?.label ?? strings.composer.standardSpeed} onclick={cycleSpeed}>
      <Zap size={15} fill={selectedSpeed ? 'currentColor' : 'none'} />
      {#if selectedSpeed}<span data-testid="effort-speed-label">{selectedSpeed.label}</span>{/if}
    </button>
  {/if}

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
      <div class="heading">
        <span class="level">{current?.label ?? strings.composer.standardSpeed}</span>
      </div>

      {#if levels.length > 0}
      <div
        class="track"
        style:--effort-intensity={`${40 + (last === 0 ? 1 : index / last) * 60}%`}
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
          <span class="progress" style="width: calc({offset(index)} + 12px)"></span>
          <span class="thumb" style="left: {offset(index)}"></span>
          {#each levels as level, at (level.id)}
            <button type="button" class="dot" class:on={at <= index} data-dot={level.id} data-value={level.id} title={level.label} aria-label={level.label} tabindex="-1" style="left: {offset(at)}" onclick={() => pick(at)}></button>
          {/each}
        </div>
      </div>
      {/if}

    </div>
  {/if}
</div>

<style>
.effort { position: relative; display: inline-flex; gap: 4px; }
.trigger { cursor: pointer; height: var(--control-sm); }
.trigger:hover, .trigger[aria-expanded='true'] { background: var(--color-surface-3); color: var(--color-foreground); }
.popover { position: absolute; bottom: calc(100% + 8px); left: 0; z-index: 40; width: 280px; padding: 10px 12px 12px; background: var(--color-surface-3); border: 1px solid var(--color-border); border-radius: var(--radius-lg); box-shadow: var(--shadow-e2); animation: pop var(--dur-2) var(--ease-out-quint); transform-origin: bottom left; }
.popover.closing { animation-name: pop-out; pointer-events: none; }
.heading { display: flex; justify-content: center; align-items: center; min-height: 22px; margin-bottom: 8px; color: var(--color-foreground); font-size: var(--text-sm); font-weight: 600; }
.level { white-space: nowrap; }
.speed { height: var(--control-sm); color: var(--color-muted-foreground); transition: color var(--dur-2), background var(--dur-2), box-shadow var(--dur-2); }
.speed :global(svg) { transition: transform var(--dur-2) var(--ease-out-quint); }
.speed:hover { color: var(--color-accent); background: var(--color-accent-soft); box-shadow: 0 0 12px var(--color-accent-soft); }
.speed:hover :global(svg) { transform: rotate(-12deg) scale(1.16); }
.speed.active { color: var(--color-accent); background: var(--color-accent-soft); }
.speed:active :global(svg) { transform: scale(.9); }
.track { padding: 3px 12px; cursor: pointer; touch-action: none; height: 30px; background: var(--color-edge); border-radius: 999px; }
.track:focus-visible { outline: 1px solid var(--color-reasoning); outline-offset: 3px; }
.line { position: relative; height: 24px; }
.progress { position: absolute; inset: 0 auto 0 -12px; border-radius: 999px 0 0 999px; background: color-mix(in oklch, var(--color-accent) var(--effort-intensity), var(--color-surface-3)); transition: background var(--dur-2); }
.dot { position: absolute; top: 50%; width: 16px; height: 24px; padding: 0; border: none; background: transparent; transform: translate(-50%, -50%); }
.dot::after { content: ""; display: block; width: 4px; height: 4px; margin: auto; border-radius: 50%; background: var(--color-muted-foreground); }
.dot.on::after { background: var(--color-reasoning-on); opacity: .45; }
.thumb { position: absolute; top: 50%; width: 28px; height: 28px; transform: translate(-50%, -50%); border-radius: 50%; background: var(--color-reasoning-on); box-shadow: var(--shadow-e1); z-index: 1; }
@media (max-width: 720px) { .popover { position: fixed; left: 18px; right: 18px; bottom: 126px; width: auto; } }
</style>
