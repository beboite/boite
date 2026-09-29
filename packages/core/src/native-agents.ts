import { collectNativeAgents, type BackgroundTask, type MessagePart, type NativeAgent, type Turn } from '@boite/contracts';
import type { Journal } from './journal.ts';

/** Read only agent tools across all pages, never the rest of a potentially large transcript. */
export function nativeAgents(journal: Journal, threadId: string, background: BackgroundTask[] = []): NativeAgent[] {
  journal.flushDeltas();
  journal.persistMessages();
  const rows = journal.db.query(`SELECT p.value AS part, m.created_at AS at, m.turn_id AS turnId, t.status AS turnStatus
    FROM messages m JOIN turns t ON t.id = m.turn_id, json_each(m.parts) p
    WHERE m.thread_id = ? AND m.role = 'assistant' AND json_extract(p.value, '$.type') = 'tool'
      AND (json_type(p.value, '$.nativeAgents') = 'array' OR lower(json_extract(p.value, '$.name')) IN ('agent', 'task', 'subagent'))
    ORDER BY m.rowid, CAST(p.key AS INTEGER)`).all(threadId) as { part: string; at: number; turnId: string; turnStatus: Turn['status'] }[];
  return collectNativeAgents(rows.map(row => ({ ...row, part: JSON.parse(row.part) as MessagePart })), background);
}
