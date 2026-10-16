/**
 * Streaming journal load, isolated from provider processes and UI rendering.
 * Run: bun bench/streaming-load.ts [streams=128] [cycles=32]
 * Each scenario runs in a fresh process and writes a temporary SQLite journal.
 * The sampled peak is a lower bound, sampled after each synchronous cycle.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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

async function scenario(reads: boolean): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'boite-streaming-load-'));
  const previousDataDir = process.env.BOITE_DATA_DIR;
  let cleanupJournal: Journal | undefined;
  try {
    process.env.BOITE_DATA_DIR = dir;
    const journal = new Journal(join(dir, 'journal.db'));
    cleanupJournal = journal;
    journal.db.exec(`CREATE TABLE bench_writes (n INTEGER);
      INSERT INTO bench_writes VALUES (0);
      CREATE TRIGGER bench_parts AFTER UPDATE OF parts ON messages
      BEGIN UPDATE bench_writes SET n = n + 1; END;`);
    const initial = 'x'.repeat(initialBytes);
    journal.putMessage({ id: 'completed', threadId: 't0', turnId: 'previous', role: 'user', state: 'complete', createdAt: Date.now(), parts: [{ type: 'text', text: 'completed sentinel' }] });
    for (let i = 0; i < streams; i++) journal.putMessage({ id: `m${i}`, threadId: `t${i}`, turnId: `turn${i}`, role: 'assistant', state: 'streaming', createdAt: Date.now(), parts: [{ type: 'text', text: initial }] });
    Bun.gc(true);
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
    journal.persistMessages();
    sample();
    const wallMs = performance.now() - started;
    const usedCpu = process.cpuUsage(cpu);
    const writes = (journal.db.query('SELECT n FROM bench_writes').get() as { n: number }).n;
    // Every row, including streams never read, must retain all deltas on disk.
    for (let i = 0; i < streams; i++) {
      const row = journal.db.query('SELECT parts FROM messages WHERE id = ?').get(`m${i}`) as { parts: string };
      assert.deepEqual(JSON.parse(row.parts), [{ type: 'text', text: initial + appended }]);
    }
    const idleCpu = process.cpuUsage();
    const idleStart = performance.now();
    await Bun.sleep(750);
    const idleUsedCpu = process.cpuUsage(idleCpu);
    const idleWallMs = performance.now() - idleStart;
    console.log(JSON.stringify({
      scenario: reads ? 'stream-and-read-one' : 'stream-only', streams, cycles, initialBytes,
      wallMs, cpuMs: (usedCpu.user + usedCpu.system) / 1000, writes,
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

if (process.env.BOITE_STREAM_BENCH_CHILD !== undefined) {
  await scenario(process.env.BOITE_STREAM_BENCH_CHILD === 'read');
} else {
  // A compiled binary relaunches itself; a source invocation also needs its script.
  const source = import.meta.path.endsWith('.ts') && !import.meta.path.includes('$bunfs') ? [import.meta.path] : [];
  for (const childScenario of ['stream', 'read']) {
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
