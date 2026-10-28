/**
 * Journal reads that grow with history: turn lookups on a thread with 2,000
 * turns, the answer text of a turn holding 35 MiB of tool output, and core
 * startup on a journal of 3,000 threads with 40 messages each.
 *
 *   bun bench/journal-reads.ts [--root <checkout>] [--runs 3]
 *
 * `--root` loads the core from another checkout, so the same script times the
 * base branch too. Each run builds its own data directories under the system
 * temporary directory and deletes them. Numbers are medians over the runs of
 * each run's median.
 *
 * - `noteMail`, `sessionBefore`, `stopQueuedCoordination`: one call on the
 *   2,000-turn thread whose last turn runs.
 * - `progress.report`: one streamed-delta report on that running turn.
 * - activity answer: the assistant text of a 30-message turn whose tool
 *   outputs (1.2 MB each) live in `part_blobs`, and the RSS the first read adds.
 * - startup: `new Core` on a copy of the seeded journal, its
 *   `startup.stores-ready` and `startup.recovered` phases, and a title recovery.
 * - thread list: `listThreads` on 4,000 threads of about 700 bytes each with 10
 *   messages, about the 3,660 threads in 2.3 MiB of a loaded machine's journal,
 *   each list after a thread write, with SQLite's default 2 MiB page cache and
 *   with the journal's own. The bytes each list reads from the file (Linux
 *   `rchar`, NaN elsewhere) are what a machine short of memory waits on the
 *   disk for.
 */
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const flag = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};
const root = resolve(flag('--root') ?? join(import.meta.dir, '..'));
const runs = Number(flag('--runs') ?? 3);
Object.assign(process.env, { BOITE_ECHO: '1', BOITE_HOST_AGENTS: '0', BOITE_TELEMETRY_URL: '', BOITE_TAILNET: '0' });

// Loaded by path so `--root` can name a checkout with an older Core.
const { Core } = await import(join(root, 'packages/core/src/core.ts')) as { Core: new (options: { dataDir: string; token: string }) => any };
const { Journal } = await import(join(root, 'packages/core/src/journal.ts')) as { Journal: new (file: string) => any };

const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1, costUsdEquivalent: 0.01 };
function thread(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, projectId: null, title: `Thread ${id}`, titleSource: 'user', providerId: 'echo', accountId: 'acct_echo', model: null, effort: null,
    cwd: tmpdir(), branch: null, permissionMode: 'default', status: 'idle', unread: false, archived: false, pinned: false, sessionId: 'ses_1',
    context: { used: 1, size: 2 }, createdAt: 1, updatedAt: 1, sessionGeneration: 0, selectionVersion: 0, ...extra,
  };
}
function turn(threadId: string, index: number, status = 'done'): Record<string, unknown> {
  return {
    id: `trn_${threadId}_${index}`, threadId, status, queuedAt: index, startedAt: index, finishedAt: status === 'done' ? index + 1 : null,
    usage: status === 'done' ? usage : null, error: null,
    execution: { providerId: 'echo', accountId: 'acct_echo', model: null, effort: null, permissionMode: 'default', sessionId: 'ses_1', sessionGeneration: 0, selectionVersion: 0 },
  };
}
const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
function time(iterations: number, run: () => void): number {
  for (let i = 0; i < 5; i++) run();
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const at = performance.now();
    run();
    samples.push(performance.now() - at);
  }
  return median(samples);
}

async function withCore<T>(measure: (core: any) => T): Promise<T> {
  const dataDir = mkdtempSync(join(tmpdir(), 'boite-journal-reads-'));
  const core = new Core({ dataDir, token: 'bench' });
  try { return measure(core); } finally {
    await core.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

function longThread(core: any): Record<string, number> {
  const journal = core.journal;
  const long = thread('thr_long');
  journal.putThread(long);
  for (let i = 0; i < 1999; i++) journal.putTurn(turn('thr_long', i));
  const running = turn('thr_long', 1999, 'queued');
  journal.putTurn(running);
  core.threads.progress.begin('thr_long', running.id);
  journal.putTurn({ ...running, status: 'running' });
  return {
    noteMailMs: time(200, () => core.threads.runner.noteMail('thr_long', Date.now())),
    sessionBeforeMs: time(200, () => core.threads.contexts.sessionBefore(long, running.id)),
    stopQueuedCoordinationMs: time(200, () => core.threads.stopQueuedCoordination('thr_long')),
    progressReportUs: time(5000, () => core.threads.progress.report('thr_long', running.id, 'working', null)) * 1000,
  };
}

function heavyTurn(core: any): Record<string, number> {
  const journal = core.journal;
  journal.putThread(thread('thr_tools'));
  const tools = turn('thr_tools', 0);
  journal.putTurn(tools);
  const output = 'x'.repeat(1_200_000);
  for (let m = 0; m < 30; m++) {
    journal.putMessage({
      id: `msg_${m}`, threadId: 'thr_tools', turnId: tools.id, role: 'assistant', state: 'complete', createdAt: m,
      parts: [{ type: 'text', text: `answer ${m}` }, { type: 'tool', toolId: `tool_${m}`, name: 'Read', status: 'done', input: {}, inputText: '{}', output: output + m }],
    });
  }
  Bun.gc(true);
  const before = process.memoryUsage().rss;
  const answer = (): string => core.activity.answer(tools);
  const at = performance.now();
  answer();
  const firstMs = performance.now() - at;
  const rssMiB = (process.memoryUsage().rss - before) / 2 ** 20;
  return { answerFirstMs: firstMs, answerMs: time(20, answer), answerRssMiB: rssMiB };
}

function seed(dir: string): void {
  const journal = new Journal(join(dir, 'journal.db'));
  journal.db.transaction(() => {
    for (let i = 0; i < 3000; i++) {
      const id = `thr_${i}`;
      journal.putThread(thread(id, { parentThreadId: i % 10 === 9 ? `thr_${i - 1}` : null, createdAt: i, updatedAt: i }));
      const first = turn(id, 0);
      journal.putTurn(first);
      for (let m = 0; m < 40; m++) {
        journal.putMessage({ id: `msg_${i}_${m}`, threadId: id, turnId: first.id, role: m % 2 ? 'assistant' : 'user', state: 'complete', createdAt: i * 100 + m,
          parts: [{ type: 'text', text: `message ${m} of thread ${i} `.repeat(8) }] });
      }
    }
  })();
  journal.close();
}

/** Bytes this process asked the kernel to read, from any file: Linux's `rchar`, NaN elsewhere. */
function bytesRead(): number {
  try { return Number(/^rchar: (\d+)$/m.exec(readFileSync('/proc/self/io', 'utf8'))![1]); } catch { return NaN; }
}

function listing(): Record<string, number> {
  const dataDir = mkdtempSync(join(tmpdir(), 'boite-journal-reads-list-'));
  const journal = new Journal(join(dataDir, 'journal.db'));
  try {
    journal.db.transaction(() => {
      for (let i = 0; i < 4000; i++) {
        const id = `thr_${i}`;
        journal.putThread(thread(id, { title: `Thread ${i} `.padEnd(600, '.'), createdAt: i, updatedAt: i }));
        for (let m = 0; m < 10; m++) {
          journal.putMessage({ id: `msg_${i}_${m}`, threadId: id, turnId: `trn_${id}_0`, role: m % 2 ? 'assistant' : 'user', state: 'complete', createdAt: i * 100 + m,
            parts: [{ type: 'text', text: `message ${m} of thread ${i}` }] });
        }
      }
    })();
    const own = (journal.db.query('PRAGMA cache_size').get() as { cache_size: number }).cache_size;
    const out: Record<string, number> = {};
    for (const [name, cache] of [['Default', -2000], ['', own]] as const) {
      journal.db.exec(`PRAGMA cache_size = ${cache}`);
      const first = journal.getThread('thr_0');
      journal.listThreads(); // Fills what this cache holds: the lists below read what it could not keep.
      let bytes = 0, lists = 0;
      out[`list${name}Ms`] = time(20, () => {
        journal.putThread({ ...first, updatedAt: first.updatedAt + ++lists });
        const before = bytesRead();
        journal.listThreads();
        bytes += bytesRead() - before;
      });
      out[`list${name}KiB`] = bytes / lists / 1024;
    }
    return out;
  } finally {
    journal.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function startup(seeded: string): Promise<Record<string, number>> {
  const dataDir = mkdtempSync(join(tmpdir(), 'boite-journal-reads-start-'));
  cpSync(seeded, dataDir, { recursive: true });
  try {
    const at = performance.now();
    const core = new Core({ dataDir, token: 'bench' });
    const coreMs = performance.now() - at;
    const titlesMs = time(5, () => core.threads.titles.recover());
    await core.close();
    const phases: Record<string, number> = {};
    for (const file of readdirSync(join(dataDir, 'logs')).filter(name => name.endsWith('.ndjson'))) {
      for (const line of readFileSync(join(dataDir, 'logs', file), 'utf8').split('\n')) {
        if (!line.includes('"startup.')) continue;
        const entry = JSON.parse(line) as { event?: string; durationMs?: number };
        if (entry.event && typeof entry.durationMs === 'number') phases[entry.event] = entry.durationMs;
      }
    }
    return { coreMs, storesReadyMs: phases['startup.stores-ready'] ?? NaN, recoveredMs: phases['startup.recovered'] ?? NaN, titlesMs };
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
}

const seeded = mkdtempSync(join(tmpdir(), 'boite-journal-reads-seed-'));
const results: Record<string, number[]> = {};
try {
  seed(seeded);
  for (let run = 0; run < runs; run++) {
    const sample = { ...await withCore(longThread), ...await withCore(heavyTurn), ...await startup(seeded), ...listing() };
    for (const [name, value] of Object.entries(sample)) (results[name] ??= []).push(value);
  }
} finally { rmSync(seeded, { recursive: true, force: true }); }
console.log(`journal reads, ${root}, ${runs} runs, medians`);
for (const [name, values] of Object.entries(results)) console.log(`${name.padEnd(26)} ${median(values).toFixed(3).padStart(10)}`);
