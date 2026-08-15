<script lang="ts">
  import { onDestroy } from "svelte";
  import { scale } from "svelte/transition";
  import { app } from "$lib/app/store.svelte";
  import { visibleStatus } from "$lib/domain/thread-status";
  import { workspace } from "$lib/backend";
  import { settings } from "$lib/features/settings/store.svelte";
  import { device } from "$lib/features/settings/device.svelte";
  import {
    paneStore,
    countLeaves,
    MAX_LEAVES,
  } from "$lib/features/panes/store.svelte";
  import {
    closeThreadWithConfirm,
    launchBlankTerminal,
    launchShortcut,
    reloadThread,
    stopThread,
  } from "$lib/features/thread/api";
  import { moveThreadToProject } from "$lib/features/thread/move";
  import { notifications } from "$lib/features/notifications/store.svelte";
  import { refreshProjectIcon } from "$lib/features/project/api";
  import { openProjectDashboard } from "$lib/features/project/dashboard";
  import { isScratch } from "$lib/domain/project";
import { projectDisplayName } from "$lib/shared/project-label";
  import { filterSidebar, normaliseTerm } from "./sidebar-filter";
  import SearchIcon from "@lucide/svelte/icons/search";
  import ThreadGlyph from "$lib/features/thread/ThreadGlyph.svelte";
  import {
    clearFinished,
    justFinished,
  } from "$lib/features/thread/finished.svelte";
  import { mcpPulse } from "$lib/features/thread/agentActivity.svelte";
  import { jumpDigit, jumpModifier } from "$lib/shared/keyboard/held.svelte";
  import { waitingReasonFor } from "$lib/features/thread/statusEngine";
  import { threadIconColor } from "$lib/features/fastpick/threadAccent";
  import { TONE_COLOR, threadVisual } from "$lib/features/thread/threadVisual";
  import RemoteProjectPicker from "./RemoteProjectPicker.svelte";
  import { confirmDialog } from "$lib/shared/components/confirm.svelte";
  import { resizeHandle } from "$lib/shared/actions/resizeHandle";
  import { longPress } from "$lib/shared/actions/longPress";
  import ContextMenu from "$lib/shared/components/ContextMenu.svelte";
  import type { ContextMenuItem } from "$lib/shared/components/ContextMenu.svelte";
  import { viewportHeight } from "$lib/shared/keyboard/overlay";
  import {
    dropIntent,
    hasBecomeADrag,
    reordered,
    reorderedAmongVisible,
    rowShift,
    sideFromRect,
    slotIndexAt,
    type RowSnapshot,
  } from "./sidebar-drag";
  import type { Thread, ThreadStatus } from "$lib/types";
  import Plus from "@lucide/svelte/icons/plus";
  import X from "@lucide/svelte/icons/x";
  import FolderOpen from "@lucide/svelte/icons/folder-open";
  import MoreHorizontal from "@lucide/svelte/icons/more-horizontal";
  // A folder, never a box: the box with a lid is the app's own logo, and the
  // archive button drawn with one read as a Boite button rather than a place
  // projects are put away. What is archived here is projects, which are folders.
  import FolderArchive from "@lucide/svelte/icons/folder-archive";
  import FolderUp from "@lucide/svelte/icons/folder-up";
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import ShortcutBar from "$lib/features/shortcut/ShortcutBar.svelte";
  import { t } from "$lib/i18n/index.svelte";

  type Props = {
    onActivateThread: (threadId: string) => void;
    onNewProject: (target?: "local" | "remote") => void;
    onRemoveProject: (projectId: string) => void;
  };
  let { onActivateThread, onNewProject, onRemoveProject }: Props = $props();

  // Dynamic mode: the plain + adds locally, the boite-colored + opens the list
  // of the boite's own projects to pick from (adding one lives in there too).
  function addProjectClick() {
    onNewProject(workspace.isDynamic ? "local" : undefined);
  }

  let showArchived = $state(false);
  // Session-scoped on purpose: revealing what was filed away is a look, not a
  // preference, and one that persisted would quietly undo the filing.
  // Opt-in, so it costs no vertical space in a sidebar whose whole job is to
  // hold rows. Cleared when it closes: a hidden filter still filtering is a
  // sidebar that has lost half its threads for no reason anybody can see.
  let filterOpen = $state(false);
  let filterTerm = $state("");
  let filterEl: HTMLInputElement | null = $state(null);
  let remotePicker = $state(false);

  /**
   * The signal design, and what it does to the glyph.
   *
   * Two separate answers on purpose: where the state is painted is the design,
   * and whether the agent's logo stays on the row is a second question that only
   * exists once the glyph has something else to show. With the classic design
   * the logo is all the glyph ever holds, so the second toggle does not apply.
   */
  const glowDesign = $derived(settings.state.sidebarDesign === "glow");
  const showLogos = $derived(!glowDesign || settings.state.sidebarHarnessLogos);

  /**
   * Hovering a row brings its agent's logo back.
   *
   * It used to be a 260ms press, which cost the row's own click: letting go
   * after asking "which agent is this" had to be swallowed, so the answer and
   * the opening were the same gesture and only one of them could win. On touch
   * it was worse, because `longPress` opened the context menu on top of the
   * reveal at 500ms. The list already tracks the hovered row for the panels, and
   * a hover costs nothing.
   */
  const revealedThreadId = $derived(
    showLogos ? null : paneStore.hoveredThreadId,
  );

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
    // Reordering is positional: the drop slot is an index into the list on
    // screen, and while rows are hidden that index is not the one the stored
    // order is written in. A filtered sidebar clicks and scrolls, it does not
    // reorder.
    if (filtering) return;
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
    openProjectDashboard(projectId);
  }

  function projectPointerDown(projectId: string, e: PointerEvent) {
    if (showArchived || filtering) return;
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
    // What the neighbours slide by is the row plus the gap under it, not the row:
    // both lists are laid out with space between them, so shifting by the box
    // alone left every row one gap short of where it will land. Measured rather
    // than assumed, because the thread gap depends on which sidebar design is on
    // and the project gap is a Tailwind class away from changing.
    drag.sourceHeight += Math.max(0, rowGap(snaps, drag.id) ?? 0);
  }

  /** The empty space between this row and the one next to it. */
  function rowGap(snaps: RowSnapshot[], id: string): number | null {
    const i = snaps.findIndex((s) => s.id === id);
    if (i < 0) return null;
    if (i + 1 < snaps.length) {
      return snaps[i + 1].top - (snaps[i].top + snaps[i].height);
    }
    if (i > 0) return snaps[i].top - (snaps[i - 1].top + snaps[i - 1].height);
    return null;
  }

  function pointerDragMove(e: PointerEvent) {
    const drag = dragState;
    if (!drag || e.pointerId !== drag.pointerId) return;

    drag.x = e.clientX;
    drag.y = e.clientY;

    if (!drag.active) {
      if (!hasBecomeADrag({ x: drag.startX, y: drag.startY }, { x: e.clientX, y: e.clientY })) {
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
      drag.slotIndex = slotIndexAt(drag.siblings, drag.id, drag.y);
      paneStore.dropPreview = null;
    } else {
      updateThreadDrag(drag, e);
    }
    dragState = { ...drag };
  }

  function updateThreadDrag(drag: DragState, e: PointerEvent) {
    const previewPicked = updatePaneDropPreview(drag, e.clientX, e.clientY);
    if (previewPicked) {
      drag.slotIndex = null;
      drag.dropProjectId = null;
      return;
    }
    // Reading the DOM is this half's job; deciding what the reading means is
    // `dropIntent`, which is where the three outcomes are kept exclusive.
    const overEl = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    const intent = dropIntent(drag.projectId, {
      inSidebar: !!overEl?.closest("[data-sidebar-root]"),
      overOwnList: !!overEl?.closest(
        `[data-thread-list][data-project-id="${drag.projectId}"]`,
      ),
      overOwnHeader: !!overEl?.closest(`[data-project-row="${drag.projectId}"]`),
      overProjectId:
        overEl?.closest<HTMLElement>("[data-project-row]")?.dataset.projectRow ??
        overEl?.closest<HTMLElement>("[data-thread-list]")?.dataset.projectId ??
        null,
      isLiveProject: (id) => app.sortedProjects.some((p) => p.id === id),
    });
    drag.slotIndex =
      intent.kind === "reorder" ? slotIndexAt(drag.siblings, drag.id, drag.y) : null;
    drag.dropProjectId = intent.kind === "give" ? intent.projectId : null;
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

  /**
   * The click a finished drag leaves behind, dropped before anything sees it.
   *
   * Letting go after a drag still fires a click, and where it lands is not the
   * row it started on: the browser targets the nearest common ancestor of the
   * press and the release, so carrying a project card past its neighbours ends
   * on the scrolling list itself — whose click handler means "you clicked the
   * empty space", clears the selection and takes the window off the project the
   * user was looking at. `suppressClickFor` could not catch that one, because it
   * is only consulted by the row handlers the click never reaches.
   *
   * Capture phase and document level, so it is dropped above every handler
   * rather than beside them. The timeout is for the drags that end with no click
   * at all, which is most of them once the pointer is captured.
   */
  function swallowNextClick() {
    if (typeof document === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const stop = () => {
      document.removeEventListener("click", swallow, true);
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    function swallow(e: MouseEvent) {
      e.preventDefault();
      e.stopPropagation();
      stop();
    }
    document.addEventListener("click", swallow, true);
    timer = setTimeout(stop, 300);
  }

  function pointerDragEnd(e: PointerEvent) {
    const drag = dragState;
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (drag.active) {
      e.preventDefault();
      swallowNextClick();
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

  // While smart sort is armed, the rendered order IS the smart order, so
  // persisting it through setProjectOrder/setThreadOrder would overwrite the
  // hand-made order with a computed one — silently, since the visible list is
  // re-sorted right back. The experiment is device-scoped and the orders are
  // workspace-scoped, so one device would clobber every other's arrangement.
  function smartSortArmed(): boolean {
    return (
      settings.state.experimentSmartSort && settings.state.smartSortBy !== "manual"
    );
  }

  function commitProjectDrag(drag: DragState) {
    if (drag.slotIndex === null || smartSortArmed()) return;
    const next = reordered(app.sortedProjects.map((p) => p.id), drag.id, drag.slotIndex);
    if (next) void settings.setProjectOrder(next);
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
      if (smartSortArmed()) return;
      // Against the rows that were actually drawn, because that is what the slot
      // counted: `captureSiblings` measures the DOM, and the DOM is this filtered
      // list. The order that gets saved is still the whole one, see
      // `reorderedAmongVisible`, so a pinned or filed thread keeps its place.
      const ids = app.threadsByProjectSorted(drag.projectId).map((t) => t.id);
      const drawn = (threadsByProject.get(drag.projectId) ?? []).map((t) => t.id);
      const next = reorderedAmongVisible(ids, drawn, drag.id, drag.slotIndex);
      if (next) void settings.setThreadOrder(drag.projectId, next);
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
    return visibleStatus(thread.status, !!thread.ptyId);
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

  /**
   * The launcher, one project at a time.
   *
   * It used to be a 40px strip across the top of the main area offering every
   * agent at all times, in the space the agent's own output wants — and it said
   * nothing about where a launch would land, so the answer had to be a second
   * menu behind a right-click. Asking from the project's own row answers that
   * question by construction: this project, the one whose `+` you pressed.
   *
   * A menu beside the button, on the app's own dropdown recipe — the same
   * `surface-popover` box, scale transition and fixed placement the shell and
   * fastpick pickers use. Two earlier attempts sat it directly under the card,
   * card-width: however exactly it lined up it read as a second rectangle
   * grafted onto the first, and on a project with a dozen threads the menu
   * opened a screen away from the `+` that had been pressed. Clearing the
   * sidebar sideways is what makes it a menu rather than more card, and it puts
   * it where the pointer already is.
   */
  let launcher = $state<{
    projectId: string;
    // The button, and the card's right edge. The menu hangs off the sidebar
    // beside the `+` rather than under the project: anchoring to the card's
    // bottom put it below every thread the project holds, which is the far end
    // of a list the button sits at the top of. The card supplies the edge to
    // clear and the width to draw, both measured, because the sidebar is
    // resizable and any constant is right at exactly one width.
    anchor: { left: number; right: number; top: number; bottom: number; width: number };
  } | null>(null);
  let launcherEl: HTMLDivElement | null = $state(null);
  let launcherPos = $state({ x: 0, y: 0, w: 0, maxH: 0, flipped: false });

  const LAUNCHER_GAP = 6;
  const LAUNCHER_EDGE = 6;

  /**
   * Beside the button, kept inside the window on both axes.
   *
   * Six pixels of air past the card's right edge is what says the menu belongs
   * to it without touching it. A sidebar dragged wide enough to leave no room
   * there flips the menu to the card's left instead, the way a submenu does.
   * Vertically it hangs from the button's own top line and rides up when the
   * pane behind fastpick is taller than the room under it — those panes are
   * several times the height of the list they replace, so the cap and the
   * shift are both needed.
   *
   * Re-run on every resize of the menu itself, which is what a pane change is.
   */
  function placeLauncher() {
    const el = launcherEl;
    if (!launcher || !el) return;
    const a = launcher.anchor;
    const vw = window.innerWidth;
    const vh = viewportHeight();
    const w = Math.min(a.width, vw - LAUNCHER_EDGE * 2);
    const right = a.right + LAUNCHER_GAP;
    const flipped = right + w + LAUNCHER_EDGE > vw && a.left - LAUNCHER_GAP - w >= LAUNCHER_EDGE;
    const maxH = Math.max(160, vh - LAUNCHER_EDGE * 2);
    // offsetHeight is the layout box, so it is already capped by the max-height
    // of the previous pass rather than by whatever the pane would like to be.
    const h = Math.min(el.offsetHeight, maxH);
    launcherPos = {
      x: flipped
        ? a.left - LAUNCHER_GAP - w
        : Math.max(LAUNCHER_EDGE, Math.min(right, vw - w - LAUNCHER_EDGE)),
      // Top-aligned with the button, then pulled up by whatever hangs off the
      // bottom of the window rather than flipped: a menu that jumps above the
      // pointer on its second pane is the same menu in two places.
      y: Math.max(LAUNCHER_EDGE, Math.min(a.top, vh - h - LAUNCHER_EDGE)),
      w,
      maxH,
      flipped,
    };
  }

  $effect(() => {
    if (!launcher || !launcherEl) return;
    placeLauncher();
    // The menu changes height when it walks into a pane, and nothing else tells
    // us: the panes live two components down and own their own state.
    const observer = new ResizeObserver(() => placeLauncher());
    observer.observe(launcherEl);
    const replace = () => placeLauncher();
    window.addEventListener("resize", replace);
    window.visualViewport?.addEventListener("resize", replace);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", replace);
      window.visualViewport?.removeEventListener("resize", replace);
    };
  });

  function toggleLauncher(projectId: string, e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (launcher?.projectId === projectId) {
      launcher = null;
      return;
    }
    const button = e.currentTarget as HTMLElement;
    const trigger = button.getBoundingClientRect();
    const card =
      button.closest<HTMLElement>(".project-block")?.getBoundingClientRect() ?? trigger;
    launcher = {
      projectId,
      anchor: {
        left: card.left,
        right: card.right,
        // The button's own top line, not the card's: the `+` sits in the header
        // row and the menu reads as coming out of it.
        top: trigger.top,
        bottom: card.bottom,
        width: card.width,
      },
    };
    // First guess, so the menu paints where it belongs rather than at 0,0 for a
    // frame; the effect measures it and corrects on the next tick.
    launcherPos = {
      x: card.right + LAUNCHER_GAP,
      y: trigger.top,
      w: card.width,
      maxH: Math.max(160, window.innerHeight - LAUNCHER_EDGE * 2),
      flipped: false,
    };
  }

  // pointerdown, like the pickers inside it: a click listener would see the row
  // the launch just removed as an outside click.
  function closeLauncherOnOutside(e: PointerEvent) {
    if (!launcher) return;
    const target = e.target as Element | null;
    if (target?.closest("[data-launcher-root]")) return;
    if (target?.closest("[data-launcher-trigger]")) return;
    launcher = null;
  }

  // Narrowed in place, keeping the shape: same projects, same order, same
  // cards, fewer rows. The palette answers "take me to X" by taking the screen;
  // this answers "which of these forty is the one about the migration", which
  // is asked while looking at the list and has to leave the list where it is.
  const filtered = $derived(
    filterSidebar(
      showArchived ? app.archivedProjects : app.sortedProjects,
      (id: string) => app.threadsByProjectSorted(id),
      projectDisplayName,
      filterTerm,
    ),
  );

  const visibleProjects = $derived(filtered.projects);
  const filtering = $derived(normaliseTerm(filterTerm).length > 0);

  /**
   * What each project draws, once the filter has had its say.
   *
   * Built on top of what the filter left rather than beside it: the term
   * narrows which rows exist at all, and this hands each project the survivors
   * that belong to it.
   */
  const threadsByProject = $derived.by(() => {
    const map = new Map<string, Thread[]>();
    for (const p of visibleProjects) {
      map.set(p.id, filtered.threads.get(p.id) ?? []);
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

<svelte:window onpointerdown={closeLauncherOnOutside} />

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
        class="rounded-md p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground {filterOpen
          ? 'bg-accent text-foreground'
          : ''}"
        onclick={() => {
          filterOpen = !filterOpen;
          if (!filterOpen) filterTerm = "";
          else queueMicrotask(() => filterEl?.focus());
        }}
        aria-label={t("sidebar.filterThreads")}
        title={t("sidebar.filterThreads")}
      >
        <SearchIcon class="size-4" />
      </button>
      <button
        type="button"
        class="rounded-md p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground {showArchived
          ? 'bg-accent text-foreground'
          : ''}"
        onclick={() => (showArchived = !showArchived)}
        aria-label={t("sidebar.showArchived")}
        title={t("sidebar.archivedProjects")}
      >
        <FolderArchive class="size-4" />
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
          <!-- Boite-colored twin of the + button. It used to go straight to the
               server-side folder browser; it opens the boite's own project list
               instead, because dynamic mode no longer grafts all of them on and
               picking which ones show is the question asked far more often.
               Adding one is still there, at the bottom of that list. -->
          <button
            type="button"
            class="rounded-md border p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground"
            class:is-open={remotePicker}
            style:border-color={workspace.info.color || "var(--color-success)"}
            onclick={() => (remotePicker = true)}
            aria-label={t("sidebar.remoteProjects")}
            aria-expanded={remotePicker}
            title={t("sidebar.remoteProjectsOn", {
              name: workspace.info.name || "boite",
            })}
          >
            <Plus class="size-4" />
          </button>
        {/if}
      {/if}
    </div>
  </header>

  {#if filterOpen}
    <div class="px-2 pb-1.5">
      <input
        bind:this={filterEl}
        bind:value={filterTerm}
        type="search"
        spellcheck="false"
        autocomplete="off"
        placeholder={t("sidebar.filterThreads")}
        aria-label={t("sidebar.filterThreads")}
        class="w-full rounded-md border border-border bg-[var(--color-surface-2)] px-2 py-1 text-xs text-foreground outline-none transition placeholder:text-muted-foreground/60 focus:border-foreground/30"
        onkeydown={(e) => {
          if (e.key !== "Escape") return;
          e.stopPropagation();
          if (filterTerm) {
            filterTerm = "";
            return;
          }
          filterOpen = false;
        }}
      />
    </div>
  {/if}

  <!-- The empty space below the rows is empty space. It used to clear the
       selection, on the reasoning that being on no project is what aims the
       next launch at Scratch, and it read as the app throwing the open thread
       away for a miss: the terminal went, nothing came, and the gesture that
       did it was a click on nothing. Scratch is a row in this list like any
       other, so it is still one click away by being clicked. -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="flex-1 overflow-y-auto px-2 pb-2"
    role="list"
    onkeydown={onListKeydown}
  >
    {#if showArchived && visibleProjects.length === 0}
      <div
        class="mx-1 mt-2 mb-2 flex w-[calc(100%-0.5rem)] flex-col items-center gap-2 rounded-lg border border-dashed border-border bg-transparent px-3 py-7 text-xs text-muted-foreground"
      >
        <FolderArchive class="size-5 opacity-70" />
        <span>{t("sidebar.noArchived")}</span>
      </div>
    {:else if !showArchived && app.projects.every((p) => isScratch(p))}
      <button
        type="button"
        class="mx-1 mt-2 mb-2 flex w-[calc(100%-0.5rem)] flex-col items-center gap-2 rounded-lg border border-dashed border-border bg-transparent px-3 py-7 text-xs text-muted-foreground transition hover:border-foreground/30 hover:bg-accent/30 hover:text-foreground"
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
        class="project-block group/block mb-2"
        class:launching={launcher?.projectId === project.id}
        class:scratch-block={isScratchRow}
        class:selected={isSelected}
        class:dragging={isProjectSource}
        class:source={isProjectSource}
        class:opacity-50={boiteOffline}
        class:drop-target={dropProjectId === project.id}
        class:remote-origin={isRemoteOrigin}
        class:boite-offline={boiteOffline}
        style:--boite={isRemoteOrigin
          ? workspace.info.color || "var(--color-success)"
          : undefined}
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
              class="min-w-0 flex-1 rounded-sm bg-[var(--color-surface-2)] px-1 py-[3px] -my-[3px] text-base font-medium leading-[19px] text-foreground outline-none ring-1 ring-foreground/25"
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
              class="min-w-0 flex-1 truncate-safe text-left text-base font-medium leading-[19px] text-foreground/90 transition group-hover/project:text-foreground"
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
              <FolderUp class="size-3.5" />
            </button>
          {:else}
            <!-- Was cursor-only: transparent text until group-hover, which from
                 the keyboard or under a finger is never. `touch-reveal` is what
                 answers the second half: this component is never mounted in the
                 mobile layout, so asking the mobile flag here answered a
                 question about a screen it can never be on. A pointer that
                 cannot hover is the real condition, and a tablet or a touch
                 laptop in the desktop layout is exactly where it is true.

                 Keyed on the card, not the header row: reaching for the launcher
                 with three threads listed under it means crossing them, and both
                 buttons used to vanish the moment the pointer left the top line.
                 The card is the thing you are in. -->
            <button
              type="button"
              class="row-action touch-reveal rounded p-1 text-muted-foreground/0 transition hover:bg-accent hover:text-foreground focus-visible:text-foreground group-hover/block:text-muted-foreground group-focus-within/block:text-muted-foreground"
              class:is-open={launcher?.projectId === project.id}
              onclick={(e) => toggleLauncher(project.id, e)}
              data-drag-block
              data-launcher-trigger
              aria-label={t("sidebar.launchHere")}
              title={t("sidebar.launchHere")}
              aria-expanded={launcher?.projectId === project.id}
            >
              <Plus class="size-3.5" />
            </button>
            <button
              type="button"
              class="row-action touch-reveal rounded p-1 text-muted-foreground/0 transition hover:bg-accent hover:text-foreground focus-visible:text-foreground group-hover/block:text-muted-foreground group-focus-within/block:text-muted-foreground"
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
          <!-- A hairline is enough between flat cards and too little between lit
               ones: a halo would land on its neighbour and two rows would read
               as one blur. 4px, not the 6px this design first took: the halo is
               now `0 0 12px -3px`, which is a nine-pixel bloom rather than a
               thirteen-pixel one, and every pixel of gap is a thread the
               sidebar stops showing. -->
          <ul
            class="px-1 pb-1 {glowDesign ? 'space-y-1' : 'space-y-px'}"
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
              {@const keepAwake = (thread.keepAwake ?? false) && !!thread.ptyId}
              {@const visual = threadVisual({
                status: displayThreadStatus(thread),
                asleep: thread.autoSlept ?? false,
                keepAwake,
              })}
              {@const fresh = justFinished(thread.id)}
              <!-- Ctrl+1..9 only ever meant the current project's threads, so
                   that is the only list numbered. Numbering every project would
                   put four rows labelled 1 on screen at once, three of which do
                   nothing. -->
              {@const digit =
                jumpModifier.down && project.id === app.currentProjectId
                  ? jumpDigit(threadIdx)
                  : null}
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
                    ? 'text-foreground'
                    : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground'}"
                  class:selected={isActive}
                  class:just-finished={fresh && !glowDesign}
                  class:mcp-touch={mcpPulse.has(thread.id)}
                  class:glow={glowDesign}
                  class:fresh={glowDesign && fresh}
                  data-state={glowDesign ? visual.state : undefined}
                  style:--tone={glowDesign ? TONE_COLOR[visual.tone] : undefined}
                >
                  {#if glowDesign && visual.state === "working"}
                    <!-- One light crossing the card, along the axis the card
                         actually has. Its predecessors were two dots walking the
                         perimeter on a motion path: on a row eight times wider
                         than it is tall they crossed the short sides in a fifth
                         of a second and crawled the long ones, and their
                         half-lap spacing was written in seconds against a lap
                         length that one state overrode.
                         Clipped by its own layer rather than by the card, so the
                         halo around the card stays outside it. -->
                    <span class="sheen" aria-hidden="true"></span>
                  {/if}
                  {#if !(renaming && renaming.kind === "thread" && renaming.id === thread.id)}
                    <button
                      type="button"
                      data-nav-row
                      class="absolute inset-0 cursor-pointer rounded-sm"
                      aria-label={thread.title ?? thread.label}
                      onclick={() => {
                        if (consumeDragClick(thread.id)) return;
                        // Opening it is reading it: the arrival flash has said
                        // what it had to say and must not still be going when
                        // the user comes back.
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
                  {#if digit !== null}
                    <!-- Over the glyph rather than beside it: a number that
                         takes its own column reflows every row in the sidebar
                         the moment the modifier goes down, and a list that
                         jumps under a held key is worse than no hint. -->
                    <span
                      class="pointer-events-none absolute left-1.5 z-[var(--z-chrome)] flex size-4 items-center justify-center rounded-xs bg-[var(--color-surface-3)] text-2xs font-semibold tabular-nums text-foreground shadow-e1"
                      aria-hidden="true"
                    >
                      {digit}
                    </span>
                  {/if}
                  <ThreadGlyph
                    status={displayThreadStatus(thread)}
                    iconKey={thread.iconKey}
                    color={threadIconColor(thread)}
                    asleep={thread.autoSlept ?? false}
                    {keepAwake}
                    design={settings.state.sidebarDesign}
                    showLogo={showLogos}
                    revealLogo={revealedThreadId === thread.id}
                    onToggleKeepAwake={() => app.toggleThreadKeepAwake(thread.id)}
                    title={glyphTitle(thread)}
                    label={t("sidebar.toggleKeepAwake")}
                  />
                  {#if renaming && renaming.kind === "thread" && renaming.id === thread.id}
                    <!-- Ring, not border, and the row's own line-height: an
                         input that brings its own box metrics makes the row
                         taller than the label it replaced, and the list jumps. -->
                    <input
                      class="relative min-w-0 flex-1 rounded-sm bg-[var(--color-surface-2)] px-1 py-[3px] -my-[3px] text-base leading-[19px] text-foreground outline-none ring-1 ring-foreground/25"
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
                      class="pointer-events-none relative min-w-0 flex-1 truncate-safe text-left text-base leading-[19px]"
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

{#if launcher}
  <!-- The dropdown recipe, spelled the way ShellPicker and FastpickPicker spell
       it: `surface-popover`, fixed, scale-in from the corner it hangs off.
       `transition:scale` rather than a CSS keyframe because an animation that
       never ticks — an unfocused window throttles them — leaves the box frozen
       at 96% of its own size, which is its own kind of wrong. -->
  <div
    bind:this={launcherEl}
    data-launcher-root
    role="menu"
    tabindex="-1"
    class="launcher-menu fixed z-[var(--z-popover)] flex flex-col overflow-hidden"
    style:left="{launcherPos.x}px"
    style:top="{launcherPos.y}px"
    style:width="{launcherPos.w}px"
    style:max-height="{launcherPos.maxH}px"
    style:transform-origin={launcherPos.flipped ? "top right" : "top left"}
    transition:scale={{ duration: 90, start: 0.96 }}
  >
    <!-- `projectId` is optional even under `{#if launcher}`: a prop is a getter,
         and a consumer reading it after its own `onLaunched` has run reads it
         against the null that callback just wrote. -->
    <ShortcutBar
      compact
      projectId={launcher?.projectId ?? null}
      onLaunched={() => (launcher = null)}
      onClose={() => (launcher = null)}
    />
  </div>
{/if}

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
      design={settings.state.sidebarDesign}
      showLogo={showLogos}
    />
    <span
      class="min-w-0 flex-1 truncate-safe text-left text-base leading-[19px]"
      title={threadDragGhost.thread.title ?? threadDragGhost.thread.label}
    >
      {threadDragGhost.thread.title ?? threadDragGhost.thread.label}
    </span>
  </div>
{/if}

{#if remotePicker}
  <RemoteProjectPicker
    onClose={() => (remotePicker = false)}
    onAddRemote={() => {
      remotePicker = false;
      onNewProject("remote");
    }}
  />
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
  /* An open launcher pins both buttons visible.
     Reaching the popover means leaving the card, and the card is what reveals
     them — so the `+` you just pressed faded out from under your own pointer,
     taking the `…` next to it along. Written here rather than as a conditional
     utility because it has to beat `text-muted-foreground/0`, and two Tailwind
     classes setting the same property are resolved by stylesheet order, not by
     the order they appear in the attribute. */
  .project-block.launching .row-action {
    color: var(--color-muted-foreground);
  }
  .project-block.launching .row-action.is-open {
    background: var(--color-accent);
    color: var(--color-foreground);
  }

  /* The project card's own recipe, not `surface-popover`.
     Every `--shadow-e*` step is two lines — a `0 0 0 1px` ring outside and a
     top-only `inset 0 1px 0` highlight — so a bordered popover reads as light /
     dark / light along its top edge whatever the border is set to. The cards
     this menu belongs to draw one flat 1px line and no shadow at all, so it
     draws the same one, and keeps only the diffuse half of the elevation to say
     it is floating. Opaque surface rather than the card's translucent mix: it
     covers rows instead of sitting among them. */
  .launcher-menu {
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    box-shadow: 0 12px 32px -6px rgb(0 0 0 / 0.75);
  }

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
  /* No hover border. Passing over a card is not an event: the outline lit up
     under the pointer on the way to somewhere else, and it read as a weaker
     version of `selected`, which is the same property saying something the user
     actually did. What hover reveals now is the two buttons, which is an offer
     rather than a state. */

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

  /* The thread that is open. A white line around the card and the bloom that
     goes with it, where there used to be a filled background — under the glow
     design the card's area is already the state's, and "this thread is open"
     written on the background was the same property saying two things at once.
     A line is free of that: no state draws one in white.

     Its own layer for two reasons. The card's own box-shadow is animated by
     `mcp-touch` and `just-finished`, which would blow the selection away for a
     second and a half; and ::before belongs to the state halo, which sets it
     per state. That leaves ::after, which paints over the label rather than
     under it — fine for a one-pixel perimeter, and it is also what keeps the
     white line above the tone line the two rules both draw at `inset 0 0 0 1px`.

     -4px on the spread, tighter than the halo's -2px: the classic design stacks
     rows a single pixel apart, and a white bloom at the halo's reach would land
     on the two neighbours hard enough to read as three selected rows. */
  .thread-card.selected::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: inherit;
    pointer-events: none;
    box-shadow:
      inset 0 0 0 1px color-mix(in srgb, var(--color-foreground) 85%, transparent),
      0 0 12px -4px color-mix(in srgb, var(--color-foreground) 60%, transparent);
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

  /* ---- The glow design ---------------------------------------------------
     Opt-in, and the whole of it hangs off `.thread-card.glow` with the state on
     a data attribute. `--tone` is the state's colour, written by the markup
     from threadVisual().

     The idea it keeps: a thread's state is worth the whole row, not a mark you
     have to look at. What it drops is the way the first cut spent that idea --
     two lights walking the card's perimeter, a second full-strength ring around
     the logo inside an already-lit card, and every one of its animations driving
     `box-shadow`, which is a paint property and repainted the card sixty times a
     second per lit row.

     So: the halo is drawn once per state and only its opacity moves, which is
     composited; the ring is gone; and the one thing that travels crosses the
     card along the axis the card actually has. */

  /* The halo. One layer, one box-shadow, set per state and never animated --
     `--lit` is what changes, and it changes on the compositor.
     A ::before rather than the card's own box-shadow because `mcp-touch`
     animates that one, and an agent touching Boite must not blow away the row's
     own state for 1.6 seconds. */
  .thread-card.glow::before {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: inherit;
    pointer-events: none;
    box-shadow:
      inset 0 0 0 1px color-mix(in srgb, var(--tone) 75%, transparent),
      0 0 10px -2px color-mix(in srgb, var(--tone) 70%, transparent);
    /* The wash rides the same layer as the halo rather than taking one of its
       own. ::after would have been the obvious second layer and is the wrong
       one: a pseudo-element paints after the children, so the tint would have
       been drawn over the label and the logo rather than under them. Sharing
       ::before also means the two never disagree about how lit the row is --
       one number moves both, and `--wash` is stated pre-multiplied by it. */
    background-color: color-mix(in srgb, var(--tone) var(--wash, 0%), transparent);
    opacity: var(--lit, 0);
    transition:
      opacity 260ms var(--ease-out-quint),
      background-color 260ms var(--ease-out-quint);
  }

  /* Every state carries a wash, including the quiet ones.
     `--wash` used to be declared on three states out of six, so the other three
     fell through to the `0%` default and were left holding a one-pixel liner at
     a fraction of its own opacity: `finished` came to 0.55 of 75% of one pixel
     of green, which is a row that renders and says nothing. A hue is only read
     off an area, so the area is what separates the states and `--lit` grades
     them. The two loud ones stay loud by margin, not by being the only ones
     drawn at all. */

  /* Mid-turn. Lit, but the sheen below is what makes this state the one that
     moves: four amber rows at rest have to sit still enough to be scanned. */
  .thread-card.glow[data-state="working"] {
    --lit: 0.85;
    --wash: 17%;
  }

  /* Blocked on an answer. Full strength, breathing, and the one row in the list
     worth crossing a room for. Opacity alone: the same reading as the box-shadow
     keyframes it replaces, none of the repainting. */
  .thread-card.glow[data-state="waiting"] {
    --lit: 1;
    --wash: 18%;
  }
  .thread-card.glow[data-state="waiting"]::before {
    animation: card-breathe 1.7s var(--ease-in-out-quad) infinite;
  }
  /* Off `--lit` rather than off two literals, so the trough follows the state's
     own resting brightness instead of drifting from it the next time one of the
     two numbers is touched. */
  @keyframes card-breathe {
    0%,
    100% {
      opacity: calc(var(--lit) * 0.45);
    }
    50% {
      opacity: var(--lit);
    }
  }

  /* Done. Green, and green enough to be found by a glance that arrives an hour
     late: this is the state the user is scanning the column for. The arrival
     flash is the `fresh` rule below, and it decays to this, not past it. */
  .thread-card.glow[data-state="finished"] {
    --lit: 0.8;
    --wash: 16%;
  }
  .thread-card.glow.fresh[data-state="finished"]::before {
    animation: card-finish 1.4s var(--ease-out-quint) forwards;
  }
  /* `forwards` pins the last keyframe for as long as `.fresh` is on the card, so
     a literal here is not a starting point the state rule can correct: it is the
     state rule, overriding it for the whole flash. It reads `--lit` for that
     reason. */
  @keyframes card-finish {
    0% {
      opacity: 1;
      transform: scale(1.015);
    }
    100% {
      opacity: var(--lit);
      transform: scale(1);
    }
  }

  /* Attached and quiet: alive, and nothing more than that. */
  .thread-card.glow[data-state="ready"] {
    --lit: 0.5;
    --wash: 12%;
  }

  /* Asleep. Exactly half of `finished` on both axes, which is what lets the two
     share a colour: a thread that finished and was then parked by the idle timer
     keeps its green and reads as the same fact an hour later, quieter. The tone
     is what separates it from a thread that was killed or that came back from a
     restart with nothing to say, and those take the dark green of `dormant`
     rather than a grey.
     Half, not off: a column where one row in six has no outline at all reads as
     a row that failed to draw. */
  .thread-card.glow[data-state="sleeping"] {
    --lit: 0.4;
    --wash: 8%;
  }

  /* Never run. Unlit, and the one state that is: the card is its label, its logo
     and the hover, with nothing painted over them. Half of `sleeping` would have
     been the pattern the other states follow, and it is wrong here — the rule
     "no row is unpainted" was written when every row after a restart landed in
     this state, which is exactly what stopped being true. A quiet row among lit
     ones reads as a row at rest; a column of them reads as the list this app
     opens on, which is what it is. */
  .thread-card.glow[data-state="cold"] {
    --lit: 0;
    --wash: 0%;
  }

  /* Ended badly. Steady, never breathing: a crash is not urgent, it is over, and
     a red light that moves reads as something still going wrong. */
  .thread-card.glow[data-state="failed"] {
    --lit: 0.9;
    --wash: 16%;
  }

  /* The sheen: one light crossing the card left to right while an agent works.
     Its own clipping layer, so the halo on ::before stays outside the clip, and
     `transform` only, so a sidebar with six working threads composites rather
     than repainting.
     45% of the card wide, starting one own-width off the left edge: the keyframe
     walks it to the far edge, which is (100 + 45) / 45 of its own width. */
  .thread-card.glow .sheen {
    position: absolute;
    inset: 0;
    border-radius: inherit;
    overflow: hidden;
    pointer-events: none;
  }
  .thread-card.glow .sheen::after {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    left: -45%;
    width: 45%;
    background: linear-gradient(
      90deg,
      transparent,
      color-mix(in srgb, var(--tone) 40%, transparent),
      transparent
    );
    animation: card-sheen 2.4s var(--ease-in-out-quad) infinite;
  }
  @keyframes card-sheen {
    to {
      transform: translateX(322%);
    }
  }

  /* Motion is the difference between "an agent is on it" and "an agent stopped
     on it", and with it gone the two amber states have to separate themselves.
     Working keeps its half-lit halo, blocked is pinned at full. */
  :global(html[data-motion="reduced"]) .thread-card.glow .sheen {
    display: none;
  }
  :global(html[data-motion="reduced"]) .thread-card.glow[data-state="waiting"]::before {
    animation: none;
    opacity: 1;
  }

  /* A project that lives on the connected boite. It used to be a two-pixel bar
     down the left of the header row, which is a marker glued to a card rather
     than a property of it; the boite's own colour on the card's outline says the
     same thing about the whole thing it is true of, threads included. */
  /* `:not(.source)` because the drag lift is a box-shadow too, and it is
     declared above: a card being carried keeps its elevation rather than
     swapping it for a coloured halo. */
  .project-block.remote-origin:not(.source) {
    border-color: color-mix(in srgb, var(--boite) 55%, var(--color-border));
    box-shadow: 0 0 10px -4px color-mix(in srgb, var(--boite) 70%, transparent);
  }
  .project-block.remote-origin.selected:not(.source) {
    border-color: color-mix(in srgb, var(--boite) 80%, var(--color-border-strong));
    box-shadow: 0 0 12px -3px color-mix(in srgb, var(--boite) 80%, transparent);
  }
  /* The boite these blocks were imported from is unreachable. This used to be a
     ring around the whole window, which said the app was down while the local
     projects two rows up kept working. Said here instead, on the only rows it is
     true of: the boite's colour drops for the warning colour, and the fade the
     block already had stays.
     After the two rules above and with the same weight, so it wins over both the
     resting accent and the selected one. */
  .project-block.remote-origin.boite-offline:not(.source) {
    border-color: color-mix(in srgb, var(--color-warning) 65%, var(--color-border));
    box-shadow: 0 0 12px -3px color-mix(in srgb, var(--color-warning) 70%, transparent);
  }
</style>
