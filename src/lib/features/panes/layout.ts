/**
 * The saved-layout blob, kept out of the store.
 *
 * The store declares runes at module scope, so importing it from a plain vitest
 * file evaluates `$state` outside a Svelte compile context and throws. The part
 * worth testing is exactly the part that has to survive untrusted input, so it
 * lives here instead. The tree walk it needs comes from `tree.ts`: a second copy
 * of `leavesOf` here is how this file came to validate a leaf shape the rest of
 * the app had already stopped writing.
 */
import type { LayoutNode, PaneContent, PaneGroup } from "./types";
import { leavesOf } from "./tree";

/**
 * Where a split layout survives a restart.
 *
 * Threads are restored from SQLite, but the tree that arranged them was memory
 * only: every split, and every ratio a user had dragged, was rebuilt by
 * syncWithThreads as one leaf per thread. Device-scoped, like the sidebar width
 * and the zoom, because a layout describes this screen rather than the workspace.
 */
const PANES_KEY = "boite.panes";

/**
 * One key per workspace this device has arranged, rather than one key for all
 * of them.
 *
 * A layout is device-scoped but its groups name projects, and project ids only
 * mean anything in the database they came from. Under a single key, machine A's
 * tree was re-hydrated onto machine B and `syncWithThreads` did not catch it:
 * it prunes thread panes, and a panel-only group has zero thread leaves, so it
 * survived with A's `projectId` and drew a git panel for a repository that is
 * not there. The alternative was deleting the blob on every switch, which made
 * every machine lose its arrangement to keep them from mixing.
 *
 * The mode is in the key as well as the boite, because dynamic shows a superset
 * of what remote shows against the same boite: a dynamic layout restored into a
 * pure remote workspace carries local groups the workspace does not have.
 */
export function panesKey(
  mode: "local" | "remote" | "dynamic",
  boiteId: string | null,
): string {
  if (mode === "local" || !boiteId) return PANES_KEY;
  return `${PANES_KEY}:${mode}:${boiteId}`;
}

/** Drops every layout this device kept for a boite it no longer knows. */
export function forgetPanesOf(boiteId: string): void {
  if (typeof localStorage === "undefined") return;
  for (const mode of ["remote", "dynamic"] as const) {
    try {
      localStorage.removeItem(panesKey(mode, boiteId));
    } catch {
      // A layout is not worth failing a removal over.
    }
  }
}

/**
 * A pane's content, one arm of the union at a time.
 *
 * Checking only `typeof kind === "string"` would let a browser pane through with
 * no url and a thread pane with no thread, and both crash the renderer the
 * moment the pane draws — after hydration has already replaced the layout, so
 * there is nothing left to fall back to.
 */
function isPaneContent(value: unknown): value is PaneContent {
  if (!value || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  switch (c.kind) {
    case "thread":
      return typeof c.threadId === "string";
    case "browser":
      return typeof c.url === "string";
    case "dashboard":
    case "git":
    case "explorer":
    case "todo":
    case "editor":
      return true;
    default:
      return false;
  }
}

// Nothing outside this module writes the blob, but localStorage is user-editable
// and a shape from an older build has to be survivable. Anything that does not
// validate is dropped, and syncWithThreads then rebuilds the missing groups.
function isLayoutNode(value: unknown, depth = 0): value is LayoutNode {
  if (depth > 8 || !value || typeof value !== "object") return false;
  const node = value as Record<string, unknown>;
  if (node.kind === "leaf") {
    if (typeof node.paneId !== "string") return false;
    if (!isPaneContent(node.content)) return false;
    // A thread pane IS its thread, per `PaneContent`. A blob that disagrees
    // makes groupOf miss the thread, and syncWithThreads then hands it a second
    // group — the same terminal on screen twice.
    const content = node.content as PaneContent;
    return content.kind !== "thread" || content.threadId === node.paneId;
  }
  if (node.kind !== "split") return false;
  if (typeof node.id !== "string") return false;
  if (node.dir !== "row" && node.dir !== "column") return false;
  if (!Array.isArray(node.children) || node.children.length < 2) return false;
  if (!Array.isArray(node.ratios) || node.ratios.length !== node.children.length) {
    return false;
  }
  // A zero or negative ratio collapses a pane with no way to drag it back.
  if (!node.ratios.every((r) => typeof r === "number" && Number.isFinite(r) && r > 0)) {
    return false;
  }
  return node.children.every((c) => isLayoutNode(c, depth + 1));
}

export function isPaneGroup(value: unknown): value is PaneGroup {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const g = value as Record<string, unknown>;
  if (typeof g.id !== "string" || typeof g.projectId !== "string") return false;
  if (typeof g.focusedPaneId !== "string") return false;
  if (!isLayoutNode(g.root)) return false;
  // A group whose focus is not one of its own leaves would render nothing.
  return leavesOf(g.root as LayoutNode).includes(g.focusedPaneId);
}

export function loadSavedGroups(key: string): PaneGroup[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isPaneGroup);
  } catch {
    return [];
  }
}
