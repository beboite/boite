import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setDriver } from '../src/drivers/index.ts';
import type { Driver, TurnResult } from '../src/drivers/types.ts';
import type { SpawnedProcess } from '../src/procs.ts';
import type { NativeProcessExit } from '../src/platform/types.ts';
import type { ProcessRecord } from '@boite/contracts';
import { STOP_DEADLINE, STOP_DEADLINE_ERROR } from '../src/threads/turn-runner.ts';
import { echoThread, startTestCore, waitFor } from './harness.ts';
import type { TestCore } from './harness.ts';

const saved = { ...STOP_DEADLINE };
let harness: TestCore;
let finishNativeStopTrace: (() => void) | undefined;

beforeEach(async () => {
  STOP_DEADLINE.ms = 100;
  STOP_DEADLINE.forceMs = 100;
  harness = await startTestCore();
});

afterEach(async () => {
  Object.assign(STOP_DEADLINE, saved);
  try { await harness.stop(); }
  finally { finishNativeStopTrace?.(); finishNativeStopTrace = undefined; }
});

test('a driver that never settles its stop is ended by the core', async () => {
  let wedged = true;
  const restore = setDriver('echo', {
    protocol: 'echo',
    startTurn() {
      // The first turn ignores its stop for good; the next one answers at once.
      if (wedged) {
        wedged = false;
        return { stop() {}, done: new Promise<TurnResult>(() => {}) };
      }
      return { stop() {}, done: Promise.resolve({ status: 'done', sessionId: null, usage: null }) };
    },
  } as unknown as Driver);
  const kills: string[] = [];
  const killTree = harness.core.procs.killTree.bind(harness.core.procs);
  harness.core.procs.killTree = (id: string) => { kills.push(id); return killTree(id); };
  try {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    const projectId = harness.core.journal.getThread(threadId)?.projectId ?? '';
    const { id: turnId } = await client.call('turns.start', { threadId, prompt: 'hi' });
    await waitFor(() => harness.core.threads.get(threadId).status === 'running');
    await client.call('turns.stop', { threadId });
    await waitFor(() => harness.core.journal.getTurn(turnId)?.status === 'stopped', 3000);
    expect(harness.core.journal.getTurn(turnId)?.error).toBe(STOP_DEADLINE_ERROR);
    expect(kills).toContain(threadId);
    await waitFor(() => harness.core.threads.get(threadId).status === 'idle', 3000);

    // The thread takes a new turn, and a project removal no longer waits on it.
    const second = await client.call('turns.start', { threadId, prompt: 'again' });
    await waitFor(() => harness.core.journal.getTurn(second.id)?.status === 'done', 3000);
    await client.call('projects.remove', { projectId });
  } finally {
    restore();
  }
}, 15_000);

test('a driver that settles its stop in time is never killed', async () => {
  const restore = setDriver('echo', {
    protocol: 'echo',
    startTurn() {
      const settled = Promise.withResolvers<TurnResult>();
      return { stop() { settled.resolve({ status: 'stopped', sessionId: null, usage: null }); }, done: settled.promise };
    },
  } as unknown as Driver);
  const kills: string[] = [];
  const killTree = harness.core.procs.killTree.bind(harness.core.procs);
  harness.core.procs.killTree = (id: string) => { kills.push(id); return killTree(id); };
  try {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    const { id: turnId } = await client.call('turns.start', { threadId, prompt: 'hi' });
    await waitFor(() => harness.core.threads.get(threadId).status === 'running');
    await client.call('turns.stop', { threadId });
    await waitFor(() => harness.core.journal.getTurn(turnId)?.status === 'stopped', 3000);
    await Bun.sleep(STOP_DEADLINE.ms + STOP_DEADLINE.forceMs + 100);
    expect(kills).not.toContain(threadId);
    expect(harness.core.journal.getTurn(turnId)?.error).toBeNull();
  } finally {
    restore();
  }
}, 15_000);

test.each([true, false])('worktree entry preserves an early stop (%s) before native preparation', async stopped => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let starts = 0;
  const restoreDriver = setDriver('echo', {
    protocol: 'echo',
    startTurn() {
      starts++;
      return { stop() {}, done: Promise.resolve({ status: 'done', sessionId: null, usage: null }) };
    },
  } as Driver);
  const client = await harness.connect();
  const { threadId } = await echoThread(harness, client);
  const originalEnter = harness.core.delegation.worktrees.enter.bind(harness.core.delegation.worktrees);
  const enter = spyOn(harness.core.delegation.worktrees, 'enter').mockImplementation(id => {
    if (id !== threadId) return originalEnter(id);
    entered.resolve();
    return release.promise;
  });
  const checkpoint = spyOn(harness.core.threads.codeCheckpoints, 'begin');
  try {
    const turn = await client.call('turns.start', { threadId, prompt: 'Accepted before worktree entry' });
    await entered.promise;
    expect(harness.core.scheduler.state().running.some(row => row.turnId === turn.id)).toBe(true);
    expect(starts).toBe(0);
    if (stopped) expect(await client.call('turns.stop', { threadId })).toEqual({ stopped: true });
    release.resolve();
    await waitFor(() => harness.core.scheduler.state().running.length === 0);
    expect(harness.core.journal.getTurn(turn.id)?.status).toBe(stopped ? 'stopped' : 'done');
    expect(starts).toBe(stopped ? 0 : 1);
    expect(checkpoint).toHaveBeenCalledTimes(stopped ? 0 : 1);
    expect(harness.core.journal.listMessages(threadId).some(message => message.role === 'user'
      && message.parts.some(part => part.type === 'text' && part.text === 'Accepted before worktree entry'))).toBe(true);
    expect(await client.call('turns.stop', { threadId })).toEqual({ stopped: false });
    const next = await client.call('turns.start', { threadId, prompt: 'A subsequent turn' });
    await waitFor(() => harness.core.scheduler.state().running.length === 0);
    expect(harness.core.journal.getTurn(next.id)?.status).toBe('done');
    expect(starts).toBe(stopped ? 1 : 2);
  } finally {
    release.resolve();
    await waitFor(() => harness.core.scheduler.state().running.length === 0);
    enter.mockRestore();
    checkpoint.mockRestore();
    restoreDriver();
  }
});

test.each([true, false])('worktree Git failure preserves an accepted stop (%s) and genuine errors', async stopped => {
  const entered = Promise.withResolvers<void>();
  const gate = join(harness.dataDir, 'finish-worktree-git');
  let starts = 0, child: SpawnedProcess | undefined;
  const restoreDriver = setDriver('echo', {
    protocol: 'echo',
    startTurn() {
      starts++;
      return { stop() {}, done: Promise.resolve({ status: 'done', sessionId: null, usage: null }) };
    },
  } as Driver);
  const client = await harness.connect();
  const { threadId } = await echoThread(harness, client);
  const started = performance.now(), timeline: Array<Record<string, unknown>> = [];
  let failed = false;
  const record = (event: string, data: Record<string, unknown> = {}) => {
    timeline.push({ ms: Math.round((performance.now() - started) * 100) / 100, event, ...data });
  };
  // Observe the actual callback route; the fallback invokes onExit a second time.
  const registry = harness.core.procs as unknown as {
    onExit(id: string, pid: number, code: number | null, native?: NativeProcessExit, expected?: ProcessRecord): void;
    exitTimers: Map<number, unknown>;
    unassigned: Set<number>;
  };
  const originalExit = registry.onExit.bind(registry);
  const exits = spyOn(registry, 'onExit').mockImplementation((id, pid, code, native, expected) => {
    if (id !== threadId || pid !== child?.record.pid) return originalExit(id, pid, code, native, expected);
    record('onExit-before', { pid, code, native: native !== undefined, fallbackPending: registry.exitTimers.has(pid),
      unassigned: registry.unassigned.has(pid), mode: harness.core.procs.capability().mode,
      nativeStartedAt: native?.startedAt ?? null, nativeIncarnation: native?.incarnation ?? null });
    originalExit(id, pid, code, native, expected);
    record('onExit-after', { pid, fallbackPending: registry.exitTimers.has(pid), live: harness.core.procs.liveCount(id) });
  });
  const off = harness.core.bus.onAny((event, payload) => {
    if (event !== 'process.exited') return;
    const process = payload as ProcessRecord;
    if (process.threadId === threadId && process.pid === child?.record.pid) record('process.exited', { pid: process.pid, exitCode: process.exitCode });
  });
  finishNativeStopTrace = () => {
    record('after-harness-stop', { live: harness.core.procs.liveCount(threadId), fallbackPending: child ? registry.exitTimers.has(child.record.pid) : false });
    try { console.error('WORKTREE_GIT_STOP_TRACE', JSON.stringify({ platform: process.platform, stopped, failed, pid: child?.record.pid, timeline })); }
    finally { exits.mockRestore(); off(); }
  };
  const spawn = harness.core.procs.spawn.bind(harness.core.procs);
  const intercepted = spyOn(harness.core.procs, 'spawn').mockImplementation((id, command, args, options) => {
    if (id !== threadId || command !== 'git') return spawn(id, command, args, options);
    child = spawn(id, process.execPath, ['-e', `
      const { existsSync } = require('node:fs');
      setInterval(() => { if (existsSync(${JSON.stringify(gate)})) process.exit(7); }, 5);
    `], options);
    record('spawn-return', { pid: child.record.pid, parentPid: child.record.parentPid, startedAt: child.record.startedAt });
    const observed = child;
    void observed.proc.exited.then(code => record('bun-exited', { pid: observed.record.pid, code }));
    void observed.exited.then(code => record('registry-exited', { pid: observed.record.pid, code }));
    entered.resolve();
    return child;
  });
  const originalEnter = harness.core.delegation.worktrees.enter.bind(harness.core.delegation.worktrees);
  let first = true;
  const enter = spyOn(harness.core.delegation.worktrees, 'enter').mockImplementation(id => {
    if (id !== threadId || !first) return originalEnter(id);
    first = false;
    // Use the real Git helper and process registry; only the executable is synthetic.
    return harness.core.worktrees.head(id, harness.dataDir).then(() => undefined);
  });
  const checkpoint = spyOn(harness.core.threads.codeCheckpoints, 'begin');
  try {
    const turn = await client.call('turns.start', { threadId, prompt: 'Accepted before worktree Git' });
    await entered.promise;
    record('entered');
    expect(harness.core.procs.liveCount(threadId)).toBe(1);
    if (stopped) expect(await client.call('turns.stop', { threadId })).toEqual({ stopped: true });
    else writeFileSync(gate, 'fail');
    record('stop-or-fail-return');
    const exitCode = await child!.exited;
    expect(exitCode).not.toBe(0);
    if (!stopped) expect(exitCode).toBe(7);
    await waitFor(() => harness.core.scheduler.state().running.length === 0);
    const finished = harness.core.journal.getTurn(turn.id)!;
    expect(finished.status).toBe(stopped ? 'stopped' : 'error');
    if (stopped) expect(finished.error).toBeNull();
    else expect(finished.error).toContain('cannot read the commit checked out');
    expect(starts).toBe(0);
    expect(checkpoint).not.toHaveBeenCalled();
    expect(harness.core.journal.listMessages(threadId).some(message => message.role === 'user'
      && message.parts.some(part => part.type === 'text' && part.text === 'Accepted before worktree Git'))).toBe(true);
    record('before-live-assertion', { live: harness.core.procs.liveOf(threadId).map(({ pid, parentPid, startedAt, exitedAt, exitCode }) => ({
      pid, parentPid, startedAt, exitedAt, exitCode, runningSince: harness.core.procs.platform.runningSince(pid),
    })) });
    expect(harness.core.procs.liveCount(threadId)).toBe(0);
    if (stopped) expect(await client.call('turns.stop', { threadId })).toEqual({ stopped: false });
    const next = await client.call('turns.start', { threadId, prompt: 'After worktree Git failure' });
    await waitFor(() => harness.core.scheduler.state().running.length === 0);
    expect(harness.core.journal.getTurn(next.id)?.status).toBe('done');
    expect(starts).toBe(1);
  } catch (error) {
    failed = true;
    record('test-error');
    throw error;
  } finally {
    writeFileSync(gate, 'finish');
    await child?.exited;
    await waitFor(() => harness.core.scheduler.state().running.length === 0);
    enter.mockRestore();
    intercepted.mockRestore();
    checkpoint.mockRestore();
    restoreDriver();
  }
});
