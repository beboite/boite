<script lang="ts">
  import { tick, type Snippet } from 'svelte';
  import { Closing } from '../lib/closing.svelte';
  import type { MenuItem } from '../lib/menu';

  let {
    items,
    onpick,
    align = 'start',
    placement = 'top',
    variant = 'chip',
    label,
    testid,
    children
  }: {
    items: MenuItem[];
    onpick: (id: string) => void;
    align?: 'start' | 'end';
    /** Where the popover sits: above the trigger, the composer's way, or under it. */
    placement?: 'top' | 'bottom';
    variant?: 'chip' | 'ghost';
    label: string;
    testid?: string;
    children: Snippet;
  } = $props();

  const popover = new Closing();
  let root = $state<HTMLDivElement | undefined>(undefined);
  let trigger = $state<HTMLButtonElement | undefined>(undefined);

  /** The keyboard lands on the first item the moment the list is there. */
  $effect(() => {
    if (!popover.open) return;
    void tick().then(() => rows()[0]?.focus({ preventScroll: true }));
  });

  function rows(): HTMLElement[] {
    return root ? Array.from(root.querySelectorAll<HTMLElement>('[data-row]:not(:disabled)')) : [];
  }

  function toggle(event: MouseEvent) {
    event.stopPropagation();
    popover.toggle();
  }

  function pick(item: MenuItem) {
    if (item.disabled) return;
    popover.hide();
    onpick(item.id);
  }

  function onWindowClick(event: MouseEvent) {
    if (!popover.open) return;
    if (root && event.target instanceof Node && root.contains(event.target)) return;
    popover.hide();
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      if (!popover.open) return;
      event.stopPropagation();
      popover.hide();
      trigger?.focus({ preventScroll: true });
      return;
    }
    if (!popover.open) {
      if (event.key !== 'ArrowDown') return;
      event.preventDefault();
      popover.show();
      return;
    }
    const list = rows();
    if (list.length === 0) return;
    const active = document.activeElement as HTMLElement | null;
    const index = active ? list.indexOf(active) : -1;
    if (event.key === 'Enter') {
      if (index < 0) return;
      event.preventDefault();
      const chosen = items.find((item) => item.id === active?.dataset['value']);
      if (chosen) pick(chosen);
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    let next = 0;
    if (event.key === 'ArrowDown') next = (index + 1) % list.length;
    else if (event.key === 'ArrowUp') next = (index - 1 + list.length) % list.length;
    else if (event.key === 'End') next = list.length - 1;
    list[next]?.focus({ preventScroll: true });
  }
</script>

<svelte:window onclick={onWindowClick} />

<div class="menu" bind:this={root}>
  <button
    type="button"
    class="trigger"
    class:chip={variant === 'chip'}
    class:ghost={variant === 'ghost'}
    aria-haspopup="menu"
    aria-expanded={popover.open}
    aria-label={label}
    title={label}
    data-testid={testid}
    bind:this={trigger}
    onclick={toggle}
    {onkeydown}
  >
    {@render children()}
  </button>

  {#if popover.shown}
    <div
      class="popover"
      class:end={align === 'end'}
      class:below={placement === 'bottom'}
      class:closing={popover.closing}
      role="menu"
      tabindex="-1"
      {onkeydown}
      use:popover.attach
      onanimationend={popover.end}
      data-testid={testid ? `${testid}-menu` : undefined}
    >
      {#each items as item (item.id)}
        <button
          type="button"
          class="item"
          class:active={item.active}
          class:danger={item.danger}
          role="menuitem"
          disabled={item.disabled}
          data-row
          data-value={item.id}
          onclick={() => pick(item)}
        >
          <span class="label">{item.label}</span>
          {#if item.hint}
            <span class="hint">{item.hint}</span>
          {/if}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .menu {
    position: relative;
    display: inline-flex;
  }

  .trigger {
    cursor: pointer;
    height: 24px;
    justify-content: center;
    transition:
      background var(--dur-2) var(--ease-out-quint),
      color var(--dur-2) var(--ease-out-quint);
  }

  .trigger.ghost {
    width: 24px;
    padding: 0;
    border-color: transparent;
    background: transparent;
    color: var(--color-muted-foreground);
    border-radius: var(--radius-md);
  }

  .trigger:hover,
  .trigger[aria-expanded='true'] {
    background: var(--color-surface-3);
    color: var(--color-foreground);
  }

  .popover {
    position: absolute;
    bottom: calc(100% + 6px);
    left: 0;
    min-width: 200px;
    max-width: 320px;
    padding: 4px;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-e2);
    z-index: 40;
    display: flex;
    flex-direction: column;
    gap: 1px;
    animation: pop var(--dur-2) var(--ease-out-quint);
    transform-origin: bottom left;
  }

  .popover.closing {
    animation-name: pop-out;
    pointer-events: none;
  }

  .popover.end {
    left: auto;
    right: 0;
    transform-origin: bottom right;
  }

  .popover.below {
    bottom: auto;
    top: calc(100% + 6px);
    transform-origin: top left;
  }

  .popover.below.end {
    transform-origin: top right;
  }

  .item {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0;
    height: auto;
    padding: 5px 8px;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--color-foreground);
    text-align: left;
    white-space: normal;
  }

  .item:hover:not(:disabled),
  .item:focus-visible {
    background: var(--color-hover);
    outline: none;
  }

  /* A full width row does not shrink under the finger, it fills one step more. */
  .item:active:not(:disabled) {
    transform: none;
    background: var(--color-active);
  }

  .item.active .label::after {
    content: '';
    display: inline-block;
    width: 5px;
    height: 5px;
    margin-left: 8px;
    border-radius: 50%;
    background: var(--color-foreground);
    vertical-align: middle;
  }

  .item.danger {
    color: var(--color-danger);
  }

  .label {
    font-weight: 500;
  }

  .hint {
    font-size: var(--text-xs);
    color: var(--color-muted-foreground);
  }
</style>
