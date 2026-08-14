import type { Checkpoint } from "$lib/backend/types";
import type { AgentTurn } from "./agent-registry";

/**
 * Which end of a turn just happened, if either.
 *
 * `open` is a flag rather than the previous state, and that is the whole
 * decision: `busy → waiting → busy` is one turn with a permission prompt in the
 * middle, and reading it off the previous state alone would call the second
 * `busy` a new turn and cut the checkpoint pair in half. Only `busy` opens one
 * and only `idle` closes one, so `shell` — the agent taking input again while a
 * command it launched runs on — is not an end either.
 *
 * The mirror of `turn_edge` in `boite-server/src/registry.rs`, which is the same
 * decision for the host that has no window.
 */
export function turnEdge(
  open: boolean,
  declared: AgentTurn["state"] | null | undefined,
): "start" | "end" | null {
  if (declared === "busy") return open ? null : "start";
  if (declared === "idle") return open ? "end" : null;
  return null;
}

/** One agent turn, as the pair of checkpoints that bracket it. */
export interface Turn {
  /** The closing checkpoint's index, which is unique for the life of a thread. */
  id: number;
  startSha: string;
  endSha: string;
  startedAt: number;
  endedAt: number;
  files: number;
  additions: number;
  deletions: number;
}

/**
 * The turns in a thread's checkpoint list, oldest first.
 *
 * A start with no end is a turn still running, or one whose closing capture
 * failed, and either way there is no diff to show: it is dropped rather than
 * paired with the next turn's end, which would report one turn's work as
 * another's. A second start replaces the first for the same reason.
 */
export function pairTurns(checkpoints: Checkpoint[]): Turn[] {
  const turns: Turn[] = [];
  let open: Checkpoint | null = null;
  for (const cp of checkpoints) {
    if (cp.edge === "start") {
      open = cp;
      continue;
    }
    // A `restore` is the net a revert took of the tree it overwrote. It is not
    // the end of anything the agent did, so it neither becomes a row of its own
    // nor closes a turn that was still open when the user reverted.
    if (cp.edge !== "end") continue;
    if (!open) continue;
    turns.push({
      id: cp.index,
      startSha: open.sha,
      endSha: cp.sha,
      startedAt: open.at,
      endedAt: cp.at,
      files: cp.files,
      additions: cp.additions,
      deletions: cp.deletions,
    });
    open = null;
  }
  return turns;
}
