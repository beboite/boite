import { app } from "$lib/app/store.svelte";
import type { DropSide, LayoutNode, PaneContent, PaneGroup, SplitDir } from "./types";
import { MAX_LEAVES, MIN_RATIO, sameContent, threadPane } from "./types";
import {
  countLeaves,
  findContent,
  injectSibling,
  leafNodesOf,
  leavesOf,
  pruneLeaf,
  threadLeavesOf,
  updateRatios,
} from "./tree";
import { uuid } from "$lib/shared/utils/uuid";

function uid(): string {
  return uuid();
}

// Re-exported: the tree helpers are the store's public vocabulary as far as the
// rest of the app is concerned, and nothing outside this feature should have to
// know the split between the reactive store and the pure functions under it.
export { countLeaves, leafNodesOf, leavesOf, threadLeavesOf };

export interface PaneRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DropPreview {
  targetPaneId: string;
  side: DropSide;
  refused: boolean;
}

class PaneStore {
  groups = $state<PaneGroup[]>([]);
  hoveredThreadId = $state<string | null>(null);
  draggingThreadId = $state<string | null>(null);
  dropPreview = $state<DropPreview | null>(null);
  rects = $state<Record<string, PaneRect>>({});

  setRect(paneId: string, rect: PaneRect) {
    const prev = this.rects[paneId];
    if (
      prev &&
      prev.x === rect.x &&
      prev.y === rect.y &&
      prev.w === rect.w &&
      prev.h === rect.h
    ) {
      return;
    }
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

  /** Pane ids in the active group, whatever they hold. */
  visibleLeaves(activeGroupId: string | null): Set<string> {
    if (!activeGroupId) return new Set();
    const g = this.groups.find((x) => x.id === activeGroupId);
    return g ? new Set(leavesOf(g.root)) : new Set();
  }

  /** Thread ids in the active group. What "which terminals are on screen" means. */
  visibleThreads(activeGroupId: string | null): Set<string> {
    if (!activeGroupId) return new Set();
    const g = this.groups.find((x) => x.id === activeGroupId);
    return g ? new Set(threadLeavesOf(g.root)) : new Set();
  }

  syncWithThreads() {
    const valid = new Map(app.threads.map((t) => [t.id, t]));

    for (const t of app.threads) {
      if (!this.groupOf(t.id)) {
        this.groups.push({
          id: uid(),
          projectId: t.projectId,
          root: threadPane(t.id),
          focusedPaneId: t.id,
        });
      }
    }

    for (let i = this.groups.length - 1; i >= 0; i--) {
      const g = this.groups[i];
      // Only thread panes can go stale: a git or browser pane is not backed by
      // a row anyone else can delete, so it lives until it is closed by hand.
      const orphans = threadLeavesOf(g.root).filter((id) => !valid.has(id));
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
  }

  setFocused(groupId: string, paneId: string) {
    const g = this.groups.find((x) => x.id === groupId);
    if (!g) return;
    if (!leavesOf(g.root).includes(paneId)) return;
    g.focusedPaneId = paneId;
  }

  setRatios(groupId: string, splitId: string, ratios: number[]) {
    const g = this.groups.find((x) => x.id === groupId);
    if (!g) return;
    g.root = updateRatios(g.root, splitId, ratios);
  }

  /**
   * Put `content` in a new pane beside `targetPaneId`.
   *
   * The one entry point for everything that is not a thread being dragged: the
   * keyboard, the palette, the pane header's own button, and the MCP verb an
   * agent calls to show what it just did. Returns the new pane's id, or null
   * when the group is full or the target is gone.
   */
  openBeside(
    targetPaneId: string,
    content: PaneContent,
    side: DropSide = "right",
    ratio = 0.35,
  ): string | null {
    const group = this.groupOf(targetPaneId);
    if (!group) return null;

    // Already open in this group: focus it instead of opening a second copy.
    // Four calls from an agent would otherwise fill the group with four git
    // panels and hit the pane cap.
    const existing = findContent(group.root, (c) => sameContent(c, content));
    if (existing) {
      group.focusedPaneId = existing.paneId;
      return existing.paneId;
    }

    if (countLeaves(group.root) >= MAX_LEAVES) return null;

    const paneId =
      content.kind === "thread" ? content.threadId : `pane-${uid()}`;
    const dir: SplitDir = side === "left" || side === "right" ? "row" : "column";
    const before = side === "left" || side === "top";
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
    group.focusedPaneId = paneId;
    return paneId;
  }

  /** Close a pane. A thread pane goes back to being a group of its own. */
  closePane(paneId: string): boolean {
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
      return true;
    }
    if (content.kind === "thread") return this.unsplit(paneId);
    const next = pruneLeaf(g.root, paneId);
    if (!next) return false;
    g.root = next;
    if (g.focusedPaneId === paneId) g.focusedPaneId = leavesOf(next)[0];
    delete this.rects[paneId];
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
      threadPane(draggedThreadId),
      dir,
      before,
      0.5,
      uid,
    );
    if (!next) return false;
    targetGroup.root = next;
    targetGroup.focusedPaneId = draggedThreadId;
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
      root: threadPane(threadId),
      focusedPaneId: threadId,
    });
    return true;
  }
}

export const paneStore = new PaneStore();
export { MAX_LEAVES, MIN_RATIO };
