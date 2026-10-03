/*
 * What a paired phone, or an agent that went off, is worth. The gate lives in
 * one place, so this walks every method the core registers rather than a
 * hand-written list: anything absent from `DEVICE_METHODS` must be refused to a
 * session and anything absent from `AGENT_METHODS` to an agent, including a
 * method added after this test was written.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
      const scheduler = phone.next('scheduler.updated');
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
      harness.core.bus.emit('scheduler.updated', harness.core.scheduler.state());
      expect(await scheduler).toEqual(harness.core.scheduler.state());
      await phone.call('settings.get', {});
      // Startup can also deliver a coalesced scheduler snapshot during this fixture.
      expect(seen.filter(name => name !== 'scheduler.updated')).toEqual(['settings.updated', 'delegation.changed']);
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

/** The fixture's own git identity: the machine's config is not the test's business. */
function git(cwd: string, ...args: string[]): void {
  const run = Bun.spawnSync({
    cmd: ['git', ...args], cwd, stdout: 'pipe', stderr: 'pipe', windowsHide: true,
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@boite.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@boite.invalid' },
  });
  if (!run.success) throw new Error(`git ${args.join(' ')} failed: ${run.stderr.toString()}`);
}

/** A repository with one committed file changed since, and a thread working in `cwd` (the root by default). */
async function repoThread(owner: Awaited<ReturnType<TestCore['connect']>>, cwd?: (root: string) => string): Promise<{ root: string; threadId: string }> {
  const root = join(harness.dataDir, 'repo');
  mkdirSync(root);
  git(root, 'init', '-q');
  writeFileSync(join(root, 'a.txt'), 'one\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'first');
  writeFileSync(join(root, 'a.txt'), 'two\n');
  const project = await owner.call('projects.add', { path: root, name: 'repo' });
  const account = (await owner.call('accounts.list', {})).find((entry) => entry.providerId === 'echo');
  const thread = await owner.call('threads.create', {
    projectId: project.id, providerId: 'echo', accountId: account?.id ?? '', title: 'repo', ...(cwd ? { cwd: cwd(root) } : {}),
  });
  return { root, threadId: thread.id };
}

describe('a paired device reads a thread\'s changes and files', () => {
  test('it reads the status, a diff, a directory and a file, and writes nothing', async () => {
    const owner = await harness.connect();
    const { root, threadId } = await repoThread(owner);
    writeFileSync(join(harness.dataDir, 'outside.txt'), 'secret\n');
    const phone = await pairedDevice();
    try {
      expect((await phone.call('git.status', { threadId })).changes.map((change) => change.path)).toEqual(['a.txt']);
      expect(await phone.call('git.diff', { threadId, path: 'a.txt' })).toMatchObject({ oldText: 'one\n', newText: 'two\n' });
      expect(await phone.call('git.diff', { threadId, path: 'a.txt', ref: 'HEAD' })).toMatchObject({ newText: 'two\n' });
      expect((await phone.call('files.list', { threadId })).map((entry) => entry.name)).toContain('a.txt');
      expect(await phone.call('files.read', { threadId, path: 'a.txt' })).toMatchObject({ kind: 'text', text: 'two\n' });

      // No writing, no history beyond HEAD, nothing outside the working tree.
      await expect(phone.call('files.write', { threadId, path: 'a.txt', text: 'from the phone' })).rejects.toThrow('files.write is for the owner only');
      await expect(phone.call('git.diff', { threadId, path: 'a.txt', ref: 'HEAD~1' })).rejects.toThrow('HEAD only');
      await expect(phone.call('git.diff', { threadId, path: 'a.txt', ref: '--output=x' })).rejects.toThrow('HEAD only');
      await expect(phone.call('files.read', { threadId, path: '../outside.txt' })).rejects.toThrow('leaves the thread\'s working directory');
      await expect(phone.call('files.read', { threadId, path: join(harness.dataDir, 'outside.txt') })).rejects.toThrow('leaves the thread\'s working directory');
      await expect(phone.call('files.list', { threadId, path: '..' })).rejects.toThrow('leaves the thread\'s working directory');
      await expect(phone.call('git.diff', { threadId, path: '../outside.txt' })).rejects.toThrow('leaves the thread\'s working directory');
      expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('two\n');
      // The owner still diffs against any revision.
      expect(await owner.call('git.diff', { threadId, path: 'a.txt', ref: 'HEAD' })).toMatchObject({ oldText: 'one\n' });
    } finally {
      phone.close();
    }
  });

  test('a link out of the project, swapped in after the thread was made, is not followed', async () => {
    const owner = await harness.connect();
    const outside = join(harness.dataDir, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.txt'), 'secret\n');
    const { root, threadId } = await repoThread(owner, (root) => {
      mkdirSync(join(root, 'nested'));
      symlinkSync(join(root, 'nested'), join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
      return join(root, 'link');
    });
    const phone = await pairedDevice();
    try {
      expect(await phone.call('files.list', { threadId })).toEqual([]);
      unlinkSync(join(root, 'link'));
      symlinkSync(outside, join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
      for (const attempt of [
        () => phone.call('files.list', { threadId }),
        () => phone.call('files.read', { threadId, path: 'secret.txt' }),
        () => phone.call('git.status', { threadId }),
        () => phone.call('git.diff', { threadId, path: 'secret.txt' }),
      ]) {
        await expect(attempt()).rejects.toThrow('a paired device reads only inside the thread\'s project or its worktrees');
      }
      // The owner's own read is not changed by this guard.
      expect((await owner.call('files.list', { threadId })).map((entry) => entry.name)).toEqual(['secret.txt']);
    } finally {
      phone.close();
    }
  });

  test('the gate holds a device to diffs against HEAD and leaves writing to the owner', () => {
    const owner: Connection = { ...deviceConnection(), identity: { principal: 'owner', sessionId: null, threadId: null } };
    expect(() => assertAllowed('git.diff', owner, { threadId: 't', path: 'a', ref: 'HEAD~3' })).not.toThrow();
    expect(() => assertAllowed('git.diff', deviceConnection(), { threadId: 't', path: 'a' })).not.toThrow();
    expect(() => assertAllowed('git.diff', deviceConnection(), { threadId: 't', path: 'a', ref: 'main' })).toThrow('HEAD only');
    expect(() => assertAllowed('files.write', deviceConnection(), { threadId: 't', path: 'a', text: '' })).toThrow('owner only');
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
    const nested = join(harness.dataDir, 'nested');
    mkdirSync(nested);
    const containedLink = join(harness.dataDir, 'contained-link');
    symlinkSync(nested, containedLink, process.platform === 'win32' ? 'junction' : 'dir');
    for (const cwd of [nested, containedLink]) {
      const created = await client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: account?.id ?? '', cwd });
      expect(created.cwd).toBe(cwd);
    }

    const linkedRoot = join(harness.dataDir, 'linked-root');
    symlinkSync(nested, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
    const linkedProject = await client.call('projects.add', { path: linkedRoot, name: 'linked project' });
    const child = join(linkedRoot, 'child');
    mkdirSync(child);
    for (const cwd of [linkedRoot, child]) {
      const created = await client.call('threads.create', { projectId: linkedProject.id, providerId: 'echo', accountId: account?.id ?? '', cwd });
      expect(created.cwd).toBe(cwd);
    }
    await expect(client.call('threads.create', {
      projectId: linkedProject.id, providerId: 'echo', accountId: account?.id ?? '', cwd: join(nested, 'child'),
    })).rejects.toThrow('the working directory must be inside the project');
  });

  test('threads.create refuses a cwd whose directory link escapes the project, and writes no thread', async () => {
    const client = await harness.connect();
    const projectRoot = join(harness.dataDir, 'project');
    const outside = join(harness.dataDir, 'outside');
    mkdirSync(projectRoot); mkdirSync(outside);
    const cwd = join(projectRoot, 'escape');
    symlinkSync(outside, cwd, process.platform === 'win32' ? 'junction' : 'dir');
    const project = await client.call('projects.add', { path: projectRoot, name: 'contained project' });
    const account = (await client.call('accounts.list', {})).find(entry => entry.providerId === 'echo');
    const creation = client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: account?.id ?? '', cwd });
    await expect(creation).rejects.toThrow('the working directory must resolve inside the project');
    await expect(creation).rejects.toMatchObject({ rpc: { data: {
      field: 'cwd', expected: 'a directory inside the project filesystem root', cwd, projectPath: projectRoot,
    } } });
    expect(await client.call('threads.list', {})).toEqual([]);
  });
});
