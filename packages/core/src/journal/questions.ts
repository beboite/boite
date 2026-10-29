import type { Database } from 'bun:sqlite';
import type { QuestionRequest } from '@boite/contracts';

/**
 * The asynchronous questions asked and never answered or skipped. An
 * asynchronous card outlives its turn and the core, while events go after
 * thirty days (`journal/retention.ts`): this projection keeps the card, written
 * in the transaction of the event that asks or closes it.
 */
export function createPendingQuestions(db: Database, backfill: boolean): void {
  db.exec('CREATE TABLE IF NOT EXISTS pending_questions (id TEXT NOT NULL UNIQUE, thread_id TEXT NOT NULL, payload TEXT NOT NULL)');
  if (!backfill) return;
  // A journal from before the projection reads its open cards from the events it still has.
  db.exec(`INSERT OR IGNORE INTO pending_questions (id, thread_id, payload)
    SELECT json_extract(asked.payload, '$.id'), asked.thread_id, asked.payload FROM events asked
     WHERE asked.type = 'question.asked' AND json_extract(asked.payload, '$.async') = 1
       AND NOT EXISTS (
         SELECT 1 FROM events done
          WHERE done.thread_id = asked.thread_id AND done.id > asked.id AND done.type = 'question.answered'
            AND json_extract(done.payload, '$.questionId') = json_extract(asked.payload, '$.id'))
     ORDER BY asked.id`);
}

/** Keeps the projection in step with one event, in its transaction. */
export function projectQuestion(db: Database, type: string, threadId: string | null, payload: unknown): void {
  if (type === 'question.asked') {
    const request = payload as QuestionRequest;
    if (request.async !== true) return;
    db.query('INSERT OR REPLACE INTO pending_questions (id, thread_id, payload) VALUES (?, ?, ?)').run(request.id, threadId ?? request.threadId, JSON.stringify(request));
  } else if (type === 'question.answered') {
    db.query('DELETE FROM pending_questions WHERE id = ? AND thread_id = ?').run((payload as { questionId: string }).questionId, threadId);
  }
}

/** Oldest first. */
export function openAsyncQuestions(db: Database): QuestionRequest[] {
  const rows = db.query('SELECT payload FROM pending_questions ORDER BY rowid').all() as { payload: string }[];
  return rows.map(row => JSON.parse(row.payload) as QuestionRequest);
}
