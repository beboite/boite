<!--
  The row under the ask bar: start or stop the pomodoro, turn focus on or off,
  and show the earlier exchanges. It holds no state of its own beyond what it
  is handed.
-->
<script lang="ts">
  import { Focus as FocusIcon, History, Timer } from '@lucide/svelte';
  import type { Focus, PomodoroTimer } from '../../lib/companion/focus.svelte';
  import { fill, strings } from '../../lib/strings';

  interface Props {
    timer: PomodoroTimer;
    focus: Focus;
    workMinutes: number;
    breakMinutes: number;
    /** The history is shown. */
    history: boolean;
    onstart: () => void;
  }

  let { timer, focus, workMinutes, breakMinutes, history = $bindable(), onstart }: Props = $props();

  const copy = strings.companion;
</script>

<div class="tools" data-testid="companion-tools">
  {#if timer.current}
    <button type="button" class="chip on" title={copy.pomodoro.stop} onclick={() => timer.stop()} data-testid="companion-pomodoro">
      <Timer size={13} /><span>{copy.pomodoro.stop}</span>
    </button>
  {:else}
    <button
      type="button"
      class="chip"
      title={fill(copy.pomodoro.startTitle, { work: String(workMinutes), rest: String(breakMinutes) })}
      onclick={onstart}
      data-testid="companion-pomodoro"
    >
      <Timer size={13} /><span>{copy.pomodoro.start}</span><span class="dim">{fill(copy.settings.minutes, { count: String(workMinutes) })}</span>
    </button>
  {/if}
  <button
    type="button"
    class="chip"
    class:on={focus.active}
    aria-pressed={focus.active}
    title={focus.active ? copy.focus.turnOff : copy.focus.turnOn}
    onclick={() => focus.toggle()}
    data-testid="companion-focus"
  >
    <FocusIcon size={13} /><span>{copy.focus.label}</span>
  </button>
  <button type="button" class="chip" class:on={history} aria-expanded={history} onclick={() => (history = !history)} data-testid="companion-history-toggle">
    <History size={13} /><span>{copy.history.label}</span>
  </button>
</div>

<style>
  .tools {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 8px;
    border-bottom: 1px solid var(--color-border);
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    cursor: pointer;
  }
  .chip.on {
    border-color: var(--color-accent);
    background: var(--color-accent-soft);
    color: var(--color-accent);
  }
  .chip:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 1px;
  }
  .dim {
    color: var(--color-muted-foreground);
  }
</style>
