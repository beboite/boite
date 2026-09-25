import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Bus } from '../src/bus.ts';
import { createPosixPlatform } from '../src/platform/posix.ts';
import type { ProcessEventSink, ProcessPlatform } from '../src/platform/types.ts';
import { ProcRegistry } from '../src/procs.ts';
import { echoThread, startTestCore, waitFor } from './harness.ts';
import type { TestCore } from './harness.ts';

const FORGET_MS = 40;
const EXIT = { exitCode: 0, cpuMs: 5, peakMemoryBytes: 1024, ioBytes: null };

let harness: TestCore;
let procs: ProcRegistry;
let sink: ProcessEventSink;

beforeEach(async () => {
  harness = await startTestCore();
  // A job that reports what the test says, over the core's own journal.
  const platform: ProcessPlatform = {
    ...createPosixPlatform('linux'),
    retain(jobs) {
      sink = jobs;
    },
  };
  procs = new ProcRegistry(harness.core.journal, new Bus(), platform, { forgetDelayMs: FORGET_MS });
});

afterEach(async () => {
  await procs.close();
  await harness.stop();
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
