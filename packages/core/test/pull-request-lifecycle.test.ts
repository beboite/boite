import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PullRequests } from '../src/pull-requests.ts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';

let harness: TestCore;
let restore: (() => void) | undefined;
beforeEach(async () => { harness = await startTestCore(); });
afterEach(async () => { restore?.(); restore = undefined; await harness.stop(); });

test('a lookup deadline closes its inherited output reader after the direct child exited', async () => {
  const client = await harness.connect();
  const { threadId } = await echoThread(harness, client);
  const thread = harness.core.threads.require(threadId);
  const pidFile = join(harness.dataDir, 'held-pipe.pid');
  const spawn = harness.core.procs.spawn.bind(harness.core.procs);
  let owned: ReturnType<typeof spawn> | undefined;
  const intercepted = spyOn(harness.core.procs, 'spawn').mockImplementation((scope, _command, _args, options) => {
    owned = spawn(scope, process.execPath, ['-e', `
      const child = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { stdout: 'inherit', stderr: 'inherit' });
      require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      process.exit(0);
    `], options);
    return owned;
  });
  restore = () => intercepted.mockRestore();
  const lookups = new PullRequests(harness.core, { timeoutMs: 100 });
  let settled = false;
  let error: unknown;
  const pending = lookups.cleanCheckout({ ...thread, branch: 'topic' }).then(() => { settled = true; }, cause => { settled = true; error = cause; });
  let holderPid: number | undefined;
  try {
    await waitFor(() => existsSync(pidFile), 2000);
    holderPid = Number(readFileSync(pidFile, 'utf8'));
    expect(holderPid).toBeGreaterThan(0);
    await owned!.exited;
    expect(owned!.proc.exitCode).toBe(0);
    await waitFor(() => settled, 1000);
    expect(String(error)).toContain('timed out');
    expect(owned!.proc.stdout.locked).toBe(false);
    expect(owned!.proc.stderr.locked).toBe(false);
    const reader = owned!.proc.stdout.getReader();
    try { expect((await reader.read()).done).toBe(true); }
    finally { reader.releaseLock(); }
    const errorReader = owned!.proc.stderr.getReader();
    try { expect((await errorReader.read()).done).toBe(true); }
    finally { errorReader.releaseLock(); }
    const turn = await client.call('turns.start', { threadId, prompt: 'unrelated echo work' });
    await waitFor(() => harness.core.journal.listTurns(threadId).some(saved => saved.id === turn.id && saved.status === 'done'));
  } finally {
    if (holderPid !== undefined) { try { process.kill(holderPid, 'SIGKILL'); } catch { /* Already gone. */ } }
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
