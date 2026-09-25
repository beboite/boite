import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { echoThread, startTestCore, waitFor } from './harness.ts';
import type { TestCore } from './harness.ts';

const LONG_CHILD = process.platform === 'win32' ? 'ping -n 30 127.0.0.1' : 'exec sleep 30';
/** POSIX tracks direct children only, so explicitly replace the fixture shell. */
const TREE_SIZE = process.platform === 'win32' ? 2 : 1;

let harness: TestCore;

/** Signal 0 checks that a pid exists without touching it. */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  harness = await startTestCore();
});

afterEach(async () => {
  await harness.stop();
});

describe('procs', () => {
  test.skipIf(process.platform !== 'win32')('spawnChild keeps native exit usage after the node exit callback', async () => {
    const threadId = 'native-child-usage';
    const child = harness.core.procs.spawnChild(threadId, process.execPath, ['-e', 'setTimeout(() => {}, 250)'], {
      cwd: harness.dataDir,
    });
    await new Promise<void>((resolve, reject) => { child.once('exit', () => resolve()); child.once('error', reject); });
    await waitFor(() => harness.core.procs.liveCount(threadId) === 0);
    const record = harness.core.journal.listProcesses(threadId, 10)[0];
    expect(record?.cpuMs).not.toBeNull();
    expect(record?.peakMemoryBytes).toBeGreaterThan(0);
    expect(record?.ioBytes).not.toBeNull();
  });
  test('killTree kills the child a turn spawned', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    await client.call('threads.subscribe', { threadId });

    const started = client.next('process.started', (record) => record.threadId === threadId, 10000);
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 20000);

    await client.call('turns.start', { threadId, prompt: `[spawn:${LONG_CHILD}]` });
    const child = await started;
    const exited = client.next('process.exited', (record) => record.pid === child.pid, 15000);
    expect(child.pid).toBeGreaterThan(0);
    expect(child.commandLine).toContain(LONG_CHILD);
    expect(child.exitedAt).toBeNull();

    // On Windows the Job Object also reports the shell's own ping child.
    await waitFor(() => harness.core.procs.liveCount(threadId) === TREE_SIZE, 5000);

    const resources = await client.call('resources.list', {});
    const mine = resources.find((entry) => entry.threadId === threadId);
    expect(mine?.live).toHaveLength(TREE_SIZE);

    const killed = await client.call('resources.killTree', { threadId });
    expect(killed.killed).toBe(TREE_SIZE);

    const gone = await exited;
    expect(gone.pid).toBe(child.pid);
    expect(gone.exitedAt).not.toBeNull();
    await waitFor(() => harness.core.procs.liveCount(threadId) === 0, 5000);

    await finished;
    const trace = await client.call('trace.get', { threadId });
    expect(trace).toHaveLength(TREE_SIZE);
    expect(trace[0]?.exitedAt).not.toBeNull();
  }, 30000);

  test('a thread with nothing running keeps its pid history, and a new process cancels the forgetting', async () => {
    const threadId = 'forget-when-idle';
    // The three maps the load tick walks. Without the timer they held every
    // thread the core ever ran, and the plugin store mints an id per call.
    const registry = harness.core.procs as unknown as {
      known: Map<string, Set<number>>;
      forgetTimers: Map<string, ReturnType<typeof setTimeout>>;
    };
    const first = harness.core.procs.spawnChild(threadId, process.execPath, ['-e', ''], { cwd: harness.dataDir });
    const pid = first.pid ?? 0;
    expect(pid).toBeGreaterThan(0);
    await new Promise<void>((resolve, reject) => { first.once('exit', () => resolve()); first.once('error', reject); });
    await waitFor(() => harness.core.procs.liveCount(threadId) === 0, 5000);

    // The history outlives the process on purpose: a job event for that pid is
    // a repeat, not a grandchild, and `known` is what tells the two apart.
    expect(registry.known.get(threadId)?.has(pid)).toBe(true);
    expect(registry.forgetTimers.has(threadId)).toBe(true);

    const second = harness.core.procs.spawnChild(threadId, process.execPath, ['-e', ''], { cwd: harness.dataDir });
    expect(registry.forgetTimers.has(threadId)).toBe(false);
    await new Promise<void>((resolve, reject) => { second.once('exit', () => resolve()); second.once('error', reject); });
    await waitFor(() => harness.core.procs.liveCount(threadId) === 0, 5000);
    expect(registry.forgetTimers.has(threadId)).toBe(true);
  }, 15000);

  test.skipIf(process.platform === 'win32')('off Windows killTree reaches what the child started', async () => {
    const threadId = 'posix-group';
    // The shell prints the pid of its background sleep, then waits on it.
    const spawned = harness.core.procs.spawn(threadId, 'sh', ['-c', 'sleep 30 & echo $!; wait']);
    const reader = spawned.proc.stdout.getReader();
    const { value } = await reader.read();
    const grandchild = Number(new TextDecoder().decode(value).trim());
    expect(grandchild).toBeGreaterThan(0);

    expect(harness.core.procs.killTree(threadId)).toBe(1);
    await spawned.exited;
    await waitFor(() => !isRunning(grandchild), 5000);
  }, 15000);

  test.skipIf(process.platform === 'win32')('off Windows a child that ignores SIGTERM still lets its thread stop', async () => {
    const threadId = 'posix-stubborn';
    const spawned = harness.core.procs.spawn(threadId, 'sh', ['-c', 'trap "" TERM; echo ready; while :; do sleep 1; done']);
    await spawned.proc.stdout.getReader().read();
    const started = Date.now();
    await harness.core.procs.stopAndWait(threadId);
    expect(Date.now() - started).toBeLessThan(5000);
  }, 15000);

  test('resources.list carries threads that ran something, and no archived thread with nothing running', async () => {
    const client = await harness.connect();
    const ran = await echoThread(harness, client, 'ran a process');
    const idle = await echoThread(harness, client, 'never ran one');
    const archived = await echoThread(harness, client, 'ran one, then archived');
    const quick = process.platform === 'win32' ? ['cmd', ['/c', 'exit 0']] as const : ['true', []] as const;
    for (const threadId of [ran.threadId, archived.threadId]) {
      await harness.core.procs.spawn(threadId, quick[0], [...quick[1]]).exited;
      await waitFor(() => harness.core.procs.liveCount(threadId) === 0, 5000);
    }
    await client.call('threads.archive', { threadId: archived.threadId, archived: true });

    const resources = await client.call('resources.list', {});
    const ids = resources.map((entry) => entry.threadId);
    expect(ids).toContain(ran.threadId);
    expect(ids).not.toContain(idle.threadId);
    expect(ids).not.toContain(archived.threadId);
    const mine = resources.find((entry) => entry.threadId === ran.threadId);
    expect(mine).toMatchObject({ title: 'ran a process', live: [], totals: { processes: 1 } });
  }, 20000);

  test('the trace capability says what it can promise on this OS', async () => {
    const client = await harness.connect();
    if (process.platform === 'win32') {
      expect(client.core.trace.mode).toBe('events');
      expect(client.core.trace.note).toContain('Job Object');
      return;
    }
    expect(client.core.trace.mode).toBe('poll');
    expect(client.core.trace.note).toContain('Windows-only');
  });
});
