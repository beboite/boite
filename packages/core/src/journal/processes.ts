import type { Database } from 'bun:sqlite';
import { processAgentCommand, type ProcessRecord } from '@boite/contracts';

/** The newest trace rows a thread keeps; live rows and agent CLI rows stay on top. */
export const PROCESS_ROWS_KEPT = 2000;
/** Exits between two prunes of a thread that never goes idle. */
const PRUNE_EVERY_EXITS = 500;

/**
 * The same candidates `native-agents.ts` reads: an agent CLI card needs its own
 * row and its parent's, whatever their age.
 */
const AGENT_EXE = `(lower(exe) LIKE '%claude%' OR lower(exe) LIKE '%codex%' OR lower(exe) LIKE '%opencode%'
  OR lower(exe) LIKE '%pi%' OR lower(exe) LIKE '%grok%' OR lower(exe) LIKE '%agy%'
  OR lower(exe) LIKE '%node%' OR lower(exe) LIKE '%bun%')`;

interface AgentRow { pid: number; parent_pid: number | null; exe: string; command_line: string | null; started_at: number }

export class ProcessRows {
  private readonly exits = new Map<string, number>();

  constructor(private readonly db: Database) {}

  put(record: ProcessRecord): void {
    this.db.query(
      `INSERT OR REPLACE INTO processes
       (thread_id, pid, parent_pid, exe, command_line, started_at, exited_at, exit_code, cpu_ms, peak_memory_bytes, io_bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      record.threadId, record.pid, record.parentPid, record.exe, record.commandLine, record.startedAt,
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
    const agents = (this.db.query(`SELECT pid, parent_pid, exe, command_line, started_at FROM processes
      WHERE thread_id = ? AND started_at < ? AND ${AGENT_EXE}`).all(threadId, cutoff.started_at) as AgentRow[])
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
}
