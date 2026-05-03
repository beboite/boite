<script lang="ts">
  import { paneStore, countLeaves, MAX_LEAVES } from "./store.svelte";
  import type { DropSide, PaneGroup } from "./types";
  import type { Thread } from "$lib/types";
  import { notifications } from "$lib/features/notifications/store.svelte";
  import { app } from "$lib/app/store.svelte";

  type Props = {
    thread: Thread;
    group: PaneGroup;
    focused: boolean;
  };
  let { thread, group, focused }: Props = $props();

  const DRAG_MIME = "application/x-boite-thread";

  let hovered = $state(false);
  let activeSide = $state<DropSide | null>(null);

  const isMultiPane = $derived(countLeaves(group.root) > 1);
  const hoveredFromSidebar = $derived(
    paneStore.hoveredThreadId === thread.id && isMultiPane,
  );
  const showFocusRing = $derived(focused && isMultiPane);

  const dragging = $derived(paneStore.draggingThreadId);

  const accepts = $derived.by(() => {
    if (!dragging) return false;
    if (dragging === thread.id) return false;
    const dragThread = app.threads.find((t) => t.id === dragging);
    if (!dragThread || dragThread.projectId !== thread.projectId) return false;
    return true;
  });

  const groupFull = $derived(countLeaves(group.root) >= MAX_LEAVES);
  const draggedAlreadyHere = $derived(
    !!dragging && paneStore.groupOf(dragging)?.id === group.id,
  );
  const refused = $derived(accepts && groupFull && !draggedAlreadyHere);

  function sideFromEvent(e: DragEvent, el: HTMLElement): DropSide {
    const r = el.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const dx = Math.min(x, r.width - x) / r.width;
    const dy = Math.min(y, r.height - y) / r.height;
    if (dx < dy) {
      return x < r.width / 2 ? "left" : "right";
    }
    return y < r.height / 2 ? "top" : "bottom";
  }

  function onDragOver(e: DragEvent) {
    if (!accepts) return;
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = refused ? "none" : "move";
    }
    if (refused) {
      activeSide = null;
      return;
    }
    activeSide = sideFromEvent(e, e.currentTarget as HTMLElement);
    hovered = true;
  }

  function onDragLeave(e: DragEvent) {
    const el = e.currentTarget as HTMLElement;
    const next = e.relatedTarget as Node | null;
    if (next && el.contains(next)) return;
    hovered = false;
    activeSide = null;
  }

  function onDrop(e: DragEvent) {
    if (!accepts) return;
    e.preventDefault();
    if (refused) {
      notifications.error(`Max ${MAX_LEAVES} panes per group`);
      hovered = false;
      activeSide = null;
      return;
    }
    const draggedId = dragging;
    const side = sideFromEvent(e, e.currentTarget as HTMLElement);
    hovered = false;
    activeSide = null;
    if (!draggedId) return;
    paneStore.splitInto(thread.id, draggedId, side);
  }
</script>

<div
  class="overlay"
  class:hovered-sidebar={hoveredFromSidebar}
  class:focused={showFocusRing}
  class:drag-active={accepts}
  class:refused
  ondragover={onDragOver}
  ondragleave={onDragLeave}
  ondrop={onDrop}
  role="presentation"
>
  {#if accepts && !refused}
    <div class="zones">
      <div class="zone zone-top" class:active={activeSide === "top"}></div>
      <div class="zone zone-bottom" class:active={activeSide === "bottom"}></div>
      <div class="zone zone-left" class:active={activeSide === "left"}></div>
      <div class="zone zone-right" class:active={activeSide === "right"}></div>
    </div>
  {/if}
</div>

<style>
  .overlay {
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 5;
  }
  .overlay.drag-active {
    pointer-events: auto;
  }
  .overlay.hovered-sidebar::after,
  .overlay.focused::after {
    content: "";
    position: absolute;
    inset: 2px;
    border-radius: 6px;
    pointer-events: none;
  }
  .overlay.focused::after {
    box-shadow: inset 0 0 0 1px var(--color-border, rgba(255, 255, 255, 0.18));
  }
  .overlay.hovered-sidebar::after {
    box-shadow: inset 0 0 0 2px var(--color-foreground, #fafafa);
    animation: pulse 1.2s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 0.85; }
    50% { opacity: 0.4; }
  }
  .overlay.refused {
    background: rgba(239, 68, 68, 0.06);
  }

  .zones {
    position: absolute;
    inset: 0;
  }
  .zone {
    position: absolute;
    background: rgba(228, 228, 231, 0.06);
    transition: background 90ms;
    border: 1px dashed rgba(228, 228, 231, 0.18);
  }
  .zone.active {
    background: rgba(228, 228, 231, 0.22);
    border-color: rgba(228, 228, 231, 0.65);
  }
  .zone-top { top: 0; left: 25%; right: 25%; height: 50%; }
  .zone-bottom { bottom: 0; left: 25%; right: 25%; height: 50%; }
  .zone-left { left: 0; top: 25%; bottom: 25%; width: 50%; }
  .zone-right { right: 0; top: 25%; bottom: 25%; width: 50%; }
</style>
