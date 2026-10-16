/**
 * Trace row cost: the exit write of N processes, then the rows one thread keeps
 * after M processes. Runs on a temporary journal, never a real data directory.
 * `--root <checkout>` loads the Journal of another checkout to compare branches.
 *
 *   bun bench/process-rows.ts [exits=5000] [processes=10000] [--root <dir>]
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ProcessRecord } from '../packages/contracts/src/index.ts';

type JournalModule = typeof import('../packages/core/src/journal.ts');
type Journal = InstanceType<JournalModule['Journal']>;

const args = Bun.argv.slice(2);
const rootAt = args.indexOf('--root');
const root = rootAt >= 0 ? resolve(args[rootAt + 1]!) : resolve(import.meta.dir, '..');
const [exits = 5000, processes = 10_000] = args.filter((arg, index) => !arg.startsWith('--') && (rootAt < 0 || index !== rootAt + 1)).map(Number);
const { Journal } = await import(join(root, 'packages/core/src/journal.ts')) as JournalModule;

// A rustc line of a Bevy build: the column a replace copies again at exit.
const commandLine = `rustc --crate-name bevy_render --edition=2024 ${'-C opt-level=3 --extern bevy_ecs=/target/release/deps/libbevy_ecs-0123456789abcdef.rlib '.repeat(24)}`.slice(0, 2241);
const record = (threadId: string, pid: number): ProcessRecord => ({
  threadId, pid, parentPid: 1, exe: 'rustc', commandLine, startedAt: pid,
  exitedAt: null, exitCode: null, cpuMs: null, peakMemoryBytes: null, ioBytes: null,
});
const finish = (journal: Journal, row: ProcessRecord): void => {
  const exited = { ...row, exitedAt: row.startedAt + 1, exitCode: 0, cpuMs: 12, peakMemoryBytes: 1 << 20, ioBytes: 4096 };
  const update = (journal as Partial<{ finishProcess(record: ProcessRecord): void }>).finishProcess;
  if (update) update.call(journal, exited); else journal.putProcess(exited);
};

const dir = mkdtempSync(join(tmpdir(), 'boite-process-rows-'));
try {
  const journal = new Journal(join(dir, 'journal.db'));
  const rows = Array.from({ length: exits }, (_, index) => record('thr_exit', 10_000 + index));
  for (const row of rows) journal.putProcess(row);
  const cpu = process.cpuUsage();
  const started = Bun.nanoseconds();
  for (const row of rows) finish(journal, row);
  const exitMs = (Bun.nanoseconds() - started) / 1e6;
  const exitCpu = process.cpuUsage(cpu);
  journal.close();

  // A separate file, so the size below is the one thread's.
  const life = new Journal(join(dir, 'life.db'));
  for (let pid = 1; pid <= processes; pid++) {
    const row = record('thr_life', pid);
    life.putProcess(row);
    finish(life, row);
  }
  // The thread goes idle once at the end, which prunes where the core can.
  (life as Partial<{ pruneProcesses(threadId: string): number }>).pruneProcesses?.call(life, 'thr_life');
  const kept = (life.db.query("SELECT COUNT(*) AS count FROM processes WHERE thread_id = 'thr_life'").get() as { count: number }).count;
  const bytes = (life.db.query('SELECT SUM(pgsize) AS bytes FROM dbstat WHERE name IN (\'processes\', \'processes_by_started\', \'sqlite_autoindex_processes_1\')').get() as { bytes: number | null }).bytes;
  life.close();
  console.log(JSON.stringify({
    root, exits, exitMs: Number(exitMs.toFixed(1)), exitUsPerRow: Number((exitMs * 1000 / exits).toFixed(1)),
    exitCpuMs: Math.round((exitCpu.user + exitCpu.system) / 1000), processes, rowsKept: kept, tableBytes: bytes,
  }));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
