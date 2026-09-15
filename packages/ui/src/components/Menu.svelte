<script lang="ts">
  import { tick, type Snippet } from 'svelte';
  import { Settings } from '@lucide/svelte';
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
    /** `text` reads as the sentence it sits in: no fill, no border, the parent's type. */
    variant?: 'chip' | 'ghost' | 'text';
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
    class:text={variant === 'text'}
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
        {#if item.separator}
          <div class="separator" role="separator"></div>
        {:else}
        <button
          type="button"
          class="item"
          class:active={item.active}
          class:danger={item.danger}
          class:hide-mark={item.hideActiveMark}
          role="menuitem"
          disabled={item.disabled}
          data-row
          data-value={item.id}
          onclick={() => pick(item)}
        >
          <span class="label">
            {#if item.icon === 'settings'}<Settings size={14} strokeWidth={1.75} />{/if}
            {#if item.status}<span class="status-dot" data-tone={item.status.tone} role="img" aria-label={item.status.label} title={item.status.label}></span>{/if}
            {item.label}
          </span>
          {#if item.hint}
            <span class="hint">{item.hint}</span>
          {/if}
        </button>
        {/if}
      {/each}
    </div>
  {/if}
</div>

<style>
  .separator { height: 1px; background: var(--color-border); margin: 5px 4px; }
  .label { display: flex; align-items: center; gap: 6px; }
  .item.hide-mark.active { background: var(--color-active); }
  .status-dot { display: inline-block; width: 6px; height: 6px; flex: none; border-radius: 50%; margin-right: 8px; vertical-align: middle; background: var(--color-live); }
  .status-dot[data-tone='success'] { background: var(--color-success); }
  .status-dot[data-tone='danger'] { background: var(--color-danger); }
  .menu {
    position: relative;
    display: inline-flex;
  }

  .trigger {
    cursor: pointer;
    height: var(--control-sm);
    justify-content: center;
    transition:
      background var(--dur-2) var(--ease-out-quint),
      color var(--dur-2) var(--ease-out-quint);
  }

  .trigger.ghost {
    width: var(--control-sm);
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

  /* A word inside a sentence, not a control parked in one: it takes the type
     and the colour of whatever it sits in and only fills under the pointer. */
  .trigger.text {
    height: auto;
    padding: 2px 6px;
    gap: 4px;
    border: none;
    background: transparent;
    color: inherit;
    font: inherit;
    border-radius: var(--radius-md);
  }

  .trigger.text:hover,
  .trigger.text[aria-expanded='true'] {
    background: var(--color-hover);
    color: inherit;
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
    /* The list reads at the body size wherever the trigger sits, a heading
       included: it never inherits the type of the sentence around it. */
    font-size: var(--text-base);
    font-weight: 400;
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

  .item.active:not(.hide-mark) .label::after {
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
    font-size: var(--text-sm);
    color: var(--color-muted-foreground);
  }
</style>
