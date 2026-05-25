<script lang="ts">
  import { onDestroy } from "svelte";
  import { app } from "$lib/app/store.svelte";
  import { settings } from "$lib/features/settings/store.svelte";
  import {
    paneStore,
    countLeaves,
    MAX_LEAVES,
  } from "$lib/features/panes/store.svelte";
  import { reloadThread, stopThread } from "$lib/features/thread/api";
  import { notifications } from "$lib/features/notifications/store.svelte";
  import StatusDot from "$lib/shared/components/StatusDot.svelte";
  import ShortcutIcon from "$lib/shared/icons/ShortcutIcon.svelte";
  import ConfirmDialog from "$lib/shared/components/ConfirmDialog.svelte";
  import ContextMenu from "$lib/shared/components/ContextMenu.svelte";
  import type { ContextMenuItem } from "$lib/shared/components/ContextMenu.svelte";
  import type { DropSide } from "$lib/features/panes/types";
  import type { Thread, ThreadStatus } from "$lib/types";
  import Plus from "@lucide/svelte/icons/plus";
  import X from "@lucide/svelte/icons/x";
  import FolderOpen from "@lucide/svelte/icons/folder-open";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import MoreHorizontal from "@lucide/svelte/icons/more-horizontal";
  import Archive from "@lucide/svelte/icons/archive";
  import ArchiveRestore from "@lucide/svelte/icons/archive-restore";
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";

  type Props = {
    onCloseThread: (threadId: string) => void;
    onActivateThread: (threadId: string) => void;
    onNewProject: () => void;
    onRemoveProject: (projectId: string) => void;
  };
  let {
    onCloseThread,
    onActivateThread,
    onNewProject,
    onRemoveProject,
  }: Props = $props();

  let menuFor = $state<string | null>(null);
  let confirmThreadId = $state<string | null>(null);
  let confirmProjectId = $state<string | null>(null);
  let showArchived = $state(false);

  type RowSnapshot = { id: string; top: number; height: number };
  type SourceRect = { left: number; top: number; width: number; height: number };
  type DragState = {
    kind: "project" | "thread";
    id: string;
    projectId: string;
    pointerId: number;
    startX: number;
    startY: number;
    x: number;
    y: number;
    active: boolean;
    sourceHeight: number;
    sourceRect: SourceRect | null;
    grabX: number;
    grabY: number;
    siblings: RowSnapshot[];
    slotIndex: number | null;
  };
  let dragState = $state<DragState | null>(null);
  let suppressClickFor = $state<string | null>(null);

  let resizing = $state(false);
  let asideEl: HTMLElement | null = $state(null);

  const liveDrag = $derived(dragState?.active ? dragState : null);
  const draggingId = $derived(liveDrag?.id ?? null);
  const draggingKind = $derived(liveDrag?.kind ?? null);
  const dragOffset = $derived(
    liveDrag ? liveDrag.y - liveDrag.startY : 0,
  );

  $effect(() => {
    if (!liveDrag) {
      document.body.classList.remove("dragging-card");
      return;
    }
    document.body.classList.add("dragging-card");
    return () => document.body.classList.remove("dragging-card");
  });

  function isDragBlocked(el: HTMLElement | null): boolean {
    return !!el?.closest("input, textarea, select, [data-no-drag], [data-drag-block]");
  }

  function threadPointerDown(thread: Thread, e: PointerEvent) {
    if (e.button === 1) e.preventDefault();
    if (e.button !== 0 || isDragBlocked(e.target as HTMLElement)) return;
    e.stopPropagation();
    startPointerDrag({
      kind: "thread",
      id: thread.id,
      projectId: thread.projectId,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      x: e.clientX,
      y: e.clientY,
      active: false,
      sourceHeight: 0,
      sourceRect: null,
      grabX: 0,
      grabY: 0,
      siblings: [],
      slotIndex: null,
    });
  }

  function threadAuxClick(id: string, e: MouseEvent) {
    if (e.button !== 1) return;
    e.preventDefault();
    e.stopPropagation();
    void stopThread(id);
  }

  function toggleMenu(id: string, e: MouseEvent) {
    e.stopPropagation();
    menuFor = menuFor === id ? null : id;
  }

  function closeMenu() {
    menuFor = null;
  }

  function selectProject(projectId: string) {
    app.selectedProjectId = projectId;
    if (app.activeThread && app.activeThread.projectId !== projectId) {
      app.activeThreadId = null;
    }
    app.view = "terminal";
  }

  function projectPointerDown(projectId: string, e: PointerEvent) {
    if (showArchived) return;
    if (e.button !== 0 || isDragBlocked(e.target as HTMLElement)) return;
    const project = app.projects.find((p) => p.id === projectId);
    if (!project) return;
    startPointerDrag({
      kind: "project",
      id: project.id,
      projectId: project.id,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      x: e.clientX,
      y: e.clientY,
      active: false,
      sourceHeight: 0,
      sourceRect: null,
      grabX: 0,
      grabY: 0,
      siblings: [],
      slotIndex: null,
    });
  }

  function startPointerDrag(next: DragState) {
    cleanupPointerDrag();
    dragState = next;
    document.addEventListener("pointermove", pointerDragMove);
    document.addEventListener("pointerup", pointerDragEnd);
    document.addEventListener("pointercancel", pointerDragEnd);
  }

  function captureSiblings(drag: DragState) {
    const sel =
      drag.kind === "project"
        ? "[data-project-row]"
        : `[data-thread-row][data-project-id="${drag.projectId}"]`;
    const rows = Array.from(document.querySelectorAll<HTMLElement>(sel));
    const snaps: RowSnapshot[] = rows.map((el) => {
      const r = el.getBoundingClientRect();
      const id =
        drag.kind === "project"
          ? el.dataset.projectRow ?? ""
          : el.dataset.threadRow ?? "";
      return { id, top: r.top, height: r.height };
    });
    drag.siblings = snaps;
    const me = snaps.find((s) => s.id === drag.id);
    drag.sourceHeight = me?.height ?? 36;
    const sourceEl = rows.find((el) => {
      const id =
        drag.kind === "project"
          ? el.dataset.projectRow ?? ""
          : el.dataset.threadRow ?? "";
      return id === drag.id;
    });
    if (sourceEl) {
      const r = sourceEl.getBoundingClientRect();
      drag.sourceRect = {
        left: r.left,
        top: r.top,
        width: r.width,
        height: r.height,
      };
      drag.grabX = drag.startX - r.left;
      drag.grabY = drag.startY - r.top;
      drag.sourceHeight = r.height;
    }
  }

  function pointerDragMove(e: PointerEvent) {
    const drag = dragState;
    if (!drag || e.pointerId !== drag.pointerId) return;

    drag.x = e.clientX;
    drag.y = e.clientY;

    if (!drag.active) {
      const moved = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY);
      if (moved < 5) {
        dragState = { ...drag };
        return;
      }
      drag.active = true;
      suppressClickFor = drag.id;
      closeMenu();
      closeContextMenu();
      captureSiblings(drag);
      if (drag.kind === "thread") paneStore.draggingThreadId = drag.id;
    }

    e.preventDefault();
    if (drag.kind === "project") {
      drag.slotIndex = computeSlotIndex(drag);
      paneStore.dropPreview = null;
    } else {
      updateThreadDrag(drag, e);
    }
    dragState = { ...drag };
  }

  function computeSlotIndex(drag: DragState): number | null {
    if (drag.siblings.length === 0) return null;
    const sourceIdx = drag.siblings.findIndex((s) => s.id === drag.id);
    if (sourceIdx < 0) return null;
    const reduced = drag.siblings.filter((_, i) => i !== sourceIdx);
    if (reduced.length === 0) return 0;
    const cy = drag.y;
    for (let i = 0; i < reduced.length; i++) {
      const mid = reduced[i].top + reduced[i].height / 2;
      if (cy < mid) return i;
    }
    return reduced.length;
  }

  function updateThreadDrag(drag: DragState, e: PointerEvent) {
    const previewPicked = updatePaneDropPreview(drag, e.clientX, e.clientY);
    if (previewPicked) {
      drag.slotIndex = null;
      return;
    }
    const overEl = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    const inAside = !!overEl?.closest("[data-sidebar-root]");
    const sameProjectList = !!overEl?.closest(
      `[data-thread-list][data-project-id="${drag.projectId}"]`,
    );
    const overSourceProjectHeader = !!overEl?.closest(
      `[data-project-row="${drag.projectId}"]`,
    );
    if (inAside && (sameProjectList || overSourceProjectHeader)) {
      drag.slotIndex = computeSlotIndex(drag);
    } else {
      drag.slotIndex = null;
    }
  }

  function updatePaneDropPreview(
    drag: DragState,
    clientX: number,
    clientY: number,
  ): boolean {
    const viewport = document.querySelector("[data-pane-viewport]") as HTMLElement | null;
    if (!viewport) {
      paneStore.dropPreview = null;
      return false;
    }
    const rootRect = viewport.getBoundingClientRect();
    const x = clientX - rootRect.left;
    const y = clientY - rootRect.top;
    if (x < 0 || y < 0 || x > rootRect.width || y > rootRect.height) {
      paneStore.dropPreview = null;
      return false;
    }

    const activeGroupId = app.activeThreadId
      ? paneStore.groupOf(app.activeThreadId)?.id ?? null
      : null;
    for (const [targetThreadId, rect] of Object.entries(paneStore.rects)) {
      if (
        targetThreadId === drag.id ||
        x < rect.x ||
        y < rect.y ||
        x > rect.x + rect.w ||
        y > rect.y + rect.h
      ) {
        continue;
      }
      const target = app.threads.find((t) => t.id === targetThreadId);
      const group = paneStore.groupOf(targetThreadId);
      if (!target || target.projectId !== drag.projectId || !group) {
        continue;
      }
      if (activeGroupId && group.id !== activeGroupId) {
        continue;
      }
      const sourceGroup = paneStore.groupOf(drag.id);
      const refused =
        countLeaves(group.root) >= MAX_LEAVES && sourceGroup?.id !== group.id;
      paneStore.dropPreview = {
        targetThreadId,
        side: sideFromRect(rect, x, y),
        refused,
      };
      return true;
    }

    paneStore.dropPreview = null;
    return false;
  }

  function sideFromRect(
    rect: { x: number; y: number; w: number; h: number },
    x: number,
    y: number,
  ): DropSide {
    const localX = x - rect.x;
    const localY = y - rect.y;
    const dx = Math.min(localX, rect.w - localX) / rect.w;
    const dy = Math.min(localY, rect.h - localY) / rect.h;
    if (dx < dy) return localX < rect.w / 2 ? "left" : "right";
    return localY < rect.h / 2 ? "top" : "bottom";
  }

  function pointerDragEnd(e: PointerEvent) {
    const drag = dragState;
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (drag.active) {
      e.preventDefault();
      if (drag.kind === "project") commitProjectDrag(drag);
      else commitThreadDrag(drag, e);
      setTimeout(() => {
        if (suppressClickFor === drag.id) suppressClickFor = null;
      }, 0);
    }
    cleanupPointerDrag();
  }

  function cleanupPointerDrag() {
    if (typeof document !== "undefined") {
      document.removeEventListener("pointermove", pointerDragMove);
      document.removeEventListener("pointerup", pointerDragEnd);
      document.removeEventListener("pointercancel", pointerDragEnd);
    }
    dragState = null;
    paneStore.draggingThreadId = null;
    paneStore.dropPreview = null;
  }

  function commitProjectDrag(drag: DragState) {
    const slot = drag.slotIndex;
    if (slot === null) return;
    const ids = app.sortedProjects.map((p) => p.id);
    const fromIdx = ids.indexOf(drag.id);
    if (fromIdx < 0) return;
    ids.splice(fromIdx, 1);
    const insertAt = Math.min(slot, ids.length);
    ids.splice(insertAt, 0, drag.id);
    void settings.setProjectOrder(ids);
  }

  function commitThreadDrag(drag: DragState, e: PointerEvent) {
    const preview = paneStore.dropPreview;
    if (preview) {
      if (preview.refused) {
        notifications.error(`Max ${MAX_LEAVES} panes per group`);
        return;
      }
      const ok = paneStore.splitInto(preview.targetThreadId, drag.id, preview.side);
      if (!ok) notifications.error("Couldn't split pane");
      return;
    }

    if (drag.slotIndex !== null) {
      const ids = app.threadsByProjectSorted(drag.projectId).map((t) => t.id);
      const fromIdx = ids.indexOf(drag.id);
      if (fromIdx < 0) return;
      ids.splice(fromIdx, 1);
      const insertAt = Math.min(drag.slotIndex, ids.length);
      ids.splice(insertAt, 0, drag.id);
      void settings.setThreadOrder(drag.projectId, ids);
      return;
    }

    if (asideEl) {
      const asideRect = asideEl.getBoundingClientRect();
      const insideAside =
        e.clientX >= asideRect.left &&
        e.clientX <= asideRect.right &&
        e.clientY >= asideRect.top &&
        e.clientY <= asideRect.bottom;
      const group = paneStore.groupOf(drag.id);
      if (insideAside && group && countLeaves(group.root) > 1) {
        paneStore.unsplit(drag.id);
      }
    }
  }

  function rowShift(idx: number, sourceIdx: number, slot: number, height: number): number {
    if (idx === sourceIdx) return 0;
    const eff = idx < sourceIdx ? idx : idx - 1;
    const base = idx > sourceIdx ? -height : 0;
    const drop = eff >= slot ? height : 0;
    return base + drop;
  }

  function threadHoverEnter(id: string) {
    paneStore.hoveredThreadId = id;
  }
  function threadHoverLeave(id: string) {
    if (paneStore.hoveredThreadId === id) paneStore.hoveredThreadId = null;
  }

  function displayThreadStatus(thread: Thread): ThreadStatus {
    if (app.unboundByDedup.includes(thread.id)) return "error";
    if (
      thread.ptyId &&
      (thread.status === "idle" || thread.status === "stopped")
    ) {
      return "ready";
    }
    return thread.status;
  }

  let ctxMenu = $state<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);

  function openThreadContextMenu(thread: Thread, e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const group = paneStore.groupOf(thread.id);
    const inMultiPane = !!group && countLeaves(group.root) > 1;
    const items: ContextMenuItem[] = [];
    if (inMultiPane) {
      items.push({
        label: "Détacher du groupe",
        action: () => {
          paneStore.unsplit(thread.id);
        },
      });
      items.push({ separator: true });
    }
    items.push({
      label: "Reload thread",
      action: () => {
        void reloadThread(thread.id);
      },
    });
    items.push({ separator: true });
    items.push({
      label: "Fermer",
      action: () => requestRemoveThread(thread.id),
      danger: true,
    });
    ctxMenu = { x: e.clientX, y: e.clientY, items };
  }
  function closeContextMenu() {
    ctxMenu = null;
  }

  function startResize(e: MouseEvent) {
    e.preventDefault();
    resizing = true;
    document.addEventListener("mousemove", onResize);
    document.addEventListener("mouseup", stopResize);
  }
  function onResize(e: MouseEvent) {
    if (!asideEl) return;
    const rect = asideEl.getBoundingClientRect();
    const next = e.clientX - rect.left;
    void settings.setSidebarWidth(next);
  }
  function stopResize() {
    resizing = false;
    if (typeof document === "undefined") return;
    document.removeEventListener("mousemove", onResize);
    document.removeEventListener("mouseup", stopResize);
  }

  function consumeDragClick(id: string): boolean {
    if (suppressClickFor !== id) return false;
    suppressClickFor = null;
    return true;
  }

  function requestRemoveThread(id: string) {
    if (!settings.state.confirmCloseThread) {
      onCloseThread(id);
      return;
    }
    confirmThreadId = id;
  }
  function confirmRemoveThread() {
    if (confirmThreadId) onCloseThread(confirmThreadId);
    confirmThreadId = null;
  }
  function cancelRemoveThread() {
    confirmThreadId = null;
  }

  function requestRemoveProject(id: string) {
    closeMenu();
    confirmProjectId = id;
  }

  function openProjectContextMenu(project: { id: string; archived: boolean }, e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    closeMenu();
    const items: ContextMenuItem[] = [];
    if (project.archived) {
      items.push({
        label: "Désarchiver",
        action: () => {
          void app.unarchiveProject(project.id);
        },
      });
    } else {
      items.push({
        label: "Archiver",
        action: () => {
          void app.archiveProject(project.id);
        },
      });
    }
    items.push({ separator: true });
    items.push({
      label: "Remove project",
      action: () => requestRemoveProject(project.id),
      danger: true,
    });
    ctxMenu = { x: e.clientX, y: e.clientY, items };
  }
  function confirmRemoveProject() {
    if (confirmProjectId) onRemoveProject(confirmProjectId);
    confirmProjectId = null;
  }
  function cancelRemoveProject() {
    confirmProjectId = null;
  }

  const pendingThread = $derived(
    confirmThreadId ? app.threads.find((t) => t.id === confirmThreadId) : null,
  );
  const pendingProject = $derived(
    confirmProjectId ? app.projects.find((p) => p.id === confirmProjectId) : null,
  );

  const visibleProjects = $derived(
    showArchived ? app.archivedProjects : app.sortedProjects,
  );

  const threadsByProject = $derived.by(() => {
    const map = new Map<string, Thread[]>();
    for (const p of visibleProjects) {
      map.set(p.id, app.threadsByProjectSorted(p.id));
    }
    return map;
  });

  const projectSourceIdx = $derived(
    liveDrag && liveDrag.kind === "project"
      ? visibleProjects.findIndex((p) => p.id === liveDrag.id)
      : -1,
  );

  const threadSourceIdx = $derived.by(() => {
    if (!liveDrag || liveDrag.kind !== "thread") return -1;
    const list = threadsByProject.get(liveDrag.projectId) ?? [];
    return list.findIndex((t) => t.id === liveDrag.id);
  });

  const threadDragGhost = $derived.by(() => {
    if (!liveDrag || liveDrag.kind !== "thread" || !liveDrag.sourceRect) {
      return null;
    }
    const thread = app.threads.find((t) => t.id === liveDrag.id);
    if (!thread) return null;
    return {
      thread,
      left: liveDrag.x - liveDrag.grabX,
      top: liveDrag.y - liveDrag.grabY,
      width: liveDrag.sourceRect.width,
    };
  });

  onDestroy(() => {
    cleanupPointerDrag();
    stopResize();
    document.body.classList.remove("dragging-card");
  });
</script>

<svelte:window onclick={closeMenu} />

<aside
  bind:this={asideEl}
  data-sidebar-root
  class="relative flex h-full shrink-0 flex-col border-r border-border bg-[var(--color-surface)] {resizing
    ? 'select-none'
    : ''}"
  style:width="{settings.state.sidebarWidth}px"
>
  <header class="flex items-center justify-between px-3 py-2">
    {#if showArchived}
      <button
        type="button"
        class="flex items-center gap-1.5 rounded text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground transition hover:text-foreground"
        onclick={() => (showArchived = false)}
        aria-label="Back to projects"
        title="Retour aux projets"
      >
        <ArrowLeft class="size-3.5" />
        Archives
      </button>
    {:else}
      <span
        class="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground"
      >
        Projects
      </span>
    {/if}
    <div class="flex items-center gap-0.5">
      <button
        type="button"
        class="rounded-md p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground {showArchived
          ? 'bg-accent text-foreground'
          : ''}"
        onclick={() => (showArchived = !showArchived)}
        aria-label="Show archived projects"
        title="Projets archivés"
      >
        <Archive class="size-4" />
      </button>
      {#if !showArchived}
        <button
          type="button"
          class="rounded-md p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground"
          onclick={onNewProject}
          aria-label="Add project"
          title="Add project from folder"
        >
          <Plus class="size-4" />
        </button>
      {/if}
    </div>
  </header>

  <div class="flex-1 overflow-y-auto px-2 pb-2">
    {#if showArchived && visibleProjects.length === 0}
      <div
        class="mx-1 mt-2 flex w-[calc(100%-0.5rem)] flex-col items-center gap-2 rounded-lg border border-dashed border-border bg-transparent px-3 py-7 text-xs text-muted-foreground"
      >
        <Archive class="size-5 opacity-70" />
        <span>Aucun projet archivé</span>
      </div>
    {:else if !showArchived && app.projects.length === 0}
      <button
        type="button"
        class="mx-1 mt-2 flex w-[calc(100%-0.5rem)] flex-col items-center gap-2 rounded-lg border border-dashed border-border bg-transparent px-3 py-7 text-xs text-muted-foreground transition hover:border-foreground/30 hover:bg-accent/30 hover:text-foreground"
        onclick={onNewProject}
      >
        <FolderOpen class="size-5 opacity-70" />
        <span>Pick a folder</span>
      </button>
    {/if}

    {#each visibleProjects as project, projectIdx (project.id)}
      {@const isSelected = app.currentProjectId === project.id}
      {@const isProjectSource = liveDrag?.kind === "project" && liveDrag.id === project.id}
      {@const projectShiftY =
        liveDrag && liveDrag.kind === "project" && liveDrag.slotIndex !== null && projectSourceIdx >= 0
          ? rowShift(projectIdx, projectSourceIdx, liveDrag.slotIndex, liveDrag.sourceHeight)
          : 0}
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div
        class="project-block mb-1.5"
        class:dragging={isProjectSource}
        class:source={isProjectSource}
        data-project-row={project.id}
        style:transform={isProjectSource
          ? `translate(0px, ${dragOffset}px) scale(1.015)`
          : `translateY(${projectShiftY}px)`}
        style:transition={isProjectSource ? "none" : "transform 180ms cubic-bezier(0.22, 1, 0.36, 1)"}
        style:z-index={isProjectSource ? 50 : "auto"}
        onpointerdown={(e) => projectPointerDown(project.id, e)}
        role="listitem"
      >
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="project-row group/project relative flex items-center gap-2 rounded-md px-2 py-1.5 transition hover:bg-accent/40 hover:text-foreground {showArchived
            ? ''
            : 'cursor-grab'} {isSelected ? 'bg-accent/40' : ''}"
          oncontextmenu={(e) => openProjectContextMenu(project, e)}
        >
          <div
            class="flex size-6 shrink-0 items-center justify-center overflow-hidden"
            class:rounded={!project.icon}
            style:background={project.icon ? "transparent" : "var(--color-surface-3)"}
          >
            {#if project.icon}
              <img
                src={project.icon}
                alt=""
                class="size-full object-contain"
                loading="lazy"
                draggable="false"
              />
            {:else}
              <span class="text-[11px] font-semibold text-muted-foreground">
                {project.name.charAt(0).toUpperCase()}
              </span>
            {/if}
          </div>
          <button
            type="button"
            class="min-w-0 flex-1 truncate text-left text-[13px] font-medium text-foreground/90 transition group-hover/project:text-foreground"
            title={project.cwd}
            onclick={() => {
              if (consumeDragClick(project.id)) return;
              if (showArchived) return;
              selectProject(project.id);
            }}
          >
            {project.name}
          </button>

          {#if showArchived}
            <button
              type="button"
              class="rounded p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground"
              onclick={(e) => {
                e.stopPropagation();
                void app.unarchiveProject(project.id);
              }}
              data-drag-block
              aria-label="Unarchive project"
              title="Désarchiver"
            >
              <ArchiveRestore class="size-3.5" />
            </button>
          {:else}
            <button
              type="button"
              class="rounded p-1 text-muted-foreground/0 transition hover:bg-accent hover:text-foreground group-hover/project:text-muted-foreground"
              onclick={(e) => toggleMenu(project.id, e)}
              data-drag-block
              aria-label="Project options"
              title="More"
            >
              <MoreHorizontal class="size-3.5" />
            </button>
          {/if}

          {#if menuFor === project.id}
            <div
              class="absolute right-2 top-full z-20 mt-1 flex min-w-36 flex-col rounded-md border bg-[var(--color-surface-2)] p-1 shadow-xl"
              role="menu"
            >
              <button
                type="button"
                class="flex items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-foreground transition hover:bg-accent"
                onclick={(e) => {
                  e.stopPropagation();
                  closeMenu();
                  void app.archiveProject(project.id);
                }}
              >
                <Archive class="size-3" />
                Archiver
              </button>
              <div class="my-1 h-px bg-border"></div>
              <button
                type="button"
                class="flex items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-danger transition hover:bg-danger/15"
                onclick={(e) => {
                  e.stopPropagation();
                  requestRemoveProject(project.id);
                }}
              >
                <Trash2 class="size-3" />
                Remove project
              </button>
            </div>
          {/if}
        </div>

        {#if !showArchived && (threadsByProject.get(project.id) ?? []).length > 0}
          {@const threads = threadsByProject.get(project.id) ?? []}
          {@const dragInThisProject =
            liveDrag?.kind === "thread" && liveDrag.projectId === project.id}
          <ul
            class="ml-3 space-y-0.5 border-l border-dashed border-border/60 pl-2"
            data-thread-list
            data-project-id={project.id}
          >
            {#each threads as thread, threadIdx (thread.id)}
              {@const isThreadSource = liveDrag?.kind === "thread" && liveDrag.id === thread.id}
              {@const isActive =
                app.activeThreadId === thread.id && app.view === "terminal"}
              {@const shiftY =
                dragInThisProject && liveDrag.slotIndex !== null && threadSourceIdx >= 0
                  ? rowShift(threadIdx, threadSourceIdx, liveDrag.slotIndex, liveDrag.sourceHeight)
                  : 0}
              <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
              <li
                class="thread-row group/thread"
                class:source={isThreadSource}
                data-thread-row={thread.id}
                data-thread-id={thread.id}
                data-project-id={thread.projectId}
                style:transform={isThreadSource
                  ? "none"
                  : `translateY(${shiftY}px)`}
                style:transition={isThreadSource ? "none" : "transform 180ms cubic-bezier(0.22, 1, 0.36, 1)"}
                style:z-index={isThreadSource ? 50 : "auto"}
                onpointerdown={(e) => threadPointerDown(thread, e)}
                onmouseenter={() => threadHoverEnter(thread.id)}
                onmouseleave={() => threadHoverLeave(thread.id)}
                oncontextmenu={(e) => openThreadContextMenu(thread, e)}
                role="listitem"
              >
                <div
                  class="thread-card flex cursor-grab items-center gap-2 rounded-md px-2 py-1.5 transition {isActive
                    ? 'bg-accent text-foreground'
                    : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground'}"
                  role="button"
                  tabindex="0"
                  onclick={() => {
                    if (consumeDragClick(thread.id)) return;
                    onActivateThread(thread.id);
                  }}
                  onauxclick={(e) => threadAuxClick(thread.id, e)}
                  onkeydown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onActivateThread(thread.id);
                    }
                  }}
                >
                  <StatusDot
                    status={displayThreadStatus(thread)}
                    asleep={thread.autoSlept ?? false}
                  />
                  <span
                    class="min-w-0 flex-1 truncate text-left text-[13px]"
                    title={thread.title ?? thread.label}
                  >
                    {thread.title ?? thread.label}
                  </span>
                  <span
                    class="relative flex size-4 shrink-0 items-center justify-center"
                    data-no-drag
                  >
                    <span
                      class="absolute inset-0 flex items-center justify-center transition-opacity group-hover/thread:opacity-0"
                    >
                      <ShortcutIcon iconKey={thread.iconKey} size={14} />
                    </span>
                    <button
                      type="button"
                      class="absolute inset-0 flex items-center justify-center rounded text-muted-foreground/70 opacity-0 transition hover:bg-danger/20 hover:text-danger group-hover/thread:opacity-100"
                      onclick={(e) => {
                        e.stopPropagation();
                        requestRemoveThread(thread.id);
                      }}
                      aria-label="Close {thread.label}"
                      title="Close thread"
                    >
                      <X class="size-3.5" />
                    </button>
                  </span>
                </div>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    {/each}
  </div>

  <button
    type="button"
    class="absolute right-0 top-0 z-10 h-full w-1 cursor-col-resize bg-transparent transition hover:bg-foreground/10"
    onmousedown={startResize}
    aria-label="Resize sidebar"
    title="Resize sidebar"
    tabindex="-1"
  ></button>
</aside>

{#if threadDragGhost}
  <div
    class="drag-ghost fixed flex items-center gap-2 rounded-md px-2 py-1.5 text-muted-foreground"
    style:left="{threadDragGhost.left}px"
    style:top="{threadDragGhost.top}px"
    style:width="{threadDragGhost.width}px"
    aria-hidden="true"
  >
    <StatusDot
      status={displayThreadStatus(threadDragGhost.thread)}
      asleep={threadDragGhost.thread.autoSlept ?? false}
    />
    <span
      class="min-w-0 flex-1 truncate text-left text-[13px]"
      title={threadDragGhost.thread.title ?? threadDragGhost.thread.label}
    >
      {threadDragGhost.thread.title ?? threadDragGhost.thread.label}
    </span>
    <span class="flex size-4 shrink-0 items-center justify-center">
      <ShortcutIcon iconKey={threadDragGhost.thread.iconKey} size={14} />
    </span>
  </div>
{/if}

<ConfirmDialog
  open={pendingThread !== null}
  title="Close thread?"
  message={pendingThread
    ? `Close ${pendingThread.title ?? pendingThread.label}? Running process will be killed.`
    : ""}
  confirmLabel="Close thread"
  danger
  onConfirm={confirmRemoveThread}
  onCancel={cancelRemoveThread}
/>

<ConfirmDialog
  open={pendingProject !== null}
  title="Remove project?"
  message={pendingProject
    ? `Remove ${pendingProject.name}? All its threads will be killed and dropped.`
    : ""}
  confirmLabel="Remove project"
  danger
  onConfirm={confirmRemoveProject}
  onCancel={cancelRemoveProject}
/>

{#if ctxMenu}
  <ContextMenu
    items={ctxMenu.items}
    x={ctxMenu.x}
    y={ctxMenu.y}
    onClose={closeContextMenu}
  />
{/if}

<style>
  :global(body.dragging-card) {
    user-select: none !important;
    cursor: grabbing !important;
  }
  :global(body.dragging-card *) {
    cursor: grabbing !important;
  }

  .project-block {
    transform-origin: left center;
    will-change: transform;
  }
  .thread-row {
    transform-origin: left center;
    will-change: transform;
  }
  .project-row,
  .thread-card {
    user-select: none;
  }

  .project-block.source > .project-row,
  .drag-ghost {
    box-shadow:
      0 12px 28px rgba(0, 0, 0, 0.5),
      0 0 0 1px rgba(255, 255, 255, 0.08);
    background: color-mix(in srgb, var(--color-surface-2, #1a1a1a) 90%, transparent);
    backdrop-filter: blur(6px);
  }
  .drag-ghost {
    pointer-events: none;
    z-index: 9999;
  }
  .thread-row.source > .thread-card {
    opacity: 0;
  }
  .thread-row.source {
    pointer-events: none;
  }
  .project-block.source {
    pointer-events: none;
  }
</style>
