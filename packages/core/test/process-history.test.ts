import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { RpcEvents } from '@boite/contracts';
import { Bus } from '../src/bus.ts';
import { createPosixPlatform } from '../src/platform/posix.ts';
import type { GuardEventSink, NativeProcessInfo, ProcessEventSink, ProcessPlatform } from '../src/platform/types.ts';
import { ProcRegistry } from '../src/procs.ts';
import { DEFAULT_SETTINGS } from '../src/settings.ts';
import { echoThread, startTestCore, waitFor } from './harness.ts';
import type { TestCore } from './harness.ts';

const FORGET_MS = 40;
const EXIT = { exitCode: 0, cpuMs: 5, peakMemoryBytes: 1024, ioBytes: null };

let harness: TestCore;
let procs: ProcRegistry;
let sink: ProcessEventSink;
let guards: GuardEventSink;
let bus: Bus;
let added: number[];
let removed: number[];
let created: Map<number, number>;
let sampled: { pid: number; bytes: number }[];
let stopped: number[];

beforeEach(async () => {
  harness = await startTestCore();
  bus = new Bus();
  added = [];
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
    pidAdded: (_threadId, pid) => { added.push(pid); },
    pidRemoved: (_threadId, pid) => { removed.push(pid); },
    sample: () => ({ processes: sampled.length, cpuPercent: 0, memoryBytes: sampled.reduce((sum, process) => sum + process.bytes, 0), workingSets: sampled }),
    machineMemory: () => ({ totalBytes: 32 * 1024 ** 3, availableBytes: 24 * 1024 ** 3 }),
    terminateProcess: (_threadId, pid) => { stopped.push(pid); return true; },
  };
  procs = new ProcRegistry(harness.core.journal, bus, platform, { forgetDelayMs: FORGET_MS });
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
