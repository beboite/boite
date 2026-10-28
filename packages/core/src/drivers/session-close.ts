import type { SpawnedChild } from '../procs.ts';

/** What closing a warm session asks of the turn it is running. */
export interface ClosingTurn {
  readonly isStopped: boolean;
  /** Ends the turn stopped; an error it already has stands. */
  endStopped(): void;
  fail(reason: string, diagnostic?: string): void;
}

/**
 * The close contract every warm session keeps: a turn still in flight ends
 * here, stopped when the user stopped it and failed otherwise, while the
 * journal is still open. Once the session lets go of its transport nothing
 * else can end that turn, since the child's late close or exit is ignored.
 */
export function endOnClose(turn: ClosingTurn | null, reason: string): void {
  if (turn === null) return;
  if (turn.isStopped) turn.endStopped();
  else turn.fail(reason);
}

/** The pipes go, then the process or its whole tree; a child already gone is not an error. */
export function releaseChild(child: SpawnedChild | null, killTree: (() => void) | null = null): void {
  if (child === null) return;
  try {
    child.stdin.end();
  } catch {
    // the pipe is already gone
  }
  try {
    if (killTree !== null) killTree();
    else child.kill();
  } catch {
    // already exited
  }
}
