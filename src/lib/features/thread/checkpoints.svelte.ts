import { app } from "$lib/app/store.svelte";
import { backendForPath } from "$lib/backend";
import type { Backend } from "$lib/backend";
import { logger } from "$lib/shared/services/logger.svelte";
import type { AgentTurn } from "./agent-registry";
import { threadGitRoot } from "./cwd";
import { turnEdge } from "./turns";
import type { Thread } from "$lib/types";

/**
 * Who takes the checkpoint, and why it is this side and not Rust.
 *
 * Whatever already computes the turn boundary on a host is what drives the
 * capture there, because neither host has a second one: the status engine here,
 * `registry.rs` on a server that has no window. A Rust ticker on the desktop
 * would be a new repeating timer with no measurement behind it, and driving both
 * from the frontend would lose every turn a server ran with nothing attached to
 * it. So the capture is a bus capability and this file is one of its two
 * callers.
 */

/** Whether a turn is open, per thread. Not durable: a reload starts a new one. */
const openTurns = new Map<string, boolean>();

/**
 * Serialised per thread. Two captures at once would both read the same last
 * index off the refs and the second would overwrite the first.
 */
const inFlight = new Map<string, Promise<unknown>>();

/**
 * Bumped when a thread's checkpoints change, so a list on screen can re-read.
 *
 * Per thread rather than one counter for all of them: a card open on one thread
 * has no reason to re-fetch because another one finished a turn. Single-key
 * writes, never a spread, or every consumer of the record invalidates.
 */
const versions = $state<Record<string, number>>({});

export function checkpointVersion(threadId: string): number {
  return versions[threadId] ?? 0;
}

/**
 * Records what the agent says about its turn, and checkpoints the two ends.
 *
 * A capture never blocks a turn: it is fired and not awaited, and a failure is
 * logged and dropped. The flag moves whether or not the capture works, because a
 * capture that failed at the start of a turn must not leave the next `idle`
 * looking like the end of a turn nobody opened.
 */
export function noteDeclaredTurn(
  thread: Thread,
  backend: Backend,
  declared: AgentTurn["state"] | null | undefined,
) {
  const edge = turnEdge(openTurns.get(thread.id) ?? false, declared);
  if (!edge) return;
  openTurns.set(thread.id, edge === "start");
  const repo = threadGitRoot(thread, app.projectById(thread.projectId));
  if (!repo) return;
  const chain = inFlight.get(thread.id) ?? Promise.resolve();
  const next = chain
    .then(() => backend.checkpoints.capture(repo, thread.id, edge))
    .then((taken) => {
      if (taken) versions[thread.id] = (versions[thread.id] ?? 0) + 1;
    })
    .catch((err) => {
      logger.warn("checkpoint", `${thread.label}: ${edge} checkpoint failed`, String(err));
    });
  inFlight.set(thread.id, next);
}

/** Drops a closed thread's bookkeeping. Its refs are dropped separately. */
export function forgetThreadTurns(threadId: string) {
  openTurns.delete(threadId);
  inFlight.delete(threadId);
  delete versions[threadId];
}

/**
 * Drops every checkpoint a deleted thread left in its repository.
 *
 * Best effort on purpose: a thread is being removed either way, and refusing to
 * remove it because its refs could not be reached would leave a row nothing can
 * get rid of.
 */
export async function dropThreadCheckpoints(thread: Thread) {
  forgetThreadTurns(thread.id);
  const repo = threadGitRoot(thread, app.projectById(thread.projectId));
  if (!repo) return;
  try {
    await backendForPath(repo).checkpoints.forget(repo, thread.id);
  } catch (err) {
    logger.warn("checkpoint", `${thread.label}: could not drop checkpoints`, String(err));
  }
}
