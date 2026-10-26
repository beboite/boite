import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../src/journal.ts';
import { compactionSteps, PRUNED_AT, scheduleEventRetention } from '../src/journal/retention.ts';

const DAY = 86_400_000;
let dir: string, journal: Journal;
let previousDataDir: string | undefined;
let stop: (() => void) | undefined;
let restore: (() => void)[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boite-retention-'));
  previousDataDir = process.env.BOITE_DATA_DIR;
  process.env.BOITE_DATA_DIR = dir;
  journal = new Journal(join(dir, 'journal.db'), { checkpoints: { tickMs: 60_000 } });
  restore = [];
});

afterEach(() => {
  stop?.();
  stop = undefined;
  for (const cleanup of restore.reverse()) cleanup();
  journal.close();
  if (previousDataDir === undefined) delete process.env.BOITE_DATA_DIR;
  else process.env.BOITE_DATA_DIR = previousDataDir;
  rmSync(dir, { recursive: true, force: true });
});

/** Drive only the scheduler's timeouts; the journal's checkpoint interval stays real. */
function timers() {
  const pending = new Map<ReturnType<typeof setTimeout>, { delay: number; run: () => unknown }>();
  const set = spyOn(globalThis, 'setTimeout').mockImplementation(((run: () => unknown, delay = 0) => {
    const timer = { unref() {} } as ReturnType<typeof setTimeout>;
    pending.set(timer, { delay, run });
    return timer;
  }) as typeof setTimeout);
  const clear = spyOn(globalThis, 'clearTimeout').mockImplementation(timer => { pending.delete(timer as ReturnType<typeof setTimeout>); });
  restore.push(() => { clear.mockRestore(); set.mockRestore(); });
  return {
    get delays() { return [...pending.values()].map(timer => timer.delay); },
    async tick() {
      expect(pending.size).toBe(1);
      const [timer, next] = [...pending.entries()][0]!;
      pending.delete(timer);
      await next.run();
    },
  };
}

function oldEvents(count = 3): void {
  const insert = journal.db.query("INSERT INTO events (thread_id, ts, type, version, payload) VALUES ('thr_test', ?, 'turn.finished', 1, '{}')");
  journal.db.transaction(() => { for (let n = 0; n < count; n++) insert.run(Date.now() - 40 * DAY); })();
}

test('a future trace prune date resumes its cursor, while a valid recent pass stays deferred', async () => {
  const now = Date.now();
  const through = 'processes:pruned-through';
  const insert = journal.db.query("INSERT INTO processes (thread_id, pid, parent_pid, exe, started_at, exited_at, exit_code) VALUES (?, ?, NULL, 'git', ?, ?, 0)");
  journal.db.transaction(() => {
    for (const thread of ['thr_a', 'thr_b']) for (let n = 1; n <= 2_601; n++) insert.run(thread, n, n, n + 1);
  })();
  const count = (thread: string) => (journal.db.query('SELECT COUNT(*) AS n FROM processes WHERE thread_id = ?').get(thread) as { n: number }).n;
  journal.setSetting(through, 'thr_a');
  journal.setSetting(PRUNED_AT, now - 60_000);
  const step = compactionSteps(journal)[3]!;
  expect(await step(now)).toBe('done');
  expect(count('thr_b')).toBe(2_601);
  expect(journal.getSetting(through)).toBe('thr_a');
  expect(journal.getSetting(PRUNED_AT)).toBe(now - 60_000);

  journal.setSetting(PRUNED_AT, now + 100);
  expect(await step(now)).toBe('more');
  expect(journal.getSetting(through)).toBe('thr_a');
  // The next scheduler tick crosses the invalid date while the trace is still being scanned.
  expect(await step(now + 250)).toBe('more');
  expect(journal.getSetting(PRUNED_AT)).toBeUndefined();
  expect(journal.getSetting(through)).toBe('thr_a');
  let finishedAt = now + 250;
  for (let ticks = 2; ticks < 40; ticks++) {
    finishedAt = now + ticks * 250;
    if (await step(finishedAt) === 'done') break;
  }
  expect(count('thr_b')).toBe(2_000);
  expect(count('thr_a')).toBe(2_601);
  expect(journal.getSetting(PRUNED_AT)).toBe(finishedAt);
  expect(journal.getSetting(through)).toBeUndefined();
  expect(await step(finishedAt + DAY - 1)).toBe('done');
  expect(count('thr_a')).toBe(2_601);
});

test('a failed ANALYZE is retried before the next statement and retention completes the same pass', async () => {
  oldEvents();
  journal.db.exec('CREATE TABLE retention_sample (id INTEGER PRIMARY KEY, value TEXT); CREATE INDEX retention_sample_value ON retention_sample(value); INSERT INTO retention_sample VALUES (1, \'sample\')');
  const pending = journal.staleStatistics(true);
  expect(pending.length).toBeGreaterThanOrEqual(2);
  const analyze = journal.analyze.bind(journal);
  const attempts: string[] = [];
  const failure = spyOn(journal, 'analyze').mockImplementation(statement => {
    attempts.push(statement);
    if (attempts.length === 1) throw new Error('synthetic SQLITE_BUSY ANALYZE');
    analyze(statement);
  });
  restore.push(() => failure.mockRestore());
  const clock = timers(), errors: string[] = [];
  stop = scheduleEventRetention(journal, message => errors.push(message));
  expect(clock.delays).toEqual([60_000]);
  await clock.tick();
  expect(errors).toEqual(['journal event retention: synthetic SQLITE_BUSY ANALYZE']);
  expect(clock.delays).toEqual([30_000]);
  await clock.tick();
  expect(attempts).toEqual([pending[0]!, pending[0]!]);
  await clock.tick();
  expect(attempts[2]).toBe(pending[1]!);
  for (let ticks = 0; ticks < 40 && clock.delays[0] !== DAY; ticks++) await clock.tick();
  expect(clock.delays).toEqual([DAY]);
  expect(journal.countEvents()).toBe(0);
  expect(attempts.slice(1, pending.length + 1)).toEqual(pending);
  // Pruning can populate settings after the startup snapshot; only normal stale statistics run afterward.
  expect(journal.staleStatistics()).toEqual([]);
});

test('a failed prune retries shortly without rebuilding completed startup statistics', async () => {
  oldEvents();
  for (const statement of journal.staleStatistics(true)) journal.analyze(statement);
  const stale = spyOn(journal, 'staleStatistics');
  const prune = journal.pruneTrail.bind(journal);
  const failure = spyOn(journal, 'pruneTrail').mockImplementationOnce(() => { throw new Error('synthetic SQLITE_BUSY prune'); });
  restore.push(() => { stale.mockRestore(); failure.mockRestore(); });
  const clock = timers(), errors: string[] = [];
  stop = scheduleEventRetention(journal, message => errors.push(message));
  await clock.tick();
  expect(errors).toEqual(['journal event retention: synthetic SQLITE_BUSY prune']);
  expect(clock.delays).toEqual([30_000]);
  failure.mockImplementation(prune);
  await clock.tick();
  expect(journal.countEvents()).toBe(0);
  expect(stale.mock.calls.filter(args => args[0] === true)).toHaveLength(1);
  for (let ticks = 0; ticks < 40 && clock.delays[0] !== DAY; ticks++) await clock.tick();
  expect(clock.delays).toEqual([DAY]);
  expect(stale.mock.calls.filter(args => args[0] === true)).toHaveLength(1);
});

test('WAL wait pauses statistics and pruning without inflating the first batch, then resumes', async () => {
  journal.close();
  journal = new Journal(join(dir, 'wal.db'), { checkpoints: { limitBytes: 4_096, tickMs: 60_000 } });
  oldEvents(1_200);
  // Hold a real WAL behind a test-sized checkpoint threshold, without a Worker or a live core.
  expect(journal.checkpoints!.behind).toBe(true);
  const analyze = spyOn(journal, 'analyze'), prune = spyOn(journal, 'pruneTrail');
  restore.push(() => { analyze.mockRestore(); prune.mockRestore(); });
  const clock = timers(), errors: string[] = [];
  stop = scheduleEventRetention(journal, message => errors.push(message));
  for (let wakes = 0; wakes < 3; wakes++) {
    await clock.tick();
    expect(clock.delays).toEqual([30_000]);
    expect(analyze).not.toHaveBeenCalled();
    expect(prune).not.toHaveBeenCalled();
  }
  journal.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  expect(journal.checkpoints!.behind).toBe(false);
  // Stand in for the independent checkpoint interval between productive scheduler ticks.
  const tickAndCheckpoint = async () => { await clock.tick(); journal.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); };
  for (let ticks = 0; ticks < 40 && prune.mock.calls.length === 0; ticks++) await tickAndCheckpoint();
  expect(analyze).toHaveBeenCalled();
  expect(prune.mock.calls[0]?.[2]).toBe(500);
  for (let ticks = 0; ticks < 40 && clock.delays[0] !== DAY; ticks++) await tickAndCheckpoint();
  expect(journal.countEvents()).toBe(0);
  expect(clock.delays).toEqual([DAY]);
  expect(errors).toEqual([]);
});

for (const action of ['stop', 'close'] as const) {
  test(`${action} during a failed retention tick does not rearm work`, async () => {
    oldEvents();
    const failure = spyOn(journal, 'analyze').mockImplementation(() => { throw new Error('synthetic SQLITE_BUSY'); });
    restore.push(() => failure.mockRestore());
    const clock = timers(), errors: string[] = [];
    stop = scheduleEventRetention(journal, message => {
      errors.push(message);
      if (action === 'stop') stop!();
      else journal.close();
    });
    await clock.tick();
    expect(errors).toHaveLength(1);
    expect(clock.delays).toEqual([]);
  });

  test(`${action} while retention waits for WAL prevents further statistics or pruning`, async () => {
    journal.close();
    journal = new Journal(join(dir, 'wal.db'), { checkpoints: { limitBytes: 4_096, tickMs: 60_000 } });
    oldEvents();
    expect(journal.checkpoints!.behind).toBe(true);
    const analyze = spyOn(journal, 'analyze'), prune = spyOn(journal, 'pruneTrail');
    restore.push(() => { analyze.mockRestore(); prune.mockRestore(); });
    const clock = timers(), errors: string[] = [];
    stop = scheduleEventRetention(journal, message => errors.push(message));
    await clock.tick();
    expect(clock.delays).toEqual([30_000]);
    if (action === 'stop') stop();
    else { journal.close(); await clock.tick(); }
    expect(clock.delays).toEqual([]);
    expect(analyze).not.toHaveBeenCalled();
    expect(prune).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
  });
}
