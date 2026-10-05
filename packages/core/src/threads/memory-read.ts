import type { MemoryEvent } from '@boite/contracts';
import type { Journal } from '../journal.ts';

/** Bounded history for a thread opened after a memory notice was broadcast. */
export function readMemoryEvents(journal: Journal, threadId: string): MemoryEvent[] {
  const rows = journal.db.query<{ payload: string }, [string]>(
    "SELECT payload FROM events WHERE thread_id = ? AND type = 'thread.memory' ORDER BY id DESC LIMIT 100",
  ).all(threadId);
  return rows.reverse().map(row => JSON.parse(row.payload) as MemoryEvent);
}
