<script lang="ts">
  import { Zap } from '@lucide/svelte';
  import type { EffortLevel } from '@boite/contracts';
  import { Closing } from '../lib/closing.svelte';
  import { floating } from '../lib/floating';
  import { strings } from '../lib/strings';
  import { levelName } from '../lib/format';

  /**
   * The reasoning chip and its popover: a ramp of rising bars, one per level of
   * the model's scale, lit up to the active one, the way a power meter reads.
   * A click on a bar, a drag along the ramp, or the arrows move it, and none of
   * them close the popover: the level is a setting of the model the composer
   * already runs. The chip carries the same ramp in miniature. A model with a
   * fast mode puts a labelled switch beside the level's name, and the chip
   * carries a bolt while it is on.
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
  let dragging = $state(false);
  /** The bar under the pointer while it hovers or drags: the heading reads it before it is picked. */
  let preview = $state<number | null>(null);

  let chosen = $derived(Math.max(0, levels.findIndex((level) => level.id === active)));
  let index = $derived(preview ?? chosen);
  /** The level the model runs, what the chip names. */
  let current = $derived(levels[chosen] ?? null);
  /** The level the popover shows: the hovered or dragged bar, else the chosen one. */
  let viewed = $derived(levels[index] ?? null);
  const selectedSpeed = $derived(speeds.find(entry => entry.id === speed));
  const label = $derived(current ? levelName(current) : selectedSpeed ? levelName(selectedSpeed) : strings.composer.standardSpeed);
  // An accent above a leading capital raises the label's visible centre.
  const accentedCap = $derived(/^\p{Lu}[\u0300-\u0314]/u.test(label.normalize('NFD')));
  function cycleSpeed() { const next = speeds.findIndex(entry => entry.id === speed) + 1; onspeed(next >= speeds.length ? null : speeds[next]!.id); }
  let last = $derived(Math.max(0, levels.length - 1));

  /** A bar's height on the ramp, from a third of it to all of it. */
  function rise(at: number): string {
    return `${34 + (last === 0 ? 1 : at / last) * 66}%`;
  }
  /** How strongly a lit bar wears the accent: the higher the level, the hotter. */
  function heat(at: number): string {
    return `${45 + (last === 0 ? 1 : at / last) * 55}%`;
  }
  /** The chip's ramp: at most six bars, the level scaled onto them. */
  const mini = $derived.by(() => {
    const count = Math.min(6, Math.max(levels.length, 3));
    const lit = levels.length === 0 ? 0 : Math.round(((chosen + 1) / levels.length) * count);
    return Array.from({ length: count }, (_, at) => ({ x: 1 + at * (12 / count), height: 3 + (at / Math.max(1, count - 1)) * 9, on: at < lit }));
  });

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

  /** The bar under the pointer, out of the ramp's own width: every bar is as wide as the others. */
  function nearest(clientX: number): number {
    const box = track?.getBoundingClientRect();
    if (!box || box.width === 0 || last === 0) return index;
    const ratio = (clientX - box.left) / box.width;
    return Math.min(last, Math.max(0, Math.floor(ratio * levels.length)));
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
    // A mouse previews the bar it hovers; a finger only while it drags.
    if (!dragging && event.pointerType !== 'mouse') return;
    preview = nearest(event.clientX);
  }

  function onpointerleave() {
    if (!dragging) preview = null;
  }

  function onpointerup(event: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    const picked = preview;
    preview = event.pointerType === 'mouse' && event.type === 'pointerup' ? picked : null;
    if (picked !== null) pick(picked);
    if (track?.hasPointerCapture(event.pointerId)) track.releasePointerCapture(event.pointerId);
  }

  function ontrackkeydown(event: KeyboardEvent) {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') pick(chosen - 1);
    else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') pick(chosen + 1);
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
    <!-- The popover's ramp in miniature: how hard the model thinks, at a glance. -->
    <svg class="meter" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      {#each mini as bar, at (at)}<rect class:on={bar.on} x={bar.x} y={13 - bar.height} width={Math.max(1.4, 12 / mini.length - 0.9)} height={bar.height} rx="0.8" />{/each}
    </svg>
    <span class="ui-label" class:accented-cap={accentedCap}>{label}</span>
    <!-- A fast mode switched on stays in sight with the popover closed. -->
    {#if current && selectedSpeed}<span class="fast-mark" data-testid="effort-fast-mark" title={levelName(selectedSpeed)}><Zap size={12} fill="currentColor" /></span>{/if}
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
      use:floating={{ anchor: () => trigger ?? null, placement: 'top', dismiss: () => popover.hide() }}
      onanimationend={popover.end}
      {onkeydown}
    >
      <div class="heading">
        <span class="level ui-label" class:previewing={preview !== null && preview !== chosen} class:spectrum={viewed?.id === 'ultrathink'} title={viewed?.description}>{viewed ? levelName(viewed) : strings.composer.standardSpeed}</span>
        {#if speeds.length > 0}
          <button type="button" class="speed" class:active={!!selectedSpeed} data-testid="effort-speed" aria-label={strings.composer.speed} aria-pressed={!!selectedSpeed} title={selectedSpeed?.description ?? (selectedSpeed ? levelName(selectedSpeed) : strings.composer.standardSpeed)} onclick={cycleSpeed}>
            <Zap size={13} fill={selectedSpeed ? 'currentColor' : 'none'} />
            {#if selectedSpeed}<span class="ui-label" data-testid="effort-speed-label">{levelName(selectedSpeed)}</span>{:else}<span class="ui-label">{levelName(speeds[0]!)}</span>{/if}
          </button>
        {/if}
      </div>

      {#if levels.length > 0}
      <div
        class="track"
        class:dragging
        bind:this={track}
        role="slider"
        tabindex="0"
        aria-label={strings.composer.effortTitle}
        aria-valuemin={0}
        aria-valuemax={last}
        aria-valuenow={dragging ? index : chosen}
        aria-valuetext={(dragging ? viewed : current) ? levelName((dragging ? viewed : current)!) : ''}
        data-testid="effort-track"
        onkeydown={ontrackkeydown}
        {onpointerdown}
        {onpointermove}
        {onpointerup}
        {onpointerleave}
        onpointercancel={onpointerup}
      >
        {#each levels as level, at (level.id)}
          {@const lit = dragging ? index : chosen}
          {@const hovering = !dragging && preview !== null && preview !== chosen}
          <button type="button" class="dot" class:on={at <= lit} class:active={at === lit} class:spectrum={level.id === 'ultrathink'}
            class:ghost={hovering && at > chosen && at <= preview!} class:fading={hovering && at > preview! && at <= chosen} class:aim={hovering && at === preview}
            data-dot={level.id} data-value={level.id} title={levelName(level)} aria-label={levelName(level)} tabindex="-1"
            style:--rise={rise(at)} style:--heat={heat(at)} style:--order={at}
            onclick={() => pick(at)}></button>
        {/each}
      </div>
      {/if}

    </div>
  {/if}
</div>

<style>
.effort { position: relative; display: inline-flex; }
.trigger { cursor: pointer; height: var(--control-sm); }
@supports (text-box: trim-both cap alphabetic) {
  .trigger .accented-cap { translate: 0 0.1em; }
}
.trigger:hover, .trigger[aria-expanded='true'] { background: var(--control-glaze) var(--color-control-hover); color: var(--color-foreground); }
.meter { flex: none; }
.meter rect { fill: currentColor; opacity: .28; transition: opacity var(--dur-2), fill var(--dur-2); }
.meter rect.on { fill: var(--color-accent); opacity: 1; }
.fast-mark { display: inline-flex; margin-left: -2px; color: var(--color-accent); }
.popover { position: absolute; bottom: calc(100% + 8px); left: 0; z-index: 40; width: 264px; padding: 12px 14px 14px; background: var(--color-surface-3); border: 1px solid var(--color-border); border-radius: var(--radius-lg); box-shadow: var(--shadow-e2); animation: pop var(--dur-2) var(--ease-out-quint); transform-origin: bottom left; }
.popover.closing { animation-name: pop-out; pointer-events: none; }
.heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 26px; margin-bottom: 10px; color: var(--color-foreground); font-size: var(--text-sm); font-weight: 600; }
.level { white-space: nowrap; transition: color var(--dur-2); }
.level.previewing { color: var(--color-muted-foreground); }
.level.spectrum { background: var(--accent-spectrum); -webkit-background-clip: text; background-clip: text; color: transparent; }
/* A labelled switch: off, an outline that says what it would do; on, the accent. */
.speed { display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 9px 0 7px; border: 1px solid var(--color-edge); border-radius: var(--radius-full); background: transparent; font-size: var(--text-xs); font-weight: 500; color: var(--color-muted-foreground); transition: color var(--dur-2), background var(--dur-2), border-color var(--dur-2), box-shadow var(--dur-2); }
.speed :global(svg) { transition: transform var(--dur-2) var(--ease-out-quint); }
.speed:hover { color: var(--color-accent); border-color: color-mix(in oklch, var(--color-accent) 40%, transparent); }
.speed:hover :global(svg) { transform: rotate(-12deg) scale(1.16); }
.speed.active { color: var(--color-accent); border-color: transparent; background: var(--color-accent-soft); box-shadow: 0 0 14px var(--color-accent-soft); }
.speed:active :global(svg) { transform: scale(.9); }
.track { display: flex; align-items: flex-end; gap: 5px; height: 46px; padding: 0 1px; cursor: pointer; touch-action: none; border-radius: var(--radius-md); }
.track:focus-visible { outline: 1px solid var(--color-reasoning); outline-offset: 4px; }
.dot { flex: 1; height: var(--rise); min-width: 0; padding: 0; border: none; border-radius: 5px; background: var(--color-edge); transition: background var(--dur-2) var(--ease-out-quint), box-shadow var(--dur-3) var(--ease-out-quint), transform var(--dur-3) var(--ease-out-quint), opacity var(--dur-2); transition-delay: calc(var(--order) * 14ms); transform-origin: bottom; }
.track .dot:hover { background: color-mix(in oklch, var(--color-accent) 22%, var(--color-edge)); }
.track .dot.on { background: color-mix(in oklch, var(--color-accent) var(--heat), var(--color-surface-3)); }
.track .dot.on.spectrum { background: var(--accent-spectrum); }
.track .dot.active { box-shadow: 0 0 16px color-mix(in oklch, var(--color-accent) 45%, transparent), inset 0 1px 0 rgb(255 255 255 / .28); transform: scaleY(1.04); }
/* A hovered bar is a proposal: what it would add is tinted, what it would drop dims, and the chosen level stays lit. */
.track .dot.ghost { background: color-mix(in oklch, var(--color-accent) 24%, var(--color-edge)); }
.dot.fading { opacity: .45; }
.dot.aim { box-shadow: inset 0 0 0 1.5px color-mix(in oklch, var(--color-accent) 70%, transparent); }
.dragging .dot, .track:hover .dot { transition-delay: 0ms; }
@media (max-width: 720px) { .popover { position: fixed; left: 18px; right: 18px; bottom: 126px; width: auto; } }
@media (prefers-reduced-motion: reduce) { .dot { transition-delay: 0ms; } }
</style>
