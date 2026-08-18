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
// of a transcript, opencode's is a SQLite query, grok's is the tail of one
// updates.jsonl. Cheap for a handful of threads,
// not free, and a turn boundary is not something the dot has to catch inside a
// frame: the status tick runs faster than this and reads the screen in between.
export const POLL_MS = 1000;

/**
 * The same read, while nobody is looking at the window.
 *
 * "Not free" now has a number on it. `crates/boite-core/benches/hot_paths.rs`
 * measures `session::agent_turns` at **10.1 ms for three agent kinds**, against
 * 95 µs for claude alone: codex opens a SQLite database and then reads a
 * rollout, opencode opens one of its own. At `POLL_MS` that is ten milliseconds
 * of blocking work every second, for as long as the app is open, and this app
 * sits in the background for hours.
 *
 * Slowed rather than stopped, which is the whole distinction. The status sweep
 * cannot pause while hidden — the threads it demotes are precisely the ones
 * nobody is looking at, and a notification is a transition it has to be awake to
 * see. What a hidden window does not need is the *sampling rate*: nobody is
 * watching a dot they cannot see. So the cost drops by four fifths and the only
 * thing given up is up to four extra seconds before a background notification,
 * which is not a delay anybody can perceive against a turn that took minutes.
 *
 * Coming back is immediate: {@link agentTurns.wake} drops the throttle so the
 * first tick after the window is looked at again reads for real.
 */
export const POLL_MS_HIDDEN = 5000;

/**
 * How long to wait before the next read.
 *
 * `document.hidden` covers minimised, another desktop, another tab and a
 * screen that has locked. Guarded for the environments with no document at all:
 * this module is plain TypeScript and its tests import it directly.
 */
function pollInterval(): number {
  const hidden = typeof document !== "undefined" && document.hidden;
  return hidden ? POLL_MS_HIDDEN : POLL_MS;
}

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
  /**
   * Drops the throttle, so the next tick reads rather than waiting out the rest
   * of an interval.
   *
   * Called when the window is looked at again. Without it the backoff would be
   * visible exactly where it must not be: a user coming back to a workspace
   * would watch a stale dot for up to {@link POLL_MS_HIDDEN}, which is the one
   * moment they are actually reading it.
   */
  wake() {
    lastPollAt = 0;
  },

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
    if (now - lastPollAt < pollInterval()) return;
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
