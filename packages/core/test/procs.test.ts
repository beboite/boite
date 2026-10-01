import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { DEFAULT_DELEGATION_CONFIG } from '@boite/contracts';
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
    const record = harness.core.journal.listProcesses(threadId, 10).find(record => record.pid === child.pid);
    expect(record).toBeDefined();
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

  test('an archive stops the turn and the processes of the thread and its sub-threads, and leaves other threads alone', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client, 'archived while working');
    const { threadId: keptId } = await echoThread(harness, client, 'keeps working');
    const output: Promise<unknown>[] = [];
    const start = (id: string) => {
      const child = harness.core.procs.spawn(id, process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
      output.push(new Response(child.proc.stdout).text(), new Response(child.proc.stderr).text());
      return child;
    };
    const parent = harness.core.threads.require(threadId);
    await client.call('delegation.configure', { threadId, config: { ...DEFAULT_DELEGATION_CONFIG, enabled: true, profiles: [{ id: 'worker', name: 'Worker', providerId: parent.providerId, accountId: parent.accountId, model: parent.model!, effort: null }] } });
    const child = await client.call('delegation.spawn', { threadId, profileId: 'worker', task: 'long running '.repeat(500), requestId: 'archive-child' });
    const own = start(threadId);
    const sub = start(child.thread.id);
    const kept = start(keptId);
    const turn = await client.call('turns.start', { threadId, prompt: 'long running '.repeat(500) });
    try {
      await client.call('threads.archive', { threadId });
      await Promise.all([own.exited, sub.exited]);
      await waitFor(() => harness.core.procs.liveCount(threadId) === 0 && harness.core.procs.liveCount(child.thread.id) === 0, 5000);
      expect(harness.core.journal.getTurn(turn.id)?.status).toBe('stopped');
      expect(harness.core.scheduler.state()).toEqual({ running: [], queued: [] });
      expect(kept.proc.exitCode).toBeNull();
      expect(harness.core.procs.liveCount(keptId)).toBeGreaterThan(0);
    } finally {
      await Promise.all([threadId, child.thread.id, keptId].map(id => harness.core.procs.stopAndWait(id)));
      await Promise.all(output);
    }
  }, 20000);

  test('resources.list carries only the threads running something now, archived or not', async () => {
    const client = await harness.connect();
    const running = await echoThread(harness, client, 'runs a process');
    const done = await echoThread(harness, client, 'ran one, now done');
    const idle = await echoThread(harness, client, 'never ran one');
    // Windows may also report native descendants. The retained trace must match
    // all starts observed for this thread, including its explicitly spawned root.
    const started = new Set<number>();
    const off = harness.core.bus.onAny((name, payload) => {
      if (name === 'process.started' && (payload as { threadId: string }).threadId === done.threadId) {
        started.add((payload as { pid: number }).pid);
      }
    });
    const quick = process.platform === 'win32' ? ['cmd', ['/c', 'exit 0']] as const : ['true', []] as const;
    const completed = harness.core.procs.spawn(done.threadId, quick[0], [...quick[1]]);
    await completed.exited;
    await waitFor(() => harness.core.procs.liveCount(done.threadId) === 0, 5000);
    const long = process.platform === 'win32' ? ['cmd', ['/c', 'ping -n 30 127.0.0.1 > nul']] as const : ['sleep', ['30']] as const;
    // An archive ends what the thread ran; what starts under it afterwards is still listed.
    await client.call('threads.archive', { threadId: running.threadId, archived: true });
    harness.core.procs.spawn(running.threadId, long[0], [...long[1]]);
    await waitFor(() => harness.core.procs.liveCount(running.threadId) > 0, 5000);

    try {
      const resources = await client.call('resources.list', {});
      expect(resources.map((entry) => entry.threadId)).toEqual([running.threadId]);
      const [mine] = resources;
      expect(mine?.title).toBe('runs a process');
      expect(mine?.live.length).toBeGreaterThan(0);
      expect(mine?.live.every((record) => record.exitedAt === null)).toBe(true);
      expect(mine?.load.processes).toBe(mine?.live.length);
    } finally {
      await harness.core.procs.stopAndWait(running.threadId);
    }
    // The trace still has what exited.
    const trace = await client.call('trace.get', { threadId: done.threadId });
    off();
    expect(trace.map(record => record.pid).sort()).toEqual([...started].sort());
    expect(trace.filter(record => record.pid === completed.record.pid)).toHaveLength(1);
    expect(trace.find(record => record.pid === completed.record.pid)?.exitedAt).toBeNumber();
    // Windows can also report a console child; every recorded process must be finished.
    expect(trace.every(record => record.exitedAt !== null)).toBe(true);
    expect(await client.call('resources.list', {})).toEqual([]);
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
