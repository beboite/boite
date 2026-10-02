import { collectNativeAgents, collectProcessAgents, type BackgroundTask, type MessagePart, type NativeAgent, type ProcessRecord, type Turn } from '@boite/contracts';
import type { Journal } from './journal.ts';
import { toProcess, type ProcessRow } from './journal/rows.ts';

interface Entry {
  messageOrder: number;
  partIndex: number;
  part: MessagePart;
  at: number;
  turnId: string;
  turnStatus: Turn['status'];
}

/** Read only agent tools across all pages, never the rest of a potentially large transcript. */
export function nativeAgents(journal: Journal, threadId: string, background: BackgroundTask[] = [], live: ProcessRecord[] = []): NativeAgent[] {
  journal.flushDeltas();
  const liveRows = journal.db.query(`SELECT m.id, m.rowid AS messageOrder, m.created_at AS at, m.turn_id AS turnId, t.status AS turnStatus
    FROM messages m JOIN turns t ON t.id = m.turn_id
    WHERE m.thread_id = ? AND m.role = 'assistant' AND m.state = 'streaming'
    ORDER BY m.rowid`).all(threadId) as (Omit<Entry, 'part' | 'partIndex'> & { id: string })[];
  const heldIds: string[] = [];
  const entries: Entry[] = [];
  for (const row of liveRows) {
    const message = journal.streamingMessage(row.id);
    if (message === undefined) continue;
    heldIds.push(message.id);
    message.parts.forEach((part, partIndex) => {
      if (part.type === 'tool' && (part.nativeAgents !== undefined || ['agent', 'task', 'subagent'].includes(part.name.toLowerCase()))) {
        entries.push({ ...row, part, partIndex });
      }
    });
  }
  const rows = journal.db.query(`SELECT m.rowid AS messageOrder, CAST(p.key AS INTEGER) AS partIndex,
      p.value AS part, m.created_at AS at, m.turn_id AS turnId, t.status AS turnStatus
    FROM messages m JOIN turns t ON t.id = m.turn_id, json_each(m.parts) p
    WHERE m.thread_id = ? AND m.role = 'assistant' AND json_extract(p.value, '$.type') = 'tool'
      AND m.id NOT IN (SELECT value FROM json_each(?))
      AND (json_type(p.value, '$.nativeAgents') = 'array' OR lower(json_extract(p.value, '$.name')) IN ('agent', 'task', 'subagent'))
    ORDER BY m.rowid, CAST(p.key AS INTEGER)`).all(threadId, JSON.stringify(heldIds)) as (Omit<Entry, 'part'> & { part: string })[];
  for (const row of rows) entries.push({ ...row, part: JSON.parse(row.part) as MessagePart });
  entries.sort((left, right) => left.messageOrder - right.messageOrder || left.partIndex - right.partIndex);
  // Read CLI candidates and their parents, rather than every shell, build and
  // browser command line in a long conversation. Running children have no age limit.
  const candidates = journal.db.query(`SELECT * FROM processes WHERE thread_id = ?
    AND (lower(exe) LIKE '%claude%' OR lower(exe) LIKE '%codex%' OR lower(exe) LIKE '%opencode%'
      OR lower(exe) LIKE '%pi%' OR lower(exe) LIKE '%grok%' OR lower(exe) LIKE '%agy%'
      OR lower(exe) LIKE '%node%' OR lower(exe) LIKE '%bun%')`).all(threadId) as ProcessRow[];
  const parents = journal.db.query(`SELECT * FROM processes WHERE thread_id = ?
    AND pid IN (SELECT value FROM json_each(?))`).all(threadId, JSON.stringify(candidates.map(row => row.parent_pid))) as ProcessRow[];
  const processes = new Map([...parents, ...candidates].map(row => [row.pid, toProcess(row)]));
  return [...collectNativeAgents(entries, background), ...collectProcessAgents([...processes.values()], live)];
}
