<!--
  The companion's ask bar: the request, whether the screen goes with it, send
  or stop, and the way to its settings. The screen is offered when the request
  speaks of it (`mentionsScreen`); a click on the eye decides instead. While it
  goes, a row under the bar says what it shows: every screen, the one the
  companion is on, or a part the user picks on sending.
-->
<script lang="ts">
  import { ArrowUp, ScanEye, Settings, Square } from '@lucide/svelte';
  import { fill, strings } from '../../lib/strings';
  import { mentionsScreen, type ScreenScope } from '../../lib/companion/screen';

  interface Props {
    draft: string;
    thinking: boolean;
    /** The screen can go with a request: in the desktop shell only. */
    canSee: boolean;
    /** How many screens there are: with one, it is every screen. */
    screens: number;
    scope: ScreenScope;
    input?: HTMLInputElement | null;
    onask: (screen: boolean) => void;
    onscope: (scope: ScreenScope) => void;
    onstop: () => void;
    onsettings: () => void;
    /** The agent asked, named when several stand side by side. */
    to?: string | null;
  }

  let { draft = $bindable(), thinking, canSee, screens, scope, input = $bindable(null), onask, onscope, onstop, onsettings, to = null }: Props = $props();

  let choice = $state<boolean | null>(null);
  const screen = $derived(canSee && (choice ?? mentionsScreen(draft)));

  const scopes = $derived([
    ...(screens > 1 ? [{ id: 'all' as const, label: strings.companion.screenAll, title: strings.companion.screenAll }] : []),
    { id: 'here' as const, label: strings.companion.screenHere, title: strings.companion.screenHere },
    { id: 'zone' as const, label: strings.companion.screenZone, title: strings.companion.screenZoneTitle }
  ]);
  /** With one screen, every screen is this one. */
  const shown = $derived(scope === 'all' && screens <= 1 ? 'here' : scope);

  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!draft.trim() || thinking) return;
    onask(screen);
    choice = null;
  }
</script>

<form class="askbar" onsubmit={submit}>
  <input bind:this={input} bind:value={draft} type="text" placeholder={to ? fill(strings.companion.askTo, { name: to }) : strings.companion.ask} aria-label={to ? fill(strings.companion.askToLabel, { name: to }) : strings.companion.askLabel} autocomplete="off" />
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

{#if screen}
  <div class="scopes" role="radiogroup" aria-label={strings.companion.screenScope} data-testid="companion-screen-scope">
    {#each scopes as option (option.id)}
      <button type="button" class="chip" class:on={shown === option.id} role="radio" aria-checked={shown === option.id} title={option.title} onclick={() => onscope(option.id)}>
        {option.label}
      </button>
    {/each}
  </div>
{/if}

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
  .scopes {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 8px;
    border-bottom: 1px solid var(--color-border);
    animation: unfold var(--dur-2) var(--ease-out-quint);
  }
  .scopes .chip {
    cursor: pointer;
  }
  .scopes .chip.on {
    border-color: var(--color-accent);
    background: var(--color-accent-soft);
    color: var(--color-accent);
  }
  .scopes .chip:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 1px;
  }

  @keyframes unfold {
    from {
      opacity: 0;
    }
  }
</style>
