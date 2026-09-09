<script lang="ts">
  import { tick } from 'svelte';
  import { Closing } from '../lib/closing.svelte';
  import { contextMenu, type ContextMenuState } from '../lib/context-menu.svelte';
  import type { MenuItem } from '../lib/menu';

  const GAP = 6;

  const popover = new Closing();
  /** The request is nulled the moment it is answered, so the exit plays on a copy. */
  let held = $state<ContextMenuState | null>(null);
  let root = $state<HTMLDivElement | undefined>(undefined);
  let left = $state(0);
  let top = $state(0);

  /** Opens at the pointer, then slides inside the viewport once its size is known. */
  $effect(() => {
    const current = contextMenu.current;
    if (!current) {
      popover.hide();
      return;
    }
    held = current;
    popover.show();
    left = current.x;
    top = current.y;
    void tick().then(() => {
      const el = root;
      if (!el) return;
      left = Math.max(GAP, Math.min(current.x, window.innerWidth - el.offsetWidth - GAP));
      top = Math.max(GAP, Math.min(current.y, window.innerHeight - el.offsetHeight - GAP));
      rows()[0]?.focus({ preventScroll: true });
    });
  });

  function rows(): HTMLElement[] {
    return root ? Array.from(root.querySelectorAll<HTMLElement>('[data-row]')) : [];
  }

  function pick(item: MenuItem) {
    if (item.disabled || item.separator) return;
    const current = contextMenu.current;
    contextMenu.close();
    current?.onpick(item.id);
  }

  function onWindowPointerdown(event: PointerEvent) {
    if (!contextMenu.current) return;
    if (root && event.target instanceof Node && root.contains(event.target)) return;
    contextMenu.close();
  }

  function onkeydown(event: KeyboardEvent) {
    if (!contextMenu.current) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      contextMenu.close();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return;
    const list = rows();
    if (list.length === 0) return;
    event.preventDefault();
    const active = document.activeElement as HTMLElement | null;
    const index = active ? list.indexOf(active) : -1;
    let next = 0;
    if (event.key === 'ArrowDown') next = (index + 1) % list.length;
    else if (event.key === 'ArrowUp') next = (index - 1 + list.length) % list.length;
    else if (event.key === 'End') next = list.length - 1;
    list[next]?.focus();
  }
</script>

<svelte:window
  onpointerdown={onWindowPointerdown}
  onkeydown={onkeydown}
  onresize={() => contextMenu.close()}
  onblur={() => contextMenu.close()}
  onscrollcapture={(event) => {
    if (root && event.target instanceof Node && root.contains(event.target)) return;
    contextMenu.close();
  }}
/>

{#if popover.shown && held}
  {@const request = held}
  <div
    class="context-menu"
    class:closing={popover.closing}
    role="menu"
    tabindex="-1"
    bind:this={root}
    use:popover.attach
    onanimationend={popover.end}
    style="left: {left}px; top: {top}px;"
    data-testid="context-menu"
    oncontextmenu={(event) => event.preventDefault()}
  >
    {#each request.items as item (item.id)}
      {#if item.separator}
        <div class="rule" role="separator"></div>
      {:else}
        <button
          type="button"
          class="row"
          class:danger={item.danger}
          class:active={item.active}
          role="menuitem"
          tabindex="-1"
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
      {/if}
    {/each}
  </div>
{/if}

<style>
  .context-menu {
    position: fixed;
    z-index: 70;
    min-width: 200px;
    max-width: 320px;
    padding: 4px;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-e2);
    display: flex;
    flex-direction: column;
    gap: 1px;
    animation: pop var(--dur-2) var(--ease-out-quint);
    transform-origin: top left;
    outline: none;
  }

  .context-menu.closing {
    animation-name: pop-out;
    pointer-events: none;
  }

  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    width: 100%;
    height: var(--control);
    padding: 0 8px;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--color-foreground);
    text-align: left;
  }

  .row:hover:not(:disabled),
  .row:focus-visible {
    background: var(--color-hover);
    outline: none;
  }

  /* A full width row does not shrink under the finger, it fills one step more. */
  .row:active:not(:disabled) {
    transform: none;
    background: color-mix(in srgb, var(--color-surface-3) 85%, var(--color-foreground));
  }

  .row.danger {
    color: var(--color-danger);
  }

  .row.active .label::after {
    content: '';
    display: inline-block;
    width: 5px;
    height: 5px;
    margin-left: 8px;
    border-radius: 50%;
    background: var(--color-foreground);
    vertical-align: middle;
  }

  .hint {
    font-size: var(--text-sm);
    color: var(--color-subtle);
    white-space: nowrap;
  }

  .rule {
    height: 1px;
    margin: 3px 6px;
    background: var(--color-border);
  }
</style>
