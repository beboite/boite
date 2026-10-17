import type { Database } from 'bun:sqlite';
import { processAgentCommand, type ProcessRecord } from '@boite/contracts';

/** The newest trace rows a thread keeps; live rows and agent CLI rows stay on top. */
export const PROCESS_ROWS_KEPT = 2000;
/** Exits between two prunes of a thread that never goes idle. */
const PRUNE_EVERY_EXITS = 500;
/** A thread is pruned by the background pass once it holds this many rows past what it keeps. */
export const PROCESS_ROWS_SLACK = 500;

/**
 * The columns of a `processes` row as `ProcessRow` reads them, with the
 * command line taken from `command_lines` (schema 36) or, on a row written
 * before, from the row itself. Use with `PROCESS_FROM`.
 */
export const PROCESS_COLUMNS = `p.thread_id, p.pid, p.parent_pid, p.exe, COALESCE(p.command_line, c.text) AS command_line, p.started_at,
  p.exited_at, p.exit_code, p.cpu_ms, p.peak_memory_bytes, p.io_bytes`;
export const PROCESS_FROM = 'processes p LEFT JOIN command_lines c ON c.id = p.command_id';

/**
 * The same candidates `native-agents.ts` reads: an agent CLI card needs its own
 * row and its parent's, whatever their age.
 */
const AGENT_EXE = `(lower(exe) LIKE '%claude%' OR lower(exe) LIKE '%codex%' OR lower(exe) LIKE '%opencode%'
  OR lower(exe) LIKE '%pi%' OR lower(exe) LIKE '%grok%' OR lower(exe) LIKE '%agy%'
  OR lower(exe) LIKE '%node%' OR lower(exe) LIKE '%bun%')`;

interface AgentRow { pid: number; parent_pid: number | null; exe: string; command_line: string | null; started_at: number }

/** Schema 36: one row per distinct command line, which process rows name by id. */
export function createCommandLines(db: Database, addColumn: boolean): void {
  db.exec(`CREATE TABLE IF NOT EXISTS command_lines (id INTEGER PRIMARY KEY, digest INTEGER NOT NULL, text TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS command_lines_digest ON command_lines (digest);`);
  if (addColumn) db.exec('ALTER TABLE processes ADD COLUMN command_id INTEGER');
  // What the daily pass looks up to find command lines no row names any more.
  db.exec('CREATE INDEX IF NOT EXISTS processes_by_command ON processes (command_id) WHERE command_id IS NOT NULL');
}

const digestOf = (text: string): bigint => BigInt.asIntN(64, Bun.hash.xxHash64(text));

/**
 * The id of `text` in `command_lines`, added when missing. A hook that runs
 * tens of thousands of times stores its command line once.
 */
export function internCommandLine(db: Database, text: string): number {
  const digest = digestOf(text);
  const found = db.query('SELECT id FROM command_lines WHERE digest = ? AND text = ?').get(digest, text) as { id: number } | null;
  if (found !== null) return found.id;
  return Number(db.query('INSERT INTO command_lines (digest, text) VALUES (?, ?)').run(digest, text).lastInsertRowid);
}

export class ProcessRows {
  private readonly exits = new Map<string, number>();

  constructor(private readonly db: Database) {}

  put(record: ProcessRecord): void {
    const commandId = record.commandLine === null ? null : internCommandLine(this.db, record.commandLine);
    this.db.query(
      `INSERT OR REPLACE INTO processes
       (thread_id, pid, parent_pid, exe, command_line, command_id, started_at, exited_at, exit_code, cpu_ms, peak_memory_bytes, io_bytes)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      record.threadId, record.pid, record.parentPid, record.exe, commandId, record.startedAt,
      record.exitedAt, record.exitCode, record.cpuMs, record.peakMemoryBytes, record.ioBytes,
    );
  }

  /**
   * The exit columns only: the start already wrote the row, and a replace would
   * copy the command line and rewrite both indexes. A row an earlier crash lost
   * is written whole.
   */
  finish(record: ProcessRecord): void {
    const { changes } = this.db.query(
      `UPDATE processes SET exited_at = ?, exit_code = ?, cpu_ms = ?, peak_memory_bytes = ?, io_bytes = ?
       WHERE thread_id = ? AND pid = ? AND started_at = ?`,
    ).run(record.exitedAt, record.exitCode, record.cpuMs, record.peakMemoryBytes, record.ioBytes, record.threadId, record.pid, record.startedAt);
    if (changes === 0) this.put(record);
    const exits = (this.exits.get(record.threadId) ?? 0) + 1;
    if (exits >= PRUNE_EVERY_EXITS) this.prune(record.threadId);
    else this.exits.set(record.threadId, exits);
  }

  /**
   * Keeps a thread's newest `keep` rows, every live row and the rows an agent
   * CLI card reads (the CLI and its parent). Returns the rows deleted.
   */
  prune(threadId: string, keep = PROCESS_ROWS_KEPT): number {
    this.exits.delete(threadId);
    const cutoff = this.db.query('SELECT started_at FROM processes WHERE thread_id = ? ORDER BY started_at DESC LIMIT 1 OFFSET ?')
      .get(threadId, keep - 1) as { started_at: number } | null;
    if (cutoff === null) return 0;
    const agents = (this.db.query(`SELECT p.pid, p.parent_pid, p.exe, COALESCE(p.command_line, c.text) AS command_line, p.started_at FROM ${PROCESS_FROM}
      WHERE p.thread_id = ? AND p.started_at < ? AND ${AGENT_EXE}`).all(threadId, cutoff.started_at) as AgentRow[])
      .filter(row => row.parent_pid !== null && processAgentCommand({ exe: row.exe, commandLine: row.command_line }) !== null);
    const kept = new Set<string>();
    const parent = this.db.query('SELECT started_at FROM processes WHERE thread_id = ? AND pid = ? AND started_at <= ? ORDER BY started_at DESC LIMIT 1');
    for (const row of agents) {
      kept.add(`${row.pid}:${row.started_at}`);
      const found = parent.get(threadId, row.parent_pid, row.started_at) as { started_at: number } | null;
      if (found !== null) kept.add(`${row.parent_pid}:${found.started_at}`);
    }
    return this.db.query(`DELETE FROM processes WHERE thread_id = ? AND exited_at IS NOT NULL AND started_at < ?
      AND (pid || ':' || started_at) NOT IN (SELECT value FROM json_each(?))`).run(threadId, cutoff.started_at, JSON.stringify([...kept])).changes;
  }

  /**
   * The next thread after `afterThreadId`, in id order, holding more than
   * `PROCESS_ROWS_KEPT` plus `PROCESS_ROWS_SLACK` rows, pruned. A thread that
   * finished before pruning ran at every 500 exits kept its whole trace.
   * Returns that thread's id, or null once none is left. Walks the
   * `processes_by_started` index, never the rows.
   */
  pruneNextThread(afterThreadId: string): string | null {
    const row = this.db.query(`SELECT thread_id AS threadId FROM processes WHERE thread_id > ?
      GROUP BY thread_id HAVING COUNT(*) > ? ORDER BY thread_id LIMIT 1`).get(afterThreadId, PROCESS_ROWS_KEPT + PROCESS_ROWS_SLACK) as { threadId: string } | null;
    if (row === null) return null;
    this.prune(row.threadId);
    return row.threadId;
  }
}

/**
 * Moves the command lines of rows written before schema 36 into
 * `command_lines`, at most `limit` rows after `afterRowid`. Returns the last
 * rowid done, or null once none is left.
 */
export function internOldCommandLines(db: Database, afterRowid: number, limit: number): number | null {
  const rows = db.query('SELECT rowid AS rowid, command_line AS text FROM processes WHERE rowid > ? AND command_line IS NOT NULL ORDER BY rowid LIMIT ?')
    .all(afterRowid, limit) as { rowid: number; text: string }[];
  if (rows.length === 0) return null;
  const ids = new Map<string, number>();
  const update = db.query('UPDATE processes SET command_id = ?, command_line = NULL WHERE rowid = ? AND command_line = ?');
  db.transaction(() => {
    for (const row of rows) {
      let id = ids.get(row.text);
      if (id === undefined) ids.set(row.text, id = internCommandLine(db, row.text));
      update.run(id, row.rowid, row.text);
    }
  })();
  return rows.at(-1)!.rowid;
}

/** Deletes the command lines no process row names any more. Returns how many went. */
export function deleteUnusedCommandLines(db: Database): number {
  return db.query('DELETE FROM command_lines WHERE NOT EXISTS (SELECT 1 FROM processes WHERE command_id = command_lines.id)').run().changes;
}
