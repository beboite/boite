import type { AgentTurn as DeclaredAgentTurn } from "$lib/backend/types";

/**
 * Reading a thread's turn out of what its own agent says about itself.
 *
 * Three of them say something, and they say it in three different places:
 *
 * - claude keeps `~/.claude/sessions/<pid>.json` per open session and rewrites
 *   `status` as each of its four states begins and ends. It is the only one that
 *   distinguishes a turn blocked on the user from a finished one.
 * - codex leaves no live file at all. Its status model exists but is pushed over
 *   JSON-RPC to whoever spawned the process, so a terminal a human started
 *   exposes nothing. What is on disk is the rollout transcript, which brackets
 *   every turn with `task_started` and closes it with `task_complete` or
 *   `turn_aborted`.
 * - opencode exposes `GET /session/status`, but a plain TUI binds no port, so the
 *   database is what is left: an assistant message gains `time.completed` when
 *   its turn ends and does not carry the field before that.
 *
 * The reading of each is in `boite-core/src/session.rs`; by the time it reaches
 * here it is one shape. What makes any of it worth having is that all three are
 * two-sided: they state that a turn finished rather than merely stopping to say
 * it continues, so a thread can be demoted on positive evidence.
 *
 * It also survives a subagent, which is what nothing else does. Claude runs one
 * in its own process (no entry of its own, the parent just stays `busy`), codex
 * keeps the turn open across `sub_agent_activity`, and opencode gives the child
 * its own session while the parent's assistant message stays incomplete. From
 * outside, all three look like a terminal that has printed nothing for ten
 * minutes, which is what used to score as finished and get the PTY killed.
 *
 * Kept pure and free of the app graph so it can be tested directly, and mirrored
 * by `declared_turn` in `boite-core/src/session.rs`: the desktop and the server
 * read the same stores and must not disagree about a thread.
 */

/**
 * The states an agent can declare, plus what it is waiting for when it named one.
 *
 * Kept as four rather than collapsed to working/not-working because two of them
 * mean "leave this thread alone" for different reasons. `waiting` needs the user
 * and `shell` has a command still running, and neither is a finished turn even
 * though neither is the agent thinking. Only claude ever says those two.
 */
export type AgentTurn = {
  state: "busy" | "waiting" | "shell" | "idle";
  /** Claude's own label for what it is blocked on. Only set with `waiting`. */
  waitingFor?: string | null;
};

/** Whether the thread is mid-something: not a finished turn. */
export function turnIsActive(turn: AgentTurn): boolean {
  return turn.state !== "idle";
}

/**
 * Mirrors `normalize` in `boite-core/src/session.rs`. The agents record a native
 * path; the thread's cwd reaches us however the project was added.
 */
function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function read(t: DeclaredAgentTurn): AgentTurn {
  switch (t.state) {
    case "idle":
      return { state: "idle" };
    case "waiting":
      return { state: "waiting", waitingFor: t.waitingFor ?? null };
    case "shell":
      return { state: "shell" };
    // `busy`, and anything else. An unset or unrecognised state comes from an
    // agent whose format we do not know, and calling that finished is the one
    // wrong answer that loses work to auto-sleep.
    default:
      return { state: "busy" };
  }
}

/**
 * Places a thread among what the agents said, and reads its turn off that, or
 * null when nothing there covers it.
 *
 * By id when the thread has captured one: that is the precise question, and a
 * miss answers null rather than falling back to the directory. An id that is not
 * there means the agent is not holding that session (it exited, or it predates
 * whatever records this), and a neighbour's state must not stand in for it.
 *
 * By directory otherwise, and only when exactly one session claims it. The window
 * before a session id is captured is a few seconds of the agent's opening turn,
 * which is routinely its longest, so leaving it unanswerable is how a fresh
 * thread gets called idle while a subagent works. Two sessions in one directory
 * answers null: with per-thread worktrees that does not normally happen, and
 * guessing between them would light or sleep the wrong thread.
 *
 * `kind` scopes the search before any of that. Two agents in one directory is
 * ordinary, and a codex thread has no business being handed a claude answer.
 */
export function declaredTurn(
  turns: DeclaredAgentTurn[],
  kind: string,
  sessionId: string | null | undefined,
  cwd: string | null | undefined,
): AgentTurn | null {
  const mine = turns.filter((t) => t.kind === kind);
  if (sessionId) {
    const hit = mine.find((t) => t.sessionId === sessionId);
    return hit ? read(hit) : null;
  }
  if (!cwd) return null;
  const want = normalizePath(cwd);
  const here = mine.filter((t) => !!t.cwd && normalizePath(t.cwd) === want);
  return here.length === 1 ? read(here[0]) : null;
}
