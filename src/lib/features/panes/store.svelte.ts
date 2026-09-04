import { app } from "$lib/app/store.svelte";
import type {
  DropSide,
  LayoutNode,
  PaneContent,
  PaneGroup,
  SplitDir,
} from "./types";
import {
  MAX_LEAVES,
  MIN_COLUMN_PX,
  MIN_PANE_PX,
  MIN_RATIO,
  SPLITTER_PX,
  sameContent,
  threadIdOf,
  threadPane,
} from "./types";
import {
  countLeaves,
  findContent,
  injectSibling,
  leafNodesOf,
  leavesOf,
  pruneLeaf,
  threadLeavesOf,
  findSplit,
} from "./tree";
import { loadSavedGroups, panesKey } from "./layout";
import { log } from "$lib/shared/log";
import { workspace } from "$lib/backend";
import { sameRect, unmeasuredRect, type PaneRect, type Viewport } from "./rect";
import { uuid } from "$lib/shared/utils/uuid";

export type { PaneRect } from "./rect";

function uid(): string {
  return uuid();
}

/**
 * The pane a thread gets, terminal or chat, read off the row.
 *
 * One function so the answer cannot differ between the five places a pane is
 * opened for a thread. A row the store has never heard of falls through to a
 * terminal, which is what an id from a stale saved layout is.
 */
function paneForThread(threadId: string): LayoutNode {
  return threadPane(threadId, app.threadById(threadId)?.runtime ?? null);
}

// Re-exported: the tree helpers are the store's public vocabulary as far as the
// rest of the app is concerned, and nothing outside this feature should have to
// know the split between the reactive store and the pure functions under it.
export { countLeaves, leafNodesOf, leavesOf, threadLeavesOf };

export interface DropPreview {
  targetPaneId: string;
  side: DropSide;
  refused: boolean;
}

class PaneStore {
  groups = $state<PaneGroup[]>([]);
  private hydrated = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  hoveredThreadId = $state<string | null>(null);
  draggingThreadId = $state<string | null>(null);
  dropPreview = $state<DropPreview | null>(null);
  rects = $state<Record<string, PaneRect>>({});
  // The area every pane is laid out inside. Kept so a pane that is the only one
  // in its group can be placed before it has been measured (see rectFor).
  viewport = $state<Viewport | null>(null);

  setViewport(w: number, h: number) {
    if (this.viewport && this.viewport.w === w && this.viewport.h === h) return;
    this.viewport = { w, h };
  }

  /**
   * Where to put this thread's terminal, or null while that is unknown.
   *
   * `visible` is the caller's own answer about the group, and it is load
   * bearing rather than an optimisation: see unmeasuredRect.
   */
  rectFor(threadId: string, group: PaneGroup, visible: boolean): PaneRect | null {
    return this.rects[threadId] ?? unmeasuredRect(group.root, this.viewport, visible);
  }

  /**
   * Forget a pane's measured box.
   *
   * syncWithThreads only prunes rects for panes that no longer exist, but a
   * pane that merely moved keeps its entry, and the drop-target search and the
   * terminal wrappers both read this map. The stale rect put a terminal at its
   * old position until the new leaf measured itself.
   */
  clearRect(paneId: string) {
    delete this.rects[paneId];
  }

  setRect(paneId: string, rect: PaneRect) {
    const prev = this.rects[paneId];
    if (prev && sameRect(prev, rect)) return;
    this.rects[paneId] = rect;
  }

  // groupOf is called per thread row per render pass; a full tree walk per
  // call made it O(threads × groups × depth). The index recomputes once per
  // structural change instead.
  private groupByPane: Map<string, PaneGroup> = $derived.by(() => {
    const map = new Map<string, PaneGroup>();
    for (const g of this.groups) {
      for (const id of leavesOf(g.root)) map.set(id, g);
    }
    return map;
  });

  private contentByPane: Map<string, PaneContent> = $derived.by(() => {
    const map = new Map<string, PaneContent>();
    for (const g of this.groups) {
      for (const leaf of leafNodesOf(g.root)) map.set(leaf.paneId, leaf.content);
    }
    return map;
  });

  /** The group a pane belongs to. A thread id is a pane id; see `PaneContent`. */
  groupOf(paneId: string): PaneGroup | null {
    return this.groupByPane.get(paneId) ?? null;
  }

  contentOf(paneId: string): PaneContent | null {
    return this.contentByPane.get(paneId) ?? null;
  }

  /** Thread ids in the active group. What "which terminals are on screen" means. */
  visibleThreads(activeGroupId: string | null): Set<string> {
    if (!activeGroupId) return new Set();
    const g = this.groups.find((x) => x.id === activeGroupId);
    return g ? new Set(threadLeavesOf(g.root)) : new Set();
  }

  /**
   * Persist the tree, coalesced.
   *
   * A splitter drag calls setRatios at pointer rate, so writing straight through
   * would hit localStorage sixty times a second for one gesture.
   */
  private saveSoon() {
    if (typeof localStorage === "undefined") return;
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    // Captured when the write is armed, never resolved inside the timeout: a
    // switch lands well within 250ms, and a key read late would file the
    // outgoing workspace's tree under the incoming one's name.
    const key = panesKey(workspace.mode, workspace.activeBoiteId);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        localStorage.setItem(key, JSON.stringify($state.snapshot(this.groups)));
      } catch {
        // A layout is not worth failing over: a full quota just means the next
        // start rebuilds one leaf per thread, which is where this began.
      }
    }, 250);
  }

  syncWithThreads() {
    // Hydration happens here rather than at boot because this is the first thing
    // to run once the threads exist, and a saved group is only meaningful next to
    // them: loading afterwards would find every leaf already claimed by the
    // one-per-thread pass below and overwrite the layout it was meant to restore.
    if (!this.hydrated) {
      this.hydrated = true;
      const saved = loadSavedGroups(panesKey(workspace.mode, workspace.activeBoiteId));
      if (saved.length > 0 && this.groups.length === 0) this.groups = saved;
    }
    const valid = new Map(app.threads.map((t) => [t.id, t]));

    for (const t of app.threads) {
      if (!this.groupOf(t.id)) {
        this.groups.push({
          id: uid(),
          projectId: t.projectId,
          root: paneForThread(t.id),
          focusedPaneId: t.id,
        });
      }
    }

    // A saved layout is bytes written before the row it names was read back,
    // and a layout persisted by a build that had no chat pane says `thread` for
    // every one of them. Repaired here rather than at the render site: a pilot
    // row drawn as a terminal is a pane with no PTY behind it, which is a blank
    // rectangle and nothing else.
    for (const g of this.groups) {
      for (const leaf of leafNodesOf(g.root)) {
        const threadId = threadIdOf(leaf.content);
        if (!threadId) continue;
        const wanted = valid.get(threadId)?.runtime === "pilot" ? "chat" : "thread";
        if (leaf.content.kind !== wanted) {
          leaf.content = { kind: wanted, threadId } as PaneContent;
        }
      }
    }

    // A move changes `projectId` on a row whose group already exists.
    // Creating a group is skipped above, and unsplit no-ops on a solo
    // thread, so without this the git panel keeps operating on the
    // project the thread just left.
    for (const t of app.threads) {
      const g = this.groupOf(t.id);
      if (g && g.projectId !== t.projectId) this.rehome(t.id, t.projectId);
    }

    for (let i = this.groups.length - 1; i >= 0; i--) {
      const g = this.groups[i];
      // Only thread panes can go stale: a git or browser pane is not backed by
      // a row anyone else can delete, so it lives until it is closed by hand.
      const orphans = threadLeavesOf(g.root).filter((id) => !valid.has(id));
      // Nothing died here. Worth saying out loud because the reaping below
      // keys on "no thread left", and a group that never had one is not a
      // widow — it is the panels a user opened on a project with no terminal
      // running, which is most of a project's life.
      if (orphans.length === 0) continue;
      let root: LayoutNode | null = g.root;
      for (const id of orphans) {
        if (!root) break;
        root = pruneLeaf(root, id);
      }
      // A group whose last thread is gone goes with it, panels included: those
      // panels were opened next to a terminal, and on their own they are a
      // project page with no way back to one.
      if (!root || threadLeavesOf(root).length === 0) {
        this.groups.splice(i, 1);
        continue;
      }
      g.root = root;
      const leaves = leavesOf(root);
      if (!leaves.includes(g.focusedPaneId)) {
        g.focusedPaneId = leaves[0];
      }
    }

    const live = new Set(this.groups.flatMap((g) => leavesOf(g.root)));
    for (const id of Object.keys(this.rects)) {
      if (!live.has(id)) delete this.rects[id];
    }
    if (this.dropPreview && !live.has(this.dropPreview.targetPaneId)) {
      this.dropPreview = null;
    }
    this.saveSoon();
  }

  /**
   * Drop the tree so a switch does not keep the previous machine's panes.
   *
   * `syncWithThreads` prunes against the live thread list, and that reaches the
   * terminals only: a git, explorer, editor, todo or browser pane is not backed
   * by a row anyone else can delete, so a panel-only group survived the switch
   * still carrying a `projectId` from a project list the new machine has never
   * heard of.
   *
   * The saved blob stays, and stays where it was: `panesKey` gives each
   * workspace its own, so the arrangement a machine had is still there when the
   * user comes back to it. Only the tree in memory is dropped. This used to
   * delete the blob outright, which was the price of a single global key —
   * every machine lost its layout to stop them from mixing.
   *
   * `viewport` stays. It measures the window this app is drawn in, which is the
   * one thing a switch does not change.
   */
  reset() {
    // The debounce holds up to 250ms of the outgoing layout. Left armed it
    // fires after the wipe and writes an empty tree over that workspace's blob.
    // The key it captured is the right one; the groups it would snapshot are
    // not, since they are cleared two lines down.
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.groups = [];
    this.rects = {};
    this.hoveredThreadId = null;
    this.draggingThreadId = null;
    this.dropPreview = null;
    // Back to false, deliberately: the next syncWithThreads has to read the
    // incoming workspace's own blob. Under the old global key that re-read was
    // the stale tree, which is why this was pinned true.
    this.hydrated = false;
  }

  setFocused(groupId: string, paneId: string) {
    const g = this.groups.find((x) => x.id === groupId);
    if (!g) return;
    if (!leavesOf(g.root).includes(paneId)) return;
    g.focusedPaneId = paneId;
    this.saveSoon();
  }

  /**
   * Moves one splitter. Called at pointer rate for the whole of a drag.
   *
   * The ratios are written in place rather than through `updateRatios`, and
   * that is the point: rebuilding the tree replaces every node from the root
   * down, so `groupByPane` and `contentByPane` recomputed on every pointermove
   * even though no pane had appeared, moved or gone. Neither index reads a
   * ratio, so writing one now invalidates nothing that walks the leaves.
   */
  setRatios(groupId: string, splitId: string, ratios: number[]) {
    const g = this.groups.find((x) => x.id === groupId);
    if (!g) return;
    const split = findSplit(g.root, splitId);
    if (!split) return;
    split.ratios = ratios;
    this.saveSoon();
  }

  /**
   * Whether a pane cut out of `targetPaneId` has the room to be a column, and
   * whether it has the room to be stacked.
   *
   * Both halves are checked, not only the new one: `ratio` is the new pane's
   * share, the target keeps the rest, and a 0.9 split starves the target
   * instead. The splitter itself comes off the top because it takes its 4px
   * from the same box.
   *
   * Unmeasured is a yes. Nothing has been laid out yet at that point, so there
   * is no width to refuse against, and refusing on a missing number would mean
   * the first pane of a session could not be opened.
   */
  private roomBeside(
    targetPaneId: string,
    ratio: number,
  ): { row: boolean; column: boolean } {
    const rect = this.rects[targetPaneId];
    if (!rect) return { row: true, column: true };
    const share = Math.min(ratio, 1 - ratio);
    return {
      row: (rect.w - SPLITTER_PX) * share >= MIN_COLUMN_PX,
      column: (rect.h - SPLITTER_PX) * share >= MIN_PANE_PX,
    };
  }

  /**
   * Put `content` in a new pane beside `targetPaneId`.
   *
   * The one entry point for everything that is not a thread being dragged: the
   * keyboard, the palette, the pane header's own button, and the MCP verb an
   * agent calls to show what it just did. Returns the new pane's id, or null
   * when the target is gone, when the group is full, or when the window has no
   * room left for the pane either way round (see `roomBeside`). `side` is a
   * preference rather than an instruction for the same reason.
   *
   * `focus` is what the agent path turns off. A user who opened a pane meant to
   * work in it; an agent that opened one is showing something to somebody who
   * is in the middle of a sentence in the terminal beside it, and taking the
   * keyboard off them to do it is the same theft as switching the view.
   */
  openBeside(
    targetPaneId: string,
    content: PaneContent,
    side: DropSide = "right",
    ratio = 0.35,
    focus = true,
  ): string | null {
    const group = this.groupOf(targetPaneId);
    if (!group) return null;

    // Already open in this group: focus it instead of opening a second copy.
    // Four calls from an agent would otherwise fill the group with four git
    // panels and hit the pane cap.
    const existing = findContent(group.root, (c) => sameContent(c, content));
    if (existing) {
      if (focus) group.focusedPaneId = existing.paneId;
      this.saveSoon();
      return existing.paneId;
    }

    if (countLeaves(group.root) >= MAX_LEAVES) return null;

    const paneId =
      content.kind === "thread" ? content.threadId : `pane-${uid()}`;
    let dir: SplitDir = side === "left" || side === "right" ? "row" : "column";
    const before = side === "left" || side === "top";
    if (dir === "row") {
      const room = this.roomBeside(targetPaneId, ratio);
      // Side by side is what the caller asked for, and on a wide window it is
      // what it gets. On a narrow one the same call used to hand back two
      // unreadable strips, so the split turns on its side instead: the new pane
      // goes under its neighbour, where the width is the one thing it keeps.
      // Neither fits, and the caller says the group is full — which it is, of
      // this window.
      if (!room.row) {
        if (!room.column) return null;
        dir = "column";
      }
    }
    const next = injectSibling(
      group.root,
      targetPaneId,
      { kind: "leaf", paneId, content },
      dir,
      before,
      ratio,
      uid,
    );
    if (!next) return null;
    group.root = next;
    if (focus) group.focusedPaneId = paneId;
    this.saveSoon();
    return paneId;
  }

  /**
   * A group of one pane, for a project with no terminal open.
   *
   * Panels used to hang off a rail that drew itself whatever was running, so
   * git, files and the todo list were reachable on a project nobody had opened
   * a terminal in yet — which is how a project starts. Panes replaced the rail
   * and inherited a rule the rail never had: every pane opens beside another
   * one. This is the seed that rule needs.
   *
   * A thread never comes through here: `syncWithThreads` is what gives a
   * terminal its group, and a second one made by hand would leave the pane
   * tree holding the same thread twice.
   */
  openGroup(projectId: string, content: PaneContent): string | null {
    if (content.kind === "thread") return null;
    const paneId = `pane-${uid()}`;
    this.groups.push({
      id: uid(),
      projectId,
      root: { kind: "leaf", paneId, content },
      focusedPaneId: paneId,
    });
    this.saveSoon();
    return paneId;
  }

  /**
   * Point a browser pane somewhere else, or hand it back to the user.
   *
   * Navigating replaces what is in the pane rather than opening another one:
   * two browser panes are told apart by their address (`sameContent`), so an
   * agent following a dev server through three routes with `openBeside` would
   * leave three frames on the user's screen.
   */
  setBrowser(paneId: string, patch: { url?: string; drivenBy?: string | null }): boolean {
    const group = this.groupOf(paneId);
    if (!group) return false;
    const leaf = leafNodesOf(group.root).find((l) => l.paneId === paneId);
    if (leaf?.content.kind !== "browser") return false;
    if (patch.url !== undefined) leaf.content.url = patch.url;
    if (patch.drivenBy !== undefined) leaf.content.drivenBy = patch.drivenBy;
    this.saveSoon();
    return true;
  }

  /** Close a pane. A thread pane goes back to being a group of its own. */
  closePane(paneId: string): boolean {
    // Every way out goes through here: the titlebar toggle, the palette, the
    // phone's strip, an agent closing what it opened. Logged at the door rather
    // than at each of them, and at debug for the same reason the open is.
    const closed = this.#closePane(paneId);
    log.debug("ui.pane", closed ? "pane.closed" : "pane.closeRefused", { pane: paneId });
    return closed;
  }

  #closePane(paneId: string): boolean {
    const g = this.groupOf(paneId);
    if (!g) return false;
    const content = this.contentOf(paneId);
    if (!content) return false;
    // Closing the last pane of a group would leave an empty group; for a thread
    // that is what `unsplit` means, and for a panel there is nothing left to
    // show, so the group goes.
    if (countLeaves(g.root) <= 1) {
      if (content.kind === "thread") return false;
      this.groups = this.groups.filter((x) => x.id !== g.id);
      this.saveSoon();
      return true;
    }
    if (content.kind === "thread") return this.unsplit(paneId);
    const next = pruneLeaf(g.root, paneId);
    if (!next) return false;
    g.root = next;
    if (g.focusedPaneId === paneId) g.focusedPaneId = leavesOf(next)[0];
    delete this.rects[paneId];
    this.saveSoon();
    return true;
  }

  splitInto(
    targetPaneId: string,
    draggedThreadId: string,
    side: DropSide,
  ): boolean {
    if (targetPaneId === draggedThreadId) return false;
    const targetGroup = this.groupOf(targetPaneId);
    const dragged = app.threadById(draggedThreadId);
    if (!targetGroup || !dragged) return false;
    if (dragged.projectId !== targetGroup.projectId) return false;

    const sourceGroup = this.groupOf(draggedThreadId);
    const movingWithinTarget = sourceGroup?.id === targetGroup.id;
    if (countLeaves(targetGroup.root) >= MAX_LEAVES && !movingWithinTarget) {
      return false;
    }

    if (sourceGroup) {
      const pruned = pruneLeaf(sourceGroup.root, draggedThreadId);
      if (sourceGroup.id === targetGroup.id) {
        if (!pruned) return false;
        targetGroup.root = pruned;
      } else if (!pruned || threadLeavesOf(pruned).length === 0) {
        // The source group had nothing left but panels; it goes with the thread
        // that was the reason those panels were open.
        this.groups = this.groups.filter((x) => x.id !== sourceGroup.id);
      } else {
        sourceGroup.root = pruned;
        if (!leavesOf(pruned).includes(sourceGroup.focusedPaneId)) {
          sourceGroup.focusedPaneId = leavesOf(pruned)[0];
        }
      }
    }

    const dir: SplitDir = side === "left" || side === "right" ? "row" : "column";
    const before = side === "left" || side === "top";
    const next = injectSibling(
      targetGroup.root,
      targetPaneId,
      paneForThread(draggedThreadId),
      dir,
      before,
      0.5,
      uid,
    );
    if (!next) return false;
    targetGroup.root = next;
    targetGroup.focusedPaneId = draggedThreadId;
    this.saveSoon();
    return true;
  }

  /**
   * Puts this thread's group on the project the thread now belongs to.
   *
   * A solo group is retagged and the old project's panels are dropped: those
   * were the source project's git and explorer, and keeping them would show
   * the wrong tree next to a terminal that has moved. A split extracts the
   * thread into a group of its own, the way unsplit does, so its former
   * neighbours stay where they were.
   */
  rehome(threadId: string, projectId: string): boolean {
    const g = this.groupOf(threadId);
    if (!g || g.projectId === projectId) return false;
    const others = threadLeavesOf(g.root).filter((id) => id !== threadId);
    if (others.length > 0) {
      const next = pruneLeaf(g.root, threadId);
      if (!next) return false;
      g.root = next;
      if (g.focusedPaneId === threadId) {
        g.focusedPaneId = leavesOf(next)[0];
      }
      this.groups.push({
        id: uid(),
        projectId,
        root: paneForThread(threadId),
        focusedPaneId: threadId,
      });
      this.saveSoon();
      return true;
    }
    const dropped: string[] = [];
    let root: LayoutNode | null = g.root;
    for (const leaf of leafNodesOf(g.root)) {
      if (leaf.content.kind === "thread") continue;
      dropped.push(leaf.paneId);
      root = root ? pruneLeaf(root, leaf.paneId) : null;
    }
    g.root = root ?? paneForThread(threadId);
    g.projectId = projectId;
    g.focusedPaneId = threadId;
    for (const id of dropped) delete this.rects[id];
    this.saveSoon();
    return true;
  }

  unsplit(threadId: string): boolean {
    const g = this.groupOf(threadId);
    if (!g || countLeaves(g.root) <= 1) return false;
    const t = app.threadById(threadId);
    if (!t) return false;
    const next = pruneLeaf(g.root, threadId);
    if (!next) return false;
    // Everything left behind is a panel: it was opened beside this thread, and
    // there is no terminal under it any more.
    if (threadLeavesOf(next).length === 0) {
      this.groups = this.groups.filter((x) => x.id !== g.id);
    } else {
      g.root = next;
      if (g.focusedPaneId === threadId) {
        g.focusedPaneId = leavesOf(next)[0];
      }
    }
    this.groups.push({
      id: uid(),
      projectId: t.projectId,
      root: paneForThread(threadId),
      focusedPaneId: threadId,
    });
    this.saveSoon();
    return true;
  }
}

export const paneStore = new PaneStore();

/**
 * Action for the element every pane is positioned inside. Feeds `setViewport`,
 * which is what lets a lone pane be placed without a measurement of its own.
 */
export function paneViewport(el: HTMLElement) {
  const read = () => {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) paneStore.setViewport(r.width, r.height);
  };
  const observer = new ResizeObserver(read);
  observer.observe(el);
  read();
  return {
    destroy() {
      observer.disconnect();
    },
  };
}

export { MAX_LEAVES, MIN_RATIO };
