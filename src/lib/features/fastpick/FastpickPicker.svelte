<script lang="ts">
  import { onMount, onDestroy, tick } from "svelte";
  import { tip } from "$lib/shared/actions/tooltip";
  import { scale } from "svelte/transition";
  import { settings } from "$lib/features/settings/store.svelte";
  import { t } from "$lib/i18n/index.svelte";
  import { registerEscape, restoreFocus, viewportHeight } from "$lib/shared/keyboard/overlay";
  import { fastpick } from "./store.svelte";
  import FastpickMenu from "./FastpickMenu.svelte";
  import Plus from "@lucide/svelte/icons/plus";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";

  /**
   * The fastpick button on the shortcut bar: a trigger, a floating box, and the
   * walk itself in `FastpickMenu`. The launcher popover shows that same walk
   * inline, which is why the two are separate files.
   */
  type Props = {
    /** See ShellPicker: the project a launch lands in, when one is named. */
    projectId?: string | null;
    onLaunched?: () => void;
  };
  let { projectId = null, onLaunched }: Props = $props();

  let open = $state(false);
  let triggerRoot: HTMLDivElement | null = $state(null);
  let menu: HTMLDivElement | null = $state(null);
  let menuPos = $state({ x: 0, y: 0 });
  const EDGE_GAP = 4;

  function toggle(e: MouseEvent) {
    e.stopPropagation();
    if (open) {
      open = false;
      return;
    }
    anchor();
    open = true;
  }

  // Fixed positioning: the shortcut bar scrolls horizontally, which would clip an
  // absolutely-positioned menu inside it. First guess only, taken before the menu
  // exists; `place` refines it once there is something to measure.
  function anchor() {
    if (!triggerRoot) return;
    const r = triggerRoot.getBoundingClientRect();
    menuPos = { x: r.left, y: r.bottom + 4 };
  }

  async function place() {
    anchor();
    await tick();
    if (!menu || !triggerRoot) return;
    const r = triggerRoot.getBoundingClientRect();
    // Layout box, not the painted one: the open transition scales the menu, and
    // a measurement taken mid-transition is smaller than what has to fit.
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    const vw = window.innerWidth;
    const vh = viewportHeight();
    const below = r.bottom + 4;
    menuPos = {
      // The trigger lives in a bar that scrolls sideways, so near the right edge
      // the menu used to run off screen.
      x: Math.max(EDGE_GAP, Math.min(r.left, vw - w - EDGE_GAP)),
      // Flipped above the trigger rather than clamped when the room below is
      // gone: a clamp alone parks the menu over the button that opened it.
      y: below + h + EDGE_GAP <= vh ? below : Math.max(EDGE_GAP, r.top - 4 - h),
    };
  }

  $effect(() => {
    if (!open) return;
    void place();
    const replace = () => void place();
    window.addEventListener("resize", replace);
    // A soft keyboard shrinks the visual viewport without necessarily resizing
    // the window, and it is the room under the trigger that changed.
    window.visualViewport?.addEventListener("resize", replace);
    return () => {
      window.removeEventListener("resize", replace);
      window.visualViewport?.removeEventListener("resize", replace);
    };
  });

  $effect(() => {
    if (!open) return;
    return registerEscape(() => (open = false));
  });

  $effect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const surface = menu;
    return () => restoreFocus(previous, surface);
  });

  // `pointerdown`, not `click`: picking a harness swaps the pane, and the browser
  // runs a microtask checkpoint between listeners, so Svelte has already detached
  // the clicked row by the time a document-level `click` looks at it. The menu
  // would then read its own item as an outside click and close on every step.
  function handleDocPointerDown(e: PointerEvent) {
    if (!open) return;
    const target = e.target as Node;
    if (triggerRoot?.contains(target) || menu?.contains(target)) return;
    open = false;
  }

  onMount(() => {
    document.addEventListener("pointerdown", handleDocPointerDown);
    // Probed once so the button can hide itself on a machine with no fastpick, rather
    // than offering a menu whose every entry fails. Turned off in the settings, nothing
    // is asked at all: the answer would only decide how to hide a button already hidden.
    if (settings.state.fastpickEnabled) void fastpick.ensure();
  });

  onDestroy(() => {
    document.removeEventListener("pointerdown", handleDocPointerDown);
  });
</script>

{#if settings.state.fastpickEnabled && fastpick.installed !== false}
  <div bind:this={triggerRoot} class="relative flex shrink-0 items-stretch">
    <button
      type="button"
      class="flex shrink-0 items-center gap-1.5 rounded-md border border-dashed border-edge px-2.5 py-1 text-sm text-muted-foreground transition hover:border-foreground/30 hover:bg-[var(--color-surface-2)] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
      onclick={toggle}
      aria-haspopup="menu"
      aria-expanded={open}
      use:tip={t("fastpick.tooltip")}
      aria-label={t("fastpick.tooltip")}
    >
      <!-- Same three parts as the Terminal button beside it: it launches a thread too, and
           a button with no glyph reads as smaller than its neighbours whatever its box says. -->
      <Plus class="size-3.5" />
      <span>{t("fastpick.label")}</span>
      <ChevronDown class="size-3.5" />
    </button>

    {#if open}
      <div
        bind:this={menu}
        class="surface-popover fixed z-[var(--z-popover)] flex max-h-[60vh] min-w-64 flex-col overflow-hidden"
        style:left="{menuPos.x}px"
        style:top="{menuPos.y}px"
        style:transform-origin="top left"
        transition:scale={{ duration: 90, start: 0.96 }}
      >
        <FastpickMenu
          {projectId}
          onLaunched={() => {
            open = false;
            onLaunched?.();
          }}
          onResize={() => void place()}
        />
      </div>
    {/if}
  </div>
{/if}
