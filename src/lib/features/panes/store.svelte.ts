import { app } from "$lib/app/store.svelte";
import type {
  DropSide,
  LayoutNode,
  PaneGroup,
  SplitDir,
} from "./types";
import { MAX_LEAVES, MIN_RATIO } from "./types";

function uid(): string {
  return crypto.randomUUID();
}

export function leavesOf(node: LayoutNode): string[] {
  if (node.kind === "leaf") return [node.threadId];
  const out: string[] = [];
  for (const c of node.children) out.push(...leavesOf(c));
  return out;
}

export function countLeaves(node: LayoutNode): number {
  return leavesOf(node).length;
}

function pruneLeaf(node: LayoutNode, threadId: string): LayoutNode | null {
  if (node.kind === "leaf") {
    return node.threadId === threadId ? null : node;
  }
  const nextChildren: LayoutNode[] = [];
  const nextRatios: number[] = [];
  for (let i = 0; i < node.children.length; i++) {
    const child = pruneLeaf(node.children[i], threadId);
    if (child) {
      nextChildren.push(child);
      nextRatios.push(node.ratios[i]);
    }
  }
  if (nextChildren.length === 0) return null;
  if (nextChildren.length === 1) return nextChildren[0];
  return {
    ...node,
    children: nextChildren,
    ratios: normalize(nextRatios),
  };
}

function normalize(ratios: number[]): number[] {
  const sum = ratios.reduce((a, b) => a + b, 0);
  if (sum <= 0) return ratios.map(() => 1 / ratios.length);
  return ratios.map((r) => r / sum);
}

function injectSibling(
  node: LayoutNode,
  targetId: string,
  dragged: LayoutNode,
  dir: SplitDir,
  before: boolean,
): LayoutNode | null {
  if (node.kind === "leaf") {
    if (node.threadId !== targetId) return null;
    const children = before ? [dragged, node] : [node, dragged];
    return {
      kind: "split",
      id: uid(),
      dir,
      ratios: [0.5, 0.5],
      children,
    };
  }

  for (let i = 0; i < node.children.length; i++) {
    const c = node.children[i];
    if (c.kind === "leaf" && c.threadId === targetId) {
      if (node.dir === dir) {
        const children = [...node.children];
        const ratios = [...node.ratios];
        const insertAt = before ? i : i + 1;
        const half = ratios[i] / 2;
        ratios[i] = half;
        ratios.splice(insertAt, 0, half);
        children.splice(insertAt, 0, dragged);
        return { ...node, children, ratios: normalize(ratios) };
      }
      const wrapped: LayoutNode = {
        kind: "split",
        id: uid(),
        dir,
        ratios: [0.5, 0.5],
        children: before ? [dragged, c] : [c, dragged],
      };
      const children = [...node.children];
      children[i] = wrapped;
      return { ...node, children };
    }
    const next = injectSibling(c, targetId, dragged, dir, before);
    if (next) {
      const children = [...node.children];
      children[i] = next;
      return { ...node, children };
    }
  }
  return null;
}

function updateRatios(
  node: LayoutNode,
  splitId: string,
  ratios: number[],
): LayoutNode {
  if (node.kind === "leaf") return node;
  if (node.id === splitId) return { ...node, ratios };
  return {
    ...node,
    children: node.children.map((c) => updateRatios(c, splitId, ratios)),
  };
}

export interface PaneRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

class PaneStore {
  groups = $state<PaneGroup[]>([]);
  hoveredThreadId = $state<string | null>(null);
  draggingThreadId = $state<string | null>(null);
  rects = $state<Record<string, PaneRect>>({});

  setRect(threadId: string, rect: PaneRect) {
    const prev = this.rects[threadId];
    if (
      prev &&
      prev.x === rect.x &&
      prev.y === rect.y &&
      prev.w === rect.w &&
      prev.h === rect.h
    ) {
      return;
    }
    this.rects[threadId] = rect;
  }

  clearRect(threadId: string) {
    delete this.rects[threadId];
  }

  groupOf(threadId: string): PaneGroup | null {
    for (const g of this.groups) {
      if (leavesOf(g.root).includes(threadId)) return g;
    }
    return null;
  }

  visibleLeaves(activeGroupId: string | null): Set<string> {
    if (!activeGroupId) return new Set();
    const g = this.groups.find((x) => x.id === activeGroupId);
    return g ? new Set(leavesOf(g.root)) : new Set();
  }

  syncWithThreads() {
    const valid = new Map(app.threads.map((t) => [t.id, t]));

    for (const t of app.threads) {
      if (!this.groupOf(t.id)) {
        this.groups.push({
          id: uid(),
          projectId: t.projectId,
          root: { kind: "leaf", threadId: t.id },
          focusedThreadId: t.id,
        });
      }
    }

    for (let i = this.groups.length - 1; i >= 0; i--) {
      const g = this.groups[i];
      const orphans = leavesOf(g.root).filter((id) => !valid.has(id));
      let root: LayoutNode | null = g.root;
      for (const id of orphans) {
        if (!root) break;
        root = pruneLeaf(root, id);
      }
      if (!root) {
        this.groups.splice(i, 1);
        continue;
      }
      g.root = root;
      const leaves = leavesOf(root);
      if (!leaves.includes(g.focusedThreadId)) {
        g.focusedThreadId = leaves[0];
      }
    }

    for (const id of Object.keys(this.rects)) {
      if (!valid.has(id)) delete this.rects[id];
    }
  }

  setFocused(groupId: string, threadId: string) {
    const g = this.groups.find((x) => x.id === groupId);
    if (!g) return;
    if (!leavesOf(g.root).includes(threadId)) return;
    g.focusedThreadId = threadId;
  }

  setRatios(groupId: string, splitId: string, ratios: number[]) {
    const g = this.groups.find((x) => x.id === groupId);
    if (!g) return;
    g.root = updateRatios(g.root, splitId, ratios);
  }

  splitInto(
    targetThreadId: string,
    draggedThreadId: string,
    side: DropSide,
  ): boolean {
    if (targetThreadId === draggedThreadId) return false;
    const targetGroup = this.groupOf(targetThreadId);
    const dragged = app.threads.find((t) => t.id === draggedThreadId);
    if (!targetGroup || !dragged) return false;
    if (dragged.projectId !== targetGroup.projectId) return false;
    if (countLeaves(targetGroup.root) >= MAX_LEAVES) return false;

    const sourceGroup = this.groupOf(draggedThreadId);
    if (sourceGroup) {
      const pruned = pruneLeaf(sourceGroup.root, draggedThreadId);
      if (sourceGroup.id === targetGroup.id) {
        if (!pruned) return false;
        targetGroup.root = pruned;
      } else {
        if (!pruned) {
          this.groups = this.groups.filter((x) => x.id !== sourceGroup.id);
        } else {
          sourceGroup.root = pruned;
          if (!leavesOf(pruned).includes(sourceGroup.focusedThreadId)) {
            sourceGroup.focusedThreadId = leavesOf(pruned)[0];
          }
        }
      }
    }

    const dir: SplitDir = side === "left" || side === "right" ? "row" : "column";
    const before = side === "left" || side === "top";
    const draggedNode: LayoutNode = { kind: "leaf", threadId: draggedThreadId };
    const next = injectSibling(
      targetGroup.root,
      targetThreadId,
      draggedNode,
      dir,
      before,
    );
    if (!next) return false;
    targetGroup.root = next;
    targetGroup.focusedThreadId = draggedThreadId;
    return true;
  }

  unsplit(threadId: string): boolean {
    const g = this.groupOf(threadId);
    if (!g || countLeaves(g.root) <= 1) return false;
    const t = app.threads.find((x) => x.id === threadId);
    if (!t) return false;
    const next = pruneLeaf(g.root, threadId);
    if (!next) return false;
    g.root = next;
    if (g.focusedThreadId === threadId) {
      g.focusedThreadId = leavesOf(next)[0];
    }
    this.groups.push({
      id: uid(),
      projectId: t.projectId,
      root: { kind: "leaf", threadId },
      focusedThreadId: threadId,
    });
    return true;
  }
}

export const paneStore = new PaneStore();
export { MAX_LEAVES, MIN_RATIO };
