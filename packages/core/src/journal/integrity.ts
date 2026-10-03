import { JOURNAL_INSPECTION_TABLES, type JournalInspection, type JournalInspectionCursor, type JournalInspectionIssue, type JournalInspectionTable, type RpcParams } from '@boite/contracts';
import type { Core } from '../core.ts';
import { invalidParams } from '../errors.ts';
import type { Journal } from '../journal.ts';

type Row = Record<string, unknown> & { rowId: number };
const JSON_MAX = 32_768;
const bounded = (column: string, max = JSON_MAX): string => `CASE WHEN length(CAST(${column} AS BLOB)) <= ${max} THEN ${column} END`;
const SELECTS: Record<JournalInspectionTable, string> = {
  threads: `SELECT t.rowid AS rowId,t.id,${bounded('t.fork_origin',4096)} AS origin,length(CAST(t.fork_origin AS BLOB)) AS jsonBytes FROM threads t`,
  turns: `SELECT t.rowid AS rowId,t.thread_id,t.status,t.started_at,${bounded('t.queue_hold',512)} AS hold,length(CAST(t.queue_hold AS BLOB)) AS jsonBytes,EXISTS(SELECT 1 FROM threads WHERE id=t.thread_id) AS threadExists FROM turns t`,
  messages: `SELECT m.rowid AS rowId,m.state,EXISTS(SELECT 1 FROM threads WHERE id=m.thread_id) AS threadExists,
    (SELECT thread_id FROM turns WHERE id=m.turn_id) AS turnThread,(SELECT status FROM turns WHERE id=m.turn_id) AS turnStatus,m.thread_id FROM messages m`,
  turn_requests: `SELECT r.rowid AS rowId,r.thread_id,r.message_id,EXISTS(SELECT 1 FROM threads WHERE id=r.thread_id) AS threadExists,
    (SELECT thread_id FROM turns WHERE id=r.turn_id) AS turnThread,EXISTS(SELECT 1 FROM messages WHERE id=r.message_id AND thread_id=r.thread_id AND turn_id=r.turn_id AND role='user') AS messageMatches FROM turn_requests r`,
  background_observations: `SELECT b.rowid AS rowId,b.thread_id,b.provider_id,b.session_generation,b.parent_turn_id,b.task_id,
    ${bounded('b.payload')} AS observation,length(CAST(b.payload AS BLOB)) AS jsonBytes,
    (SELECT provider_id FROM threads WHERE id=b.thread_id) AS currentProvider,(SELECT session_generation FROM threads WHERE id=b.thread_id) AS currentGeneration,
    (SELECT thread_id FROM turns WHERE id=b.parent_turn_id) AS parentThread FROM background_observations b`,
  coordination_letters: `SELECT c.rowid AS rowId,c.thread_id,c.direction,${bounded('c.data')} AS letter,length(CAST(c.data AS BLOB)) AS jsonBytes,
    EXISTS(SELECT 1 FROM threads WHERE id=c.thread_id) AS threadExists FROM coordination_letters c`,
};
const ALIASES: Record<JournalInspectionTable,string> = { threads:'t',turns:'t',messages:'m',turn_requests:'r',background_observations:'b',coordination_letters:'c' };

export function validateInspection(params: RpcParams<'journal.inspect'>): { cursor: JournalInspectionCursor; limit: number } {
  if (!params || typeof params !== 'object') throw invalidParams('journal.inspect: expected an object');
  const limit = params.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw invalidParams('limit: expected an integer from 1 to 500');
  const cursor = params.cursor ?? { table: 'threads', afterRowid: 0 };
  if (!cursor || !JOURNAL_INSPECTION_TABLES.includes(cursor.table) || !Number.isSafeInteger(cursor.afterRowid) || cursor.afterRowid < 0) {
    throw invalidParams('cursor: expected a known journal table and a nonnegative safe-integer afterRowid');
  }
  return { cursor, limit };
}

/** Read-only, rowid-keyed pages. Concurrent requests are not an atomic whole-journal proof. */
export function inspectJournal(journal: Journal, params: RpcParams<'journal.inspect'>): JournalInspection {
  const { cursor: start, limit } = validateInspection(params);
  const issues: JournalInspectionIssue[] = [];
  let checked = 0;
  for (let index = JOURNAL_INSPECTION_TABLES.indexOf(start.table); index < JOURNAL_INSPECTION_TABLES.length; index++) {
    const table = JOURNAL_INSPECTION_TABLES[index]!;
    const after = table === start.table ? start.afterRowid : 0;
    const rows = journal.db.query(`${SELECTS[table]} WHERE ${ALIASES[table]}.rowid > ? ORDER BY ${ALIASES[table]}.rowid LIMIT ?`).all(after, limit - checked + 1) as Row[];
    if (checked === limit) {
      if (rows.length) return { issues, checked, cursor: {table,afterRowid:after}, truncated:true };
      continue;
    }
    for (const [offset,row] of rows.entries()) {
      if (checked === limit) return { issues, checked, cursor: {table,afterRowid:rows[offset-1]!.rowId}, truncated:true };
      checkRow(journal, table, row, issues);
      checked++;
    }
  }
  return { issues, checked, cursor:null, truncated:false };
}

function checkRow(journal: Journal, table: JournalInspectionTable, row: Row, issues: JournalInspectionIssue[]): void {
  const add = (code: JournalInspectionIssue['code'], field: string, expected: string): void => { issues.push({table,rowId:row.rowId,code,field,expected}); };
  const relation = (): void => {
    if (!row.threadExists) add('missing-thread','thread_id','an existing owning thread');
    if (row.turnThread == null) add('missing-turn','turn_id','an existing turn');
    else if (row.turnThread !== row.thread_id) add('turn-thread-mismatch','turn_id','a turn of the owning thread');
  };
  const object = (field: string, max = JSON_MAX): Record<string,unknown> | null => {
    if (typeof row.jsonBytes === 'number' && row.jsonBytes > max) { add('oversized-json',field,`JSON no larger than ${max} bytes`); return null; }
    if (typeof row[field] !== 'string') return null;
    try {
      const value: unknown = JSON.parse(row[field]);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      return value as Record<string,unknown>;
    } catch { add('malformed-json',field,'a JSON object'); return null; }
  };
  if (table === 'threads') {
    const origin = object('origin',4096); if (!origin) return;
    const nullableId = (value: unknown): boolean => value === null || (typeof value === 'string' && value.length > 0 && value.length <= 128);
    if (typeof origin.threadId !== 'string' || !origin.threadId.length || origin.threadId.length > 128 || origin.threadId === row.id
      || !nullableId(origin.messageId) || !nullableId(origin.turnId) || !['native','seeded'].includes(String(origin.mode))) {
      add('invalid-fork-origin','fork_origin','a distinct source, nullable message/turn IDs and native or seeded mode'); return;
    }
    // A source or selected point may legitimately be deleted or rewound later; existing points must still belong to that source.
    for (const [field,sourceTable] of [['messageId','messages'],['turnId','turns']] as const) {
      if (origin[field] == null) continue;
      const owner = journal.db.query(`SELECT thread_id FROM ${sourceTable} WHERE id = ?`).get(origin[field] as string) as {thread_id:string}|null;
      if (owner && owner.thread_id !== origin.threadId) add('fork-origin-owner-mismatch',`fork_origin.${field}`,'a point owned by the recorded source');
    }
  } else if (table === 'turns') {
    if (!row.threadExists) add('missing-thread','thread_id','an existing owning thread');
    const hold = object('hold',512); if (!hold) return;
    if (row.status !== 'queued' || row.started_at !== null || hold.reason !== 'core-restarted' || !timestamp(hold.since)) add('invalid-queue-hold','queue_hold','an unstarted queued turn held after core restart');
  } else if (table === 'messages') {
    relation();
    if (row.state === 'streaming' && ['done','error','stopped'].includes(String(row.turnStatus))) add('terminal-streaming-message','state','a non-streaming message on a terminal turn');
  } else if (table === 'turn_requests') {
    relation();
    if (row.message_id !== null && !row.messageMatches) add('request-message-mismatch','message_id','a user message of the owning thread and turn');
  } else if (table === 'background_observations') {
    if (row.currentProvider == null) add('missing-thread','thread_id','an existing owning thread');
    const task = object('observation'); if (!task) return;
    const states = ['running','completed','error','cancelled','ended'];
    if (task.threadId !== row.thread_id || task.providerId !== row.provider_id || task.sessionGeneration !== row.session_generation
      || (task.parentTurnId ?? '') !== row.parent_turn_id || task.id !== row.task_id
      || typeof task.id !== 'string' || !task.id.length || !(task.parentTurnId === null || (typeof task.parentTurnId === 'string' && task.parentTurnId.length > 0))
      || !Number.isSafeInteger(task.sessionGeneration) || Number(task.sessionGeneration) < 0
      || !states.includes(String(task.state)) || !['shell','agent','monitor','workflow','other'].includes(String(task.kind))
      || !timestamp(task.startedAt) || !timestamp(task.observedAt)
      || (task.state === 'running' ? task.finishedAt !== null : !timestamp(task.finishedAt))) add('invalid-background-observation','payload','matching native identity, valid state and observation timestamps');
    if (task.state === 'running' && (row.provider_id !== row.currentProvider || row.session_generation !== row.currentGeneration)) add('background-owner-mismatch','session_generation','live work owned by the current provider and session generation');
    if (row.parent_turn_id && (row.parentThread != null ? row.parentThread !== row.thread_id : task.state === 'running')) add('background-parent-mismatch','parent_turn_id','an originating turn of the owning thread');
  } else {
    if (!row.threadExists) add('missing-thread','thread_id','an existing owning thread');
    const letter = object('letter'); if (!letter) return;
    const owner = row.direction === 'out' ? letter.from : row.direction === 'in' ? letter.to : null;
    if (!owner || typeof owner !== 'object' || (owner as {threadId?:unknown}).threadId !== row.thread_id) add('invalid-letter-owner','data','a receipt matching its direction and owning thread');
  }
}
function timestamp(value: unknown): boolean { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }

export function registerJournalInspection(core: Core): void {
  // Owner-only by default. Diagnostics deliberately expose no private stored payload or repair action.
  core.router.register('journal.inspect', params => inspectJournal(core.journal,params));
}
