import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Journal } from '../src/journal.ts';
import { compactionSteps, ONE_TIME_PASSES, pruneEventsOnce } from '../src/journal/retention.ts';
import type { WalCheckpointOptions } from '../src/journal/wal-checkpoints.ts';

let dir: string;
let file: string;
let journal: Journal | undefined;
let errors: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boite-checkpoints-'));
  file = join(dir, 'journal.db');
  errors = [];
});

afterEach(() => {
  journal?.close();
  journal = undefined;
  rmSync(dir, { recursive: true, force: true });
});

/** Ticks run by hand: the timer would fire only after a minute. */
function open(options: WalCheckpointOptions = {}): Journal {
  journal = new Journal(file, { onError: message => errors.push(message), checkpoints: { limitBytes: 256 * 1024, tickMs: 60_000, idleMs: 60_000, ...options } });
  return journal;
}

/** Writes about 100 KiB in one message. */
function write(target: Journal, n: number): void {
  target.putMessage({ id: `msg_${n}`, threadId: 'thr_test', turnId: 'trn_test', role: 'assistant', state: 'complete', createdAt: n, parts: [{ type: 'text', text: `${n}`.padEnd(100 * 1024, '.') }] });
}

async function settle(target: Journal): Promise<void> {
  while (target.checkpoints!.running) await Bun.sleep(2);
}

const walBytes = () => statSync(`${file}-wal`, { throwIfNoEntry: false })?.size ?? 0;

test('a Worker started after the first write checkpoints the WAL and keeps it near its limit', async () => {
  const target = open();
  target.checkpoints!.tick();
  expect(target.checkpoints!.ran).toEqual({ worker: 0, main: 0 });
  for (let n = 0; n < 40; n++) {
    write(target, n);
    target.checkpoints!.tick();
    await settle(target);
  }
  // 40 writes of 100 KiB: without checkpoints the WAL would hold all 4 MiB of them.
  expect(target.checkpoints!.ran.worker).toBeGreaterThan(1);
  expect(target.checkpoints!.ran.main).toBe(0);
  expect(walBytes()).toBeLessThan(1024 * 1024);
  expect(target.getMessage('msg_39')?.parts).toEqual([{ type: 'text', text: '39'.padEnd(100 * 1024, '.') }]);
  expect(errors).toEqual([]);
});

test('a quiet WAL is truncated, and closing waits for the checkpoint the Worker runs', async () => {
  const target = open({ idleMs: 0 });
  write(target, 1);
  target.checkpoints!.tick();
  await settle(target);
  expect(walBytes()).toBe(0);
  // The Worker is up; it gets 4 MiB to copy and the journal closes while it does.
  for (let n = 2; n < 42; n++) write(target, n);
  target.checkpoints!.tick();
  expect(target.checkpoints!.running).toBe(true);
  target.close();
  expect(target.checkpoints!.running).toBe(false);
  journal = undefined;
  // The Worker's connection closed first, so the journal's was the last one and emptied the WAL.
  // Linux's SQLite removes the file; Apple's system SQLite keeps it at 0 bytes.
  expect(walBytes()).toBe(0);
  expect(errors).toEqual([]);
});

test('without a Worker the main thread checkpoints and the owner hears it once', () => {
  const target = open({ worker: () => { throw new Error('no Worker here'); } });
  for (let n = 0; n < 12; n++) {
    write(target, n);
    target.checkpoints!.tick();
  }
  expect(target.checkpoints!.ran.worker).toBe(0);
  expect(target.checkpoints!.ran.main).toBeGreaterThan(1);
  expect(walBytes()).toBeLessThan(1024 * 1024);
  expect(errors).toEqual(['journal checkpoint worker unavailable, checkpointing on the main thread: no Worker here']);
});

test('the compaction passes and event retention wait while the WAL is past twice its limit, and go on once it is checkpointed', async () => {
  const target = open();
  // The WAL file shrinks back to this limit when it restarts, as the real 4 MiB limit does.
  target.db.exec(`PRAGMA journal_size_limit = ${256 * 1024}`);
  const now = Date.now();
  target.db.query("INSERT INTO events (thread_id, ts, type, version, payload) VALUES ('thr_test', ?, 'turn.finished', 1, '{}')").run(now - 40 * 86_400_000);
  const events = (): number => (target.db.query('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
  for (let n = 0; n < 6; n++) write(target, n);
  expect(walBytes()).toBeGreaterThan(2 * 256 * 1024);
  expect(target.checkpoints!.behind).toBe(true);
  const [first] = compactionSteps(target);
  expect(await first!(Date.now())).toBe('more');
  // The ticks wrote nothing: the pass has not started and the old event is still there.
  expect(target.getSetting(ONE_TIME_PASSES[0])).toBeUndefined();
  expect(pruneEventsOnce(target, now)).toBe(true);
  expect(events()).toBe(1);
  target.checkpoints!.tick();
  await settle(target);
  // The next write restarts the checkpointed WAL.
  target.setSetting('test:restart', 1);
  expect(target.checkpoints!.behind).toBe(false);
  while (await first!(Date.now()) === 'more');
  expect(target.getSetting(ONE_TIME_PASSES[0])).toBe(Number.MAX_SAFE_INTEGER);
  while (pruneEventsOnce(target, now));
  expect(events()).toBe(0);
});
