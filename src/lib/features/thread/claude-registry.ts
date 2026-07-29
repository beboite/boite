import type { LiveClaudeSession } from "$lib/backend/types";

/**
 * Reading a thread's turn out of claude's own session registry.
 *
 * Claude keeps `~/.claude/sessions/<pid>.json` for every session it has open and
 * rewrites `status` as each turn starts and ends: `busy` while one is in flight,
 * `idle` the moment it is not. That makes it the only signal Boite has that
 * states "finished" rather than merely stopping to say "still working".
 *
 * It is also the only one that survives a subagent. The Task tool runs one in
 * claude's own process, so a subagent gets no registry entry of its own and its
 * turns are appended to the parent's transcript with `isSidechain`, so the parent
 * simply stays `busy` for the whole run. From outside, that looks like a terminal
 * which has printed nothing for ten minutes, which is what the old detection
 * scored as finished and the auto-sleep timer then killed.
 *
 * Kept pure and free of the app graph so it can be tested directly, and mirrored
 * by `declared_turn` in `boite-core/src/session.rs`: the desktop and the server
 * read the same files and must not disagree about a thread.
 */

export type AgentTurn = "busy" | "idle";

/**
 * Mirrors `normalize` in `boite-core/src/session.rs`. Claude records a native
 * path; the thread's cwd reaches us however the project was added.
 */
function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

// Anything that is not a clean "idle" is a turn in flight. An unset or
// unrecognised status comes from a claude whose registry format we do not know,
// and calling that finished is the one wrong answer that loses work to auto-sleep.
function read(s: LiveClaudeSession): AgentTurn {
  return s.status === "idle" ? "idle" : "busy";
}

/**
 * Places a thread in the registry and reads its turn off it, or null when the
 * registry has nothing to say about it.
 *
 * By id when the thread has captured one: that is the precise question, and a
 * miss answers null rather than falling back to the directory. An id that is not
 * in the registry means claude is not holding that session (it exited, or it
 * predates the registry), and a neighbour's state must not stand in for it.
 *
 * By directory otherwise, and only when exactly one live session claims it. The
 * window before a session id is captured is a few seconds of the agent's opening
 * turn, which is routinely its longest, so leaving it unanswerable is how a fresh
 * thread gets called idle while a subagent works. Two sessions in one directory
 * answers null: with per-thread worktrees that does not normally happen, and
 * guessing between them would light or sleep the wrong thread.
 */
export function declaredTurn(
  sessions: LiveClaudeSession[],
  sessionId: string | null | undefined,
  cwd: string | null | undefined,
): AgentTurn | null {
  if (sessionId) {
    const hit = sessions.find((s) => s.id === sessionId);
    return hit ? read(hit) : null;
  }
  if (!cwd) return null;
  const want = normalizePath(cwd);
  const here = sessions.filter((s) => !!s.cwd && normalizePath(s.cwd) === want);
  return here.length === 1 ? read(here[0]) : null;
}
