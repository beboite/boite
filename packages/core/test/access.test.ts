/*
 * What a paired phone is worth if it is stolen. The gate lives in one place, so
 * this walks every method the core registers rather than a hand-written list:
 * anything absent from `DEVICE_METHODS` must be refused to a session, including
 * a method added after this test was written.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { RpcMethodName } from '@boite/contracts';
import { connect } from '../src/client.ts';
import { DEVICE_METHODS, assertAllowed } from '../src/access.ts';
import type { Connection } from '../src/router.ts';
import { echoThread, startTestCore, testProject } from './harness.ts';
import type { TestCore } from './harness.ts';

let harness: TestCore;

beforeEach(async () => {
  harness = await startTestCore();
});

afterEach(async () => {
  await harness.stop();
});

function deviceConnection(): Connection {
  return {
    id: 'con_test',
    subscriptions: new Set(),
    identity: { principal: 'session', sessionId: 'ses_test' },
    sendEvent: () => undefined,
    close: () => undefined,
  };
}

/** A real paired device: a grant minted by the owner, exchanged once. */
async function pairedDevice(): Promise<Awaited<ReturnType<typeof connect>>> {
  const owner = await harness.connect();
  const { grant } = await owner.call('pairing.grant', {});
  return await connect(harness.url, '', { grant, client: { name: 'pwa', version: 'test' } });
}

describe('the access gate', () => {
  test('every method outside DEVICE_METHODS is refused to a session, the gate being the only list', () => {
    const connection = deviceConnection();
    const owner: Connection = { ...connection, identity: { principal: 'owner', sessionId: null } };
    const refusedNames: RpcMethodName[] = [];
    for (const method of harness.core.router.methods()) {
      // The owner calls everything, always.
      expect(() => assertAllowed(method, owner)).not.toThrow();
      if (DEVICE_METHODS.has(method)) {
        expect(() => assertAllowed(method, connection)).not.toThrow();
        continue;
      }
      expect(() => assertAllowed(method, connection)).toThrow(`${method} is for the owner only`);
      refusedNames.push(method);
    }
    // Guard against a gate that refuses nothing because the router was empty.
    expect(refusedNames.length).toBeGreaterThan(20);
    expect(refusedNames).toContain('projects.add');
    expect(refusedNames).toContain('settings.set');
    expect(refusedNames).toContain('providers.dryRun');
    expect(refusedNames).toContain('accounts.login');
    expect(refusedNames).toContain('resources.killTree');
    expect(refusedNames).toContain('trace.get');
  });

  test('every name in DEVICE_METHODS is a method the core really registers', () => {
    const registered = new Set(harness.core.router.methods());
    for (const method of DEVICE_METHODS) expect(registered.has(method)).toBe(true);
  });

  test('a paired device is refused over the wire on the four it used to reach', async () => {
    const phone = await pairedDevice();
    try {
      const failures: string[] = [];
      const attempts: (() => Promise<unknown>)[] = [
        () => phone.call('projects.add', { path: harness.dataDir, name: 'from the phone' }),
        () => phone.call('settings.set', { listenOnLan: true }),
        () => phone.call('providers.dryRun', { file: 'C:\\Windows\\win.ini' }),
        () => phone.call('accounts.add', { providerId: 'echo', label: 'from the phone' }),
      ];
      for (const attempt of attempts) {
        try {
          await attempt();
          failures.push('none');
        } catch (error) {
          failures.push((error as Error).message);
        }
      }
      expect(failures).toEqual([
        'projects.add is for the owner only',
        'settings.set is for the owner only',
        'providers.dryRun is for the owner only',
        'accounts.add is for the owner only',
      ]);
      // Nothing went through: the gate runs before the handler.
      const owner = await harness.connect();
      expect(await owner.call('projects.list', {})).toEqual([]);
      expect(harness.core.settings.get().listenOnLan).toBe(false);
    } finally {
      phone.close();
    }
  });

  test('a paired device still reads threads and answers the agent', async () => {
    const owner = await harness.connect();
    const { threadId } = await echoThread(harness, owner);
    const phone = await pairedDevice();
    try {
      expect((await phone.call('threads.list', {})).map((thread) => thread.id)).toEqual([threadId]);
      const finished = phone.next<'turn.finished'>('turn.finished', (turn) => turn.threadId === threadId, 10_000);
      await phone.call('turns.start', { threadId, prompt: 'from the phone' });
      expect((await finished).status).toBe('done');
    } finally {
      phone.close();
    }
  });
});

describe('a working directory outside the project', () => {
  test('threads.create refuses a cwd the project does not contain, and writes no thread', async () => {
    const client = await harness.connect();
    const project = await testProject(harness, client);
    const accounts = await client.call('accounts.list', {});
    const account = accounts.find((entry) => entry.providerId === 'echo');
    let failure = 'none';
    try {
      await client.call('threads.create', {
        projectId: project.id,
        providerId: 'echo',
        accountId: account?.id ?? '',
        title: 'escaped',
        cwd: process.platform === 'win32' ? 'C:\\Windows' : '/etc',
      });
    } catch (error) {
      failure = (error as Error).message;
    }
    expect(failure).toBe('the working directory must be inside the project');
    expect(await client.call('threads.list', {})).toEqual([]);
  });

  test('a cwd inside the project is kept, and the project root itself is fine', async () => {
    const client = await harness.connect();
    const project = await testProject(harness, client);
    const accounts = await client.call('accounts.list', {});
    const account = accounts.find((entry) => entry.providerId === 'echo');
    const thread = await client.call('threads.create', {
      projectId: project.id,
      providerId: 'echo',
      accountId: account?.id ?? '',
      title: 'at the root',
      cwd: harness.dataDir,
    });
    expect(thread.cwd).toBe(harness.dataDir);
  });
});
