/*
 * What a paired phone, or an agent that went off, is worth. The gate lives in
 * one place, so this walks every method the core registers rather than a
 * hand-written list: anything absent from `DEVICE_METHODS` must be refused to a
 * session and anything absent from `AGENT_METHODS` to an agent, including a
 * method added after this test was written.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { RpcMethodName } from '@boite/contracts';
import { connect } from '../src/client.ts';
import { AGENT_METHODS, DEVICE_METHODS, assertAllowed } from '../src/access.ts';
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
    identity: { principal: 'session', sessionId: 'ses_test', threadId: null },
    sendEvent: () => undefined,
    close: () => undefined,
  };
}

function agentConnection(threadId: string): Connection {
  return { ...deviceConnection(), identity: { principal: 'agent', sessionId: null, threadId } };
}

/** A real paired device: a grant minted by the owner, exchanged once. */
async function pairedDevice(): Promise<Awaited<ReturnType<typeof connect>>> {
  const owner = await harness.connect();
  const { grant } = await owner.call('pairing.grant', {});
  return await connect(harness.url, '', { grant, client: { name: 'pwa', version: 'test' } });
}

describe('the access gate', () => {
  test('paired phones discover and refresh account models without opening owner settings', async () => {
    const owner = await harness.connect();
    const account = (await owner.call('accounts.list', {})).find(account => account.providerId === 'echo')!;
    const phone = await pairedDevice();
    try {
      const params = { providerId: 'echo', accountId: account.id };
      const expected = await owner.call('providers.probe', params);
      expect((await phone.call('providers.probe', params)).models).toEqual(expected.models);
      expect((await phone.call('providers.probe', { ...params, refresh: true })).models).toEqual(expected.models);
      await expect(phone.call('providers.probe', { ...params, accountId: 'missing' })).rejects.toThrow('account');
      await expect(phone.call('providers.reload', {})).rejects.toThrow('owner only');
      await expect(phone.call('accounts.add', { providerId: 'echo', label: 'Phone' })).rejects.toThrow('owner only');
    } finally { phone.close(); }
  });

  test('paired phones can focus a conversation, but agent sockets cannot', async () => {
    const owner = await harness.connect();
    const { threadId } = await echoThread(harness, owner);
    const phone = await pairedDevice();
    const agent = await connect(harness.url, harness.core.agents.tokenFor(threadId));
    try {
      expect(await phone.call('threads.focus', { threadId })).toEqual({ ok: true });
      expect(await phone.call('threads.focus', { threadId: null })).toEqual({ ok: true });
      let rejected: Error | null = null;
      try { await agent.call('threads.focus', { threadId }); }
      catch (error) { rejected = error as Error; }
      expect(rejected?.message).toContain('threads.focus');
    } finally { phone.close(); agent.close(); }
  });

  test('paired messages cannot impersonate a persistent agent session', () => {
    expect(() => assertAllowed('agents.message.send', deviceConnection(), { threadId: 'thr_other' })).toThrow('threadId');
    expect(() => assertAllowed('agents.message.send', deviceConnection(), { scope: { kind: 'agent', id: 'identity' } })).not.toThrow();
  });
  test('agent sockets cannot receive owner broadcasts or another thread activity', async () => {
    const owner = await harness.connect();
    const { threadId } = await echoThread(harness, owner);
    const agent = await connect(harness.url, harness.core.agents.tokenFor(threadId));
    const seen: string[] = [];
    agent.onAny(name => seen.push(name));
    try {
      harness.core.bus.emit('core.log', { level: 'info', message: 'private diagnostic', at: Date.now() });
      harness.core.bus.emit('account.login', { accountId: 'other-account', state: 'running', output: 'private login output', url: 'https://example.test/login', exitCode: null });
      harness.core.bus.emit('thread.updated', harness.core.threads.require(threadId));
      harness.core.bus.emit('thread.activity', { threadId: 'another-thread', activity: { goal: null, loop: null, tasks: [] } });
      harness.core.bus.emit('thread.activity', { threadId, activity: { goal: null, loop: null, tasks: [] } });
      harness.core.bus.emit('delegation.changed', { threadId: 'another-thread' });
      harness.core.bus.emit('delegation.changed', { threadId });
      // The response follows every event on this socket, with no timing guess.
      await agent.call('agent.where', { threadId });
      expect(seen).toEqual(['thread.activity']);
    } finally { agent.close(); }
  });

  test('device sockets receive readable state, but no login output, trace or diagnostics', async () => {
    const owner = await harness.connect();
    const { threadId } = await echoThread(harness, owner);
    const phone = await pairedDevice();
    await phone.call('threads.subscribe', { threadId });
    const seen: string[] = [];
    phone.onAny(name => seen.push(name));
    try {
      harness.core.bus.emit('account.login', { accountId: 'other-account', state: 'running', output: 'private login output', url: 'https://example.test/login', exitCode: null });
      harness.core.bus.emit('core.log', { level: 'error', message: 'private diagnostic', at: Date.now() });
      harness.core.bus.emit('process.focusPushed', { threadId: 'private-thread', pid: 123, title: 'private window', restored: true, at: Date.now() });
      harness.core.bus.emit('quotas.updated', []);
      harness.core.bus.emit('quotas.progress', { requestId: 'private-read', quota: {
        accountId: 'private-account', providerId: 'claude', providerName: 'Claude', label: 'Private', enabled: true,
        status: 'ready', windows: [], checkedAt: 1, error: null,
      } });
      harness.core.bus.emit('settings.updated', harness.core.settings.get());
      harness.core.bus.emit('delegation.changed', { threadId: 'another-thread' });
      harness.core.bus.emit('delegation.changed', { threadId });
      await phone.call('settings.get', {});
      expect(seen).toEqual(['settings.updated', 'delegation.changed']);
    } finally { phone.close(); }
  });

  test('every method outside DEVICE_METHODS is refused to a session, the gate being the only list', () => {
    const connection = deviceConnection();
    const owner: Connection = { ...connection, identity: { principal: 'owner', sessionId: null, threadId: null } };
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

  test('an agent reaches exactly AGENT_METHODS, on its own thread and nowhere else', () => {
    const connection = agentConnection('thr_own');
    const reached: RpcMethodName[] = [];
    for (const method of harness.core.router.methods()) {
      if (AGENT_METHODS.has(method)) {
        expect(() => assertAllowed(method, connection, { threadId: 'thr_own' })).not.toThrow();
        // Its own thread or nothing: another thread id, and no thread id at all.
        expect(() => assertAllowed(method, connection, { threadId: 'thr_other' })).toThrow(
          `${method} is for thread thr_own, not thread thr_other`,
        );
        expect(() => assertAllowed(method, connection, {})).toThrow(`${method} is for thread thr_own`);
        reached.push(method);
        continue;
      }
      expect(() => assertAllowed(method, connection, { threadId: 'thr_own' })).toThrow(
        `${method} is not one of the agent's methods`,
      );
    }
    expect([...reached].sort()).toEqual([...AGENT_METHODS.keys()].sort());
    // The ones it is worth saying out loud: writing a file, confirming a card,
    // reading the trace, and following another thread's events.
    for (const owned of ['files.write', 'todos.remove', 'trace.get', 'threads.subscribe'] as RpcMethodName[]) {
      expect(AGENT_METHODS.has(owned)).toBe(false);
    }
  });

  test('every name in AGENT_METHODS is a method the core really registers, and carries a reason', () => {
    const registered = new Set(harness.core.router.methods());
    for (const [method, reason] of AGENT_METHODS) {
      expect(registered.has(method)).toBe(true);
      expect(reason.length).toBeGreaterThan(10);
    }
  });

  test('an agent connection is refused an owner method and another thread over the wire', async () => {
    const owner = await harness.connect();
    const { threadId } = await echoThread(harness, owner);
    const other = await harness.core.threads.create({
      projectId: harness.core.projects.require(harness.core.threads.require(threadId).projectId).id,
      providerId: 'echo',
      accountId: harness.core.threads.require(threadId).accountId,
      title: 'another thread',
    });
    const agent = await connect(harness.url, harness.core.agents.tokenFor(threadId), {
      client: { name: 'boite-cli', version: 'test' },
    });
    try {
      expect(agent.principal).toBe('agent');
      expect(agent.threadId).toBe(threadId);
      expect(await agent.call('agent.where', { threadId })).toMatchObject({ threadId });
      const failures: string[] = [];
      const attempts: (() => Promise<unknown>)[] = [
        () => agent.call('files.write', { threadId, path: 'from-the-agent.txt', text: 'no' }),
        () => agent.call('trace.get', { threadId }),
        () => agent.call('agent.where', { threadId: other.id }),
        () => agent.call('todos.list', { threadId: other.id }),
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
        "files.write is not one of the agent's methods",
        "trace.get is not one of the agent's methods",
        `agent.where is for thread ${threadId}, not thread ${other.id}`,
        `todos.list is for thread ${threadId}, not thread ${other.id}`,
      ]);
    } finally {
      agent.close();
    }
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

  test('a thread the phone creates reaches the computer at once, without a subscription', async () => {
    const owner = await harness.connect();
    const project = await testProject(harness, owner);
    const account = (await owner.call('accounts.list', {})).find((entry) => entry.providerId === 'echo');
    const phone = await pairedDevice();
    try {
      const created = owner.next<'thread.created'>('thread.created', (thread) => thread.title === 'from the phone', 5_000);
      const thread = await phone.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: account?.id ?? '', title: 'from the phone' });
      expect((await created).id).toBe(thread.id);
      // Its first turn moves the computer's row too, though the computer never opened it.
      const updated = owner.next<'thread.updated'>('thread.updated', (row) => row.id === thread.id && row.status === 'idle' && row.lastUserMessageAt !== null, 10_000);
      await phone.call('turns.start', { threadId: thread.id, prompt: 'hello' });
      expect((await updated).id).toBe(thread.id);
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
