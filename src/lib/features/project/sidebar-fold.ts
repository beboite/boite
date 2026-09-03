/**
 * How many rows a project shows before the rest go behind a "show more".
 *
 * A project with 24 threads made the sidebar 24 rows tall, and three of those
 * made it 72: the list stopped being a place to find anything and became a
 * scroll. Ten is what a 240px column shows without one on a laptop.
 *
 * The cut is not a scroll box per project. A box inside a scroll pane is two
 * scrollbars for one gesture, and the rows below the cut are the ones nobody
 * has touched in days — they are worth a click, not a viewport.
 */
export const FOLD_LIMIT = 10;

/** What the fold needs off a row: its depth in the delegation tree. */
export interface FoldableRow {
  depth: number;
}

export interface FoldResult<R> {
  /** The rows to draw, in the order they came in. */
  rows: R[];
  /** How many rows the fold is holding back. Zero when nothing is folded. */
  hidden: number;
}

/**
 * A parent and the delegation rows drawn under it, as one unit.
 *
 * The fold cuts blocks rather than rows because `visibleDelegationRows` emits a
 * tree flattened into a list: cutting between a parent and its opened children
 * would leave an indented row under nothing, which reads as a bug rather than
 * as a fold. Rows before the first depth-0 row (a cycle in the parent links, or
 * a child whose parent the filter removed) join the first block instead of
 * being dropped.
 */
function toBlocks<R extends FoldableRow>(rows: readonly R[]): R[][] {
  const blocks: R[][] = [];
  for (const row of rows) {
    if (row.depth === 0 || blocks.length === 0) blocks.push([row]);
    else blocks[blocks.length - 1].push(row);
  }
  return blocks;
}

/**
 * The first ten rows of a project, with live work pulled up into them.
 *
 * `pinned` says a row must be on screen whatever its position: running,
 * waiting, or the thread the user is looking at. Those take their slots first
 * and the earliest of the rest fill what is left, so a fold never hides an
 * agent that is doing something and never hides the selected row either. When
 * more than `limit` rows are pinned they are all drawn: the cap is a tidiness
 * rule and live work outranks it.
 *
 * Pure and index-free on purpose: the caller keeps the unfolded index for the
 * Ctrl+digit hint, so folding a row never renumbers the ones above it.
 */
export function foldRows<R extends FoldableRow>(
  rows: readonly R[],
  pinned: (row: R) => boolean,
  expanded: boolean,
  limit: number = FOLD_LIMIT,
): FoldResult<R> {
  if (expanded || rows.length <= limit) return { rows: [...rows], hidden: 0 };

  const blocks = toBlocks(rows);
  const chosen = new Set<number>();
  let count = 0;
  for (let i = 0; i < blocks.length; i += 1) {
    if (!blocks[i].some(pinned)) continue;
    chosen.add(i);
    count += blocks[i].length;
  }
  // Stops at the first block that would overflow rather than skipping it for a
  // smaller one further down: a list that reorders itself to fill the last slot
  // is a list whose top ten changes for reasons nobody can see.
  for (let i = 0; i < blocks.length && count < limit; i += 1) {
    if (chosen.has(i)) continue;
    if (count + blocks[i].length > limit) break;
    chosen.add(i);
    count += blocks[i].length;
  }

  const kept: R[] = [];
  for (let i = 0; i < blocks.length; i += 1) {
    if (chosen.has(i)) kept.push(...blocks[i]);
  }
  return { rows: kept, hidden: rows.length - kept.length };
}
