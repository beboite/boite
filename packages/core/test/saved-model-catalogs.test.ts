import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import type { ModelInfo } from '@boite/contracts';
import { getDriver, probedModelsOf, setDriver } from '../src/drivers/index.ts';
import { removeDir } from '../src/fs-retry.ts';
import { startTestCore } from './harness.ts';

const before: ModelInfo[] = [{ id: 'saved', name: 'Saved', default: true }];
const after: ModelInfo[] = [{ id: 'fresh', name: 'Fresh', default: true }];

/** The answer, or null when it did not arrive within `ms`. */
async function answered<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

test('a restarted core answers the saved model list at once and reads a fresh one behind it', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'boite-core-'));
  const restore = setDriver('echo', { ...getDriver('echo'), probe: async () => ({ models: before, probedAt: 1 }) });
  try {
    const first = await startTestCore({ dataDir });
    const account = await (await first.connect()).call('accounts.add', { providerId: 'echo', label: 'Saved list' });
    try {
      expect((await (await first.connect()).call('providers.probe', { providerId: 'echo', accountId: account.id })).models).toEqual(before);
    } finally {
      await first.stop();
    }

    // The agent of the restarted core takes as long as the test says.
    const agent = Promise.withResolvers<void>();
    let reads = 0;
    let read: ModelInfo[] | null = null;
    // Kept the way every agent's driver keeps what it read.
    setDriver('echo', {
      ...getDriver('echo'),
      probe: async () => { reads++; await agent.promise; read = after; return { models: after, probedAt: 2 }; },
      probedModels: () => read,
    });
    const second = await startTestCore({ dataDir });
    try {
      const client = await second.connect();
      const fresh = client.next('providers.probed', event => event.accountId === account.id, 5000);
      const saved = await answered(client.call('providers.probe', { providerId: 'echo', accountId: account.id }), 2000);
      expect(saved?.models).toEqual(before);
      expect(reads).toBe(1);
      // A send in the meantime may name a model of the list on screen.
      expect(probedModelsOf('echo', 'echo', account.id)).toEqual(before);
      agent.resolve();
      expect((await fresh).models).toEqual(after);
      expect((await client.call('providers.probe', { providerId: 'echo', accountId: account.id })).models).toEqual(after);
      expect(reads).toBe(1);
    } finally {
      agent.resolve();
      await second.stop();
    }
  } finally {
    restore();
    await removeDir(dataDir);
  }
});

test('a saved model list read under another descriptor waits for the agent', async () => {
  const agent = Promise.withResolvers<void>();
  let reads = 0;
  const restore = setDriver('echo', {
    ...getDriver('echo'),
    probe: async () => { if (++reads > 1) await agent.promise; return { models: reads > 1 ? after : before, probedAt: reads }; },
  });
  const harness = await startTestCore();
  try {
    const client = await harness.connect();
    const account = await client.call('accounts.add', { providerId: 'echo', label: 'Changed descriptor' });
    expect((await client.call('providers.probe', { providerId: 'echo', accountId: account.id })).models).toEqual(before);
    // A descriptor change drops every list, the saved one no longer matches.
    harness.core.providers.require('echo').models = [...harness.core.providers.require('echo').models, { id: 'added', name: 'Added' }];
    harness.core.bus.emit('providers.updated', harness.core.providers.list());
    const probe = client.call('providers.probe', { providerId: 'echo', accountId: account.id });
    expect(await answered(probe, 300)).toBeNull();
    agent.resolve();
    expect((await probe).models).toEqual(after);
  } finally {
    agent.resolve();
    restore();
    await harness.stop();
  }
});
