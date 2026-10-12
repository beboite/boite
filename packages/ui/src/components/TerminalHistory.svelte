<script lang="ts">
  import { CornerDownLeft, History, X } from '@lucide/svelte';
  import { onMount, tick } from 'svelte';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import { filterCommands } from '../lib/terminal-marks';
  import type { TerminalSession } from '../lib/terminal-session.svelte';

  /**
   * The shell's recent commands over its screen, newest first, from its own
   * history file: what the up arrow walks through, across past sessions, with
   * a search. Enter runs the one picked, Shift+Enter puts it at the prompt to
   * edit, Escape goes back to the shell.
   */
  let { store, session }: { store: Store; session: TerminalSession } = $props();
  /** One per list: two panes of a split can show theirs at once. */
  const listId = $props.id();

  let input = $state<HTMLInputElement | undefined>(undefined);
  let list = $state<HTMLUListElement | undefined>(undefined);
  let query = $state('');
  let commands = $state<string[] | null | undefined>(undefined);
  let selected = $state(0);
  let shown = $derived(commands ? filterCommands(commands, query) : []);

  onMount(() => {
    input?.focus();
    let live = true;
    void store.terminalHistory(session.id).then((found) => { if (live) commands = found; });
    return () => { live = false; };
  });

  $effect(() => {
    void query;
    selected = 0;
  });

  async function reveal() {
    await tick();
    list?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }

  function pick(command: string, run: boolean) {
    session.useCommand(command, run);
  }

  /** Escape from anywhere in the list, the close button included: the page's Escape would stop a turn. */
  function onEscape(event: KeyboardEvent) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    session.closeHistory();
  }

  /** The search field's keys: the arrows walk the list, Enter picks. */
  function onkeydown(event: KeyboardEvent) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (shown.length === 0) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      selected = (selected + step + shown.length) % shown.length;
      void reveal();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const command = shown[selected];
      if (command !== undefined) pick(command, !event.shiftKey);
    }
  }

  /** The first line of a multi-line command, and how many follow. */
  function firstLine(command: string): { text: string; more: number } {
    const lines = command.split('\n');
    return { text: lines[0] ?? '', more: lines.length - 1 };
  }
</script>

<div class="history" role="dialog" tabindex="-1" aria-label={strings.terminal.history} onkeydown={onEscape} data-testid="terminal-history">
  <div class="search">
    <History size={14} strokeWidth={1.75} />
    <input
      bind:this={input}
      bind:value={query}
      {onkeydown}
      placeholder={strings.terminal.historySearch}
      aria-label={strings.terminal.historySearch}
      aria-controls={listId}
      spellcheck="false"
      autocomplete="off"
      data-testid="terminal-history-input"
    />
    <button type="button" class="ghost small icon" title={strings.common.close} aria-label={strings.common.close}
      onclick={() => session.closeHistory()} data-testid="terminal-history-close"><X size={14} /></button>
  </div>
  {#if commands === undefined}
    <p class="note" role="status">{strings.terminal.historyLoading}</p>
  {:else if commands === null}
    <p class="note" role="status">{strings.terminal.historyOld}</p>
  {:else if commands.length === 0}
    <p class="note" role="status">{strings.terminal.historyEmpty}</p>
  {:else if shown.length === 0}
    <p class="note" role="status">{strings.terminal.historyNone}</p>
  {:else}
    <ul id={listId} role="listbox" bind:this={list} aria-label={strings.terminal.history}>
      {#each shown as command, index (command)}
        {@const line = firstLine(command)}
        <li role="option" aria-selected={index === selected} data-testid="terminal-history-item">
          <button type="button" tabindex="-1" title={command}
            onpointerenter={() => { selected = index; }}
            onclick={(event) => pick(command, !event.shiftKey)}>
            <span class="text">{line.text}</span>
            {#if line.more > 0}<span class="more">+{line.more}</span>{/if}
            {#if index === selected}<CornerDownLeft size={12} strokeWidth={1.75} />{/if}
          </button>
        </li>
      {/each}
    </ul>
    <p class="hint">{strings.terminal.historyHint}</p>
  {/if}
</div>

<style>
  .history {
    position: absolute;
    top: 6px;
    right: 18px;
    z-index: 4;
    display: flex;
    flex-direction: column;
    width: min(520px, calc(100% - 36px));
    max-height: calc(100% - 12px);
    border: 1px solid var(--color-edge);
    border-radius: var(--radius-md);
    background: var(--color-surface);
    box-shadow: var(--shadow-e2);
    overflow: hidden;
    animation: pop var(--dur-2) var(--ease-out-quint);
  }

  .search {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: none;
    padding: 3px 3px 3px 10px;
    border-bottom: 1px solid var(--color-border);
    color: var(--color-muted-foreground);
  }

  input {
    flex: 1;
    min-width: 0;
    height: var(--control-sm);
    padding: 0;
    border: none;
    background: transparent;
    font-family: var(--font-terminal);
    font-size: var(--text-sm);
    color: var(--color-foreground);
  }

  input:focus { outline: none; }

  ul {
    flex: 1;
    min-height: 0;
    margin: 0;
    padding: 4px;
    list-style: none;
    overflow-y: auto;
  }

  li button {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    height: 26px;
    padding: 0 8px;
    border: none;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--color-foreground);
    font-family: var(--font-terminal);
    font-size: var(--text-sm);
    text-align: left;
    cursor: pointer;
  }

  li[aria-selected='true'] button { background: var(--color-active); }

  .text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: pre;
  }

  .more {
    flex: none;
    font-size: var(--text-xs);
    color: var(--color-muted-foreground);
  }

  .note, .hint {
    margin: 0;
    padding: 10px 12px;
    font-size: var(--text-xs);
    color: var(--color-muted-foreground);
  }

  .hint {
    flex: none;
    padding: 6px 12px;
    border-top: 1px solid var(--color-border);
  }

  @media (max-width: 720px) {
    .history { left: 8px; right: 8px; width: auto; }
  }
</style>
