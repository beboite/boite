import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { dlopen, FFIType, ptr } from 'bun:ffi';
import type { Pointer } from 'bun:ffi';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RpcErrorCode } from '@boite/contracts';
import type { ProcessRecord, ThreadSummary } from '@boite/contracts';
import { cpuRateOfGlobalJob, memoryLimitOfJob, releaseThreadJob, sampleThreadJob } from '../src/platform/windows/jobs.ts';
import { commandLineOf, consoleHost, startedAs, whenCommandLineReads, type ProcessReads } from '../src/platform/windows/process-reads.ts';
import { jobPacketAction, MSG_JOB_MEMORY_LIMIT, MSG_NEW_PROCESS } from '../src/platform/windows/jobs-packets.ts';
import { resolveMemoryLimits } from '../src/memory-limits.ts';
import { nativeAgents } from '../src/native-agents.ts';
import { processPlatform } from '../src/platform/index.ts';
import { STARTUP_PRIORITY } from '../src/procs.ts';
import { echoThread, startTestCore, waitFor } from './harness.ts';
import type { TestCore } from './harness.ts';

const onWindows = process.platform === 'win32';
const describeWindows = onWindows ? describe : describe.skip;

const STILL_ACTIVE = 259;
/** Git for Windows' MSYS2 bash, the shell Claude Code runs its commands in. */
const GIT_BASH = 'C:\\Program Files\\Git\\usr\\bin\\bash.exe';
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
  await harness.core.procs.killAll();
  await harness.stop();
});

describeWindows('windows job objects', () => {
  test('load samples only the owning thread and drops its exited and forgotten pids', async () => {
    const procs = harness.core.procs;
    const first = procs.spawn('sample-first', 'ping', ['-n', '30', '127.0.0.1']);
    const second = procs.spawn('sample-second', 'ping', ['-n', '30', '127.0.0.1']);
    await until('both sample roots to be tracked', () =>
      sampleThreadJob('sample-first')?.workingSets?.some(row => row.pid === first.record.pid) === true
      && sampleThreadJob('sample-second')?.workingSets?.some(row => row.pid === second.record.pid) === true, 10000);
    expect(sampleThreadJob('sample-first')?.workingSets?.map(row => row.pid)).toEqual([first.record.pid]);
    expect(sampleThreadJob('sample-second')?.workingSets?.map(row => row.pid)).toEqual([second.record.pid]);
    procs.killTree('sample-first');
    await first.exited;
    await until('the first root to leave the live registry', () => procs.liveCount('sample-first') === 0, 5000);
    expect(sampleThreadJob('sample-first')?.workingSets).toEqual([]);
    expect(sampleThreadJob('sample-first')?.memoryBytes).toBe(0);
    expect(sampleThreadJob('sample-second')?.workingSets?.map(row => row.pid)).toEqual([second.record.pid]);
    releaseThreadJob('sample-first');
    expect(sampleThreadJob('sample-first')).toBeNull();
    await procs.killAll();
    await procs.close();
    expect(sampleThreadJob('sample-second')).toBeNull();
  }, 30000);

  test('launch priority expires without a ready signal and keeps caps and other threads unchanged', async () => {
    const deadline = STARTUP_PRIORITY.ms;
    STARTUP_PRIORITY.ms = 3000;
    try {
      harness.core.procs.spawn('initializing', 'ping', ['-n', '30', '127.0.0.1'], { startup: true });
      harness.core.procs.spawn('background', 'ping', ['-n', '30', '127.0.0.1']);
      const client = await harness.connect();
      await client.call('settings.set', { threadMemoryCapMb: 500, agentCpuCapPercent: 50 });
      expect(memoryLimitOfJob('initializing')).toMatchObject({ priority: 0x20, flags: 0x2220, bytes: Math.floor(500 * 1048576 * 1.1 / 4096) * 4096 });
      expect(memoryLimitOfJob('background')?.priority).toBe(0x4000);
      expect(cpuRateOfGlobalJob()).toEqual({ flags: 5, rate: 5000 });
      await until('launch priority to expire', () => memoryLimitOfJob('initializing')?.priority === 0x4000, 6000);
      expect(harness.core.procs.liveCount('initializing')).toBeGreaterThan(0);
      expect(cpuRateOfGlobalJob()).toEqual({ flags: 5, rate: 5000 });
    } finally {
      STARTUP_PRIORITY.ms = deadline;
    }
  });

  test('global and thread memory limits are resolved and updated on existing jobs', async () => {
    const client = await harness.connect();
    const child = harness.core.procs.spawn('memory-cap', 'ping', ['-n', '30', '127.0.0.1']);
    const totalBytes = processPlatform.machineMemory()!.totalBytes;
    for (const [percent, cap] of [[60, 0], [10, 1048576], [25, 300], [90, 0], [60, 0]] as const) {
      await client.call('settings.set', { agentMemoryBudgetPercent: percent, threadMemoryCapMb: cap });
      const resolved = resolveMemoryLimits(harness.core.settings.get(), totalBytes);
      expect(memoryLimitOfJob(null)).toMatchObject({ flags: 0x2200, bytes: Math.floor(Math.min(resolved.budgetMb * 1048576 * 1.1, totalBytes * 0.9) / 4096) * 4096 });
      expect(memoryLimitOfJob('memory-cap')).toEqual({ flags: 0x2220, priority: 0x4000, bytes: Math.floor(resolved.threadMemoryCapMb * 1048576 * 1.1 / 4096) * 4096 });
      expect(cpuRateOfGlobalJob()).toEqual({ flags: 5, rate: 7500 });
    }
    await client.call('settings.set', { memoryProtection: false });
    expect(memoryLimitOfJob(null)).toMatchObject({ flags: 0x2000, bytes: 0 });
    expect(memoryLimitOfJob('memory-cap')).toEqual({ flags: 0x2020, priority: 0x4000, bytes: 0 });
    expect(cpuRateOfGlobalJob()).toEqual({ flags: 5, rate: 7500 });
    await client.call('settings.set', { memoryProtection: true });
    expect(memoryLimitOfJob(null)?.flags).toBe(0x2200);
    expect(memoryLimitOfJob('memory-cap')?.flags).toBe(0x2220);
    harness.core.procs.killTree('memory-cap');
    await child.exited;
  });

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

    // Process discovery and title updates can arrive before the first memory sample.
    const measured = (entry: ThreadSummary) => entry.load?.processes === 2 && entry.load.memoryBytes > 0;
    await until('a thread.updated carrying measured memory', () => loads.some(measured), 3000);
    const pushed = loads.find(measured);
    expect(pushed?.load?.memoryBytes).toBeGreaterThan(0);
    const thread = await client.call('threads.get', { threadId });
    expect(thread.load?.processes).toBe(2);
    expect(thread.load?.memoryBytes).toBeGreaterThan(0);
    // The turn waits on the ping: a client replaces its row with the push, so the push keeps the row's clock.
    expect(pushed?.status).toBe('running');
    expect(pushed?.runningSince).toEqual(expect.any(Number));

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

  test('the orphan sweep stops a ping whose shell exited and keeps one whose shell runs', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    const procs = harness.core.procs;
    const kept = procs.spawn(threadId, 'cmd', ['/c', 'ping -n 30 127.0.0.1']);
    const left = procs.spawn(threadId, 'cmd', ['/c', 'start /b ping -n 30 127.0.0.1']);

    await until('both pings to be reported', () => procs.liveOf(threadId).filter(isPing).length === 2, 10000);
    await until('the detaching shell to leave the registry',
      () => !procs.liveOf(threadId).some((record) => record.pid === left.record.pid), 10000);
    const pings = procs.liveOf(threadId).filter(isPing);
    const orphan = pings.find((record) => record.parentPid === left.record.pid) as ProcessRecord;
    const control = pings.find((record) => record.parentPid === kept.record.pid) as ProcessRecord;
    expect(orphan).toBeDefined();
    expect(control).toBeDefined();

    // Read as the timer would, past the grace that follows a turn.
    expect(procs.sweepOrphans(threadId, Date.now() + 60_000)).toEqual([orphan.pid]);
    await until('the orphan to be gone', () => !isRunning(orphan.pid), 5000);
    await until('its exit to be reported', () => !procs.liveOf(threadId).some((record) => record.pid === orphan.pid), 5000);
    expect(isRunning(control.pid)).toBe(true);
    expect(isRunning(kept.record.pid)).toBe(true);
  }, 30000);

  // Git Bash forks a copy of the shell to exec each command, and the copy exits: the script's Windows parent is gone while its shell runs.
  (existsSync(GIT_BASH) ? test : test.skip)('the orphan sweep keeps a script Git Bash runs while its shell runs, and stops it once the shell is gone', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    const procs = harness.core.procs;
    // The trailing `:` keeps bash from exec'ing the script in place, as a background task's shell does.
    const shell = procs.spawn(threadId, GIT_BASH, ['-c', '/usr/bin/sh -c "while :; do /usr/bin/sleep 30; done"; :']);
    const script = (): ProcessRecord | undefined => procs.liveOf(threadId).find((record) => /[\\/]sh\.exe$/i.test(record.exe));
    const sleep = (): ProcessRecord | undefined => procs.liveOf(threadId).find((record) => /[\\/]sleep\.exe$/i.test(record.exe));
    await until('the script and its sleep to be reported', () => script() !== undefined && sleep() !== undefined, 10000);
    const sh = script() as ProcessRecord;
    const nap = sleep() as ProcessRecord;
    await until('the fork stubs to exit', () => !procs.liveOf(threadId).some((record) => record.pid === sh.parentPid || record.pid === nap.parentPid), 10000);
    expect(isRunning(sh.parentPid as number)).toBe(false);

    expect(procs.sweepOrphans(threadId, Date.now() + 60_000)).toEqual([]);
    expect(isRunning(sh.pid)).toBe(true);
    expect(isRunning(nap.pid)).toBe(true);

    process.kill(shell.record.pid);
    await until('the shell to leave the registry', () => !procs.liveOf(threadId).some((record) => record.pid === shell.record.pid), 10000);
    expect(procs.sweepOrphans(threadId, Date.now() + 60_000).sort()).toEqual([sh.pid, nap.pid].sort());
    await until('the script to be gone', () => !isRunning(sh.pid) && !isRunning(nap.pid), 5000);
  }, 30000);

  (existsSync(GIT_BASH) ? test : test.skip)('stopping the thread stops a Git Bash script the orphan sweep keeps', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    const procs = harness.core.procs;
    procs.spawn(threadId, GIT_BASH, ['-c', '/usr/bin/sh -c "while :; do /usr/bin/sleep 30; done"; :']);
    const script = (): ProcessRecord | undefined => procs.liveOf(threadId).find((record) => /[\\/]sh\.exe$/i.test(record.exe));
    const sleep = (): ProcessRecord | undefined => procs.liveOf(threadId).find((record) => /[\\/]sleep\.exe$/i.test(record.exe));
    await until('the script and its sleep to be reported', () => script() !== undefined && sleep() !== undefined, 10000);
    const sh = script() as ProcessRecord;
    const nap = sleep() as ProcessRecord;
    await until('the fork stubs to exit', () => !procs.liveOf(threadId).some((record) => record.pid === sh.parentPid || record.pid === nap.parentPid), 10000);
    expect(procs.sweepOrphans(threadId, Date.now() + 60_000)).toEqual([]);

    // The thread's job goes whole, whatever the sweep kept.
    procs.killTree(threadId);
    await until('the script to be gone', () => !isRunning(sh.pid) && !isRunning(nap.pid), 5000);
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

  test('an agent CLI a nested job ends without an exit packet leaves the running count with its exit', async () => {
    // A test suite's own core does this to the CLIs it ran: TerminateJobObject on
    // its job, which posts their exits to no job above it.
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    const workDir = join(harness.dataDir, 'nested-job');
    const launcher = harness.core.procs.spawn(threadId, process.execPath, [join(import.meta.dir, 'fixtures', 'nested-job-cli.ts'), workDir, '1']);
    const agents = async () => (await client.call('delegation.get', { threadId })).nativeAgents.filter(agent => agent.source === 'process');
    const deadline = async (label: string, predicate: (found: Awaited<ReturnType<typeof agents>>) => boolean, timeoutMs: number) => {
      const started = Date.now();
      while (!predicate(await agents())) {
        if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}: ${JSON.stringify(await agents())}`);
        await Bun.sleep(50);
      }
    };
    await deadline('the CLI to run', found => found.some(agent => agent.status === 'running'), 15000);
    const [running] = await agents();
    expect(running).toMatchObject({ name: 'Claude Code', model: 'claude-haiku-5-5', status: 'running' });
    const pid = harness.core.procs.liveOf(threadId).find(record => `process:${threadId}:${record.pid}:${record.startedAt}` === running!.id)?.pid as number;
    expect(isRunning(pid)).toBe(true);

    writeFileSync(join(workDir, 'end'), '');
    await until('the nested job to end the CLI', () => !isRunning(pid), 5000);
    // The next load tick finds the exit the port never posted.
    await deadline('the CLI to leave the running count', found => !found.some(agent => agent.status === 'running'), 10000);
    expect(harness.core.procs.liveOf(threadId).map(record => record.pid)).not.toContain(pid);
    // The journal alone, as a restarted core or a client that reconnects reads it.
    const ended = nativeAgents(harness.core.journal, threadId).find(agent => agent.id === running!.id);
    expect(ended?.status).toBe('stopped');
    expect(ended?.finishedAt).toBeGreaterThanOrEqual(running!.startedAt);

    writeFileSync(join(workDir, 'exit'), '');
    await launcher.exited;
  }, 45000);

  test('a CPU cap set to 0 or 100 at runtime lifts the cap the global job already had', async () => {
    const client = await harness.connect();
    const threadId = 'cpu-cap';
    // A process in a thread job is what builds the global job the cap lives on.
    const child = harness.core.procs.spawn(threadId, 'ping', ['-n', '30', '127.0.0.1'], { startup: true });
    expect(cpuRateOfGlobalJob()).not.toBeNull();
    expect(memoryLimitOfJob(threadId)?.priority).toBe(0x20);

    const rateAfter = async (percent: number): Promise<{ flags: number; rate: number } | null> => {
      await client.call('settings.set', { agentCpuCapPercent: percent });
      return cpuRateOfGlobalJob();
    };
    // ENABLE | HARD_CAP, and the rate in hundredths of a percent.
    expect(await rateAfter(3)).toEqual({ flags: 0x5, rate: 300 });
    expect(await rateAfter(0)).toEqual({ flags: 0, rate: 0 });
    expect(memoryLimitOfJob(threadId)?.priority).toBe(0x4000);
    expect(await rateAfter(40)).toEqual({ flags: 0x5, rate: 4000 });
    expect(await rateAfter(100)).toEqual({ flags: 0, rate: 0 });

    for (const percent of [0, 100]) {
      await rateAfter(percent);
      const uncappedId = `uncapped-start-${percent}`;
      const uncapped = harness.core.procs.spawn(uncappedId, 'ping', ['-n', '30', '127.0.0.1'], { startup: true });
      expect(memoryLimitOfJob(uncappedId)?.priority).toBe(0x4000);
      expect(cpuRateOfGlobalJob()).toEqual({ flags: 0, rate: 0 });
      harness.core.procs.killTree(uncappedId);
      await uncapped.exited;
    }

    harness.core.procs.killTree(threadId);
    await child.exited;
  }, 30000);
});

test('a console host whose image name could not be read is still left out of the trace by its command line', () => {
  // The process a CI run caught: opened, its command line read, its image name refused.
  expect(consoleHost(null, String.raw`\??\C:\Windows\system32\conhost.exe 0x4`)).toBe(true);
  expect(consoleHost(null, String.raw`"C:\Windows\System32\conhost.exe" 0x4`)).toBe(true);
  expect(consoleHost(String.raw`C:\Windows\System32\OpenConsole.exe`, null)).toBe(true);
  // Only the system's own host: a real process whose path holds the name stays in the trace.
  expect(consoleHost(null, String.raw`C:\Tools\conhost.exe helpers\worker.exe --run`)).toBe(false);
  expect(consoleHost(null, String.raw`C:\Windows\System32\conhost.exe.bak\worker.exe`)).toBe(false);
  expect(consoleHost(null, String.raw`"C:\Windows\System32\conhost.exe tools\worker.exe" --run`)).toBe(false);
  expect(consoleHost(null, String.raw`"C:\Program Files\conhost.exe tools\bun.exe" -e 1`)).toBe(false);
  expect(consoleHost(String.raw`C:\bun\bun.exe`, 'conhost.exe 0x4')).toBe(false);
  expect(consoleHost(null, null)).toBe(false);
});

/**
 * A process handle whose parameters Windows writes only after `polls` command
 * line reads, and whose command line text stays zeros for `blank` reads more.
 */
function lateParameters(polls: number, text = 'ping -n 30 127.0.0.1', blank = 0): ProcessReads {
  const PEB = 0x1000n, PARAMETERS = 0x2000n, BUFFER = 0x3000n;
  const utf16 = new Uint8Array(Buffer.from(text, 'utf16le'));
  let reads = 0;
  const fail = () => false;
  return {
    hasNt: true,
    imageName: fail, exitCode: fail, processTimes: fail, ioCounters: fail, memoryInfo: fail,
    basicInfo(_proc, out) { reads++; new DataView(out.buffer).setBigUint64(8, PEB, true); return true; },
    readMemory(_proc, address, into) {
      const view = new DataView(into.buffer);
      if (address === PEB + 0x20n) view.setBigUint64(0, reads > polls ? PARAMETERS : 0n, true);
      else if (address === PARAMETERS + 0x70n) { view.setUint16(0, utf16.length, true); view.setBigUint64(8, BUFFER, true); }
      else if (address === BUFFER) into.set(reads > polls + blank ? utf16 : new Uint8Array(utf16.length));
      else return false;
      return true;
    },
  };
}

test('a process the job reports before Windows wrote its command line gets it once it reads', async () => {
  // windows-2025 reported a ping whose name and parent read and whose command line was still empty.
  const lines: (string | null)[] = [];
  const late = lateParameters(2);
  expect(commandLineOf(late, 1)).toBeNull();
  expect(whenCommandLineReads(late, 1, null, line => lines.push(line), 20, 1)).not.toBeNull();
  expect(lines).toEqual([]);
  await waitFor(() => lines.length > 0, 1000);
  expect(lines).toEqual(['ping -n 30 127.0.0.1']);

  // windows-2025 also read the command line's length while its text was still zeros (2026-10-22).
  const zeros: (string | null)[] = [];
  const unwritten = lateParameters(0, 'ping -n 30 127.0.0.1', 2);
  expect(commandLineOf(unwritten, 1)).toBeNull();
  whenCommandLineReads(unwritten, 1, null, line => zeros.push(line), 20, 1);
  await waitFor(() => zeros.length > 0, 1000);
  expect(zeros).toEqual(['ping -n 30 127.0.0.1']);

  // One that never gets parameters settles with none after its tries; one that exits first settles at once.
  const never: (string | null)[] = [];
  whenCommandLineReads(lateParameters(Infinity), 1, null, line => never.push(line), 3, 1);
  await waitFor(() => never.length > 0, 1000);
  expect(never).toEqual([null]);
  const exited: (string | null)[] = [];
  whenCommandLineReads(lateParameters(Infinity), 1, null, line => exited.push(line), 20, 50)!.flush();
  await Bun.sleep(80);
  expect(exited).toEqual([null]);

  // A command line read at once goes out before the call returns.
  const ready: (string | null)[] = [];
  expect(whenCommandLineReads(late, 1, 'ping -n 1 127.0.0.1', line => ready.push(line))).toBeNull();
  expect(ready).toEqual(['ping -n 1 127.0.0.1']);
});

test('a process that read neither its name nor its command line at its start is named once the wait ends, and a console host leaves', () => {
  // Windows CI, 2026-10-19: a console host entered prepared-drivers.test.ts's trace as `unknown`, with no command line.
  const named = (image: string | null): ProcessReads => ({
    ...lateParameters(Infinity),
    imageName(_proc, buffer, size) {
      if (image === null) return false;
      buffer.set(new Uint16Array(new Uint8Array(Buffer.from(image, 'utf16le')).buffer));
      size[0] = image.length;
      return true;
    },
  });
  expect(startedAs(named(String.raw`C:\Windows\System32\conhost.exe`), 1, null, null)).toBeNull();
  expect(startedAs(named(null), 1, null, String.raw`\??\C:\Windows\system32\conhost.exe 0x4`)).toBeNull();
  expect(startedAs(named(String.raw`C:\bun\bun.exe`), 1, null, null)).toBe(String.raw`C:\bun\bun.exe`);
  expect(startedAs(named(null), 1, String.raw`C:\bun\bun.exe`, 'bun -e 1')).toBe(String.raw`C:\bun\bun.exe`);
  expect(startedAs(named(null), 1, null, null)).toBe('unknown');
});

describe('the jobs Worker packet filter', () => {
  const GLOBAL = 1;
  const THREAD = 2;
  const EXIT_PROCESS = 7;

  test("a process start reaches the core once, through its thread's job, and the global budget alert still does", () => {
    expect(jobPacketAction(MSG_NEW_PROCESS, THREAD, 4242, GLOBAL)).toBe('open');
    expect(jobPacketAction(MSG_NEW_PROCESS, GLOBAL, 4242, GLOBAL)).toBe('drop');
    expect(jobPacketAction(EXIT_PROCESS, THREAD, 4242, GLOBAL)).toBe('post');
    expect(jobPacketAction(EXIT_PROCESS, GLOBAL, 4242, GLOBAL)).toBe('drop');
    expect(jobPacketAction(MSG_JOB_MEMORY_LIMIT, GLOBAL, 4242, GLOBAL)).toBe('post');
    expect(jobPacketAction(MSG_JOB_MEMORY_LIMIT, THREAD, 4242, GLOBAL)).toBe('post');
    // A start with no pid has nothing to open.
    expect(jobPacketAction(MSG_NEW_PROCESS, THREAD, 0, GLOBAL)).toBe('post');
  });
});

describe('job settings', () => {
  test('memory settings default to auto and persist explicit values', async () => {
    const client = await harness.connect();
    expect(await client.call('settings.get', {})).toMatchObject({ agentMemoryBudgetPercent: 60, memoryReserveMb: 0 });
    await client.call('settings.set', { agentMemoryBudgetPercent: 25, memoryReserveMb: 256 });
    expect(await client.call('settings.get', {})).toMatchObject({ agentMemoryBudgetPercent: 25, memoryReserveMb: 256 });
  });

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
