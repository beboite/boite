<script lang="ts">
  import { Closing } from '../lib/closing.svelte';
  import { fitMenu, type MenuFit } from '../lib/menu-fit';
  import type { PaletteItem } from '../lib/palette';

  /**
   * The list that pops over the composer: the slash menu and the mention menu
   * are the same box with different rows. The composer owns the query, the
   * selection and the keyboard; this only draws, and closes the way the
   * picker does. Each row is the label in mono, a hint greyed beside it, the
   * description under it, and a heading where the caller says the group changes.
   */
  let {
    open,
    items,
    selected,
    kind,
    label,
    empty,
    footer = null,
    heading = () => null,
    nameOf = (item) => item.label,
    onpick,
    onhover
  }: {
    open: boolean;
    items: PaletteItem[];
    /** The row the keyboard is on, an index into `items`. */
    selected: number;
    /** The test ids: `<kind>-menu`, `<kind>-row`, `<kind>-empty`. */
    kind: 'slash' | 'mention';
    /** The list's accessible name. */
    label: string;
    /** What the box says when nothing matches. */
    empty: string;
    /** One line under the rows, for what the list left out. */
    footer?: string | null;
    /** The heading before a row, only where the group changes. */
    heading?: (index: number) => string | null;
    /** What a row's `data-name` says, the thing a test picks it by. */
    nameOf?: (item: PaletteItem) => string;
    onpick: (item: PaletteItem) => void;
    onhover: (index: number) => void;
  } = $props();

  const popover = new Closing();
  let list = $state<HTMLDivElement | undefined>(undefined);

  $effect(() => {
    if (open) popover.show();
    else popover.hide();
  });

  /** Eight rows of a name and its description, then it scrolls. */
  const CAP = 420;
  let fit = $state<MenuFit>({ below: false, maxHeight: CAP });
  let viewport = $state(0);

  /** Measured against the composer box the list hangs from, and the title bar it must not cover. */
  function measure(node: HTMLElement): MenuFit {
    const anchor = (node.offsetParent ?? node.parentElement)?.getBoundingClientRect();
    if (!anchor) return { below: false, maxHeight: CAP };
    const titlebar = document.querySelector('.titlebar')?.getBoundingClientRect().bottom ?? 0;
    return fitMenu(anchor, window.innerHeight, Math.max(0, titlebar), CAP);
  }

  $effect(() => {
    void items;
    void viewport;
    if (popover.shown && list) fit = measure(list);
  });

  $effect(() => {
    void items;
    void fit;
    const row = list?.querySelector<HTMLElement>(`[data-index="${selected}"]`);
    // jsdom draws nothing and has no scrollIntoView; a real list keeps the row in view.
    if (row && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' });
  });
</script>

<svelte:window onresize={() => (viewport = window.innerHeight)} />
{#if popover.shown}
  <div
    class="menu"
    class:closing={popover.closing}
    class:below={fit.below}
    style:max-height="{fit.maxHeight}px"
    role="listbox"
    aria-label={label}
    tabindex="-1"
    data-testid="{kind}-menu"
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
        data-testid="{kind}-row"
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
      <p class="empty subtle" data-testid="{kind}-empty">{empty}</p>
    {:else if footer}
      <p class="footer subtle" data-testid="{kind}-footer">{footer}</p>
    {/if}
  </div>
{/if}

<style>
  /* Above the composer, on the picker's surface: same ground, same radius,
     same shadow, same entrance. Eight rows fit, the rest scrolls; a shorter
     window gets a shorter list, or the list under the box when that side has
     more room (`lib/menu-fit.ts`). */
  .menu {
    position: absolute;
    bottom: calc(100% + 6px);
    left: 0;
    z-index: 40;
    display: flex;
    flex-direction: column;
    gap: 1px;
    width: min(420px, 100%);
    overflow: auto;
    padding: 6px;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-e2);
    animation: pop var(--dur-2) var(--ease-out-quint);
    transform-origin: bottom left;
  }

  .menu.below {
    top: calc(100% + 6px);
    bottom: auto;
    transform-origin: top left;
  }

  .menu.closing {
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

  /* What sits after the name is read, never inserted. */
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

  .empty,
  .footer {
    padding: 8px;
    font-size: var(--text-sm);
  }

  .footer {
    font-size: var(--text-xs);
  }
</style>
