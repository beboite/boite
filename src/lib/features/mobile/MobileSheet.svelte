<script lang="ts">
  import type { Snippet } from "svelte";
  import { fade, fly } from "svelte/transition";
  import { focusTrap } from "$lib/shared/actions/focusTrap";
  import { t } from "$lib/i18n/index.svelte";

  type Props = {
    open: boolean;
    title?: string;
    onClose: () => void;
    children: Snippet;
  };
  let { open, title = "", onClose, children }: Props = $props();

  // How far the sheet has to travel before letting go dismisses it. Short
  // enough to feel like a flick, long enough that a thumb resting mid-scroll
  // cannot throw the sheet away.
  const DISMISS_PX = 96;
  // Swallowed before the sheet moves at all, so tapping a row inside it does
  // not nudge the whole panel on the few pixels a thumb always travels.
  const SLOP_PX = 8;

  let panel: HTMLDivElement | null = $state(null);

  // Focus, its restore and the Tab cycle are `use:focusTrap` below. The sheet
  // used to carry its own copy of all three, which is the copy the shared
  // action was written from: only the innermost open surface answers there, so a
  // sheet opened over a popover no longer cycles the popover's buttons.
  let dragY = $state(0);
  let dragPointer: number | null = null;
  let dragStartY = 0;
  // A drag only competes with the scroll container when that container has
  // nothing left to give: starting one mid-scroll would fight the finger.
  let fromTop = false;

  function endDrag() {
    dragPointer = null;
    dragY = 0;
  }

  function dragStart(e: PointerEvent) {
    // A mouse drags nothing here: the desktop has no sheet, and swallowing its
    // press would break text selection inside the panel.
    if (e.pointerType === "mouse" || dragPointer !== null) return;
    dragPointer = e.pointerId;
    dragStartY = e.clientY;
    fromTop = (panel?.scrollTop ?? 0) <= 0;
    dragY = 0;
  }

  function dragMove(e: PointerEvent) {
    if (dragPointer !== e.pointerId || !fromTop) return;
    // Downward only, and no preventDefault: the panel is already scrolled to
    // the top and `overscroll-contain` stops the gesture from reaching the page
    // behind, so the browser has nothing to steal.
    const dy = e.clientY - dragStartY;
    dragY = dy > SLOP_PX ? dy - SLOP_PX : 0;
  }

  function dragEnd(e: PointerEvent) {
    if (dragPointer !== e.pointerId) return;
    const dismiss = dragY > DISMISS_PX;
    endDrag();
    if (dismiss) onClose();
  }

  // Escape belongs to the topmost surface, and while this sheet is up that is
  // this sheet: propagation stops so the filter fields and pickers underneath
  // do not also react to the key that closed it.
  function onWindowKeyDown(e: KeyboardEvent) {
    if (!open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  }
</script>

<svelte:window onkeydown={onWindowKeyDown} />

{#if open}
  <div class="fixed inset-0 z-[var(--z-sheet)] flex flex-col justify-end">
    <button
      type="button"
      class="absolute inset-0 bg-[var(--color-scrim)]"
      aria-label={t("titlebar.close")}
      tabindex="-1"
      onclick={onClose}
      transition:fade={{ duration: 140 }}
    ></button>
    <!-- dvh, not vh: `100vh` is the large viewport on a phone, so a 75vh sheet
         with the URL bar showing ran past the bottom of the screen. -->
    <!-- The pointer handlers are a swipe-to-dismiss on top of a dialog that
         already closes with Escape, so the gesture adds a shortcut rather than
         being the only way out. -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      bind:this={panel}
      role="dialog"
      aria-modal="true"
      aria-labelledby={title ? "sheet-title" : undefined}
      aria-label={title ? undefined : t("titlebar.close")}
      tabindex="-1"
      class="surface-dialog relative max-h-[75dvh] scroll-pane overflow-y-auto overscroll-contain rounded-b-none border-x-0 border-b-0"
      style="padding-bottom: env(safe-area-inset-bottom, 0px); padding-left: env(safe-area-inset-left, 0px); padding-right: env(safe-area-inset-right, 0px);"
      style:transform={dragY > 0 ? `translateY(${dragY}px)` : undefined}
      style:transition={dragY > 0 ? "none" : "transform var(--dur-2)"}
      transition:fly={{ y: 320, duration: 200 }}
      use:focusTrap
      onpointerdown={dragStart}
      onpointermove={dragMove}
      onpointerup={dragEnd}
      onpointercancel={dragEnd}
      onpointerleave={dragEnd}
    >
      <div class="sticky top-0 z-[var(--z-chrome)] flex justify-center bg-[var(--color-surface)] pb-1 pt-2.5">
        <span class="h-1 w-10 rounded-full bg-[var(--color-surface-3)]"></span>
      </div>
      {#if title}
        <div id="sheet-title" class="px-4 pb-1 text-sm font-semibold text-foreground">{title}</div>
      {/if}
      <div class="p-2.5">
        {@render children()}
      </div>
    </div>
  </div>
{/if}
