import type {
  AgentTurn as DeclaredAgentTurn,
  AgentTurnQuery,
  Backend,
} from "$lib/backend/types";
import { logger } from "$lib/shared/services/logger.svelte";
import { declaredTurn, type AgentTurn } from "./agent-registry";

/**
 * The polled view of what the agents say they are doing.
 *
 * `agent-registry.ts` holds the reading of it; this holds the copy and how often
 * it is refreshed. Split because the decision is worth testing on its own and the
 * logger pulls the whole backend graph in behind it.
 */

// Claude's is a directory of small files, codex's is a SQLite index plus the tail
// of a transcript, opencode's is a SQLite query. Cheap for a handful of threads,
// not free, and a turn boundary is not something the dot has to catch inside a
// frame: the status tick runs faster than this and reads the screen in between.
export const POLL_MS = 1000;

/**
 * How long one read may hold the poll before another is allowed out.
 *
 * `inFlight` used to be cleared in `.finally()` alone, which assumes the promise
 * settles. A remote boite's rpc has no timeout of its own and an `invoke` can
 * hang, and either one latched the flag true for good: `turns` then kept its last
 * contents forever, every agent thread stayed frozen on whatever it had last
 * declared, and nothing said so. Generous next to POLL_MS because a slow read is
 * ordinary and a lost one is not.
 */
export const POLL_DEADLINE_MS = 15_000;

let turns: DeclaredAgentTurn[] = [];
let lastPollAt = 0;
let inFlight = false;
let inFlightSince = 0;
// Which read is the current one. A call that comes back after its deadline has
// passed is not allowed to publish its answer or to clear the flag its successor
// now owns: it is reporting on a poll nobody is waiting for any more.
let pollSeq = 0;
// Until the first answer lands, silence cannot be read as "no agent knows this
// thread": doing so would demote a working thread for one poll interval on every
// launch.
let answered = false;

export const agentTurns = {
  /**
   * What this thread's agent says about its turn, or null when it says nothing.
   * `cwd` is only consulted while `sessionId` is still uncaptured.
   */
  stateOf(
    kind: string,
    sessionId: string | null | undefined,
    cwd: string | null | undefined,
  ): AgentTurn | null {
    if (!answered) return null;
    return declaredTurn(turns, kind, sessionId, cwd);
  },

  /**
   * Refresh, at most once per `POLL_MS`. Safe to call on every status tick: it
   * returns immediately when the last read is still fresh or one is already in
   * flight and under its deadline.
   *
   * `queries` names the threads worth asking about, which is what keeps the cost
   * proportional to what is open rather than to every session these agents have
   * ever recorded. `backend` is whichever one derives status client-side, which is
   * the local one: the boite runs its own copy of this for the threads it owns.
   */
  poll(backend: Backend, queries: AgentTurnQuery[]) {
    const now = Date.now();
    if (inFlight) {
      if (now - inFlightSince < POLL_DEADLINE_MS) return;
      // Past the deadline the read is abandoned rather than waited on. It may
      // still settle, and it may never; either way this is the last that is heard
      // of it, and the status loop gets to ask again.
      logger.debug(
        "status",
        `agent turn read gave no answer in ${POLL_DEADLINE_MS}ms, asking again`,
      );
    }
    if (now - lastPollAt < POLL_MS) return;
    lastPollAt = now;
    if (queries.length === 0) {
      turns = [];
      answered = true;
      return;
    }
    inFlight = true;
    inFlightSince = now;
    const seq = ++pollSeq;
    void backend.session
      .agentTurns(queries)
      .then((next) => {
        if (seq !== pollSeq) return;
        turns = next;
        answered = true;
      })
      .catch((err) => {
        // Keep the last answer rather than dropping to "nobody knows anything":
        // a failed read is not evidence a turn ended.
        logger.debug("status", "agent turn read failed", String(err));
      })
      .finally(() => {
        if (seq === pollSeq) inFlight = false;
      });
  },
};
