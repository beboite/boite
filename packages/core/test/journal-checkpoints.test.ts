import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Journal } from '../src/journal.ts';
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
  // The Worker's connection closed first, so the journal's was the last one and removed the WAL.
  expect(existsSync(`${file}-wal`)).toBe(false);
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
