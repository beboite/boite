import type { Backend, LiveClaudeSession } from "$lib/backend/types";
import { logger } from "$lib/shared/services/logger.svelte";
import { declaredTurn, type AgentTurn } from "./claude-registry";

/**
 * The polled view of claude's session registry.
 *
 * `claude-registry.ts` holds the reading of it; this holds the copy and how often
 * it is refreshed. Split because the decision is worth testing on its own and the
 * logger pulls the whole backend graph in behind it.
 */

// A directory of small json files plus a liveness check per entry. Cheap, but not
// free, and a turn boundary is not something the dot has to catch inside a frame:
// the status tick runs faster than this and reads the screen in between.
const POLL_MS = 1000;

let sessions: LiveClaudeSession[] = [];
let lastPollAt = 0;
let inFlight = false;
// Until the first answer lands, the registry cannot be read as "claude does not
// know this thread": doing so would demote a working thread for one poll interval
// on every launch.
let answered = false;

export const claudeTurn = {
  /**
   * What claude says about this thread's turn, or null when it says nothing.
   * `cwd` is only consulted while `sessionId` is still uncaptured.
   */
  stateOf(
    sessionId: string | null | undefined,
    cwd: string | null | undefined,
  ): AgentTurn | null {
    if (!answered) return null;
    return declaredTurn(sessions, sessionId, cwd);
  },

  /**
   * Refresh the registry, at most once per `POLL_MS`. Safe to call on every status
   * tick: it returns immediately when the last read is still fresh or one is
   * already in flight.
   *
   * `backend` is whichever backend derives status client-side, which is the local
   * one: the boite runs its own copy of this for the threads it owns.
   */
  poll(backend: Backend) {
    const now = Date.now();
    if (inFlight || now - lastPollAt < POLL_MS) return;
    lastPollAt = now;
    inFlight = true;
    void backend.session
      .liveClaude()
      .then((next) => {
        sessions = next;
        answered = true;
      })
      .catch((err) => {
        // Keep the last answer rather than dropping to "claude knows nothing": a
        // failed read is not evidence a turn ended.
        logger.debug("status", "claude session registry read failed", String(err));
      })
      .finally(() => {
        inFlight = false;
      });
  },
};
