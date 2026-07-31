<script lang="ts" module>
  export interface ContextMenuItem {
    label?: string;
    action?: () => void;
    separator?: boolean;
    danger?: boolean;
    disabled?: boolean;
  }

</script>

<script lang="ts">
  import {
    registerEscape,
    restoreFocus,
    viewportHeight,
  } from "$lib/shared/keyboard/overlay";
  import { onMount, onDestroy, tick } from "svelte";
  import { settings } from "$lib/features/settings/store.svelte";

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

  const mobile = $derived(settings.state.mobileLayout);

  async function positionMenu() {
    await tick();
    if (!menuRef) return;
    // Layout box, not the painted one: the open animation scales the menu down,
    // and a measurement taken mid-animation reports a menu 4% smaller than the
    // one the clamp has to fit.
    const w = menuRef.offsetWidth;
    const h = menuRef.offsetHeight;
    const vw = window.innerWidth;
    const vh = viewportHeight();
    adjustedX = Math.max(EDGE_GAP, Math.min(x, vw - w - EDGE_GAP));
    adjustedY = Math.max(EDGE_GAP, Math.min(y, vh - h - EDGE_GAP));
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
    const buttons = focusableItems();
    if (buttons.length === 0) return;
    const idx = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const last = buttons.length - 1;

    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const down = e.key === "ArrowDown";
      // From outside the menu the two directions mean "first" and "last", not
      // an offset from -1: ArrowUp used to land on the second to last item.
      if (idx < 0) {
        buttons[down ? 0 : last].focus();
        return;
      }
      const step = down ? 1 : -1;
      buttons[(idx + step + buttons.length) % buttons.length].focus();
      return;
    }
    if (e.key === "Home") {
      e.preventDefault();
      buttons[0].focus();
      return;
    }
    if (e.key === "End") {
      e.preventDefault();
      buttons[last].focus();
      return;
    }
    if (e.key === "Tab") {
      // Trapped: Tab used to walk into the view behind the menu and leave the
      // menu hanging over an app the keyboard had already left.
      e.preventDefault();
      if (idx < 0) {
        buttons[e.shiftKey ? last : 0].focus();
        return;
      }
      const step = e.shiftKey ? -1 : 1;
      buttons[(idx + step + buttons.length) % buttons.length].focus();
    }
    // Nothing for Enter or Space: the focused item is a button, which already
    // activates on both.
  }

  onMount(() => {
    if (menuRef && menuRef.parentElement !== document.body) {
      document.body.appendChild(menuRef);
    }
    void positionMenu();
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeydown);
    window.addEventListener("resize", positionMenu);
    // The visual viewport moves on its own when a soft keyboard opens, without
    // a window resize on some platforms.
    window.visualViewport?.addEventListener("resize", positionMenu);
  });

  // One tick late on purpose: the onMount above moves the menu to <body>, and
  // appending a node blurs whatever inside it had focus, so focusing first would
  // lose the keyboard to the move.
  $effect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const surface = menuRef;
    let cancelled = false;
    void tick().then(() => {
      if (!cancelled) (focusableItems()[0] ?? menuRef)?.focus();
    });
    return () => {
      cancelled = true;
      restoreFocus(previous, surface);
    };
  });

  $effect(() => registerEscape(onClose));

  onDestroy(() => {
    document.removeEventListener("mousedown", handleClickOutside);
    document.removeEventListener("keydown", handleKeydown);
    window.removeEventListener("resize", positionMenu);
    window.visualViewport?.removeEventListener("resize", positionMenu);
    if (menuRef && menuRef.parentElement === document.body) {
      menuRef.remove();
    }
  });
</script>

<div
  class="ctx-menu"
  class:mobile
  bind:this={menuRef}
  style:left="{adjustedX}px"
  style:top="{adjustedY}px"
  style:visibility={positioned ? "visible" : "hidden"}
  role="menu"
  tabindex="-1"
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
        <span class="label">{item.label}</span>
      </button>
    {/if}
  {/each}
</div>

<style>
  .ctx-menu {
    position: fixed;
    z-index: var(--z-popover);
    min-width: 180px;
    /* Capped: a label built from a project folder name (shortcut/launchMenu.ts)
       used to stretch the menu past the viewport, and the clamp then only cut
       the right side off. */
    max-width: min(320px, 90vw);
    padding: 4px;
    /* The popover recipe from app.css, spelled out rather than applied as the
       utility class: Svelte scoped styles are not run through Tailwind, and the
       menu owns its own position and animation anyway. */
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-e3);
    transform-origin: top left;
    animation: ctx-in var(--dur-1) var(--ease-out-quint);
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
    color: var(--color-foreground);
    font-size: var(--text-sm);
    text-align: left;
    cursor: pointer;
    overflow: hidden;
    transition: background var(--dur-1);
  }
  .label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .item:hover:not(:disabled),
  /* The keyboard highlight is the hover highlight: in a menu, focus is the
     selection, so a second visual language for it would only compete. */
  .item:focus-visible {
    background: var(--color-surface-3);
    outline: none;
  }
  .item:disabled {
    color: var(--color-muted-foreground);
    cursor: not-allowed;
  }
  .item.danger {
    color: var(--color-danger);
  }
  /* Mixed from the same token as the text above it: the fill used to be
     Tailwind's red-500 while the label was --color-danger, so one element
     carried two reds. */
  .item.danger:hover:not(:disabled) {
    background: color-mix(in srgb, var(--color-danger) 15%, transparent);
  }
  /* A long press raises these menus on a phone (shared/actions/longPress.ts),
     where a 25px row is smaller than the finger aiming at it. */
  .mobile .item {
    min-height: 44px;
    padding: 11px 14px;
    font-size: var(--text-md);
  }
  .separator {
    height: 1px;
    margin: 4px 6px;
    background: var(--color-border);
  }
</style>
