import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import type { ModelInfo } from '@boite/contracts';
import { getDriver, probedModelsOf, setDriver } from '../src/drivers/index.ts';
import { removeDir } from '../src/fs-retry.ts';
import type { CoreClient } from '../src/client.ts';
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

/**
 * A core that probed once, stopped, then a second core on the same data
 * directory whose agent answers when the test says. `held` is what its driver
 * already holds, as a sign-in's or a turn's own session leaves it.
 */
async function restarted(run: (ctx: { client: CoreClient; accountId: string; reads: () => number; answer: () => void }) => Promise<void>, held: ModelInfo[] | null = null): Promise<void> {
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
    const agent = Promise.withResolvers<void>();
    let reads = 0;
    let read = held;
    // Kept the way every agent's driver keeps what it read.
    setDriver('echo', {
      ...getDriver('echo'),
      probe: async () => {
        if (read !== null) return { models: read, probedAt: 2 };
        reads++;
        await agent.promise;
        read = after;
        return { models: after, probedAt: 2 };
      },
      probedModels: () => read,
      forgetProbes: () => { read = null; },
    });
    const second = await startTestCore({ dataDir });
    try {
      await run({ client: await second.connect(), accountId: account.id, reads: () => reads, answer: () => agent.resolve() });
    } finally {
      agent.resolve();
      await second.stop();
    }
  } finally {
    restore();
    await removeDir(dataDir);
  }
}

test('a restarted core answers the saved model list at once and reads a fresh one behind it', () => restarted(async ({ client, accountId, reads, answer }) => {
  const fresh = client.next('providers.probed', event => event.accountId === accountId, 5000);
  const saved = await answered(client.call('providers.probe', { providerId: 'echo', accountId }), 2000);
  expect(saved?.models).toEqual(before);
  expect(reads()).toBe(1);
  // A second look while the agent still starts gets the same list, and no second agent.
  expect((await answered(client.call('providers.probe', { providerId: 'echo', accountId }), 2000))?.models).toEqual(before);
  expect(reads()).toBe(1);
  // A send in the meantime may name a model of the list on screen.
  expect(probedModelsOf('echo', 'echo', accountId)).toEqual(before);
  answer();
  expect((await fresh).models).toEqual(after);
  expect((await client.call('providers.probe', { providerId: 'echo', accountId })).models).toEqual(after);
  expect(reads()).toBe(1);
}));

test('a saved model list shown while a refresh reads is the one model checks accept', () => restarted(async ({ client, accountId, reads, answer }) => {
  // A client with rows of its own asks for a fresh list as the picker opens.
  const refresh = client.call('providers.probe', { providerId: 'echo', accountId, refresh: true });
  const saved = await answered(client.call('providers.probe', { providerId: 'echo', accountId }), 2000);
  expect(saved?.models).toEqual(before);
  expect(probedModelsOf('echo', 'echo', accountId)).toEqual(before);
  answer();
  expect((await refresh).models).toEqual(after);
  expect(reads()).toBe(1);
}));

test('a list the driver already holds after a restart wins over the saved one and starts no agent', () => restarted(async ({ client, accountId, reads }) => {
  const session: ModelInfo[] = [{ id: 'session', name: 'From the sign-in', default: true }];
  const probe = client.call('providers.probe', { providerId: 'echo', accountId });
  expect((await answered(probe, 2000))?.models).toEqual(session);
  expect(reads()).toBe(0);
}, [{ id: 'session', name: 'From the sign-in', default: true }]));

test('a refresh that fails after a restart leaves the saved model list answering at once', () => restarted(async ({ client, accountId }) => {
  const failed = Promise.withResolvers<void>();
  setDriver('echo', { ...getDriver('echo'), probe: async () => { failed.resolve(); throw new Error('the agent did not start'); }, probedModels: () => null });
  expect((await answered(client.call('providers.probe', { providerId: 'echo', accountId }), 2000))?.models).toEqual(before);
  await failed.promise;
  await new Promise(resolve => setTimeout(resolve, 50));
  expect((await answered(client.call('providers.probe', { providerId: 'echo', accountId }), 2000))?.models).toEqual(before);
  expect(probedModelsOf('echo', 'echo', accountId)).toEqual(before);
}));

test('a saved model list row that does not parse is read again from the agent', async () => {
  const restore = setDriver('echo', { ...getDriver('echo'), probe: async () => ({ models: after, probedAt: 1 }) });
  const harness = await startTestCore();
  try {
    const client = await harness.connect();
    const account = await client.call('accounts.add', { providerId: 'echo', label: 'Broken row' });
    harness.core.journal.db.query('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(`model-catalog:${JSON.stringify(['echo', account.id])}`, '{not json');
    expect((await client.call('providers.probe', { providerId: 'echo', accountId: account.id })).models).toEqual(after);
  } finally {
    restore();
    await harness.stop();
  }
});

test.each(['descriptor', 'sign-in'] as const)('a saved model list read before a %s change waits for the agent', async change => {
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
    if (change === 'descriptor') {
      // A descriptor change drops every list, the saved one no longer matches.
      harness.core.providers.require('echo').models = [...harness.core.providers.require('echo').models, { id: 'added', name: 'Added' }];
      harness.core.bus.emit('providers.updated', harness.core.providers.list());
    } else {
      // A sign-in under the same identity may still be another account.
      harness.core.accounts.check(account.id, true);
    }
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
