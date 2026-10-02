import { existsSync } from 'node:fs';
import { expect, spyOn, test } from 'bun:test';
import { RpcErrorCode, type ModelInfo } from '@boite/contracts';
import { getDriver, setDriver } from '../src/drivers/index.ts';
import { unavailable } from '../src/errors.ts';
import { probeThreadId } from '../src/providers/probe.ts';
import { startTestCore } from './harness.ts';

const models: ModelInfo[] = [{ id: 'scripted', name: 'Scripted', default: true, effort: { levels: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }], default: 'high' } }];
const result = { models, probedAt: 1700000000000 };

async function within<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 5000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test.each(['success', 'failure', 'account change'] as const)('a probe preserves its %s when child close never arrives, releases its lane and lets the core stop', async outcome => {
  const harness = await startTestCore();
  const client = await harness.connect();
  const account = await client.call('accounts.add', { providerId: 'echo', label: 'Probe cleanup' });
  const threadId = probeThreadId('echo', account.id);
  const protocolReady = Promise.withResolvers<void>();
  const finishProtocol = Promise.withResolvers<void>();
  const directories: string[] = [];
  const closeListeners: Array<() => void> = [];
  const requests: Promise<unknown>[] = [];
  const childSpies: Array<{ mockRestore(): void }> = [];
  let holdClose = true;
  let reads = 0;
  const spawn = harness.core.procs.spawnChild.bind(harness.core.procs);
  const spawnSpy = spyOn(harness.core.procs, 'spawnChild').mockImplementation((...args) => {
    const child = spawn(...args);
    const once = child.once.bind(child);
    childSpies.push(spyOn(child, 'once').mockImplementation((...args: Parameters<typeof child.once>) => {
      const [event, listener] = args;
      if (event !== 'close' || !holdClose) return once(event, listener);
      // The real registered process still exits; only its close notification is held.
      closeListeners.push(() => listener(child.exitCode, child.signalCode));
      return child;
    }));
    return child;
  });
  const restoreDriver = setDriver('echo', {
    ...getDriver('echo'),
    async probe(ctx) {
      const first = ++reads === 1;
      directories.push(ctx.cwd);
      const child = ctx.spawnChild(process.execPath, ['-e', "process.stdout.write('ready\\n'); setInterval(() => {}, 1000)"], { cwd: ctx.cwd });
      await new Promise<void>(resolve => { child.stdout.once('data', () => resolve()); });
      // A protocol can finish before node reports that every process pipe closed.
      child.kill();
      if (first) {
        protocolReady.resolve();
        await finishProtocol.promise;
        if (outcome === 'failure') throw unavailable('original scripted discovery failure', { reason: 'scripted' });
      }
      return result;
    },
  });
  try {
    const first = client.call('providers.probe', { providerId: 'echo', accountId: account.id }).then(value => ({ value }), error => ({ error }));
    requests.push(first);
    await within(protocolReady.promise, 'the registered probe process did not report its protocol result');
    if (outcome === 'account change') harness.core.accounts.check(account.id, true);
    finishProtocol.resolve();
    // A different request key shares this account's lane, rather than the first promise.
    const next = client.call('providers.probe', { providerId: 'echo', accountId: account.id, model: 'retry' });
    requests.push(next);
    const [settled, retried] = await within(Promise.all([first, next]), 'probe cleanup blocked its protocol result and the next request in its account lane');
    if (outcome === 'success') expect(settled).toEqual({ value: result });
    else expect(settled).toMatchObject({ error: { rpc: outcome === 'failure'
      ? { code: RpcErrorCode.Unavailable, message: 'original scripted discovery failure', data: { reason: 'scripted' } }
      : { code: RpcErrorCode.Refused, message: 'the provider or account changed during discovery; refresh models' } } });
    expect(retried).toEqual(result);
    expect(reads).toBe(2);
    expect(harness.core.procs.liveCount(threadId)).toBe(0);
    expect(harness.core.providers.installs.leaseCount('echo')).toBe(0);
    expect(closeListeners).toHaveLength(2);
    expect(directories).toHaveLength(2);
    expect(directories.every(directory => !existsSync(directory))).toBe(true);
    await within(harness.stop(), 'a completed probe cleanup blocked core shutdown');
  } finally {
    // Release held notifications on failure so the old implementation can also tear down.
    holdClose = false;
    finishProtocol.resolve();
    for (const release of closeListeners) release();
    await harness.core.procs.stopAndWait(threadId).catch(() => undefined);
    await Promise.allSettled(requests);
    restoreDriver();
    spawnSpy.mockRestore();
    for (const spy of childSpies) spy.mockRestore();
    await harness.stop();
  }
}, 20000);
