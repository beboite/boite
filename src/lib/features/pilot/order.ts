/**
 * The order a timeline reads in, which is not the order the journal minted.
 *
 * A turn's row is written by `turn.started`, so its sequence is the *first* of
 * the turn: left where the journal put it, the footer saying what a turn cost
 * and what it changed is drawn above the answer it is about. That was visible
 * on the first run of the pane and is what this fixes.
 *
 * The rule is one line: a turn row sits after the last item that names it.
 * Everything else keeps the journal's order, which is the order things
 * happened, so a card never moves once it has been drawn.
 */

import type { PilotItemRow } from "./types";

/**
 * The rows in reading order.
 *
 * Stable by construction rather than by a sort: the items are walked once in
 * journal order and a turn row is emitted when its last item has gone past.
 * A turn nothing names yet, one still running with no output, comes out where
 * it was, which is what draws the "running" line under a prompt that has just
 * been sent.
 */
export function readingOrder(items: readonly PilotItemRow[]): PilotItemRow[] {
  const turns = new Map<string, PilotItemRow>();
  /** The last position, in this array, of an item belonging to each turn. */
  const lastOf = new Map<string, number>();

  for (const row of items) {
    if (row.kind === "turn") {
      const turnId = turnIdOf(row);
      if (turnId) turns.set(turnId, row);
      continue;
    }
    if (row.turnId) lastOf.set(row.turnId, 0);
  }
  if (turns.size === 0) return [...items];

  // Second pass for the positions, now that the turn rows are known and are not
  // counted as members of their own turn.
  let index = 0;
  for (const row of items) {
    if (row.kind === "turn") continue;
    if (row.turnId && turns.has(row.turnId)) lastOf.set(row.turnId, index);
    index += 1;
  }

  const body = items.filter((row) => row.kind !== "turn");
  const out: PilotItemRow[] = [];
  const emitted = new Set<string>();
  for (let at = 0; at < body.length; at++) {
    out.push(body[at]);
    for (const [turnId, last] of lastOf) {
      if (last !== at || emitted.has(turnId)) continue;
      const turn = turns.get(turnId);
      if (turn) {
        out.push(turn);
        emitted.add(turnId);
      }
    }
  }
  // A turn with nothing under it yet, in the order the journal minted it.
  for (const [turnId, turn] of turns) {
    if (!emitted.has(turnId)) out.push(turn);
  }
  return out;
}

function turnIdOf(row: PilotItemRow): string | null {
  if (row.turnId) return row.turnId;
  const fromBody = row.body?.turnId;
  return typeof fromBody === "string" ? fromBody : null;
}
