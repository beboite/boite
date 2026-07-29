<script lang="ts">
  import { onDestroy } from "svelte";
  import { app } from "$lib/app/store.svelte";
  import { workspace } from "$lib/backend";
  import { settings } from "$lib/features/settings/store.svelte";
  import {
    paneStore,
    countLeaves,
    MAX_LEAVES,
  } from "$lib/features/panes/store.svelte";
  import {
    closeThreadWithConfirm,
    reloadThread,
    stopThread,
  } from "$lib/features/thread/api";
  import { moveThreadToProject } from "$lib/features/thread/move";
  import { notifications } from "$lib/features/notifications/store.svelte";
  import { refreshProjectIcon } from "$lib/features/project/api";
  import { isScratch, projectDisplayName } from "$lib/features/project/scratch";
  import StatusDot from "$lib/shared/components/StatusDot.svelte";
  import ShortcutIcon from "$lib/shared/icons/ShortcutIcon.svelte";
  import { threadIconColor } from "$lib/features/fastpick/threadAccent";
  import { confirmDialog } from "$lib/shared/components/confirm.svelte";
  import { resizeHandle } from "$lib/shared/actions/resizeHandle";
  import { longPress } from "$lib/shared/actions/longPress";
  import ContextMenu from "$lib/shared/components/ContextMenu.svelte";
  import type { ContextMenuItem } from "$lib/shared/components/ContextMenu.svelte";
  import type { DropSide } from "$lib/features/panes/types";
  import type { Thread, ThreadStatus } from "$lib/types";
  import Plus from "@lucide/svelte/icons/plus";
  import X from "@lucide/svelte/icons/x";
  import FolderOpen from "@lucide/svelte/icons/folder-open";
  import MoreHorizontal from "@lucide/svelte/icons/more-horizontal";
  import Archive from "@lucide/svelte/icons/archive";
  import ArchiveRestore from "@lucide/svelte/icons/archive-restore";
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import { t } from "$lib/i18n/index.svelte";

  type Props = {
    onActivateThread: (threadId: string) => void;
    onNewProject: (target?: "local" | "remote") => void;
    onRemoveProject: (projectId: string) => void;
  };
  let { onActivateThread, onNewProject, onRemoveProject }: Props = $props();

  // Dynamic mode: the plain + adds locally, the boite-colored + adds on the
  // boite (server-side folder browser).
  function addProjectClick() {
    onNewProject(workspace.isDynamic ? "local" : undefined);
  }

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
    // Another project the card is currently over. Set only while it is over one
    // that is not its own — hovering the source project is a reorder, and the
    // two are mutually exclusive with `slotIndex`.
    dropProjectId: string | null;
  };
  let dragState = $state<DragState | null>(null);
  let dragCaptureEl: HTMLElement | null = null;
  let suppressClickFor = $state<string | null>(null);

  let resizing = $state(false);
  let asideEl: HTMLElement | null = $state(null);

  const liveDrag = $derived(dragState?.active ? dragState : null);
  const draggingId = $derived(liveDrag?.id ?? null);
  const draggingKind = $derived(liveDrag?.kind ?? null);
  const dragOffset = $derived(
    liveDrag ? liveDrag.y - liveDrag.startY : 0,
  );
  // The project about to receive the dragged card. Read by the markup to light
  // its row up, which is the only thing telling the user that letting go here
  // moves the thread rather than doing nothing.
  const dropProjectId = $derived(liveDrag?.dropProjectId ?? null);

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
    dragCaptureEl = e.currentTarget as HTMLElement;
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
      dropProjectId: null,
    });
  }

  function threadAuxClick(id: string, e: MouseEvent) {
    if (e.button !== 1) return;
    e.preventDefault();
    e.stopPropagation();
    void stopThread(id);
  }

  // Clicking a project opens its page. It used to drop you on the terminal
  // view, which showed whatever thread happened to be active — or a list of
  // keyboard shortcuts when none was. The project's own page is the answer to
  // the click that asked for it; a thread is one click further, from there or
  // from this list.
  //
  // The thread is always left behind, including the one whose project is the
  // one being clicked: keeping it made that project the only row in the
  // sidebar that did nothing. With a page to land on rather than a thread's
  // terminal, that is now also the only way the click has anything to show.
  function selectProject(projectId: string) {
    app.selectedProjectId = projectId;
    app.activeThreadId = null;
    app.view = "project";
  }

  function projectPointerDown(projectId: string, e: PointerEvent) {
    if (showArchived) return;
    if (e.button !== 0 || isDragBlocked(e.target as HTMLElement)) return;
    const project = app.projects.find((p) => p.id === projectId);
    if (!project) return;
    dragCaptureEl = e.currentTarget as HTMLElement;
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
      dropProjectId: null,
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
      // Capture keeps the drag alive if the button is released outside the
      // window. Deferred until the drag really starts: capturing on
      // pointerdown retargets the click to the row, so plain clicks never
      // reached the activate/select handlers.
      try {
        dragCaptureEl?.setPointerCapture(drag.pointerId);
      } catch {
        // pointer already released
      }
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
      drag.dropProjectId = null;
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
      drag.dropProjectId = null;
      return;
    }
    drag.slotIndex = null;
    // Over a different project — its header or the space its threads occupy —
    // the card is being given to it. Archived rows are excluded: they are only
    // on screen while the archive list is open, and dropping onto one would
    // move a live thread into a project the user has put away.
    const overProject =
      overEl?.closest<HTMLElement>("[data-project-row]")?.dataset.projectRow ??
      overEl?.closest<HTMLElement>("[data-thread-list]")?.dataset.projectId ??
      null;
    drag.dropProjectId =
      inAside &&
      overProject &&
      overProject !== drag.projectId &&
      app.sortedProjects.some((p) => p.id === overProject)
        ? overProject
        : null;
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
      const target = app.threadById(targetThreadId);
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
    dragCaptureEl = null;
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
    // Checked before the pane preview: the two are already exclusive in
    // updateThreadDrag, and reading the drop project first keeps the intent
    // ("give this to that project") ahead of the layout question.
    if (drag.dropProjectId) {
      void moveThreadToProject(drag.id, drag.dropProjectId);
      return;
    }

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

  // Inline rename: one row at a time swaps its label for an input. Kept here
  // rather than per-row so opening a second rename closes the first.
  let renaming = $state<{
    kind: "thread" | "project";
    id: string;
    value: string;
  } | null>(null);

  function startRename(kind: "thread" | "project", id: string, current: string) {
    renaming = { kind, id, value: current };
  }

  function commitRename() {
    const r = renaming;
    if (!r) return;
    renaming = null;
    const next = r.value.trim();
    if (r.kind === "project") {
      if (next) void app.renameProject(r.id, next);
      return;
    }
    const thread = app.threads.find((t) => t.id === r.id);
    if (!thread || next === (thread.title ?? "")) return;
    // Emptied on purpose: drop the manual name instead of storing "".
    void app.renameThread(r.id, next || null);
  }

  function cancelRename() {
    renaming = null;
  }

  function renameKeydown(e: KeyboardEvent) {
    // The row and the terminal both listen for keys; a rename in progress owns
    // every one of them.
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      commitRename();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelRename();
    }
  }

  function selectOnMount(node: HTMLInputElement) {
    node.focus();
    node.select();
  }

  function openThreadContextMenu(thread: Thread, e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    openThreadMenuAt(thread, e.clientX, e.clientY);
  }

  // A finger held on the card, which is the only right-click a touch screen
  // has. Refused mid-drag: the card is already on its way somewhere.
  function longPressMenu(open: () => void) {
    if (liveDrag) return;
    open();
  }

  function openThreadMenuAt(thread: Thread, x: number, y: number) {
    const group = paneStore.groupOf(thread.id);
    const inMultiPane = !!group && countLeaves(group.root) > 1;
    const items: ContextMenuItem[] = [];
    items.push({
      label: "Rename",
      action: () =>
        startRename("thread", thread.id, thread.title ?? thread.label),
    });
    items.push({ separator: true });
    if (inMultiPane) {
      items.push({
        label: "Detach from group",
        action: () => {
          paneStore.unsplit(thread.id);
        },
      });
      items.push({ separator: true });
    }
    // Same call middle-click makes; the shortcut is undiscoverable, and on a
    // trackpad there is no middle button to make it with. Already stopped
    // means there is no PTY left to put down.
    items.push({
      label: "Put to sleep",
      action: () => {
        void stopThread(thread.id);
      },
      disabled: !thread.ptyId,
    });
    items.push({
      label: thread.keepAwake ? "Allow auto-sleep" : "Keep awake",
      action: () => {
        app.toggleThreadKeepAwake(thread.id);
      },
    });
    items.push({ separator: true });
    items.push({
      label: "Reload thread",
      action: () => {
        void reloadThread(thread.id);
      },
    });
    items.push({ separator: true });
    items.push({
      label: "Close thread",
      action: () => requestRemoveThread(thread.id),
      danger: true,
    });
    ctxMenu = { x, y, items };
  }
  function closeContextMenu() {
    ctxMenu = null;
  }

  function onResize(e: PointerEvent) {
    if (!asideEl) return;
    const rect = asideEl.getBoundingClientRect();
    void settings.setSidebarWidth(e.clientX - rect.left);
  }

  function consumeDragClick(id: string): boolean {
    if (suppressClickFor !== id) return false;
    suppressClickFor = null;
    return true;
  }

  function requestRemoveThread(id: string) {
    void closeThreadWithConfirm(id);
  }

  async function requestRemoveProject(id: string) {
    const project = app.projects.find((p) => p.id === id);
    if (!project) return;
    const ok = await confirmDialog.ask({
      title: "Remove project?",
      message: `Remove ${projectDisplayName(project)}? All its threads will be killed and dropped.`,
      confirmLabel: "Remove project",
      danger: true,
    });
    if (ok) onRemoveProject(id);
  }

  function openProjectContextMenu(
    project: { id: string; name: string; archived: boolean },
    e: MouseEvent,
  ) {
    e.preventDefault();
    e.stopPropagation();
    openProjectMenuAt(project, e.clientX, e.clientY);
  }

  function openProjectMenuAt(
    project: { id: string; name: string; archived: boolean },
    x: number,
    y: number,
  ) {
    const items: ContextMenuItem[] = [];
    // Scratch is the app's own row and reads in the app's language, so there is
    // no name on it for the user to change.
    if (!isScratch(project)) {
      items.push({
        label: "Rename",
        action: () => startRename("project", project.id, project.name),
      });
      items.push({ separator: true });
    }
    if (project.archived) {
      items.push({
        label: "Unarchive",
        action: () => {
          void app.unarchiveProject(project.id);
        },
      });
    } else {
      items.push({
        label: "Archive",
        action: () => {
          void app.archiveProject(project.id);
        },
      });
    }
    items.push({
      label: "Refresh icon",
      action: () => {
        const p = app.projects.find((x) => x.id === project.id);
        if (p) void refreshProjectIcon(p);
      },
    });
    items.push({ separator: true });
    items.push({
      label: "Remove project",
      action: () => void requestRemoveProject(project.id),
      danger: true,
    });
    ctxMenu = { x, y, items };
  }

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
    const thread = app.threadById(liveDrag.id);
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
    document.body.classList.remove("dragging-card");
  });
</script>

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
        aria-label={t("sidebar.backToProjects")}
        title={t("sidebar.backToProjects")}
      >
        <ArrowLeft class="size-3.5" />
        {t("sidebar.archives")}
      </button>
    {:else}
      <span
        class="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground"
      >
        {t("sidebar.projects")}
      </span>
    {/if}
    <div class="flex items-center gap-0.5">
      <button
        type="button"
        class="rounded-md p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground {showArchived
          ? 'bg-accent text-foreground'
          : ''}"
        onclick={() => (showArchived = !showArchived)}
        aria-label={t("sidebar.showArchived")}
        title={t("sidebar.archivedProjects")}
      >
        <Archive class="size-4" />
      </button>
      {#if !showArchived}
        <button
          type="button"
          class="rounded-md p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground"
          onclick={addProjectClick}
          aria-label={t("sidebar.addProject")}
          title={t("sidebar.addProjectFromFolder")}
        >
          <Plus class="size-4" />
        </button>
        {#if workspace.isDynamic}
          <!-- Boite-colored twin of the + button: adds a project on the
               connected boite via the server-side folder browser. -->
          <button
            type="button"
            class="rounded-md border p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground"
            style:border-color={workspace.info.color || "var(--color-success)"}
            onclick={() => onNewProject("remote")}
            aria-label={t("sidebar.addProjectOnBoite")}
            title={t("sidebar.addProjectOn", { name: workspace.info.name || "boite" })}
          >
            <Plus class="size-4" />
          </button>
        {/if}
      {/if}
    </div>
  </header>

  <!-- The empty space below the rows is how the user gets onto no project at
       all, which is what sends the next launch to Scratch. Only the container
       itself: a click that reached a row is that row's. -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    class="flex-1 overflow-y-auto px-2 pb-2"
    role="list"
    onclick={(e) => {
      if (e.target === e.currentTarget) app.clearSelection();
    }}
  >
    {#if showArchived && visibleProjects.length === 0}
      <div
        class="mx-1 mt-2 flex w-[calc(100%-0.5rem)] flex-col items-center gap-2 rounded-lg border border-dashed border-border bg-transparent px-3 py-7 text-xs text-muted-foreground"
      >
        <Archive class="size-5 opacity-70" />
        <span>{t("sidebar.noArchived")}</span>
      </div>
    {:else if !showArchived && app.projects.length === 0}
      <button
        type="button"
        class="mx-1 mt-2 flex w-[calc(100%-0.5rem)] flex-col items-center gap-2 rounded-lg border border-dashed border-border bg-transparent px-3 py-7 text-xs text-muted-foreground transition hover:border-foreground/30 hover:bg-accent/30 hover:text-foreground"
        onclick={addProjectClick}
      >
        <FolderOpen class="size-5 opacity-70" />
        <span>{t("sidebar.pickFolder")}</span>
      </button>
    {/if}

    {#each visibleProjects as project, projectIdx (project.id)}
      {@const isSelected = app.currentProjectId === project.id}
      {@const isRemoteOrigin = workspace.isDynamic && project.origin === "remote"}
      {@const boiteOffline = isRemoteOrigin && workspace.connection !== "connected"}
      {@const isProjectSource = liveDrag?.kind === "project" && liveDrag.id === project.id}
      <!-- Scratch is the home folder, not a repository: no worktree, nothing to
           branch, nothing git has an opinion about. It sits in the list like a
           project because everything a thread needs keys off one, so the row is
           the only place left to say it is not one. A lighter surface, no
           border and no badge — enough to read as apart, not as broken. -->
      {@const isScratchRow = isScratch(project)}
      {@const projectShiftY =
        liveDrag && liveDrag.kind === "project" && liveDrag.slotIndex !== null && projectSourceIdx >= 0
          ? rowShift(projectIdx, projectSourceIdx, liveDrag.slotIndex, liveDrag.sourceHeight)
          : 0}
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div
        class="project-block mb-1.5"
        class:dragging={isProjectSource}
        class:source={isProjectSource}
        class:opacity-50={boiteOffline}
        class:drop-target={dropProjectId === project.id}
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
            : 'cursor-pointer'} {isSelected
            ? 'bg-accent/40'
            : isScratchRow
              ? 'bg-[var(--color-surface-2)]'
              : ''}"
          style:box-shadow={isRemoteOrigin
            ? `inset 2px 0 0 0 ${workspace.info.color || "var(--color-success)"}`
            : undefined}
          title={isRemoteOrigin
            ? `On ${workspace.info.name || "boite"}${boiteOffline ? " (disconnected)" : ""}`
            : undefined}
          oncontextmenu={(e) => openProjectContextMenu(project, e)}
          use:longPress={{
            onLongPress: (x, y) =>
              longPressMenu(() => openProjectMenuAt(project, x, y)),
          }}
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
                decoding="async"
                draggable="false"
              />
            {:else}
              <span class="text-[11px] font-semibold text-muted-foreground">
                {projectDisplayName(project).charAt(0).toUpperCase()}
              </span>
            {/if}
          </div>
          {#if renaming && renaming.kind === "project" && renaming.id === project.id}
            <input
              class="min-w-0 flex-1 rounded-sm bg-[var(--color-surface-2)] px-1 py-0 text-[13px] font-medium leading-[19px] text-foreground outline-none ring-1 ring-foreground/25"
              bind:value={renaming.value}
              use:selectOnMount
              onclick={(e) => e.stopPropagation()}
              onkeydown={renameKeydown}
              onblur={commitRename}
              aria-label={t("sidebar.projectName")}
            />
          {:else}
            <button
              type="button"
              class="min-w-0 flex-1 truncate text-left text-[13px] font-medium leading-[19px] text-foreground/90 transition group-hover/project:text-foreground"
              title={project.cwd}
              onclick={() => {
                if (consumeDragClick(project.id)) return;
                if (showArchived) return;
                selectProject(project.id);
              }}
            >
              {projectDisplayName(project)}
            </button>
          {/if}

          {#if showArchived}
            <button
              type="button"
              class="rounded p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground"
              onclick={(e) => {
                e.stopPropagation();
                void app.unarchiveProject(project.id);
              }}
              data-drag-block
              aria-label={t("sidebar.unarchiveProject")}
              title={t("sidebar.unarchive")}
            >
              <ArchiveRestore class="size-3.5" />
            </button>
          {:else}
            <button
              type="button"
              class="rounded p-1 text-muted-foreground/0 transition hover:bg-accent hover:text-foreground group-hover/project:text-muted-foreground"
              onclick={(e) => openProjectContextMenu(project, e)}
              data-drag-block
              aria-label={t("sidebar.projectOptions")}
              title={t("sidebar.more")}
            >
              <MoreHorizontal class="size-3.5" />
            </button>
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
                use:longPress={{
                  onLongPress: (x, y) =>
                    longPressMenu(() => openThreadMenuAt(thread, x, y)),
                }}
                role="listitem"
              >
                <div
                  class="thread-card flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 transition {isActive
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
                  <button
                    type="button"
                    data-no-drag
                    class="-m-1 inline-flex shrink-0 cursor-pointer items-center justify-center p-1"
                    onclick={(e) => {
                      e.stopPropagation();
                      app.toggleThreadKeepAwake(thread.id);
                    }}
                    title={thread.keepAwake
                      ? t("sidebar.keepAwakeOn")
                      : t("sidebar.keepAwakeOff")}
                    aria-label={t("sidebar.toggleKeepAwake")}
                  >
                    <StatusDot
                      status={displayThreadStatus(thread)}
                      asleep={thread.autoSlept ?? false}
                      keepAwake={(thread.keepAwake ?? false) && !!thread.ptyId}
                    />
                  </button>
                  {#if renaming && renaming.kind === "thread" && renaming.id === thread.id}
                    <!-- Ring, not border, and the row's own line-height: an
                         input that brings its own box metrics makes the row
                         taller than the label it replaced, and the list jumps. -->
                    <input
                      class="min-w-0 flex-1 rounded-sm bg-[var(--color-surface-2)] px-1 py-0 text-[13px] leading-[19px] text-foreground outline-none ring-1 ring-foreground/25"
                      bind:value={renaming.value}
                      use:selectOnMount
                      onclick={(e) => e.stopPropagation()}
                      onkeydown={renameKeydown}
                      onblur={commitRename}
                      aria-label={t("sidebar.threadName")}
                    />
                  {:else}
                    <!-- Same line box the rename input uses. Left to the font,
                         this height is SF Pro on macOS and Segoe UI on Windows,
                         and the row would resize on edit wherever the two
                         disagree — Inter is only a preference here, nothing
                         ships it. -->
                    <span
                      class="min-w-0 flex-1 truncate text-left text-[13px] leading-[19px]"
                      title={thread.title ?? thread.label}
                    >
                      {thread.title ?? thread.label}
                    </span>
                  {/if}
                  <span
                    class="relative flex size-4 shrink-0 items-center justify-center"
                    data-no-drag
                  >
                    <span
                      class="absolute inset-0 flex items-center justify-center transition-opacity group-hover/thread:opacity-0"
                    >
                      <ShortcutIcon iconKey={thread.iconKey} size={14} color={threadIconColor(thread)} />
                    </span>
                    <button
                      type="button"
                      class="absolute inset-0 flex items-center justify-center rounded text-muted-foreground/70 opacity-0 transition hover:bg-danger/20 hover:text-danger group-hover/thread:opacity-100"
                      onclick={(e) => {
                        e.stopPropagation();
                        requestRemoveThread(thread.id);
                      }}
                      aria-label="Close {thread.label}"
                      title={t("sidebar.closeThread")}
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
    class="absolute -right-px top-0 z-10 h-full w-1 cursor-col-resize transition hover:bg-foreground/10 after:absolute after:inset-y-0 after:-inset-x-1.5 after:content-[''] {resizing ? 'bg-foreground/20' : 'bg-transparent'}"
    use:resizeHandle={{
      onResize,
      onStateChange: (r) => (resizing = r),
    }}
    aria-label={t("sidebar.resizeSidebar")}
    title={t("sidebar.resizeSidebar")}
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
      keepAwake={(threadDragGhost.thread.keepAwake ?? false) && !!threadDragGhost.thread.ptyId}
    />
    <span
      class="min-w-0 flex-1 truncate text-left text-[13px] leading-[19px]"
      title={threadDragGhost.thread.title ?? threadDragGhost.thread.label}
    >
      {threadDragGhost.thread.title ?? threadDragGhost.thread.label}
    </span>
    <span class="flex size-4 shrink-0 items-center justify-center">
      <ShortcutIcon
              iconKey={threadDragGhost.thread.iconKey}
              size={14}
              color={threadIconColor(threadDragGhost.thread)}
            />
    </span>
  </div>
{/if}

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

  /* Where letting go would put the thread. A ring rather than a fill: the row
     underneath already uses background to mean "selected", and two meanings on
     one property read as one. */
  .project-block.drop-target {
    outline: 2px dashed var(--color-primary, #6366f1);
    outline-offset: 2px;
    border-radius: 0.5rem;
  }
</style>
