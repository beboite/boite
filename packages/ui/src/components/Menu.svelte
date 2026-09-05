<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { MenuItem } from '../lib/menu';

  let {
    items,
    onpick,
    align = 'start',
    label,
    testid,
    children
  }: {
    items: MenuItem[];
    onpick: (id: string) => void;
    align?: 'start' | 'end';
    label: string;
    testid?: string;
    children: Snippet;
  } = $props();

  let open = $state(false);
  let root = $state<HTMLDivElement | undefined>(undefined);

  function toggle(event: MouseEvent) {
    event.stopPropagation();
    open = !open;
  }

  function pick(item: MenuItem) {
    if (item.disabled) return;
    open = false;
    onpick(item.id);
  }

  function onWindowClick(event: MouseEvent) {
    if (!open) return;
    if (root && event.target instanceof Node && root.contains(event.target)) return;
    open = false;
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && open) {
      event.stopPropagation();
      open = false;
    }
  }
</script>

<svelte:window onclick={onWindowClick} />

<div class="menu" bind:this={root}>
  <button
    type="button"
    class="chip trigger"
    aria-haspopup="menu"
    aria-expanded={open}
    aria-label={label}
    title={label}
    data-testid={testid}
    onclick={toggle}
    {onkeydown}
  >
    {@render children()}
  </button>

  {#if open}
    <div class="popover" class:end={align === 'end'} role="menu" tabindex="-1" {onkeydown} data-testid={testid ? `${testid}-menu` : undefined}>
      {#each items as item (item.id)}
        <button
          type="button"
          class="item"
          class:active={item.active}
          class:danger={item.danger}
          role="menuitem"
          disabled={item.disabled}
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
    transition:
      background var(--dur-2) var(--ease-out-quint),
      color var(--dur-2) var(--ease-out-quint);
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

  .popover.end {
    left: auto;
    right: 0;
    transform-origin: bottom right;
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

  .item:hover:not(:disabled) {
    background: var(--color-surface-3);
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
