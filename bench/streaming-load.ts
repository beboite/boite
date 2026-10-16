/**
 * Streaming journal load, isolated from provider processes and UI rendering.
 * Run: bun bench/streaming-load.ts [streams=128] [cycles=32]
 * Each scenario runs in a fresh process and writes a temporary SQLite journal.
 * The sampled peak is a lower bound, sampled after each synchronous cycle.
 * WAL autocheckpoint is off, so `walMiB` is every byte the run wrote to the WAL.
 * The `wide-row` scenario streams 60 s of text, on a simulated clock, into one
 * message that already holds 100 tool parts of 8 KB: one write every 500 ms.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../packages/core/src/journal.ts';

const numbers = process.argv.slice(1).filter(argument => /^\d+$/.test(argument)).map(Number);
const streams = Number(process.env.BOITE_STREAM_BENCH_STREAMS ?? numbers[0] ?? 128);
const cycles = Number(process.env.BOITE_STREAM_BENCH_CYCLES ?? numbers[1] ?? 32);
assert(Number.isSafeInteger(streams) && streams >= 1 && streams <= 128, 'streams must be 1..128');
assert(Number.isSafeInteger(cycles) && cycles >= 1 && cycles <= 128, 'cycles must be 1..128');
const initialBytes = 256 * 1024;
const mib = 1024 * 1024;

/** Counts writes of message rows and, where the journal has it, of `streaming_parts`. */
function countWrites(journal: Journal): () => number {
  journal.db.exec(`PRAGMA wal_autocheckpoint = 0;
    CREATE TABLE bench_writes (n INTEGER);
    INSERT INTO bench_writes VALUES (0);
    CREATE TRIGGER bench_parts AFTER UPDATE OF parts ON messages
    BEGIN UPDATE bench_writes SET n = n + 1; END;`);
  if (journal.db.query("SELECT 1 FROM sqlite_master WHERE name = 'streaming_parts'").get() !== null) {
    journal.db.exec(`CREATE TRIGGER bench_side_insert AFTER INSERT ON streaming_parts BEGIN UPDATE bench_writes SET n = n + 1; END;
      CREATE TRIGGER bench_side_update AFTER UPDATE ON streaming_parts BEGIN UPDATE bench_writes SET n = n + 1; END;`);
  }
  return () => (journal.db.query('SELECT n FROM bench_writes').get() as { n: number }).n;
}

/** The parts a restart reads: the row, with what a stream wrote beside it. */
function diskParts(journal: Journal, id: string): unknown[] {
  const parts = JSON.parse((journal.db.query('SELECT parts FROM messages WHERE id = ?').get(id) as { parts: string }).parts) as unknown[];
  if (journal.db.query("SELECT 1 FROM sqlite_master WHERE name = 'streaming_parts'").get() === null) return parts;
  for (const row of journal.db.query('SELECT part_index AS i, json FROM streaming_parts WHERE message_id = ?').all(id) as { i: number; json: string }[]) parts[row.i] = JSON.parse(row.json);
  return parts;
}

const walMiB = (file: string): number => statSync(`${file}-wal`).size / mib;
const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

async function wideRow(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'boite-streaming-load-'));
  const file = join(dir, 'journal.db');
  const journal = new Journal(file);
  const realNow = Date.now;
  try {
    const writes = countWrites(journal);
    let now = realNow();
    Date.now = () => now;
    const tools = Array.from({ length: 100 }, (_, n) => ({ type: 'tool' as const, toolId: `call_${n}`, name: 'Read', input: { file: `f${n}` }, status: 'done' as const, output: 'o'.repeat(8_000) }));
    journal.putMessage({ id: 'wide', threadId: 'thr', turnId: 'turn', role: 'assistant', state: 'streaming', createdAt: now, parts: [...tools, { type: 'text', text: '' }] });
    const walBefore = walMiB(file);
    const persists: number[] = [];
    let text = '';
    for (let round = 0; round < 120; round++) {
      const delta = `${round}`.padEnd(100, '.');
      text += delta;
      journal.appendDelta('thr', 'wide', 100, delta);
      journal.flushDeltas();
      now += 500;
      const started = performance.now();
      journal.persistMessages();
      persists.push(performance.now() - started);
    }
    const wal = walMiB(file) - walBefore;
    const parts = diskParts(journal, 'wide');
    assert.equal(parts.length, 101);
    assert.deepEqual(parts[100], { type: 'text', text });
    const rowKiB = (journal.db.query('SELECT length(parts) AS n FROM messages WHERE id = ?').get('wide') as { n: number }).n / 1024;
    console.log(JSON.stringify({
      scenario: 'wide-row', parts: 101, persists: persists.length, appendedChars: text.length, writes: writes(),
      walMiB: wal, persistP50Ms: median(persists), persistMaxMs: Math.max(...persists), rowKiB,
      platform: process.platform, bun: Bun.version,
    }));
  } finally {
    Date.now = realNow;
    journal.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function scenario(reads: boolean): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'boite-streaming-load-'));
  const previousDataDir = process.env.BOITE_DATA_DIR;
  let cleanupJournal: Journal | undefined;
  try {
    process.env.BOITE_DATA_DIR = dir;
    const file = join(dir, 'journal.db');
    const journal = new Journal(file);
    cleanupJournal = journal;
    const countedWrites = countWrites(journal);
    const initial = 'x'.repeat(initialBytes);
    journal.putMessage({ id: 'completed', threadId: 't0', turnId: 'previous', role: 'user', state: 'complete', createdAt: Date.now(), parts: [{ type: 'text', text: 'completed sentinel' }] });
    for (let i = 0; i < streams; i++) journal.putMessage({ id: `m${i}`, threadId: `t${i}`, turnId: `turn${i}`, role: 'assistant', state: 'streaming', createdAt: Date.now(), parts: [{ type: 'text', text: initial }] });
    Bun.gc(true);
    const walBefore = walMiB(file);
    const before = process.memoryUsage();
    const cpu = process.cpuUsage();
    let peakRss = before.rss;
    let peakHeap = before.heapUsed;
    let appended = '';
    const sample = (): void => {
      const memory = process.memoryUsage();
      peakRss = Math.max(peakRss, memory.rss);
      peakHeap = Math.max(peakHeap, memory.heapUsed);
    };
    const started = performance.now();
    for (let round = 0; round < cycles; round++) {
      const delta = `${round}:abcdefghabcdefghabcdefgh`;
      appended += delta;
      for (let i = 0; i < streams; i++) journal.appendDelta(`t${i}`, `m${i}`, 0, delta);
      journal.flushDeltas();
      if (reads) {
        const page = journal.listMessagePage('t0', { limit: 2 });
        assert.equal(page.messages[0]?.id, 'completed');
        assert.deepEqual(page.messages[0]?.parts, [{ type: 'text', text: 'completed sentinel' }]);
        assert.equal(page.messages[1]?.id, 'm0');
        assert.equal(page.messages[1]?.state, 'streaming');
        assert.deepEqual(page.messages[1]?.parts, [{ type: 'text', text: initial + appended }]);
      }
      sample();
    }
    const persistStarted = performance.now();
    journal.persistMessages();
    const persistMs = performance.now() - persistStarted;
    sample();
    const wallMs = performance.now() - started;
    const usedCpu = process.cpuUsage(cpu);
    const writes = countedWrites();
    const wal = walMiB(file) - walBefore;
    // Every message, including streams never read, must retain all deltas on disk.
    for (let i = 0; i < streams; i++) assert.deepEqual(diskParts(journal, `m${i}`), [{ type: 'text', text: initial + appended }]);
    const idleCpu = process.cpuUsage();
    const idleStart = performance.now();
    await Bun.sleep(750);
    const idleUsedCpu = process.cpuUsage(idleCpu);
    const idleWallMs = performance.now() - idleStart;
    console.log(JSON.stringify({
      scenario: reads ? 'stream-and-read-one' : 'stream-only', streams, cycles, initialBytes,
      wallMs, cpuMs: (usedCpu.user + usedCpu.system) / 1000, writes, persistMs, walMiB: wal,
      rssBeforeMiB: before.rss / mib, sampledPeakRssMiB: peakRss / mib,
      heapBeforeMiB: before.heapUsed / mib, sampledPeakHeapMiB: peakHeap / mib,
      idleWallMs, idleCpuMs: (idleUsedCpu.user + idleUsedCpu.system) / 1000,
      persistedRowsVerified: streams, readSnapshotsVerified: reads ? cycles : 0,
      platform: process.platform, bun: Bun.version,
    }));
  } finally {
    try { cleanupJournal?.close(); }
    finally {
      if (previousDataDir === undefined) delete process.env.BOITE_DATA_DIR;
      else process.env.BOITE_DATA_DIR = previousDataDir;
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

if (process.env.BOITE_STREAM_BENCH_CHILD === 'wide') {
  await wideRow();
} else if (process.env.BOITE_STREAM_BENCH_CHILD !== undefined) {
  await scenario(process.env.BOITE_STREAM_BENCH_CHILD === 'read');
} else {
  // A compiled binary relaunches itself; a source invocation also needs its script.
  const source = import.meta.path.endsWith('.ts') && !import.meta.path.includes('$bunfs') ? [import.meta.path] : [];
  for (const childScenario of ['stream', 'read', 'wide']) {
    const child = Bun.spawn({
      cmd: [process.execPath, ...source], windowsHide: true, stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, BOITE_STREAM_BENCH_CHILD: childScenario, BOITE_STREAM_BENCH_STREAMS: String(streams), BOITE_STREAM_BENCH_CYCLES: String(cycles) },
    });
    const [output, errors, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (errors) process.stderr.write(errors);
    if (exitCode !== 0) throw new Error(`streaming-load ${childScenario} child exited ${exitCode}`);
    process.stdout.write(output);
  }
}
