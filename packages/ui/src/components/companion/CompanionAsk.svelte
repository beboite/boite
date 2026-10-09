<!--
  The companion's ask bar: the request, whether the screen goes with it, send
  or stop, and the way to its settings. The screen is offered when the request
  speaks of it (`mentionsScreen`); a click on the eye decides instead.
-->
<script lang="ts">
  import { ArrowUp, ScanEye, Settings, Square } from '@lucide/svelte';
  import { strings } from '../../lib/strings';
  import { mentionsScreen } from '../../lib/companion/screen';

  interface Props {
    draft: string;
    thinking: boolean;
    /** The screen can go with a request: in the desktop shell only. */
    canSee: boolean;
    input?: HTMLInputElement | null;
    onask: (screen: boolean) => void;
    onstop: () => void;
    onsettings: () => void;
  }

  let { draft = $bindable(), thinking, canSee, input = $bindable(null), onask, onstop, onsettings }: Props = $props();

  let choice = $state<boolean | null>(null);
  const screen = $derived(canSee && (choice ?? mentionsScreen(draft)));

  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!draft.trim() || thinking) return;
    onask(screen);
    choice = null;
  }
</script>

<form class="askbar" onsubmit={submit}>
  <input bind:this={input} bind:value={draft} type="text" placeholder={strings.companion.ask} aria-label={strings.companion.askLabel} autocomplete="off" />
  {#if canSee}
    <button
      type="button"
      class="ghost icon eye"
      class:on={screen}
      aria-pressed={screen}
      aria-label={strings.companion.seeScreen}
      title={screen ? strings.companion.seeingScreen : strings.companion.seeScreen}
      onclick={() => (choice = !screen)}
      data-testid="companion-screen-toggle"
    ><ScanEye size={15} /></button>
  {/if}
  {#if thinking}
    <button type="button" class="icon" aria-label={strings.companion.stop} title={strings.companion.stop} onclick={onstop}><Square size={14} /></button>
  {:else}
    <button type="submit" class="primary icon" aria-label={strings.companion.send} title={strings.companion.send} disabled={!draft.trim()}><ArrowUp size={15} /></button>
  {/if}
  <button type="button" class="ghost icon" aria-label={strings.companion.openSettings} title={strings.companion.openSettings} onclick={onsettings}><Settings size={15} /></button>
</form>

<style>
  .askbar {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 8px;
    border-bottom: 1px solid var(--color-border);
  }
  .askbar input {
    flex: 1;
    min-width: 0;
  }
  .eye {
    color: var(--color-muted-foreground);
  }
  .eye.on {
    color: var(--color-accent);
    background: var(--color-accent-soft);
  }
</style>
