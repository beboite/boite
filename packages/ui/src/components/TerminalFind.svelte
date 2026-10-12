<script lang="ts">
  import { ChevronDown, ChevronUp, X } from '@lucide/svelte';
  import { onMount } from 'svelte';
  import { fill, strings } from '../lib/strings';
  import type { TerminalSession } from '../lib/terminal-session.svelte';

  /**
   * The find bar over one shell's screen, Windows Terminal's Ctrl+Shift+F.
   * Matches are found as the query is typed, highlighted on the screen and on
   * the scrollbar. Enter goes to the next one up the scrollback (the newest
   * output is at the bottom), Shift+Enter down, Escape closes.
   */
  let { session }: { session: TerminalSession } = $props();

  let input = $state<HTMLInputElement | undefined>(undefined);
  let query = $state('');

  onMount(() => {
    input?.focus();
    input?.select();
  });

  function step(backwards: boolean) {
    session.find(query, backwards);
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      // Up the scrollback first: what was printed last is at the bottom already.
      step(!event.shiftKey);
    } else if (event.key === 'Escape') {
      // Taken here, so the page's Escape does not stop a running turn.
      event.preventDefault();
      event.stopPropagation();
      session.closeSearch();
    }
  }

  let results = $derived(session.searchResults);
</script>

<div class="find" role="search" data-testid="terminal-find">
  <input
    bind:this={input}
    bind:value={query}
    oninput={() => session.find(query, true)}
    {onkeydown}
    placeholder={strings.terminal.find}
    aria-label={strings.terminal.find}
    spellcheck="false"
    autocomplete="off"
    data-testid="terminal-find-input"
  />
  <span class="count" aria-live="polite" data-testid="terminal-find-count">
    {#if query.length > 0 && results !== null}
      {results.count === 0 ? strings.chat.findNone : results.index < 0
        ? String(results.count)
        : fill(strings.chat.findCount, { at: String(results.index + 1), total: String(results.count) })}
    {/if}
  </span>
  <button type="button" class="ghost small icon" title={strings.chat.findPrevious} aria-label={strings.chat.findPrevious}
    disabled={query.length === 0} onclick={() => step(true)} data-testid="terminal-find-previous"><ChevronUp size={14} /></button>
  <button type="button" class="ghost small icon" title={strings.chat.findNext} aria-label={strings.chat.findNext}
    disabled={query.length === 0} onclick={() => step(false)} data-testid="terminal-find-next"><ChevronDown size={14} /></button>
  <button type="button" class="ghost small icon" title={strings.common.close} aria-label={strings.common.close}
    onclick={() => session.closeSearch()} data-testid="terminal-find-close"><X size={14} /></button>
</div>

<style>
  .find {
    position: absolute;
    top: 6px;
    right: 18px;
    z-index: 4;
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 3px 3px 3px 10px;
    border: 1px solid var(--color-edge);
    border-radius: var(--radius-md);
    background: var(--color-surface);
    box-shadow: var(--shadow-e2);
    animation: pop var(--dur-2) var(--ease-out-quint);
  }

  input {
    width: 200px;
    height: var(--control-sm);
    padding: 0;
    border: none;
    background: transparent;
    font-family: var(--font-terminal);
    font-size: var(--text-sm);
  }

  input:focus { outline: none; }

  .count {
    min-width: 52px;
    padding: 0 6px;
    color: var(--color-muted-foreground);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
    text-align: right;
    white-space: nowrap;
  }

  @media (max-width: 720px) {
    .find { left: 8px; right: 8px; }
    input { flex: 1; width: auto; min-width: 0; }
  }
</style>
