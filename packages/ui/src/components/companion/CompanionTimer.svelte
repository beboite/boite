<!--
  The pomodoro's countdown in the HUD, beside the activity pill: the phase,
  the time left and what it is for. On hover or keyboard focus it shows its
  controls: pause or resume, skip the break, stop. Hidden without a timer.
-->
<script lang="ts">
  import { Coffee, Pause, Play, SkipForward, Square, Timer } from '@lucide/svelte';
  import type { PomodoroTimer } from '../../lib/companion/focus.svelte';
  import { clock } from '../../lib/companion/pomodoro';
  import { inShell } from '../../lib/companion/shell';
  import { fill, strings } from '../../lib/strings';

  interface Props {
    timer: PomodoroTimer;
    /** The shell's word that the pointer is on the companion (`senses.hover`). */
    hover: boolean;
    /** The chip changed size, for the page to read its hit areas again. */
    onresize: () => void;
  }

  let { timer, hover, onresize }: Props = $props();

  const copy = strings.companion.pomodoro;

  let pointer = $state(false);
  let keyboard = $state(false);
  const open = $derived(pointer || keyboard);

  // A click-through window does not see the pointer go: the shell's word wins.
  $effect(() => {
    if (inShell() && !hover) pointer = false;
  });

  const resting = $derived(timer.phase === 'break');
  const phaseName = $derived(resting ? copy.rest : copy.work);
  const time = $derived(clock(timer.left));
  const said = $derived(fill(timer.paused ? copy.paused : copy.left, { phase: phaseName, time }));

  let width = $state(0);
  $effect(() => {
    void [width, open];
    requestAnimationFrame(onresize);
  });
</script>

{#if timer.current}
  <div
    class="timer"
    class:resting
    class:paused={timer.paused}
    data-hit
    data-testid="companion-timer"
    role="timer"
    aria-label={said}
    bind:offsetWidth={width}
    onpointerenter={() => (pointer = true)}
    onpointerleave={() => (pointer = false)}
    onfocusin={(event) => (keyboard = (event.target as HTMLElement).matches(':focus-visible'))}
    onfocusout={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) keyboard = false;
    }}
  >
    <span class="mark" aria-hidden="true">{#if resting}<Coffee size={13} />{:else}<Timer size={13} />{/if}</span>
    <span class="time" aria-hidden="true">{time}</span>
    {#if timer.current.label && !resting}<span class="label" title={timer.current.label}>{timer.current.label}</span>{/if}
    <span class="controls" class:open>
      {#if timer.paused}
        <button class="ghost icon" aria-label={copy.resume} title={copy.resume} onclick={() => timer.resume()} data-testid="companion-timer-resume"><Play size={12} /></button>
      {:else}
        <button class="ghost icon" aria-label={copy.pause} title={copy.pause} onclick={() => timer.pause()} data-testid="companion-timer-pause"><Pause size={12} /></button>
      {/if}
      {#if resting}
        <button class="ghost icon" aria-label={copy.skipBreak} title={copy.skipBreak} onclick={() => timer.skip()}><SkipForward size={12} /></button>
      {/if}
      <button class="ghost icon" aria-label={copy.stop} title={copy.stop} onclick={() => timer.stop()} data-testid="companion-timer-stop"><Square size={11} /></button>
    </span>
  </div>
{/if}

<style>
  .timer {
    flex: none;
    display: flex;
    align-items: center;
    gap: 6px;
    height: 30px;
    padding: 0 4px 0 9px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-full);
    background: var(--color-surface);
    box-shadow: var(--shadow-e2);
    font-size: var(--text-xs);
    animation: rise var(--dur-2) var(--ease-out-quint);
  }
  .mark {
    display: grid;
    color: var(--color-live);
  }
  .resting .mark {
    color: var(--color-success);
  }
  .time {
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .paused .time {
    color: var(--color-muted-foreground);
    animation: blink 1.6s ease-in-out infinite;
  }
  .label {
    max-width: 110px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-muted-foreground);
  }
  /* The controls unfold on hover, from nothing: the chip stays small otherwise. */
  .controls {
    display: flex;
    max-width: 0;
    overflow: hidden;
    opacity: 0;
    transition:
      max-width var(--dur-3) var(--ease-out-quint),
      opacity var(--dur-2) var(--ease-out-quint);
  }
  .controls.open {
    max-width: 80px;
    opacity: 1;
  }
  /* Folded, the buttons stay reachable by Tab: focusing one unfolds them. */
  .timer:not(:has(.controls.open)) {
    padding-right: 10px;
  }
  .controls button {
    width: 22px;
    height: 22px;
    min-width: 0;
    padding: 0;
    border-radius: var(--radius-full);
  }

  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(-3px);
    }
  }
  @keyframes blink {
    50% {
      opacity: 0.45;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .timer,
    .paused .time,
    .controls {
      animation: none;
      transition: none;
    }
  }
</style>
