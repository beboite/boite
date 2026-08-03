/**
 * What dragging a row in the sidebar decides, with nothing that touches the DOM.
 *
 * `ProjectSidebar.svelte` was 1510 lines, and about four hundred of them were
 * this: the geometry of where a card would land, the arithmetic that slides the
 * other rows out of its way, and the rule for which of three completely
 * different things a drop means. Every one of those was reachable only through a
 * mounted sidebar with a live pointer sequence over it, which is why none of
 * them had a test.
 *
 * The split is the same one `features/terminal/launch.ts` made: the decisions
 * come out, the effects stay. What is left in the component reads elements,
 * writes stores and sequences listeners, which is a component's job and does not
 * get better for being moved somewhere else.
 */

/** A sibling row as it was measured when the drag started. */
export interface RowSnapshot {
  id: string;
  top: number;
  height: number;
}

/** Which edge of a pane a thread would be dropped against. */
export type DropSide = "left" | "right" | "top" | "bottom";

/**
 * How far a pointer travels before a press becomes a drag.
 *
 * A press that never crosses it is a click, and the sidebar has plenty of those
 * — selecting a project, activating a thread, hitting a menu button. Capturing
 * the pointer is deferred past this for the same reason: a captured pointer
 * retargets the click that follows, so capturing on pointerdown meant a plain
 * click never reached the row's own handler.
 */
export const DRAG_THRESHOLD_PX = 5;

export function hasBecomeADrag(
  from: { x: number; y: number },
  to: { x: number; y: number },
): boolean {
  return Math.hypot(to.x - from.x, to.y - from.y) >= DRAG_THRESHOLD_PX;
}

/**
 * Where the dragged row would be inserted, counting the list without it.
 *
 * Walked against each remaining row's midpoint. The dragged row is removed from
 * the list first, so the index is one into the list as it will be after the
 * move, which is what the caller then splices into.
 *
 * `null` when there is nothing to decide: an empty list, or a list the dragged
 * row is not in, which is what a stale snapshot looks like.
 */
export function slotIndexAt(
  siblings: readonly RowSnapshot[],
  draggedId: string,
  y: number,
): number | null {
  if (siblings.length === 0) return null;
  const sourceIdx = siblings.findIndex((s) => s.id === draggedId);
  if (sourceIdx < 0) return null;
  const reduced = siblings.filter((_, i) => i !== sourceIdx);
  if (reduced.length === 0) return 0;
  for (let i = 0; i < reduced.length; i++) {
    if (y < reduced[i].top + reduced[i].height / 2) return i;
  }
  return reduced.length;
}

/**
 * How far a row slides while another is being carried over it.
 *
 * The list is never reordered during the drag; the rows are translated, so
 * letting go in the middle of the animation cannot leave the order half
 * applied. Two independent parts: everything below the source has already
 * closed the gap the source left behind, and everything at or after the slot
 * has to open one for it.
 */
export function rowShift(
  idx: number,
  sourceIdx: number,
  slot: number,
  height: number,
): number {
  if (idx === sourceIdx) return 0;
  const effective = idx < sourceIdx ? idx : idx - 1;
  const closedGap = idx > sourceIdx ? -height : 0;
  const openedGap = effective >= slot ? height : 0;
  return closedGap + openedGap;
}

/**
 * Which edge of a pane the pointer is nearest, in the pane's own coordinates.
 *
 * Nearest edge rather than nearest quadrant: a wide short pane is split
 * vertically for most of its area, which is what somebody dragging into it
 * means. The comparison is on the *fraction* of each axis for that reason — raw
 * pixel distance would make every pane behave like a square.
 */
export function sideFromRect(
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

/** What the pointer is currently over, as the component read it off the DOM. */
export interface HoverFacts {
  /** Inside the sidebar at all. Outside it, a thread is being taken to a pane. */
  inSidebar: boolean;
  /** Over the dragged thread's own project's thread list. */
  overOwnList: boolean;
  /** Over the dragged thread's own project's header row. */
  overOwnHeader: boolean;
  /** The project row or thread list under the pointer, whichever came first. */
  overProjectId: string | null;
  /** Whether that project is one the sidebar is actually showing. */
  isLiveProject: (projectId: string) => boolean;
}

/**
 * What letting go here would mean.
 *
 * Three outcomes and they are mutually exclusive, which is the part worth having
 * in one place: `reorder` moves the thread within its own project, `give` hands
 * it to another one, and `none` leaves it to whatever the pane viewport decided.
 *
 * The archived-project rule lives here. Archived rows are only on screen while
 * the archive list is open, and dropping a live thread onto one would move it
 * into a project the user has put away — so a project the sidebar is not
 * showing is not a target, rather than being a target that then looks broken.
 */
export type DropIntent =
  | { kind: "reorder" }
  | { kind: "give"; projectId: string }
  | { kind: "none" };

export function dropIntent(ownProjectId: string, facts: HoverFacts): DropIntent {
  if (!facts.inSidebar) return { kind: "none" };
  if (facts.overOwnList || facts.overOwnHeader) return { kind: "reorder" };
  const target = facts.overProjectId;
  if (target && target !== ownProjectId && facts.isLiveProject(target)) {
    return { kind: "give", projectId: target };
  }
  return { kind: "none" };
}

/**
 * The list after the dragged id has been moved to `slot`.
 *
 * Shared by the project reorder and the thread reorder, which had a copy each.
 * Returns `null` when the id is not in the list, because a caller that then
 * saved the order would write a list with the dragged row silently dropped out
 * of it.
 */
export function reordered(
  ids: readonly string[],
  draggedId: string,
  slot: number,
): string[] | null {
  const from = ids.indexOf(draggedId);
  if (from < 0) return null;
  const next = ids.slice();
  next.splice(from, 1);
  next.splice(Math.min(slot, next.length), 0, draggedId);
  return next;
}
