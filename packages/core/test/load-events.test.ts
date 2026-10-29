import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { RpcEvents, ThreadSummary } from '@boite/contracts';
import { Bus } from '../src/bus.ts';
import { connect, type CoreClient } from '../src/client.ts';
import { createPosixPlatform } from '../src/platform/posix.ts';
import type { ProcessEventSink, ProcessPlatform } from '../src/platform/types.ts';
import { ProcRegistry } from '../src/procs.ts';
import { DEFAULT_SETTINGS } from '../src/settings.ts';
import { echoThread, startTestCore, waitFor } from './harness.ts';
import type { TestCore } from './harness.ts';

const FAST_MS = 40;
const IDLE_MS = 200;

let harness: TestCore;
let bus: Bus;
let procs: ProcRegistry;
let sink: ProcessEventSink;
let samples: string[];
const clients: CoreClient[] = [];

beforeEach(async () => {
  harness = await startTestCore();
  bus = new Bus();
  samples = [];
  // A steady scope: the same process count and no CPU, so nothing but a turn keeps the tick fast.
  const platform: ProcessPlatform = {
    ...createPosixPlatform('linux', null),
    capability: () => ({ os: 'windows', mode: 'events', note: 'synthetic native events' }),
    retain(jobs) { sink = jobs; },
    pidAdded() {},
    pidRemoved() {},
    sample: (threadId) => { samples.push(threadId); return { processes: 1, cpuPercent: 0, memoryBytes: 1024 }; },
    machineMemory: () => ({ totalBytes: 32 * 1024 ** 3, availableBytes: 24 * 1024 ** 3 }),
  };
  procs = new ProcRegistry(harness.core.journal, bus, platform, { loadIntervalMs: FAST_MS, idleLoadIntervalMs: IDLE_MS });
  procs.applySettings({ ...DEFAULT_SETTINGS, reapOrphans: false });
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await procs.close();
  bus.dispose();
  await harness.stop();
});

const ticksOver = async (threadId: string, ms: number): Promise<number> => {
  const before = samples.filter(id => id === threadId).length;
  await Bun.sleep(ms);
  return samples.filter(id => id === threadId).length - before;
};

test('the load tick slows down while nothing works and speeds up as soon as a turn starts', async () => {
  const threadId = 'terminal:idle';
  sink.started(threadId, 700, { exe: 'shell', commandLine: null, parentPid: null, startedAt: 1, incarnation: '1' });
  // The first sample sees a new process count, so one more tick runs fast; then the idle pace.
  await Bun.sleep(FAST_MS * 3);
  const idle = await ticksOver(threadId, IDLE_MS * 5);
  expect(idle).toBeGreaterThanOrEqual(3);
  expect(idle).toBeLessThanOrEqual(7);

  // The re-arm is immediate: the next sample does not wait out the idle delay.
  const hurried = samples.length;
  bus.emit('turn.started', { threadId } as unknown as RpcEvents['turn.started']);
  await waitFor(() => samples.length > hurried, FAST_MS * 3);
  const running = await ticksOver(threadId, IDLE_MS * 5);
  expect(running).toBeGreaterThanOrEqual(12);

  bus.emit('turn.finished', { threadId } as unknown as RpcEvents['turn.finished']);
  await Bun.sleep(FAST_MS * 2);
  expect(await ticksOver(threadId, IDLE_MS * 5)).toBeLessThanOrEqual(7);
});

test('a scope with no thread behind it asks the thread table once while its load stands still', async () => {
  const threadId = 'system:devices';
  const getThread = harness.core.journal.getThread.bind(harness.core.journal);
  let asked = 0;
  harness.core.journal.getThread = (id) => { if (id === threadId) asked += 1; return getThread(id); };
  const loads: unknown[] = [];
  bus.onAny((name, payload) => { if (name === 'thread.load' || name === 'thread.updated') loads.push(payload); });
  bus.emit('turn.started', { threadId: 'elsewhere' } as unknown as RpcEvents['turn.started']);
  sink.started(threadId, 701, { exe: 'emulator', commandLine: null, parentPid: null, startedAt: 1, incarnation: '1' });
  await waitFor(() => samples.filter(id => id === threadId).length >= 5, 2000);
  expect(asked).toBe(1);
  expect(loads).toEqual([]);
});

test('a load sample is a load-only event for a client that accepts it and the whole row for an older one', async () => {
  const owner = await harness.connect();
  const { threadId } = await echoThread(harness, owner);
  const current = await connect(harness.url, harness.token, { accepts: ['thread.load'] });
  const legacy = await connect(harness.url, harness.token);
  clients.push(current, legacy);
  expect(current.core.features?.loadEvents).toBe(true);
  const seen = { current: [] as string[], legacy: [] as string[] };
  current.onAny(event => { if (event.startsWith('thread.')) seen.current.push(event); });
  legacy.onAny(event => { if (event.startsWith('thread.')) seen.legacy.push(event); });

  const load = { processes: 2, cpuPercent: 7.5, memoryBytes: 64 * 1024 * 1024 };
  const lean = current.next('thread.load', event => event.threadId === threadId, 3000);
  const full = legacy.next('thread.updated', row => row.id === threadId, 3000);
  harness.core.bus.emit('thread.load', { threadId, load });
  expect(await lean).toEqual({ threadId, load });
  const row: ThreadSummary = await full;
  expect(row).toMatchObject({ id: threadId, title: expect.any(String), status: 'idle', load });

  // A rename may still send real rows to both; the load sample reached each in one form only.
  await Bun.sleep(100);
  expect(seen.current.filter(event => event === 'thread.load')).toHaveLength(1);
  expect(seen.legacy.filter(event => event === 'thread.load')).toHaveLength(0);
});

test('a thread whose last process exits gets a zero load, so no client keeps counting it as running', async () => {
  const owner = await harness.connect();
  const { threadId } = await echoThread(harness, owner);
  const loads: RpcEvents['thread.load']['load'][] = [];
  bus.onAny((name, payload) => {
    const event = payload as RpcEvents['thread.load'];
    if (name === 'thread.load' && event.threadId === threadId) loads.push(event.load);
  });
  sink.started(threadId, 702, { exe: 'claude', commandLine: null, parentPid: null, startedAt: 1, incarnation: '1' });
  await waitFor(() => loads.some(load => load.processes === 1), 2000);

  sink.exited(threadId, 702, { exitCode: 0, cpuMs: null, peakMemoryBytes: null, ioBytes: null, startedAt: 1, incarnation: '1' });
  await waitFor(() => loads.at(-1)?.processes === 0, 2000);
  expect(loads.at(-1)).toEqual({ processes: 0, cpuPercent: 0, memoryBytes: 0 });
});
