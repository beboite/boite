<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { Search } from '@lucide/svelte';
  import type { ThreadSummary } from '@boite/contracts';
  import { Closing } from '../lib/closing.svelte';
  import { appCommands, runCommand } from '../lib/commands.svelte';
  import { PALETTE_LIMIT, RECENT_THREADS, rankItems, type PaletteItem } from '../lib/palette';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import { workspace } from '../lib/workspace.svelte';
  import StatusMark from './StatusMark.svelte';

  let { store }: { store: Store } = $props();

  const overlay = new Closing();
  let query = $state('');
  let selected = $state(0);
  let input = $state<HTMLInputElement | undefined>(undefined);
  let list = $state<HTMLDivElement | undefined>(undefined);

  const inShell = window.__TAURI_INTERNALS__ !== undefined;

  $effect(() => {
    if (!store.paletteOpen) {
      overlay.hide();
      return;
    }
    query = '';
    selected = 0;
    overlay.show();
    void tick().then(() => input?.focus({ preventScroll: true }));
  });

  /** Every live thread, most recent first; the list cuts it to the recents until something is typed. */
  let threadItems = $derived.by((): PaletteItem[] =>
    (workspace.machines.length ? workspace.machines : [{ id: '', label: '', store }]).flatMap(machine => [...machine.store.threads]
      .filter((t) => !t.archived)
      .map((t) => ({
        id: `thread:${machine.store.threadKey(t.id)}`,
        kind: 'thread' as const,
        label: t.title,
        hint: `${machine.store.projects.find(p => p.id === t.projectId)?.name ?? ''} · ${machine.label}`,
        keywords: t.status,
        at: t.lastUserMessageAt ?? t.createdAt
      }))).sort((a,b) => b.at - a.at)
  );

  let commandItems = $derived.by((): PaletteItem[] => appCommands(store, inShell));

  /** Threads first, commands after: a query ranks across both, nothing typed shows the recents. */
  let rows = $derived.by((): PaletteItem[] => {
    const typed = query.trim().length > 0;
    const threads = typed ? threadItems : threadItems.slice(0, RECENT_THREADS);
    return rankItems(query, [...threads, ...commandItems], PALETTE_LIMIT);
  });

  // The walk starts over on what the user typed, never on the list being
  // rebuilt: the core pushes a `thread.updated` a second per live agent, and
  // the selection cannot jump back to the top under his fingers.
  $effect(() => {
    void query;
    untrack(() => (selected = 0));
  });

  /** A shorter list keeps the keyboard on a row that is still there. */
  $effect(() => {
    const count = rows.length;
    untrack(() => {
      if (selected >= count) selected = Math.max(0, count - 1);
    });
  });

  $effect(() => {
    const row = list?.querySelector<HTMLElement>(`[data-index="${selected}"]`);
    // jsdom draws nothing and has no scrollIntoView; a real list keeps the row in view.
    if (row && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' });
  });

  function close() {
    store.paletteOpen = false;
  }

  function pick(item: PaletteItem) {
    close();
    if (item.kind === 'thread') {
      store.showChat();
      if (workspace.machines.length) void workspace.openNotification(item.id.slice('thread:'.length));
      else void store.open(item.id.slice('thread:'.length));
      return;
    }
    runCommand(store, item.id, inShell);
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const item = rows[selected];
      if (item) pick(item);
      return;
    }
    if (rows.length === 0) return;
    if (event.key === 'ArrowDown') selected = (selected + 1) % rows.length;
    else if (event.key === 'ArrowUp') selected = (selected - 1 + rows.length) % rows.length;
    else if (event.key === 'Home') selected = 0;
    else if (event.key === 'End') selected = rows.length - 1;
    else return;
    event.preventDefault();
  }

  function threadOf(item: PaletteItem): ThreadSummary | null {
    if (item.kind !== 'thread') return null;
    const id = item.id.slice('thread:'.length);
    const hosts = workspace.machines.length ? workspace.machines.map(m => m.store) : [store];
    for (const host of hosts) { const thread = host.threads.find(t => host.threadKey(t.id) === id); if (thread) return thread; }
    return null;
  }

  /** The heading before a row: only where the kind changes. */
  function heading(index: number): string | null {
    const item = rows[index];
    if (!item) return null;
    const previous = rows[index - 1];
    if (previous && previous.kind === item.kind) return null;
    return item.kind === 'thread' ? strings.palette.threads : strings.palette.commands;
  }
</script>

{#if overlay.shown}
  <div
    class="scrim"
    class:closing={overlay.closing}
    role="presentation"
    use:overlay.attach
    onanimationend={overlay.end}
    onclick={(event) => {
      if (event.target === event.currentTarget) close();
    }}
  >
    <div class="palette" class:closing={overlay.closing} role="dialog" aria-modal="true" aria-label={strings.palette.placeholder} data-testid="palette">
      <label class="field">
        <Search size={16} strokeWidth={1.75} />
        <input
          bind:this={input}
          bind:value={query}
          placeholder={strings.palette.placeholder}
          aria-label={strings.palette.placeholder}
          autocomplete="off"
          spellcheck="false"
          data-testid="palette-input"
          {onkeydown}
        />
        <span class="kbd">Esc</span>
      </label>
      <div class="list" role="listbox" bind:this={list} data-testid="palette-list">
        {#each rows as item, index (item.id)}
          {@const thread = threadOf(item)}
          {@const title = heading(index)}
          {#if title}
            <div class="section-label">{title}</div>
          {/if}
          <button
            type="button"
            class="row"
            class:selected={index === selected}
            role="option"
            aria-selected={index === selected}
            data-index={index}
            data-testid="palette-row"
            data-palette-id={item.id}
            onmousemove={() => (selected = index)}
            onclick={() => pick(item)}
          >
            {#if thread}
              <span class="mark-slot"><StatusMark status={thread.status} unread={thread.unread} /></span>
            {/if}
            <span class="label">{item.label}</span>
            {#if item.hint}
              <span class="hint" class:kbd={item.kind === 'command'}>{item.hint}</span>
            {/if}
          </button>
        {/each}
        {#if rows.length === 0}
          <p class="empty subtle">{strings.palette.empty}</p>
        {/if}
      </div>
      <div class="foot subtle">{strings.palette.hint}</div>
    </div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: min(14vh, 120px);
    background: var(--color-scrim);
    backdrop-filter: blur(4px);
    animation: fade var(--dur-2) var(--ease-out-quint);
  }

  .scrim.closing {
    animation-name: fade-out;
    pointer-events: none;
  }

  .palette {
    width: min(560px, calc(100vw - 32px));
    max-height: min(70vh, 520px);
    display: flex;
    flex-direction: column;
    background: var(--color-surface);
    border: 1px solid var(--color-edge);
    border-radius: var(--radius-xl);
    box-shadow: var(--shadow-e3);
    overflow: hidden;
    animation: pop var(--dur-2) var(--ease-out-quint);
  }

  .palette.closing {
    animation-name: pop-out;
  }

  .field {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 48px;
    padding: 0 14px;
    border-bottom: 1px solid var(--color-border);
    color: var(--color-subtle);
  }

  .field input {
    flex: 1;
    min-width: 0;
    height: 100%;
    padding: 0;
    border: none;
    background: transparent;
    font-size: var(--text-md);
    color: var(--color-foreground);
  }

  .field input:focus {
    outline: none;
  }

  .list {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 6px;
  }

  .section-label {
    padding: 8px 8px 4px;
  }

  .row {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 10px;
    height: var(--row);
    padding: 0 10px;
    border: none;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--color-foreground);
    text-align: left;
    justify-content: flex-start;
  }

  .row:hover:not(:disabled) {
    background: transparent;
  }

  .row.selected {
    background: var(--color-active);
  }

  .row:active:not(:disabled) {
    transform: none;
  }

  .mark-slot {
    display: inline-flex;
    width: 10px;
    justify-content: center;
    flex: none;
  }

  .label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 400;
  }

  .hint {
    flex: none;
    font-size: var(--text-sm);
    color: var(--color-muted-foreground);
  }

  .empty {
    padding: 14px 10px;
    text-align: center;
    font-size: var(--text-sm);
  }

  .foot {
    padding: 6px 14px 8px;
    border-top: 1px solid var(--color-border);
    font-size: var(--text-xs);
  }
</style>
