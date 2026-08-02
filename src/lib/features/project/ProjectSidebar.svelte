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
  import ThreadGlyph from "$lib/features/thread/ThreadGlyph.svelte";
  import {
    clearFinished,
    justFinished,
  } from "$lib/features/thread/finished.svelte";
  import { mcpPulse } from "$lib/features/thread/agentActivity.svelte";
  import { waitingReasonFor } from "$lib/features/thread/statusEngine";
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

  /**
   * Arrow keys over the projects and their threads.
   *
   * The list is the app's main navigation and Tab was the only way through it,
   * which on a real sidebar means a dozen presses to reach the third thread. One
   * marked control per row carries the walk; the per-row actions stay in the tab
   * order behind it.
   */
  function onListKeydown(e: KeyboardEvent) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") {
      return;
    }
    const container = e.currentTarget as HTMLElement;
    const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-nav-row]"));
    if (rows.length === 0) return;
    const active = document.activeElement as HTMLElement | null;
    let at = active ? rows.indexOf(active) : -1;
    if (at < 0 && active) {
      // Focus is on a row's own action (the status dot, the close X): the walk
      // continues from the row that action belongs to.
      const block = active.closest("[data-thread-row], [data-project-row]");
      if (block) at = rows.findIndex((r) => block.contains(r));
    }
    e.preventDefault();
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? rows.length - 1
          : e.key === "ArrowDown"
            ? Math.min(at + 1, rows.length - 1)
            : Math.max(at < 0 ? 0 : at - 1, 0);
    rows[next]?.focus();
  }

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
    // No active group means no pane is on screen. Every hidden group still has a
    // mounted PaneShell measuring the full viewport, so without this the drop
    // matched an arbitrary invisible pane and merged the thread into a group the
    // user could not see.
    if (!activeGroupId) {
      paneStore.dropPreview = null;
      return false;
    }
    for (const [targetPaneId, rect] of Object.entries(paneStore.rects)) {
      if (
        targetPaneId === drag.id ||
        x < rect.x ||
        y < rect.y ||
        x > rect.x + rect.w ||
        y > rect.y + rect.h
      ) {
        continue;
      }
      const group = paneStore.groupOf(targetPaneId);
      // The group's project, not the target pane's thread: a pane holding a git
      // panel or a browser has no thread to ask, and dropping a terminal beside
      // one is exactly the arrangement the split is for.
      if (!group || group.projectId !== drag.projectId) {
        continue;
      }
      if (group.id !== activeGroupId) {
        continue;
      }
      const sourceGroup = paneStore.groupOf(drag.id);
      const refused =
        countLeaves(group.root) >= MAX_LEAVES && sourceGroup?.id !== group.id;
      paneStore.dropPreview = {
        targetPaneId,
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
        notifications.error(t("sidebar.maxPanes", { count: MAX_LEAVES }));
        return;
      }
      const ok = paneStore.splitInto(preview.targetPaneId, drag.id, preview.side);
      if (!ok) notifications.error(t("sidebar.splitFailed"));
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

  /**
   * What the glyph says on hover: why the thread is blocked when it is, and the
   * keep-awake toggle's own state the rest of the time.
   *
   * "Waiting" alone does not separate a permission prompt from a plan waiting to
   * be approved, and claude says which. Read through the status, which is what
   * makes this recompute: the reason is a plain map, and it is written and
   * cleared by the same pass that moves the status.
   */
  function glyphTitle(thread: Thread): string {
    if (displayThreadStatus(thread) === "waiting") {
      const reason = waitingReasonFor(thread.id);
      if (reason) return reason;
    }
    return thread.keepAwake ? t("sidebar.keepAwakeOn") : t("sidebar.keepAwakeOff");
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
      label: t("sidebar.rename"),
      action: () =>
        startRename("thread", thread.id, thread.title ?? thread.label),
    });
    items.push({ separator: true });
    if (inMultiPane) {
      items.push({
        label: t("sidebar.detachFromGroup"),
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
      label: t("sidebar.putToSleep"),
      action: () => {
        void stopThread(thread.id);
      },
      disabled: !thread.ptyId,
    });
    items.push({
      label: thread.keepAwake
        ? t("sidebar.allowAutoSleep")
        : t("sidebar.keepAwake"),
      action: () => {
        app.toggleThreadKeepAwake(thread.id);
      },
    });
    items.push({ separator: true });
    items.push({
      label: t("sidebar.reloadThread"),
      action: () => {
        void reloadThread(thread.id);
      },
    });
    items.push({ separator: true });
    items.push({
      label: t("sidebar.closeThread"),
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
      title: t("sidebar.removeProjectTitle"),
      message: t("sidebar.removeProjectMsg", {
        name: projectDisplayName(project),
      }),
      confirmLabel: t("sidebar.removeProject"),
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
        label: t("sidebar.rename"),
        action: () => startRename("project", project.id, project.name),
      });
      items.push({ separator: true });
    }
    if (project.archived) {
      items.push({
        label: t("sidebar.unarchive"),
        action: () => {
          void app.unarchiveProject(project.id);
        },
      });
    } else {
      items.push({
        label: t("sidebar.archive"),
        action: () => {
          void app.archiveProject(project.id);
        },
      });
    }
    items.push({
      label: t("sidebar.refreshIcon"),
      action: () => {
        const p = app.projects.find((x) => x.id === project.id);
        if (p) void refreshProjectIcon(p);
      },
    });
    items.push({ separator: true });
    items.push({
      label: t("sidebar.removeProject"),
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
        class="section-label flex items-center gap-1.5 rounded transition hover:text-foreground"
        onclick={() => (showArchived = false)}
        aria-label={t("sidebar.backToProjects")}
        title={t("sidebar.backToProjects")}
      >
        <ArrowLeft class="size-3.5" />
        {t("sidebar.archives")}
      </button>
    {:else}
      <span
        class="section-label"
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
    onkeydown={onListKeydown}
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
           project because everything a thread needs keys off one, so the card
           is the only place left to say it is not one. Faded and hatched,
           threads included: a lighter surface alone read as a selected row, and
           the whole card being temporary is the thing to say. -->
      {@const isScratchRow = isScratch(project)}
      {@const projectShiftY =
        liveDrag && liveDrag.kind === "project" && liveDrag.slotIndex !== null && projectSourceIdx >= 0
          ? rowShift(projectIdx, projectSourceIdx, liveDrag.slotIndex, liveDrag.sourceHeight)
          : 0}
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div
        class="project-block mb-2"
        class:scratch-block={isScratchRow}
        class:selected={isSelected}
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
          class="project-row group/project relative flex items-center gap-2 px-2 py-1.5 transition hover:text-foreground {showArchived
            ? ''
            : 'cursor-pointer'}"
          style:box-shadow={isRemoteOrigin
            ? `inset 2px 0 0 0 ${workspace.info.color || "var(--color-success)"}`
            : undefined}
          title={isRemoteOrigin
            ? boiteOffline
              ? t("sidebar.onBoiteOffline", {
                  name: workspace.info.name || "boite",
                })
              : t("sidebar.onBoite", { name: workspace.info.name || "boite" })
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
              <span class="text-xs font-semibold text-muted-foreground">
                {projectDisplayName(project).charAt(0).toUpperCase()}
              </span>
            {/if}
          </div>
          {#if renaming && renaming.kind === "project" && renaming.id === project.id}
            <input
              class="min-w-0 flex-1 rounded-sm bg-[var(--color-surface-2)] px-1 py-0 text-base font-medium leading-[19px] text-foreground outline-none ring-1 ring-foreground/25"
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
              data-nav-row
              class="min-w-0 flex-1 truncate text-left text-base font-medium leading-[19px] text-foreground/90 transition group-hover/project:text-foreground"
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
            <!-- Was cursor-only: transparent text until group-hover, which from
                 the keyboard or under a finger is never. `touch-reveal` is what
                 answers the second half: this component is never mounted in the
                 mobile layout, so asking the mobile flag here answered a
                 question about a screen it can never be on. A pointer that
                 cannot hover is the real condition, and a tablet or a touch
                 laptop in the desktop layout is exactly where it is true. -->
            <button
              type="button"
              class="touch-reveal rounded p-1 text-muted-foreground/0 transition hover:bg-accent hover:text-foreground focus-visible:text-foreground group-hover/project:text-muted-foreground group-focus-within/project:text-muted-foreground"
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
          <!-- No rail down the left any more: the card's own outline is what
               says these threads belong to this project, and a dashed line
               inside a box is the same statement made twice. -->
          <ul
            class="space-y-px px-1 pb-1"
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
                <!-- The row used to be a div role="button" with three real
                     buttons inside it, which is a control nested in a control:
                     Space activated the thread and scrolled the list at once,
                     and the actions were unreachable from the row's own
                     semantics. The row is now one button that fills the card,
                     with the actions as siblings painting over it. -->
                <div
                  class="thread-card relative flex cursor-pointer items-center gap-2 rounded-sm px-1.5 py-1 transition {isActive
                    ? 'bg-accent text-foreground'
                    : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground'}"
                  class:just-finished={justFinished(thread.id)}
                  class:mcp-touch={mcpPulse.has(thread.id)}
                >
                  {#if !(renaming && renaming.kind === "thread" && renaming.id === thread.id)}
                    <button
                      type="button"
                      data-nav-row
                      class="absolute inset-0 cursor-pointer rounded-sm"
                      aria-label={thread.title ?? thread.label}
                      onclick={() => {
                        if (consumeDragClick(thread.id)) return;
                        // Opening it is reading it: the glow has said what it had
                        // to say and must not still be going when the user comes
                        // back.
                        clearFinished(thread.id);
                        onActivateThread(thread.id);
                      }}
                      onauxclick={(e) => threadAuxClick(thread.id, e)}
                    ></button>
                  {/if}
                  <!-- The glyph is itself a button (keep-awake), so it sits
                       beside the row button rather than inside it. Its own CSS
                       is position:relative, which is what keeps it above the
                       overlay that fills the card. -->
                  <ThreadGlyph
                    status={displayThreadStatus(thread)}
                    iconKey={thread.iconKey}
                    color={threadIconColor(thread)}
                    asleep={thread.autoSlept ?? false}
                    keepAwake={(thread.keepAwake ?? false) && !!thread.ptyId}
                    onToggleKeepAwake={() => app.toggleThreadKeepAwake(thread.id)}
                    title={glyphTitle(thread)}
                    label={t("sidebar.toggleKeepAwake")}
                  />
                  {#if renaming && renaming.kind === "thread" && renaming.id === thread.id}
                    <!-- Ring, not border, and the row's own line-height: an
                         input that brings its own box metrics makes the row
                         taller than the label it replaced, and the list jumps. -->
                    <input
                      class="relative min-w-0 flex-1 rounded-sm bg-[var(--color-surface-2)] px-1 py-0 text-base leading-[19px] text-foreground outline-none ring-1 ring-foreground/25"
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
                    <!-- Painted over the row button, and inert to the cursor so a
                         click on the name is still a click on the row. Hidden
                         from assistive tech because the row button already
                         carries this name. -->
                    <span
                      class="pointer-events-none relative min-w-0 flex-1 truncate text-left text-base leading-[19px]"
                      title={thread.title ?? thread.label}
                      aria-hidden="true"
                    >
                      {thread.title ?? thread.label}
                    </span>
                  {/if}
                  <!-- The logo used to live here, opposite the status dot, and
                       swapped for the close button on hover. The glyph on the
                       left carries both now, which leaves this end for the one
                       thing that is a control rather than a description.
                       Revealed on hover, and permanently where there is no hover
                       to give: on a touch layout the X was a control that never
                       appeared. Focus-within counts too, so a keyboard walking
                       the row reaches it. -->
                  <button
                    type="button"
                    data-no-drag
                    class="touch-reveal relative flex size-4 shrink-0 items-center justify-center rounded-xs text-muted-foreground/70 opacity-0 transition hover:bg-danger/20 hover:text-danger focus-visible:opacity-100 group-hover/thread:opacity-100 group-focus-within/thread:opacity-100"
                    onclick={(e) => {
                      e.stopPropagation();
                      requestRemoveThread(thread.id);
                    }}
                    aria-label={t("sidebar.closeThreadNamed", {
                      name: thread.title ?? thread.label,
                    })}
                    title={t("sidebar.closeThread")}
                  >
                    <X class="size-3.5" />
                  </button>
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
    <ThreadGlyph
      inert
      status={displayThreadStatus(threadDragGhost.thread)}
      iconKey={threadDragGhost.thread.iconKey}
      color={threadIconColor(threadDragGhost.thread)}
      asleep={threadDragGhost.thread.autoSlept ?? false}
      keepAwake={(threadDragGhost.thread.keepAwake ?? false) && !!threadDragGhost.thread.ptyId}
    />
    <span
      class="min-w-0 flex-1 truncate text-left text-base leading-[19px]"
      title={threadDragGhost.thread.title ?? threadDragGhost.thread.label}
    >
      {threadDragGhost.thread.title ?? threadDragGhost.thread.label}
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
  /* A row control that a cursor reveals has to be permanently on screen where
     there is no cursor. The sidebar is a desktop-layout component, so the
     condition is the pointer rather than the layout: a touch laptop or a tablet
     runs this exact markup and gets no hover at all. */
  @media (hover: none) {
    .touch-reveal {
      opacity: 1;
      color: var(--color-muted-foreground);
    }
  }

  :global(body.dragging-card) {
    user-select: none !important;
    cursor: grabbing !important;
  }
  :global(body.dragging-card *) {
    cursor: grabbing !important;
  }

  /* A project is a container, and until now it was a heading with some rows
     under it: at a dozen threads across three projects, nothing on screen said
     where one project stopped and the next began. The outline is that
     statement, and it is why the dashed rail down the thread list could go. */
  .project-block {
    transform-origin: left center;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: color-mix(in srgb, var(--color-surface-2) 45%, transparent);
    transition:
      border-color var(--dur-2) var(--ease-out-quint),
      background-color var(--dur-2) var(--ease-out-quint);
  }
  /* will-change only while a drag is on. Left on permanently it gave every
     project and every thread row its own compositor layer at rest, and each of
     those layers is also a containing block for any position:fixed descendant.
     The class comes from body.dragging-card, which the drag already sets. */
  :global(body.dragging-card) .project-block,
  :global(body.dragging-card) .thread-row {
    will-change: transform;
  }
  .project-block:hover {
    border-color: color-mix(
      in srgb,
      var(--color-border-strong) 60%,
      var(--color-border)
    );
  }
  /* Selected is the card, not the header row. The row used to carry a
     background for it, which put "this project is selected" and "this thread is
     open" on the same property one indent apart. */
  .project-block.selected {
    border-color: var(--color-border-strong);
    background: var(--color-surface-2);
  }

  /* Temporary, and it has to look it. Faded so it sits behind the real
     projects, hatched so a screenshot still says so, and on the block rather
     than the row so the threads underneath are inside the same crossed-out
     card. It lifts under the pointer: a row you are about to click has to be
     readable, and this is still the way into a scratch terminal. */
  .project-block.scratch-block {
    opacity: 0.6;
    border-style: dashed;
    background-image: repeating-linear-gradient(
      135deg,
      transparent 0 5px,
      color-mix(in srgb, var(--color-foreground) 7%, transparent) 5px 6px
    );
    transition: opacity 140ms ease;
  }
  .project-block.scratch-block:hover {
    opacity: 0.9;
  }
  .thread-row {
    transform-origin: left center;
  }
  .project-row,
  .thread-card {
    user-select: none;
  }

  /* The lift is on the card now rather than on its header row: with an outline
     around the whole block, shadowing only the top strip left the threads
     underneath flat on the page while the project floated off it. */
  .project-block.source,
  .drag-ghost {
    box-shadow: var(--shadow-e3);
    background: color-mix(in srgb, var(--color-surface-2, #1a1a1a) 90%, transparent);
    backdrop-filter: blur(6px);
  }
  .drag-ghost {
    pointer-events: none;
    z-index: var(--z-popover);
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
     one property read as one.
     The colour used to be `var(--color-primary, #6366f1)`, and there is no
     --color-primary in this palette — so the one time the app drew a drop
     target it drew it in an indigo that appears nowhere else. */
  .project-block.drop-target {
    outline: 2px dashed var(--color-foreground);
    outline-offset: 2px;
  }

  /* A thread that has just finished. Green drains out of the card over six
     seconds, which is long enough to be caught by a glance that arrives late
     and short enough that the row goes back to being a row. `forwards` matters:
     without it the box-shadow snaps back to the 0% keyframe for one frame
     before the class drops, and the card flashes green on its way out. */
  .thread-card.just-finished {
    animation: boite-finish-glow 6s var(--ease-out-quint) forwards;
  }

  /* This agent just changed something in Boite itself rather than in its own
     terminal. Violet, not green: green is a thread finishing, and this is the
     app being driven from outside while the thread carries on. */
  .thread-card.mcp-touch {
    animation: boite-mcp-pulse 1.6s var(--ease-out-quint) forwards;
  }
</style>
