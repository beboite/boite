import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { PullRequests } from '../src/pull-requests.ts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';

let harness: TestCore;
let restore: (() => void) | undefined;
beforeEach(async () => { harness = await startTestCore(); });
afterEach(async () => { restore?.(); restore = undefined; await harness.stop(); });

test('a lookup deadline cancels held output readers after the direct child exited', async () => {
  const client = await harness.connect();
  const { threadId } = await echoThread(harness, client);
  const thread = harness.core.threads.require(threadId);
  // Explicitly open readers make the deadline independent of native pipe lifetime.
  // Their asynchronous source cleanup remains pending after cancellation.
  const canceled: string[] = [];
  const hold = (name: string): ReadableStream<Uint8Array> => new ReadableStream({
    cancel: () => { canceled.push(name); return new Promise<void>(() => undefined); },
  });
  const stdout = hold('stdout'), stderr = hold('stderr');
  const spawn = harness.core.procs.spawn.bind(harness.core.procs);
  let owned: ReturnType<typeof spawn> | undefined;
  const intercepted = spyOn(harness.core.procs, 'spawn').mockImplementation((scope, _command, _args, options) => {
    owned = spawn(scope, process.execPath, ['-e', 'process.exit(0)'], options);
    return { ...owned, proc: new Proxy(owned.proc, {
      get: (target, name) => name === 'stdout' ? stdout : name === 'stderr' ? stderr : Reflect.get(target, name, target),
    }) };
  });
  restore = () => intercepted.mockRestore();
  const lookups = new PullRequests(harness.core, { timeoutMs: 1000 });
  let settled = false;
  let error: unknown;
  const pending = lookups.cleanCheckout({ ...thread, branch: 'topic' }).then(() => { settled = true; }, cause => { settled = true; error = cause; });
  try {
    await waitFor(() => owned !== undefined);
    expect(owned!.proc.pid).toBeGreaterThan(0);
    await owned!.exited;
    expect(owned!.proc.exitCode).toBe(0);
    expect(settled).toBe(false);
    await waitFor(() => settled, 2000);
    expect(String(error)).toContain('timed out');
    expect(canceled.sort()).toEqual(['stderr', 'stdout']);
    expect(stdout.locked).toBe(false);
    expect(stderr.locked).toBe(false);
    const reader = stdout.getReader();
    try { expect((await reader.read()).done).toBe(true); }
    finally { reader.releaseLock(); }
    const errorReader = stderr.getReader();
    try { expect((await errorReader.read()).done).toBe(true); }
    finally { errorReader.releaseLock(); }
    const turn = await client.call('turns.start', { threadId, prompt: 'unrelated echo work' });
    await waitFor(() => harness.core.journal.listTurns(threadId).some(saved => saved.id === turn.id && saved.status === 'done'));
  } finally {
    if (owned) {
      if (owned.proc.exitCode === null) owned.proc.kill('SIGKILL');
      await owned.exited;
      await Promise.all([owned.proc.stdout.cancel(), owned.proc.stderr.cancel()]);
    }
    await pending;
  }
});

test('oversized lookup output fails instead of accepting truncated evidence', async () => {
  const client = await harness.connect();
  const { threadId } = await echoThread(harness, client);
  const spawn = harness.core.procs.spawn.bind(harness.core.procs);
  const intercepted = spyOn(harness.core.procs, 'spawn').mockImplementation((scope, _command, _args, options) => spawn(scope, process.execPath, ['-e', `console.log('x'.repeat(4096))`], options));
  restore = () => intercepted.mockRestore();
  const lookups = new PullRequests(harness.core, { timeoutMs: 1000, maxOutputBytes: 1024 });
  await expect(lookups.cleanCheckout({ ...harness.core.threads.require(threadId), branch: 'topic' })).rejects.toThrow('stdout exceeded');
});

test('canceling a queued lookup never spawns it or stops another owning scope', async () => {
  const client = await harness.connect();
  const { threadId } = await echoThread(harness, client);
  const thread = { ...harness.core.threads.require(threadId), branch: 'topic' };
  const spawn = harness.core.procs.spawn.bind(harness.core.procs);
  const spawned: string[] = [];
  const intercepted = spyOn(harness.core.procs, 'spawn').mockImplementation((scope, _command, _args, options) => {
    spawned.push(scope);
    return spawn(scope, process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options);
  });
  restore = () => intercepted.mockRestore();
  const lookups = new PullRequests(harness.core, { timeoutMs: 5000 });
  const first = new AbortController(), second = new AbortController(), queued = new AbortController();
  const a = lookups.cleanCheckout(thread, undefined, first.signal).catch(() => null);
  const b = lookups.cleanCheckout(thread, undefined, second.signal).catch(() => null);
  let rejected = false;
  const c = lookups.cleanCheckout({ ...thread, id: 'queued' }, undefined, queued.signal).catch(() => { rejected = true; return null; });
  try {
    await waitFor(() => spawned.length === 2);
    queued.abort();
    await waitFor(() => rejected, 1000);
    expect(spawned.some(scope => scope.includes('queued'))).toBe(false);
    expect(new Set(spawned).size).toBe(2);
    expect(harness.core.procs.liveThreads().filter(scope => spawned.includes(scope))).toHaveLength(2);
    first.abort();
    await a;
    expect(harness.core.procs.liveCount(spawned[1]!)).toBe(1);
  } finally {
    first.abort(); second.abort();
    for (const scope of spawned) harness.core.procs.killTree(scope);
    await Promise.all([a, b, c]);
  }
});
