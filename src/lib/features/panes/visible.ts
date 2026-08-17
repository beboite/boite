/**
 * Whether a pane is one the user can actually see.
 *
 * **Every group is mounted at once.** The page draws them all and hides the
 * ones that are not the active thread's, which is what keeps a terminal alive
 * while the user reads another and what lets a browser pane an agent opened
 * finish loading, keep its driver attached and answer questions while the
 * window is showing something else entirely. It also means "the pane exists"
 * and "the pane is on the screen" are two different questions, and the layout
 * tree answers neither: a hidden group's leaves are laid out at the same
 * rectangles as the visible one's.
 *
 * So the page marks its groups and this reads the mark. Two callers: the
 * window's description of itself, which would otherwise report a pane nobody
 * can see as visible, and the screenshot, which photographs a rectangle of the
 * window and would otherwise hand back whatever is drawn over the pane.
 */

/** What the page puts on each group wrapper, and what it puts there. */
export const GROUP_ATTRIBUTE = "data-pane-group";
export const SHOWN_ATTRIBUTE = "data-pane-shown";

/** For a caller that already has the leaf element in hand. */
export function shownIn(el: Element | null | undefined): boolean {
  return el?.closest(`[${GROUP_ATTRIBUTE}]`)?.getAttribute(SHOWN_ATTRIBUTE) === "true";
}

/**
 * For a caller that has a pane id and no element.
 *
 * A pane that is not in the DOM at all reads as not shown, which is the honest
 * answer for the one moment it happens: the tree has just gained a leaf and the
 * page has not drawn it yet.
 */
export function paneIsShown(paneId: string): boolean {
  if (typeof document === "undefined") return false;
  return shownIn(document.querySelector(`[data-pane-leaf="${CSS.escape(paneId)}"]`));
}
