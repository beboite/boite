<script lang="ts">
  import { app } from "$lib/app/store.svelte";
  import { tip } from "$lib/shared/actions/tooltip";
  import { edgeFade } from "$lib/shared/actions/edgeFade";
  import { editorStore } from "./store.svelte";
  import X from "@lucide/svelte/icons/x";
  import FileIcon from "@lucide/svelte/icons/file";
  import GitCompareArrows from "@lucide/svelte/icons/git-compare-arrows";
  import { t } from "$lib/i18n/index.svelte";
  import { scrollIntoViewSmooth } from "$lib/theme/motion";

  // This project's files only. A buffer belonging to another project is still
  // open — it is just not in this strip, the same way its threads are not in
  // this project's list.
  const buffers = $derived(editorStore.forProject(app.currentProjectId));

  // The strip is one tab stop and it is the selected tab that holds it. Falling
  // back to the first tab matters for the moment between a buffer opening and
  // the store naming it active, where otherwise no tab is reachable at all.
  const tabStopId = $derived(
    buffers.some((b) => b.id === editorStore.activeId)
      ? editorStore.activeId
      : buffers[0]?.id ?? null,
  );

  let stripEl: HTMLDivElement | null = $state(null);

  function activate(id: string) {
    editorStore.setActive(id);
  }

  function close(e: Event, id: string) {
    e.stopPropagation();
    e.preventDefault();
    void editorStore.close(id);
  }

  function middleClickClose(e: MouseEvent, id: string) {
    if (e.button !== 1) return;
    close(e, id);
  }

  // Each tab carries an id so the panel can point back at it with
  // aria-labelledby, and every tab claims that one panel in return. One id
  // rather than one per buffer because that is what the DOM does: EditorPanel is
  // a single container whose contents are swapped, so per-buffer ids would leave
  // every inactive tab's aria-controls pointing at nothing.
  const PANEL_ID = "editor-panel";

  function tabId(id: string): string {
    return `editor-tab-${id}`;
  }

  function tabs(): HTMLElement[] {
    if (!stripEl) return [];
    return Array.from(stripEl.querySelectorAll<HTMLElement>('[role="tab"]'));
  }

  /** Selection follows focus, which is the tab pattern for a strip whose panel
   *  is already mounted: moving here is the same act as switching buffer. */
  function moveTo(list: HTMLElement[], index: number) {
    const el = list[(index + list.length) % list.length];
    const id = el?.dataset.tabId;
    if (!id) return;
    activate(id);
    el.focus();
  }

  function onStripKeydown(e: KeyboardEvent) {
    const list = tabs();
    if (list.length === 0) return;
    const at = list.findIndex((el) => el.dataset.tabId === editorStore.activeId);
    if (e.key === "ArrowRight") {
      e.preventDefault();
      moveTo(list, at + 1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      moveTo(list, at < 0 ? 0 : at - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      moveTo(list, 0);
    } else if (e.key === "End") {
      e.preventDefault();
      moveTo(list, list.length - 1);
    } else if (e.key === "Delete" || e.key === "Backspace") {
      // The strip is one tab stop, so the per-tab X is not in the tab order any
      // more. This is what replaces it.
      const id = list[at]?.dataset.tabId;
      if (!id) return;
      e.preventDefault();
      void editorStore.close(id);
    }
  }

  /**
   * Dragging a tab to reorder the strip.
   *
   * Pointer events, not HTML drag-and-drop. The native API looked like the
   * right tool for a one-axis drag inside one strip, and it does not work here:
   * the Tauri webview owns the OS drag-and-drop session — that is what catches
   * folders dropped on the window to add a project — so a drag started inside
   * the page is handed to the system, which paints macOS's green `+` copy
   * cursor and never delivers a drop back. The sidebar reorders projects and
   * threads with pointer events for the same reason.
   *
   * `dropBefore` is the id the tab would land in front of, or `"end"` past the
   * last one, which is exactly what gets handed to the store — so the line on
   * screen is the move that will happen.
   */
  type TabSnapshot = { id: string; left: number; width: number };

  let draggingId = $state<string | null>(null);
  /** Where the carried tab would be inserted, counting the strip without it. */
  let slot = $state<number | null>(null);
  /** How far it has been carried from where it started, in px. */
  let carryX = $state(0);
  let snaps: TabSnapshot[] = [];
  let dragFromX = 0;
  let dragArmedId: string | null = null;
  // A drag ends on the same element a click would fire from; without this every
  // reorder also switched to the tab that happened to be under the finger.
  let suppressClickId: string | null = null;

  const DRAG_THRESHOLD = 4;

  /**
   * Arms a drag. It does not capture the pointer — that waits until the drag
   * actually starts, in `tabPointerMove`.
   *
   * Capturing here broke closing a tab. A captured pointer retargets its events
   * to the capturing element, and the `click` that follows is dispatched from
   * where pointerdown and pointerup agree — the wrapper, not the X inside it. So
   * the close button's handler never ran, on any tab, and the only symptom was
   * that clicking it did nothing.
   */
  function tabPointerDown(e: PointerEvent, id: string) {
    if (e.button !== 0) return;
    // The X is not a handle: a press that starts on it is a close, and arming a
    // drag from it would also let a twitchy finger reorder instead of closing.
    if ((e.target as Element | null)?.closest("[data-tab-close]")) return;
    dragArmedId = id;
    dragFromX = e.clientX;
  }

  /**
   * Every tab's box, taken once when the drag arms.
   *
   * Once: the whole point is that the tabs move while the pointer does, so
   * measuring them mid-drag would read the preview back as if it were the real
   * layout and the slot would chase its own tail.
   */
  function snapshot(): TabSnapshot[] {
    const list = Array.from(stripEl?.querySelectorAll<HTMLElement>(".tab") ?? []);
    return list.flatMap((el) => {
      const id = el.dataset.tabId;
      if (!id) return [];
      const rect = el.getBoundingClientRect();
      return [{ id, left: rect.left, width: rect.width }];
    });
  }

  /** The slot the carried tab would drop into, in the strip minus itself. */
  function slotAt(x: number): number {
    const rest = snaps.filter((s) => s.id !== draggingId);
    // Walked against each remaining tab's midpoint, shifted by however much the
    // gap the carried tab left behind has moved them.
    let cursor = rest.length > 0 ? Math.min(snaps[0].left, rest[0].left) : 0;
    for (let i = 0; i < rest.length; i++) {
      if (x < cursor + rest[i].width / 2) return i;
      cursor += rest[i].width;
    }
    return rest.length;
  }

  function tabPointerMove(e: PointerEvent) {
    if (!dragArmedId) return;
    if (!draggingId) {
      if (Math.abs(e.clientX - dragFromX) < DRAG_THRESHOLD) return;
      snaps = snapshot();
      draggingId = dragArmedId;
      // Captured now that it is a drag: from here the pointer has to keep
      // reporting to this tab even when it leaves it, which is the whole point.
      // A click is no longer coming, so retargeting costs nothing.
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }
    carryX = e.clientX - dragFromX;
    slot = slotAt(e.clientX);
  }

  function tabPointerUp(e: PointerEvent) {
    const el = e.currentTarget as HTMLElement;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    if (draggingId && slot !== null) {
      const rest = buffers.filter((b) => b.id !== draggingId);
      editorStore.reorder(draggingId, rest[slot]?.id ?? null);
      suppressClickId = draggingId;
    }
    dragArmedId = null;
    draggingId = null;
    slot = null;
    carryX = 0;
    snaps = [];
  }

  /**
   * How far a tab slides to open the gap, the horizontal twin of the sidebar's
   * `rowShift`. `base` takes out the width the carried tab no longer occupies
   * for everything to its right; `drop` puts back the width it is about to take
   * at its new slot.
   */
  function tabShift(idx: number, sourceIdx: number, at: number, width: number): number {
    if (idx === sourceIdx) return 0;
    const eff = idx < sourceIdx ? idx : idx - 1;
    const base = idx > sourceIdx ? -width : 0;
    const drop = eff >= at ? width : 0;
    return base + drop;
  }

  const sourceIdx = $derived(
    draggingId ? buffers.findIndex((b) => b.id === draggingId) : -1,
  );
  const carriedWidth = $derived(snaps.find((s) => s.id === draggingId)?.width ?? 0);

  function clickTab(id: string) {
    if (suppressClickId === id) {
      suppressClickId = null;
      return;
    }
    activate(id);
  }

  // The bar is horizontal; convert vertical wheel input instead of ignoring it.
  function wheelScroll(e: WheelEvent) {
    if (!stripEl || e.deltaY === 0 || e.deltaX !== 0) return;
    e.preventDefault();
    stripEl.scrollLeft += e.deltaY;
  }

  // Tabs opened from the git panel land offscreen without this.
  $effect(() => {
    const id = editorStore.activeId;
    if (!id || !stripEl) return;
    const el = stripEl.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(id)}"]`);
    scrollIntoViewSmooth(el, { block: "nearest", inline: "nearest" });
  });
</script>

<div
  bind:this={stripEl}
  class="tab-strip edge-fade flex h-8 shrink-0 items-stretch gap-px overflow-x-auto bg-[var(--color-titlebar)]"
  use:edgeFade
  onwheel={wheelScroll}
  role="tablist"
  aria-label={t("editor.openFiles")}
>
  {#each buffers as b, i (b.id)}
    {@const active = editorStore.activeId === b.id}
    {@const carried = draggingId === b.id}
    {@const shift =
      draggingId && slot !== null && sourceIdx >= 0 && !carried
        ? tabShift(i, sourceIdx, slot, carriedWidth)
        : 0}
    <!-- Presentation, not a bare div: an un-roled wrapper is a generic child of
         the tablist, which leaves the aria-selected on the button inside it
         describing a tab the tablist does not own. -->
    <div
      role="presentation"
      data-tab-id={b.id}
      class="tab group flex shrink-0 items-center border-r border-border transition {active
        ? 'bg-[var(--color-background)] text-foreground'
        : 'text-muted-foreground hover:bg-[var(--color-surface-2)] hover:text-foreground'}"
      class:carried
      style:transform={carried ? `translateX(${carryX}px)` : `translateX(${shift}px)`}
      style:transition={carried || !draggingId
        ? "none"
        : "transform 160ms cubic-bezier(0.22, 1, 0.36, 1)"}
      onpointerdown={(e) => tabPointerDown(e, b.id)}
      onpointermove={tabPointerMove}
      onpointerup={tabPointerUp}
      onpointercancel={tabPointerUp}
    >
      <button
        type="button"
        role="tab"
        id={tabId(b.id)}
        data-tab-id={b.id}
        aria-selected={active}
        aria-controls={PANEL_ID}
        tabindex={b.id === tabStopId ? 0 : -1}
        class="flex h-full items-center gap-1.5 pl-2.5 text-sm"
        onclick={() => clickTab(b.id)}
        onkeydown={onStripKeydown}
        onauxclick={(e) => middleClickClose(e, b.id)}
        use:tip={b.path}
      >
        {#if b.kind === "diff"}
          <GitCompareArrows class="size-3.5 shrink-0" />
        {:else}
          <FileIcon class="size-3.5 shrink-0" />
        {/if}
        <span class="max-w-[200px] truncate">{b.displayName}</span>
        {#if editorStore.isDirty(b)}
          <span
            class="size-1.5 shrink-0 rounded-full bg-foreground/70"
            role="img"
            aria-label={t("editor.unsaved")}
          ></span>
        {/if}
      </button>
      <button
        type="button"
        data-tab-close
        class="ml-1 mr-1.5 rounded p-0.5 opacity-0 transition hover:bg-[var(--color-surface-3)] hover:opacity-100 focus-visible:opacity-100 group-hover:opacity-80"
        tabindex="-1"
        onclick={(e) => close(e, b.id)}
        aria-label={t("editor.closeTab")}
      >
        <X class="size-3" />
      </button>
    </div>
  {/each}
  <!-- The empty run past the last tab, so the strip keeps its background out to
       the edge. Inert: with pointer capture the drag is delivered to the tab
       that started it wherever the pointer goes, so nothing here listens. -->
  <div role="presentation" class="drop-tail"></div>
</div>

<style>
  /* A 10px scrollbar inside a 32px bar eats a third of it. */
  .tab-strip {
    scrollbar-width: none;
  }
  .tab-strip::-webkit-scrollbar {
    display: none;
  }

  .tab {
    cursor: grab;
  }

  /* The tab under the pointer, lifted out of the row rather than marked with a
     line beside it. Its neighbours slide to open the gap, so the strip shows
     the order it will have on release instead of an indicator to interpret. */
  .tab.carried {
    cursor: grabbing;
    z-index: 2;
    box-shadow: var(--shadow-e2);
    /* A drag across a filename is a text selection unless something says
       otherwise, and highlighted text following the pointer reads as a bug. */
    user-select: none;
  }

  .drop-tail {
    flex: 1 0 24px;
    min-width: 24px;
  }
</style>
