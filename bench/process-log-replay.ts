/**
 * Process records a log directory holds, played again through this
 * checkout's log store at their own times: what it would have written.
 * Reads the `core.<n>.ndjson` files of `<logs>` and writes only to a
 * temporary directory.
 *
 *   bun bench/process-log-replay.ts <logs>
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus } from '../packages/core/src/bus.ts';
import { DiagnosticLogs } from '../packages/core/src/logs.ts';

interface Logged { at: number; threadId?: string; event?: string; durationMs?: number; data?: { pid?: number; parentPid?: number; exe?: string; exitCode?: number | null; cpuMs?: number } }

const source = process.argv[2];
if (!source) throw new Error('usage: bun bench/process-log-replay.ts <logs directory>');
const records: Logged[] = [];
for (const file of readdirSync(source).filter((name) => /^core\.\d+\.ndjson$/.test(name))) {
  for (const line of readFileSync(join(source, file), 'utf8').split('\n')) {
    if (!line.includes('"source":"processes"')) continue;
    try { records.push(JSON.parse(line) as Logged); } catch { /* a line cut by a rotation */ }
  }
}
if (records.length < 2) throw new Error(`${source} holds fewer than two process records`);
records.sort((a, b) => a.at - b.at);
const span = (records.at(-1)!.at - records[0]!.at) / 1000;
const inputBytes = records.reduce((sum, record) => sum + JSON.stringify(record).length + 1, 0);

const directory = mkdtempSync(join(tmpdir(), 'boite-log-replay-'));
const logs = new DiagnosticLogs(directory);
const bus = new Bus();
logs.attach(bus);
const starts = new Map<string, number>();
// The store reads the clock to hold starts and gather batches: it runs at the records' own time.
const realNow = Date.now;
let clock = records[0]!.at, swept = clock, seen = 0;
Date.now = () => clock;
try {
  for (const record of records) {
    clock = record.at;
    if (clock - swept >= 1000) { (logs as unknown as { sweep(): void }).sweep(); swept = clock; }
    if (++seen % 200 === 0) await logs.flush();
    const pid = record.data?.pid ?? 0, threadId = record.threadId ?? '';
    const base = { pid, parentPid: record.data?.parentPid ?? null, threadId, exe: record.data?.exe ?? 'unknown', commandLine: '', peakMemoryBytes: null, ioBytes: null };
    if (record.event === 'process.started') {
      starts.set(`${threadId}:${pid}`, record.at);
      bus.emit('process.started', { ...base, startedAt: record.at, exitedAt: null, exitCode: null, cpuMs: null });
    } else if (record.event === 'process.exited') {
      const startedAt = starts.get(`${threadId}:${pid}`) ?? record.at - (record.durationMs ?? 0);
      bus.emit('process.exited', { ...base, startedAt, exitedAt: record.at, exitCode: record.data?.exitCode ?? null, cpuMs: record.data?.cpuMs ?? null });
    }
  }
} finally {
  bus.dispose();
  Date.now = realNow;
  await logs.close();
}
let written = 0, writtenBytes = 0;
for (const file of readdirSync(join(directory, 'logs')).filter((name) => name.endsWith('.ndjson'))) {
  written += readFileSync(join(directory, 'logs', file), 'utf8').split('\n').filter(Boolean).length;
  writtenBytes += statSync(join(directory, 'logs', file)).size;
}
rmSync(directory, { recursive: true, force: true });
const perMinute = (bytes: number) => (bytes / 1048576 / span * 60).toFixed(2);
console.log(`read: ${records.length} process records over ${span.toFixed(0)} s, ${(records.length / span).toFixed(1)}/s, ${perMinute(inputBytes)} MB/min`);
console.log(`written: ${written} records, ${(written / span).toFixed(1)}/s, ${perMinute(writtenBytes)} MB/min`);
