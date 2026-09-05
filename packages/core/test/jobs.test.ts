import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { dlopen, FFIType, ptr } from 'bun:ffi';
import type { Pointer } from 'bun:ffi';
import { RpcErrorCode } from '@boite/contracts';
import type { ProcessRecord, ThreadSummary } from '@boite/contracts';
import { echoThread, startTestCore } from './harness.ts';
import type { TestCore } from './harness.ts';

const onWindows = process.platform === 'win32';
const describeWindows = onWindows ? describe : describe.skip;

const STILL_ACTIVE = 259;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

const k32 = onWindows
  ? dlopen('kernel32.dll', {
      OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
      GetExitCodeProcess: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
    }).symbols
  : null;

/** True while the pid still exists and has not exited. */
function isRunning(pid: number): boolean {
  if (k32 === null) return false;
  const handle = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  if (handle === null || Number(handle) === 0) return false;
  const code = new Uint32Array(1);
  const ok = k32.GetExitCodeProcess(handle as Pointer, ptr(code));
  k32.CloseHandle(handle as Pointer);
  return ok !== 0 && code[0] === STILL_ACTIVE;
}

function isPing(record: ProcessRecord): boolean {
  return record.exe.toLowerCase().endsWith('ping.exe');
}

/** Same wait as the harness, but the failure says which condition gave up. */
async function until(label: string, predicate: () => boolean, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

let harness: TestCore;

beforeEach(async () => {
  harness = await startTestCore();
});

afterEach(async () => {
  harness.core.procs.killAll();
  await harness.stop();
});

describeWindows('windows job objects', () => {
  test('the whole tree a turn launches is traced, measured and killed', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    await client.call('threads.subscribe', { threadId });

    const started: ProcessRecord[] = [];
    client.on('process.started', (record) => {
      if (record.threadId === threadId) started.push(record);
    });
    const exited: ProcessRecord[] = [];
    client.on('process.exited', (record) => {
      if (record.threadId === threadId) exited.push(record);
    });
    const loads: ThreadSummary[] = [];
    client.on('thread.updated', (thread) => {
      if (thread.id === threadId) loads.push(thread);
    });

    await client.call('turns.start', { threadId, prompt: '[spawn:ping -n 30 127.0.0.1]' });

    // The shell is the direct child; its ping is only ever seen through the job.
    await until('both processes to be reported', () => started.length === 2, 10000);
    const shell = started[0];
    const ping = started[1];
    expect(shell?.pid).toBeGreaterThan(0);
    expect(ping?.pid).toBeGreaterThan(0);
    expect(ping?.pid).not.toBe(shell?.pid);
    expect(isPing(ping as ProcessRecord)).toBe(true);
    expect(ping?.parentPid).toBe(shell?.pid as number);
    expect(ping?.commandLine).toContain('-n 30');

    const trace = await client.call('trace.get', { threadId });
    expect(trace).toHaveLength(2);
    expect(trace.some((record) => record.pid === ping?.pid)).toBe(true);
    expect(trace.some((record) => record.pid === shell?.pid)).toBe(true);

    const resources = await client.call('resources.list', {});
    const mine = resources.find((entry) => entry.threadId === threadId);
    expect(mine?.live).toHaveLength(2);

    const thread = await client.call('threads.get', { threadId });
    expect(thread.load?.processes).toBe(2);
    expect(thread.load?.memoryBytes).toBeGreaterThan(0);

    await until('a thread.updated carrying the load', () => loads.some((entry) => entry.load?.processes === 2), 3000);
    const pushed = loads.find((entry) => entry.load?.processes === 2);
    expect(pushed?.load?.memoryBytes).toBeGreaterThan(0);

    const killed = await client.call('resources.killTree', { threadId });
    expect(killed.killed).toBe(2);

    await until('both pids to be gone', () => !isRunning(shell?.pid as number) && !isRunning(ping?.pid as number), 1000);
    await until('both exits to be reported', () => exited.length === 2, 5000);
    for (const record of exited) {
      expect(record.exitCode).not.toBeNull();
      expect(record.cpuMs).not.toBeNull();
      expect(record.exitedAt).not.toBeNull();
    }
  }, 30000);

  test('a grandchild that outlives its parent is still traced and still killed', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    await client.call('threads.subscribe', { threadId });

    const started: ProcessRecord[] = [];
    client.on('process.started', (record) => {
      if (record.threadId === threadId) started.push(record);
    });

    // `start /b` detaches: the shell is gone long before the ping is.
    await client.call('turns.start', { threadId, prompt: '[spawn:start /b ping -n 30 127.0.0.1]' });

    await until('the detached ping to be reported', () => started.some(isPing), 10000);
    const ping = started.find(isPing);
    const shell = started.find((record) => !isPing(record));
    expect(ping?.pid).toBeGreaterThan(0);
    await until('the shell to exit on its own', () => !isRunning(shell?.pid as number), 10000);
    expect(isRunning(ping?.pid as number)).toBe(true);

    const killed = await client.call('resources.killTree', { threadId });
    expect(killed.killed).toBeGreaterThan(0);
    await until('the detached ping to be killed', () => !isRunning(ping?.pid as number), 2000);
  }, 30000);
});

describe('job settings', () => {
  test('the CPU cap is a percentage and refuses anything past 100', async () => {
    const client = await harness.connect();

    const next = await client.call('settings.set', { agentCpuCapPercent: 50 });
    expect(next.agentCpuCapPercent).toBe(50);
    expect((await client.call('settings.get', {})).agentCpuCapPercent).toBe(50);

    let code = 0;
    let message = 'none';
    try {
      await client.call('settings.set', { agentCpuCapPercent: 101 });
    } catch (error) {
      code = (error as { rpc?: { code: number } }).rpc?.code ?? 0;
      message = (error as Error).message;
    }
    expect(code).toBe(RpcErrorCode.InvalidParams);
    expect(message).toContain('agentCpuCapPercent');
    expect((await client.call('settings.get', {})).agentCpuCapPercent).toBe(50);
  });
});
