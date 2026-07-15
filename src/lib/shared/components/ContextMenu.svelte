<script lang="ts" module>
  export interface ContextMenuItem {
    label?: string;
    action?: () => void;
    separator?: boolean;
    danger?: boolean;
    disabled?: boolean;
    icon?: any;
  }
</script>

<script lang="ts">
  import { onMount, onDestroy, tick } from "svelte";

  type Props = {
    items: ContextMenuItem[];
    x: number;
    y: number;
    onClose: () => void;
  };
  let { items, x, y, onClose }: Props = $props();

  let menuRef = $state<HTMLDivElement | null>(null);
  let adjustedX = $state(0);
  let adjustedY = $state(0);
  // Hidden until the first clamp pass, so the menu never paints one frame at
  // an unpositioned corner.
  let positioned = $state(false);
  const EDGE_GAP = 4;

  let hasIcons = $derived(items.some((item) => item.icon));

  async function positionMenu() {
    await tick();
    if (!menuRef) return;
    const rect = menuRef.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    adjustedX = Math.max(EDGE_GAP, Math.min(x, vw - rect.width - EDGE_GAP));
    adjustedY = Math.max(EDGE_GAP, Math.min(y, vh - rect.height - EDGE_GAP));
    positioned = true;
  }

  $effect(() => {
    void x;
    void y;
    void positionMenu();
  });

  function handleClickOutside(e: MouseEvent) {
    if (menuRef && !menuRef.contains(e.target as Node)) onClose();
  }

  function focusableItems(): HTMLButtonElement[] {
    return Array.from(
      menuRef?.querySelectorAll<HTMLButtonElement>("button.item:not(:disabled)") ??
        [],
    );
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      onClose();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const buttons = focusableItems();
      if (buttons.length === 0) return;
      const idx = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next =
        e.key === "ArrowDown"
          ? buttons[(idx + 1) % buttons.length]
          : buttons[(idx - 1 + buttons.length) % buttons.length];
      next.focus();
    }
  }

  onMount(() => {
    if (menuRef && menuRef.parentElement !== document.body) {
      document.body.appendChild(menuRef);
    }
    void positionMenu();
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeydown);
    window.addEventListener("resize", positionMenu);
  });

  onDestroy(() => {
    document.removeEventListener("mousedown", handleClickOutside);
    document.removeEventListener("keydown", handleKeydown);
    window.removeEventListener("resize", positionMenu);
    if (menuRef && menuRef.parentElement === document.body) {
      menuRef.remove();
    }
  });
</script>

<div
  class="ctx-menu"
  bind:this={menuRef}
  style:left="{adjustedX}px"
  style:top="{adjustedY}px"
  style:visibility={positioned ? "visible" : "hidden"}
  role="menu"
>
  {#each items as item, i (i)}
    {#if item.separator}
      <div class="separator" role="separator"></div>
    {:else}
      <button
        type="button"
        class="item"
        class:danger={item.danger}
        disabled={item.disabled}
        role="menuitem"
        onmousedown={(e) => e.preventDefault()}
        onclick={() => {
          item.action?.();
          onClose();
        }}
      >
        {#if hasIcons}
          <span class="icon-wrapper">
            {#if item.icon}
              {@const Icon = item.icon}
              <Icon size={14} />
            {/if}
          </span>
        {/if}
        <span class="label">{item.label}</span>
      </button>
    {/if}
  {/each}
</div>

<style>
  .ctx-menu {
    position: fixed;
    z-index: 99999;
    min-width: 180px;
    padding: 4px;
    background: var(--color-surface-2, #18181b);
    border: 1px solid var(--color-border, rgba(255, 255, 255, 0.1));
    border-radius: 6px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
    transform-origin: top left;
    animation: ctx-in 90ms ease-out;
  }
  @keyframes ctx-in {
    from {
      opacity: 0;
      transform: scale(0.96);
    }
  }
  .item {
    display: flex;
    width: 100%;
    align-items: center;
    padding: 6px 10px;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--color-foreground, #fafafa);
    font-size: 12px;
    text-align: left;
    cursor: pointer;
    transition: background 80ms;
  }
  .item:hover:not(:disabled) {
    background: var(--color-surface-3, rgba(255, 255, 255, 0.06));
  }
  .item:disabled {
    color: var(--color-muted-foreground, rgba(255, 255, 255, 0.4));
    cursor: not-allowed;
  }
  .item.danger {
    color: var(--color-danger, #f87171);
  }
  .item.danger:hover:not(:disabled) {
    background: rgba(239, 68, 68, 0.15);
  }
  .icon-wrapper {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    margin-right: 8px;
    flex-shrink: 0;
    opacity: 0.7;
    transition: opacity 80ms;
  }
  .item:hover:not(:disabled) .icon-wrapper {
    opacity: 1;
  }
  .item.danger .icon-wrapper {
    color: var(--color-danger, #f87171);
  }
  .label {
    flex: 1;
  }
  .separator {
    height: 1px;
    margin: 4px 6px;
    background: var(--color-border, rgba(255, 255, 255, 0.1));
  }
</style>
