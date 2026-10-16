/**
 * WAL checkpoint stalls during heavy streaming, on the real clock.
 * Run: bun bench/wal-checkpoints.ts [streams=16] [rounds=60] [intervalMs=500]
 * Each round appends 1 KiB to the text part of every stream, then flushes and
 * writes the streaming parts, timing that write on the event loop, and sleeps
 * `intervalMs`, the core's persist cadence, so timers and a checkpoint Worker
 * run between writes. Each text part starts at 64 KiB, so a round writes about
 * 1 MiB and the WAL passes 4 MiB every few rounds. A checkpoint run inside a
 * commit shows up in the maximum.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../packages/core/src/journal.ts';

const numbers = process.argv.slice(2).filter(argument => /^\d+$/.test(argument)).map(Number);
const streams = numbers[0] ?? 16;
const rounds = numbers[1] ?? 60;
const intervalMs = numbers[2] ?? 500;
assert(Number.isSafeInteger(streams) && streams >= 1 && streams <= 64, 'streams must be 1..64');
assert(Number.isSafeInteger(rounds) && rounds >= 1 && rounds <= 2_000, 'rounds must be 1..2000');
const mib = 1024 * 1024;

const dir = mkdtempSync(join(tmpdir(), 'boite-wal-checkpoints-'));
const file = join(dir, 'journal.db');
const journal = new Journal(file);
try {
  const initial = 'x'.repeat(64 * 1024);
  for (let i = 0; i < streams; i++) {
    journal.putMessage({ id: `m${i}`, threadId: `t${i}`, turnId: `turn${i}`, role: 'assistant', state: 'streaming', createdAt: Date.now(), parts: [{ type: 'text', text: initial }] });
  }
  const writes: number[] = [];
  const started = performance.now();
  for (let round = 0; round < rounds; round++) {
    const delta = `${round}:`.padEnd(1024, 'y');
    for (let i = 0; i < streams; i++) journal.appendDelta(`t${i}`, `m${i}`, 0, delta);
    const before = performance.now();
    journal.flushDeltas();
    journal.persistMessages();
    writes.push(performance.now() - before);
    await Bun.sleep(intervalMs);
  }
  const wallMs = performance.now() - started;
  const sorted = [...writes].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!;
  const checkpoints = (journal as unknown as { checkpoints?: { ran: { worker: number; main: number } } | null }).checkpoints?.ran ?? null;
  console.log(JSON.stringify({
    streams, rounds, intervalMs, wallMs: Math.round(wallMs),
    writeP50Ms: +at(0.5).toFixed(2), writeP99Ms: +at(0.99).toFixed(2), writeMaxMs: +sorted.at(-1)!.toFixed(2),
    walMiB: +(statSync(`${file}-wal`).size / mib).toFixed(2), checkpoints,
    platform: process.platform, bun: Bun.version,
  }));
} finally {
  journal.close();
  rmSync(dir, { recursive: true, force: true });
}
