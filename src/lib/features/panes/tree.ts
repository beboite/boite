import { threadIdOf } from "./types";
import type { LayoutNode, PaneContent, SplitDir } from "./types";

/**
 * The layout tree, as plain functions.
 *
 * Split out of the store so it can be tested: the store is a `.svelte.ts` full
 * of runes and cannot be imported by a plain node test, and this is the part
 * where a mistake silently loses a pane rather than throwing.
 *
 * Every function is pure and returns a new tree; nothing here mutates its input.
 */

/** Pane ids of every leaf under this node, in layout order. */
export function leavesOf(node: LayoutNode): string[] {
  if (node.kind === "leaf") return [node.paneId];
  const out: string[] = [];
  for (const c of node.children) out.push(...leavesOf(c));
  return out;
}

/** Every leaf under this node, contents included. */
export function leafNodesOf(
  node: LayoutNode,
): Extract<LayoutNode, { kind: "leaf" }>[] {
  if (node.kind === "leaf") return [node];
  const out: Extract<LayoutNode, { kind: "leaf" }>[] = [];
  for (const c of node.children) out.push(...leafNodesOf(c));
  return out;
}

/**
 * Thread ids under this node.
 *
 * Distinct from `leavesOf` now that a leaf need not be a thread: the callers
 * that ask "which terminals are on screen" — the status engine's visibility
 * sweep, the page's activation bookkeeping, Ctrl+Tab — mean this one, and
 * handing them the pane id of a git panel has them looking up a thread that
 * does not exist.
 */
export function threadLeavesOf(node: LayoutNode): string[] {
  return leafNodesOf(node)
    .map((l) => threadIdOf(l.content))
    .filter((id): id is string => id !== null);
}

export function countLeaves(node: LayoutNode): number {
  return leavesOf(node).length;
}

export function normalize(ratios: number[]): number[] {
  const sum = ratios.reduce((a, b) => a + b, 0);
  if (sum <= 0) return ratios.map(() => 1 / ratios.length);
  return ratios.map((r) => r / sum);
}

/**
 * The tree without `paneId`, or null when that was the only leaf.
 *
 * A split left with one child collapses into that child: without it the tree
 * would accumulate single-child splits, each one a splitter handle the user can
 * grab that moves nothing.
 */
export function pruneLeaf(node: LayoutNode, paneId: string): LayoutNode | null {
  if (node.kind === "leaf") {
    return node.paneId === paneId ? null : node;
  }
  const nextChildren: LayoutNode[] = [];
  const nextRatios: number[] = [];
  for (let i = 0; i < node.children.length; i++) {
    const child = pruneLeaf(node.children[i], paneId);
    if (child) {
      nextChildren.push(child);
      nextRatios.push(node.ratios[i]);
    }
  }
  if (nextChildren.length === 0) return null;
  if (nextChildren.length === 1) return nextChildren[0];
  return { ...node, children: nextChildren, ratios: normalize(nextRatios) };
}

export function findSplit(
  node: LayoutNode,
  splitId: string,
): Extract<LayoutNode, { kind: "split" }> | null {
  if (node.kind === "leaf") return null;
  if (node.id === splitId) return node;
  for (const c of node.children) {
    const r = findSplit(c, splitId);
    if (r) return r;
  }
  return null;
}

/**
 * Put `dragged` next to the leaf `targetId`, and give it `ratio` of that leaf's
 * share.
 *
 * `ratio` is of the target cell, not of the whole split: opening a 35% panel
 * beside one of three terminals must not resize the other two. Returns null
 * when the target is not in this tree, which is how the caller learns the drop
 * missed.
 */
export function injectSibling(
  node: LayoutNode,
  targetId: string,
  dragged: LayoutNode,
  dir: SplitDir,
  before: boolean,
  ratio: number,
  newSplitId: () => string,
): LayoutNode | null {
  if (node.kind === "leaf") {
    if (node.paneId !== targetId) return null;
    return {
      kind: "split",
      id: newSplitId(),
      dir,
      ratios: before ? [ratio, 1 - ratio] : [1 - ratio, ratio],
      children: before ? [dragged, node] : [node, dragged],
    };
  }

  for (let i = 0; i < node.children.length; i++) {
    const c = node.children[i];
    if (c.kind === "leaf" && c.paneId === targetId) {
      if (node.dir === dir) {
        const children = [...node.children];
        const ratios = [...node.ratios];
        const insertAt = before ? i : i + 1;
        const taken = ratios[i] * ratio;
        ratios[i] -= taken;
        ratios.splice(insertAt, 0, taken);
        children.splice(insertAt, 0, dragged);
        return { ...node, children, ratios: normalize(ratios) };
      }
      const wrapped: LayoutNode = {
        kind: "split",
        id: newSplitId(),
        dir,
        ratios: before ? [ratio, 1 - ratio] : [1 - ratio, ratio],
        children: before ? [dragged, c] : [c, dragged],
      };
      const children = [...node.children];
      children[i] = wrapped;
      return { ...node, children };
    }
    const next = injectSibling(
      c,
      targetId,
      dragged,
      dir,
      before,
      ratio,
      newSplitId,
    );
    if (next) {
      const children = [...node.children];
      children[i] = next;
      return { ...node, children };
    }
  }
  return null;
}

/** The leaf holding this content, if the tree already has one. */
export function findContent(
  node: LayoutNode,
  matches: (content: PaneContent) => boolean,
): Extract<LayoutNode, { kind: "leaf" }> | null {
  return leafNodesOf(node).find((l) => matches(l.content)) ?? null;
}
