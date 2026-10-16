import type { Database } from 'bun:sqlite';
import type { Turn } from '@boite/contracts';
import { toTurn, type TurnRow } from './rows.ts';

export function writeTurn(db: Database, turn: Turn): void {
  db.query(
    `INSERT OR REPLACE INTO turns (id, thread_id, status, queued_at, started_at, finished_at, usage, error, execution, checkpoint, queue_hold)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
 * The cost and tokens the turns of one agent session reported, summed in SQL:
 * every turn of the thread with usage in session generation `generation`,
 * except `exceptTurnId`. A turn with no recorded generation counts in none.
 */
export function sumSessionUsage(db: Database, threadId: string, generation: number, exceptTurnId: string): { costUsd: number; tokens: number } {
  const row = db.query(`SELECT COALESCE(SUM(json_extract(usage, '$.costUsdEquivalent')), 0) AS costUsd,
    COALESCE(SUM(json_extract(usage, '$.inputTokens') + json_extract(usage, '$.outputTokens') + json_extract(usage, '$.cacheReadTokens') + json_extract(usage, '$.cacheWriteTokens')), 0) AS tokens
    FROM turns WHERE thread_id = ? AND id <> ? AND usage IS NOT NULL AND json_extract(execution, '$.sessionGeneration') = ?`)
    .get(threadId, exceptTurnId, generation) as { costUsd: number; tokens: number };
  return { costUsd: row.costUsd, tokens: row.tokens };
}
