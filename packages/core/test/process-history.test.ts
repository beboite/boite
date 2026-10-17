import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RpcEvents } from '@boite/contracts';
import { Bus } from '../src/bus.ts';
import { Journal } from '../src/journal.ts';
import { TracePrune } from '../src/journal/processes.ts';
import { createPosixPlatform } from '../src/platform/posix.ts';
import type { GuardEventSink, NativeProcessInfo, ProcessEventSink, ProcessPlatform } from '../src/platform/types.ts';
import { ProcRegistry } from '../src/procs.ts';
import { nativeAgents } from '../src/native-agents.ts';
import { DEFAULT_SETTINGS } from '../src/settings.ts';
import { echoThread, startTestCore, waitFor } from './harness.ts';
import type { TestCore } from './harness.ts';
import { compactAll, schema35Journal } from './fixtures/journal-schema35.ts';

const FORGET_MS = 40;
const EXIT = { exitCode: 0, cpuMs: 5, peakMemoryBytes: 1024, ioBytes: null };

let harness: TestCore;
let procs: ProcRegistry;
let sink: ProcessEventSink;
let guards: GuardEventSink;
let bus: Bus;
let added: number[];
let unguarded: number[];
let removed: number[];
let created: Map<number, number>;
let sampled: { pid: number; bytes: number }[];
let stopped: number[];

beforeEach(async () => {
  harness = await startTestCore();
  bus = new Bus();
  added = [];
  unguarded = [];
  removed = [];
  created = new Map();
  sampled = [];
  stopped = [];
  // A job that reports what the test says, over the core's own journal.
  const platform: ProcessPlatform = {
    ...createPosixPlatform('linux', null),
    capability: () => ({ os: 'windows', mode: 'events', note: 'synthetic captured native events, no Windows execution' }),
    retain(jobs, guardEvents) {
      sink = jobs;
      guards = guardEvents;
    },
    startedAt: (pid) => created.get(pid) ?? null,
    runningSince: (pid) => created.get(pid) ?? null,
    pidAdded: (_threadId, pid, guarded) => { added.push(pid); if (!guarded) unguarded.push(pid); },
    pidRemoved: (_threadId, pid) => { removed.push(pid); },
    sample: () => ({ processes: sampled.length, cpuPercent: 0, memoryBytes: sampled.reduce((sum, process) => sum + process.bytes, 0), workingSets: sampled }),
    machineMemory: () => ({ totalBytes: 32 * 1024 ** 3, availableBytes: 24 * 1024 ** 3 }),
    terminateProcess: (_threadId, pid) => { stopped.push(pid); return true; },
  };
  procs = new ProcRegistry(harness.core.journal, bus, platform, { forgetDelayMs: FORGET_MS, loadIntervalMs: 20, idleLoadIntervalMs: 20 });
});

afterEach(async () => {
  await procs.close();
  bus.dispose();
  await harness.stop();
});

test('a warm thread traces a reused pid once and ignores old incarnation events', async () => {
  const threadId = 'plugin:warm:1';
  const info = (startedAt: number, incarnation: string): NativeProcessInfo & { startedAt: number; incarnation: string } => ({
    exe: 'tool', commandLine: null, parentPid: 9001, startedAt, incarnation,
  });
  const started: RpcEvents['process.started'][] = [];
  bus.onAny((name, payload) => { if (name === 'process.started') started.push(payload as RpcEvents['process.started']); });
  sink.started(threadId, 9001, info(1000, '10000000'));
  const first = info(2000, '20000000');
  created.set(9002, 2000);
  sink.started(threadId, 9002, first);
  sink.exited(threadId, 9002, { ...EXIT, startedAt: first.startedAt, incarnation: first.incarnation });
  expect(procs.liveOf(threadId).map(record => record.pid)).toEqual([9001]);

  // Reading today's occupant would misidentify this delayed old start.
  created.set(9002, 3000);
  sink.started(threadId, 9002, first);
  expect(procs.liveOf(threadId).map(record => record.pid)).toEqual([9001]);
  const second = info(3000, '30000000');
  sink.started(threadId, 9002, second);
  sink.started(threadId, 9002, second);
  expect(procs.liveOf(threadId).map(record => record.pid)).toEqual([9001, 9002]);
  expect(started).toHaveLength(3);
  expect(added).toEqual([9001, 9002, 9002]);

  // A duplicate old exit must leave the replacement registered with guards.
  sink.exited(threadId, 9002, { ...EXIT, startedAt: first.startedAt, incarnation: first.incarnation });
  sink.started(threadId, 9002, first);
  expect(procs.liveOf(threadId).find(record => record.pid === 9002)?.startedAt).toBe(3000);
  expect(removed).toEqual([9002]);
  sink.exited(threadId, 9002, EXIT);
  expect(procs.liveOf(threadId).find(record => record.pid === 9002)?.startedAt).toBe(3000);
  sampled = [{ pid: 9001, bytes: 1 }, { pid: 9002, bytes: 32 * 1024 ** 2 }];
  procs.applySettings({ ...DEFAULT_SETTINGS, threadMemoryCapMb: 16, reapOrphans: false });
  await waitFor(() => stopped.length > 0, 2000);
  expect(stopped).toEqual([9002]);
  sink.exited(threadId, 9002, { ...EXIT, cpuMs: 9, startedAt: second.startedAt, incarnation: second.incarnation });
  expect(removed).toEqual([9002, 9002]);
  expect(procs.liveOf(threadId).map(record => record.pid)).toEqual([9001]);
  // Exact native creation times distinguish two processes within the same ms.
  const third = info(3000, '30000001');
  sink.started(threadId, 9002, third);
  sink.started(threadId, 9002, second);
  sink.exited(threadId, 9002, { ...EXIT, startedAt: second.startedAt, incarnation: second.incarnation });
  expect(procs.liveOf(threadId).find(record => record.pid === 9002)?.startedAt).toBe(3001);
  sink.exited(threadId, 9002, { ...EXIT, cpuMs: 12, startedAt: third.startedAt, incarnation: third.incarnation });
  expect(started).toHaveLength(4);
  expect(harness.core.journal.listProcesses(threadId, 10)).toMatchObject([
    { pid: 9002, startedAt: 3001, cpuMs: 12 },
    { pid: 9002, startedAt: 3000, cpuMs: 9 },
    { pid: 9002, startedAt: 2000, cpuMs: 5 },
    { pid: 9001, startedAt: 1000, exitedAt: null },
  ]);
});

test('orphan sweeps use native birth order when reused pids need separate trace rows', () => {
  const info = (parentPid: number, incarnation: string): NativeProcessInfo => ({
    exe: 'tool', commandLine: null, parentPid, startedAt: 3000, incarnation,
  });
  const threadId = 'native-orphan';
  sink.started(threadId, 9002, info(8999, '30000000'));
  sink.exited(threadId, 9002, { ...EXIT, startedAt: 3000, incarnation: '30000000' });
  sink.started(threadId, 9002, info(8999, '30000001'));
  sink.started(threadId, 9003, info(9002, '30000002'));
  expect(procs.liveOf(threadId).find(record => record.pid === 9002)?.startedAt).toBe(3001);
  created.set(9002, 3000);
  created.set(8999, 2999);
  expect(procs.sweepOrphans(threadId, 40_000)).toEqual([]);
  // This occupant of the missing parent's pid was born after the orphan.
  created.set(8999, 3001);
  expect(procs.sweepOrphans(threadId, 40_000)).toEqual([9002, 9003]);

  stopped.length = 0;
  const replacementThread = 'native-parent-replacement';
  sink.started(replacementThread, 9002, info(process.pid, '30000000'));
  sink.started(replacementThread, 9003, info(9002, '30000001'));
  sink.exited(replacementThread, 9002, { ...EXIT, startedAt: 3000, incarnation: '30000000' });
  sink.started(replacementThread, 9002, info(process.pid, '30000002'));
  // A live replacement with the same millisecond is not this child's parent.
  expect(procs.sweepOrphans(replacementThread, 40_000)).toEqual([9003]);
  expect(stopped).toEqual([9003]);
});

test('a short direct child is not resurrected by its delayed native start', async () => {
  const threadId = 'plugin:short:1';
  const child = procs.spawn(threadId, process.execPath, ['-e', '']);
  await child.exited;
  expect(procs.liveCount(threadId)).toBe(0);
  sink.started(threadId, child.record.pid, { exe: 'tool', commandLine: null, parentPid: process.pid });
  sink.exited(threadId, child.record.pid, EXIT);
  expect(procs.liveCount(threadId)).toBe(0);
  expect(added).toEqual([child.record.pid]);
  expect(harness.core.journal.listProcesses(threadId, 10)).toHaveLength(1);
});

test('a shown app and the processes its job reports stay clear of the focus and audio guards', async () => {
  const threadId = 'plugin:bots:app';
  const app = procs.spawn(threadId, process.execPath, ['-e', ''], { showWindow: true });
  sink.started(threadId, 9301, { exe: 'webview', commandLine: null, parentPid: app.record.pid, startedAt: 1, incarnation: '1' });
  const tool = procs.spawn('plugin:tool:1', process.execPath, ['-e', '']);
  await Promise.all([app.exited, tool.exited]);
  expect(added).toEqual([app.record.pid, 9301, tool.record.pid]);
  expect(unguarded).toEqual([app.record.pid, 9301]);
});

test('process diagnostics carry correlation without copying window titles or platform output', () => {
  const secretText = 'private project window and arbitrary provider output';
  const logs: RpcEvents['core.log'][] = [];
  const focus: RpcEvents['process.focusPushed'][] = [];
  bus.onAny((name, payload) => {
    if (name === 'core.log') logs.push(payload as RpcEvents['core.log']);
    if (name === 'process.focusPushed') focus.push(payload as RpcEvents['process.focusPushed']);
  });
  guards.pushed('private-thread', 9002, secretText, true);
  guards.muted('private-thread', 9002);
  sink.note('private-thread', secretText);
  guards.note(secretText);
  sink.memoryLimit('private-thread', 'thread-cap');
  expect(focus).toMatchObject([{ threadId: 'private-thread', pid: 9002, title: secretText, restored: true }]);
  expect(JSON.stringify(logs)).not.toContain(secretText);
  expect(logs).toMatchObject([
    { source: 'process', event: 'process.focus-pushed', threadId: 'private-thread', message: 'a window of pid 9002 was pushed back; restored=true' },
    { source: 'process', event: 'process.muted', threadId: 'private-thread' },
    { source: 'process', event: 'platform.warning', threadId: 'private-thread' },
    { source: 'process', event: 'guard.warning' },
    { source: 'process', event: 'memory.limit', threadId: 'private-thread' },
  ]);
});

test('a process is one trace row, with no copy in the event log', () => {
  const events = harness.core.journal.countEvents();
  sink.started('plugin:fetch:1', 300, { exe: 'git', commandLine: 'git fetch', parentPid: null });
  sink.exited('plugin:fetch:1', 300, EXIT);
  expect(harness.core.journal.listProcesses('plugin:fetch:1', 10)).toMatchObject([{ pid: 300, exitCode: 0, cpuMs: 5 }]);
  expect(harness.core.journal.countEvents()).toBe(events);
});

test('an id with no thread behind it leaves no rows once it is forgotten, a thread keeps its trace', async () => {
  const client = await harness.connect();
  const { threadId } = await echoThread(harness, client);
  for (const [id, pid] of [['plugin:fetch:2', 400], [threadId, 401]] as const) {
    sink.started(id, pid, { exe: 'git', commandLine: 'git status', parentPid: null });
    sink.exited(id, pid, EXIT);
  }
  expect(harness.core.journal.listProcesses('plugin:fetch:2', 10)).toHaveLength(1);

  await waitFor(() => harness.core.journal.listProcesses('plugin:fetch:2', 10).length === 0, 2000);
  expect(harness.core.journal.listProcesses(threadId, 10)).toHaveLength(1);
});

test('a thread that never goes idle forgets the pids that exited past the forget delay', async () => {
  const threadId = 'terminal:watcher';
  sink.started(threadId, 500, { exe: 'shell', commandLine: null, parentPid: null, startedAt: 1, incarnation: '1' });
  for (let pid = 1000; pid < 2000; pid++) {
    sink.started(threadId, pid, { exe: 'rustc', commandLine: null, parentPid: 500, startedAt: pid, incarnation: String(pid) });
    sink.exited(threadId, pid, { ...EXIT, startedAt: pid, incarnation: String(pid) });
  }
  expect(procs.knownCount(threadId)).toBe(1001);
  // Twice the delay: a sweep runs at most once per delay, after the entries aged past it.
  await Bun.sleep(FORGET_MS * 2 + 100);
  expect(procs.liveOf(threadId).map(record => record.pid)).toEqual([500]);
  expect(procs.knownCount(threadId)).toBe(1);
});

test('a thread keeps its newest 2,000 trace rows, its live rows and the rows its agent cards read', async () => {
  const client = await harness.connect();
  const { threadId } = await echoThread(harness, client);
  const run = (pid: number, exe: string, commandLine: string | null, parentPid: number | null, exit = true) => {
    sink.started(threadId, pid, { exe, commandLine, parentPid, startedAt: pid, incarnation: String(pid) });
    if (exit) sink.exited(threadId, pid, { ...EXIT, startedAt: pid, incarnation: String(pid) });
  };
  run(1, 'shell', null, null, false);
  run(2, 'bash', 'bash -c claude', 1);
  run(3, 'claude', 'claude -p "Review parsing" --model opus', 2);
  for (let pid = 10; pid < 2110; pid++) run(pid, 'rustc', 'rustc --edition 2024', 1);
  const rows = () => harness.core.journal.db.query('SELECT pid FROM processes WHERE thread_id = ? ORDER BY started_at').all(threadId).map(row => (row as { pid: number }).pid);
  expect(rows()).toHaveLength(2103);
  // The exit wrote its columns into the start's row.
  expect(harness.core.journal.listProcesses(threadId, 1)).toMatchObject([{ pid: 2109, exitCode: 0, cpuMs: 5, commandLine: 'rustc --edition 2024' }]);

  expect(harness.core.journal.pruneProcesses(threadId)).toBe(100);
  expect(rows().slice(0, 4)).toEqual([1, 2, 3, 110]);
  expect(rows()).toHaveLength(2003);
  expect(nativeAgents(harness.core.journal, threadId).map(agent => [agent.name, agent.status])).toEqual([['Claude Code', 'done']]);

  // The thread going idle prunes again: the root's row is no longer live.
  sink.exited(threadId, 1, { ...EXIT, startedAt: 1, incarnation: '1' });
  await waitFor(() => rows().length === 2002, 2000);
  expect(rows().slice(0, 3)).toEqual([2, 3, 110]);
});

test('a schema 35 trace has its command lines stored once and every thread over the limit pruned in the background, agent cards kept', () => {
  const dir = mkdtempSync(join(tmpdir(), 'boite-trace-'));
  const file = join(dir, 'journal.db');
  const old = schema35Journal(file);
  const insert = old.query(`INSERT INTO processes (thread_id, pid, parent_pid, exe, command_line, started_at, exited_at, exit_code, cpu_ms, peak_memory_bytes, io_bytes)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, 5, 1024, NULL)`);
  old.transaction(() => {
    // A thread that finished before pruning ran every 500 exits: its whole trace, hooks with one command line.
    insert.run('thr_done', 1, null, 'shell', null, 1, null);
    insert.run('thr_done', 2, 1, 'bash', 'bash -c claude', 2, 3);
    insert.run('thr_done', 3, 2, 'claude', 'claude -p "Review parsing" --model opus', 3, 4);
    for (let pid = 10; pid < 2_610; pid++) insert.run('thr_done', pid, 1, 'bash', 'bash hooks/pre-tool.sh', pid, pid + 1);
    // A thread under the limit keeps everything.
    for (let pid = 10; pid < 110; pid++) insert.run('thr_small', pid, null, 'git', `git status ${pid % 2}`, pid, pid + 1);
  })();
  old.close();

  const journal = new Journal(file);
  try {
    const listed = (threadId: string) => journal.listProcesses(threadId, 5_000);
    const before = { done: listed('thr_done'), small: listed('thr_small') };
    expect(before.done[0]).toMatchObject({ pid: 2609, commandLine: 'bash hooks/pre-tool.sh' });
    compactAll(journal);
    const count = (sql: string) => (journal.db.query(sql).get() as { n: number }).n;
    expect(count('SELECT COUNT(*) AS n FROM processes WHERE command_line IS NOT NULL')).toBe(0);
    // One row per distinct command line, the pruned rows' included until the daily cleanup.
    expect(count('SELECT COUNT(*) AS n FROM command_lines')).toBe(5);
    const rows = journal.db.query("SELECT pid FROM processes WHERE thread_id = 'thr_done' ORDER BY started_at").all().map(row => (row as { pid: number }).pid);
    expect(rows).toHaveLength(2_003);
    expect(rows.slice(0, 4)).toEqual([1, 2, 3, 610]);
    expect(listed('thr_done')).toEqual(before.done.filter(record => rows.includes(record.pid)));
    expect(listed('thr_small')).toEqual(before.small);
    expect(nativeAgents(journal, 'thr_done').map(agent => [agent.name, agent.status])).toEqual([['Claude Code', 'done']]);

    // A new row names its command line too; a thread deleted leaves its lines to the daily cleanup.
    journal.putProcess({ threadId: 'thr_small', pid: 500, parentPid: null, exe: 'git', commandLine: 'git status 0', startedAt: 500, exitedAt: null, exitCode: null, cpuMs: null, peakMemoryBytes: null, ioBytes: null });
    expect(count('SELECT COUNT(*) AS n FROM command_lines')).toBe(5);
    expect(listed('thr_small')[0]).toMatchObject({ pid: 500, commandLine: 'git status 0' });
    journal.deleteThreads(['thr_small']);
    compactAll(journal, Date.now() + 86_400_001);
    expect((journal.db.query('SELECT text FROM command_lines ORDER BY id').all() as { text: string }[]).map(row => row.text))
      .toEqual(['bash -c claude', 'claude -p "Review parsing" --model opus', 'bash hooks/pre-tool.sh']);
  } finally {
    journal.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the background trace prune reads and deletes a bounded batch per call, keeping an agent whose parent sits chunks earlier', () => {
  const dir = mkdtempSync(join(tmpdir(), 'boite-trace-'));
  const journal = new Journal(join(dir, 'journal.db'));
  try {
    const put = (pid: number, exe: string, commandLine: string, parentPid: number | null) => journal.putProcess({
      threadId: 'thr_long', pid, parentPid, exe, commandLine, startedAt: pid, exitedAt: pid + 1, exitCode: 0, cpuMs: 1, peakMemoryBytes: null, ioBytes: null,
    });
    journal.db.transaction(() => {
      put(1, 'bash', 'bash -c claude', null);
      for (let pid = 10; pid < 8_010; pid++) put(pid, 'rustc', 'rustc --edition 2024', 1);
      put(5_000, 'claude', 'claude -p "Review parsing" --model opus', 1);
    })();
    const count = () => (journal.db.query("SELECT COUNT(*) AS n FROM processes WHERE thread_id = 'thr_long'").get() as { n: number }).n;
    const trace = new TracePrune(journal.db, 1_000);
    let through = '', calls = 0;
    for (let more = true; more; calls++) {
      const before = count();
      ({ through, more } = trace.step(through));
      expect(before - count()).toBeLessThanOrEqual(1_000);
    }
    // Chunks of the old rows read, then batches deleted, then the walk past the last thread.
    expect(calls).toBeGreaterThan(10);
    const pids = (journal.db.query("SELECT pid FROM processes WHERE thread_id = 'thr_long' ORDER BY started_at").all() as { pid: number }[]).map(row => row.pid);
    expect(pids).toHaveLength(2_002);
    expect(pids.slice(0, 3)).toEqual([1, 5_000, 6_010]);
  } finally {
    journal.close();
    rmSync(dir, { recursive: true, force: true });
  }
});