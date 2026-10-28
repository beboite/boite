import type { Database } from 'bun:sqlite';
import type { Turn } from '@boite/contracts';
import { parseJson, toTurn, type TurnRow } from './rows.ts';
import { usageGroups, type UsageGroup } from './usage-sums.ts';

export function writeTurn(db: Database, turn: Turn): void {
  db.query(
    `INSERT OR REPLACE INTO turns (id, thread_id, status, queued_at, started_at, finished_at, usage, error, execution, checkpoint, queue_hold, agent_totals, quiet)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    turn.id,
    turn.threadId,
    turn.status,
    turn.queuedAt,
    turn.startedAt,
    turn.finishedAt,
    turn.usage === null ? null : JSON.stringify(turn.usage),
    turn.error,
    turn.execution === undefined ? null : JSON.stringify(turn.execution),
    turn.checkpoint ? JSON.stringify(turn.checkpoint) : null,
    turn.queueHold ? JSON.stringify(turn.queueHold) : null,
    turn.agentTotals ? JSON.stringify(turn.agentTotals) : null,
    turn.quiet ? 1 : 0,
  );
}

/**
 * One turn of a thread picked in SQL, so a thread with thousands of turns
 * reads one row, not its history. Newest first by rowid, which is what
 * `listTurns(threadId)` ends with; `queued` takes the oldest.
 */
const ONE_TURN = {
  running: "SELECT * FROM turns WHERE thread_id = ? AND status = 'running' ORDER BY rowid DESC LIMIT 1",
  last: 'SELECT * FROM turns WHERE thread_id = ? ORDER BY rowid DESC LIMIT 1',
  ended: "SELECT * FROM turns WHERE thread_id = ? AND status NOT IN ('queued', 'running') ORDER BY rowid DESC LIMIT 1",
  queued: "SELECT * FROM turns WHERE thread_id = ? AND status = 'queued' AND json_extract(execution, '$.operation') = ? ORDER BY rowid LIMIT 1",
} as const;

export function oneTurn(db: Database, which: keyof typeof ONE_TURN, ...params: string[]): Turn | null {
  const row = db.query(ONE_TURN[which]).get(...params) as TurnRow | null;
  return row === null ? null : toTurn(row);
}

/**
 * What one agent session already used, for an agent that restores its own
 * totals on resume: the last `agentTotals` a turn of the thread in session
 * generation `generation` recorded, except `exceptTurnId`. The agent starts
 * from those, which can be less than the sum of the session's turns: a process
 * that started from zero left the earlier ones out. Turns recorded before
 * those totals fall back to that sum: `groups`, which `usage.ts` reads. A
 * turn with no recorded generation counts in none.
 */
export function sumSessionUsage(db: Database, threadId: string, generation: number, exceptTurnId: string): SessionUsage {
  const reported = db.query(`SELECT id, agent_totals FROM turns WHERE thread_id = ? AND id <> ? AND agent_totals IS NOT NULL
    AND json_extract(execution, '$.sessionGeneration') = ? ORDER BY rowid DESC LIMIT 1`)
    .get(threadId, exceptTurnId, generation) as { id: string; agent_totals: string } | null;
  if (reported !== null) return { reported: parseJson<{ costUsd: number; tokens: number }>(reported.agent_totals, `turns.agent_totals of ${reported.id}`), groups: [] };
  return { reported: null, groups: usageGroups(db, { where: "t.thread_id = ? AND t.id <> ? AND json_extract(t.execution, '$.sessionGeneration') = ?" }, threadId, exceptTurnId, generation) };
}

/** An agent session's last reported totals, or the groups of its turns to sum. */
export interface SessionUsage {
  reported: { costUsd: number; tokens: number } | null;
  groups: UsageGroup[];
}
