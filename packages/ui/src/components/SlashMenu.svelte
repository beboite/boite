<script lang="ts">
  import { AGENT_PREFIX, isAgentCommand, slashName } from '../lib/commands.svelte';
  import { Closing } from '../lib/closing.svelte';
  import type { PaletteItem } from '../lib/palette';
  import { strings } from '../lib/strings';

  /**
   * What `/` opens over the composer: the agent's own commands first, Boite's
   * under them. The composer owns the query, the selection and the keyboard;
   * this only draws, and closes the way the picker does.
   */
  let {
    open,
    items,
    selected,
    onpick,
    onhover
  }: {
    open: boolean;
    items: PaletteItem[];
    /** The row the keyboard is on, an index into `items`. */
    selected: number;
    onpick: (item: PaletteItem) => void;
    onhover: (index: number) => void;
  } = $props();

  const popover = new Closing();
  let list = $state<HTMLDivElement | undefined>(undefined);

  $effect(() => {
    if (open) popover.show();
    else popover.hide();
  });

  $effect(() => {
    void items;
    const row = list?.querySelector<HTMLElement>(`[data-index="${selected}"]`);
    // jsdom draws nothing and has no scrollIntoView; a real list keeps the row in view.
    if (row && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' });
  });

  /** The heading before a row: only where the group changes, like the palette. */
  function heading(index: number): string | null {
    const item = items[index];
    if (!item) return null;
    const previous = items[index - 1];
    if (previous && isAgentCommand(previous) === isAgentCommand(item)) return null;
    return isAgentCommand(item) ? strings.slash.agent : strings.slash.app;
  }

  function nameOf(item: PaletteItem): string {
    return isAgentCommand(item) ? item.id.slice(AGENT_PREFIX.length) : slashName(item);
  }
</script>

{#if popover.shown}
  <div
    class="slash"
    class:closing={popover.closing}
    role="listbox"
    aria-label={strings.slash.label}
    tabindex="-1"
    data-testid="slash-menu"
    bind:this={list}
    use:popover.attach
    onanimationend={popover.end}
  >
    {#each items as item, index (item.id)}
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
        data-testid="slash-row"
        data-name={nameOf(item)}
        onmousemove={() => onhover(index)}
        onmousedown={(event) => event.preventDefault()}
        onclick={() => onpick(item)}
      >
        <span class="head">
          <span class="name">{item.label}</span>
          {#if item.hint}
            <span class="hint">{item.hint}</span>
          {/if}
        </span>
        {#if item.description}
          <span class="description">{item.description}</span>
        {/if}
      </button>
    {/each}
    {#if items.length === 0}
      <p class="empty subtle" data-testid="slash-empty">{strings.slash.empty}</p>
    {/if}
  </div>
{/if}

<style>
  /* Above the composer, on the picker's surface: same ground, same radius,
     same shadow, same entrance. Eight rows fit, the rest scrolls. */
  .slash {
    position: absolute;
    bottom: calc(100% + 6px);
    left: 0;
    z-index: 40;
    display: flex;
    flex-direction: column;
    gap: 1px;
    width: min(420px, 100%);
    /* Eight rows of a name and its description, then it scrolls. */
    max-height: 420px;
    overflow: auto;
    padding: 6px;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-e2);
    animation: pop var(--dur-2) var(--ease-out-quint);
    transform-origin: bottom left;
  }

  .slash.closing {
    animation-name: pop-out;
    pointer-events: none;
  }

  .section-label {
    padding: 8px 8px 4px;
  }

  .row {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 1px;
    width: 100%;
    height: auto;
    flex: none;
    padding: 5px 8px;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--color-foreground);
    text-align: left;
    white-space: normal;
  }

  .row:hover:not(:disabled) {
    background: var(--color-hover);
  }

  .row.selected {
    background: var(--color-active);
  }

  /* A full width row does not shrink under the finger. */
  .row:active:not(:disabled) {
    transform: none;
  }

  .head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
    max-width: 100%;
  }

  .name {
    font-size: var(--text-base);
    font-weight: 500;
    font-family: var(--font-mono);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* What the agent says goes after the name. It is read, never inserted. */
  .hint {
    font-size: var(--text-sm);
    font-family: var(--font-mono);
    color: var(--color-subtle);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .description {
    max-width: 100%;
    font-size: var(--text-xs);
    color: var(--color-muted-foreground);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .empty {
    padding: 8px;
    font-size: var(--text-sm);
  }
</style>
