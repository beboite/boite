/*
 * The agent's door: the token a thread's processes carry, what it opens, and
 * the two surfaces the CLI drives from inside a turn. Everything here runs on a
 * fresh temporary data directory, and the agent connects like the CLI does,
 * with the token and nothing else.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { AGENT_ENV } from '@boite/contracts';
import type { CoreClient } from '../src/client.ts';
import { connect } from '../src/client.ts';
import { agentEnvFor } from '../src/agent.ts';
import { resolveCliDir } from '../src/core.ts';
import { echoThread, startTestCore, waitFor } from './harness.ts';
import type { TestCore } from './harness.ts';

let harness: TestCore;
let client: CoreClient;
let threadId: string;

beforeEach(async () => {
  harness = await startTestCore();
  client = await harness.connect();
  ({ threadId } = await echoThread(harness, client));
});

afterEach(async () => {
  await harness.stop();
});

/** The CLI's own hello: the token the thread's environment carries, no grant, no core token. */
async function agentClient(): Promise<CoreClient> {
  return await connect(harness.url, harness.core.agents.tokenFor(threadId), {
    client: { name: 'boite-cli', version: 'test' },
  });
}

describe('the per-thread token', () => {
  test('the same thread is minted one token, and hello hands the thread back', async () => {
    const token = harness.core.agents.tokenFor(threadId);
    expect(harness.core.agents.tokenFor(threadId)).toBe(token);
    expect(harness.core.agents.authenticate(token)).toBe(threadId);
    expect(harness.core.agents.authenticate('not a token')).toBe(null);

    const agent = await agentClient();
    try {
      expect(agent.principal).toBe('agent');
      expect(agent.threadId).toBe(threadId);
      expect(agent.core.version).toBe(harness.core.version);
    } finally {
      agent.close();
    }
    // The owner says hello with the core token and is nobody's agent.
    expect(client.principal).toBe('owner');
    expect(client.threadId).toBe(null);
  });

  test('an archived thread and a removed project close the door behind them', async () => {
    const token = harness.core.agents.tokenFor(threadId);
    harness.core.threads.archive(threadId, true);
    await waitFor(() => harness.core.agents.authenticate(token) === null);
    expect(harness.core.agents.authenticate(token)).toBe(null);
    let refusal = 'none';
    try {
      const agent = await connect(harness.url, token, { client: { name: 'boite-cli', version: 'test' } });
      agent.close();
    } catch (error) {
      refusal = (error as Error).message;
    }
    expect(refusal).toBe('the token is wrong');
  });

  test('an agent already connected is put out when its thread is archived', async () => {
    const agent = await agentClient();
    try {
      expect(await agent.call('todos.list', { threadId })).toEqual([]);
      harness.core.threads.archive(threadId, true);
      // Forgetting the token only stops the next hello. The socket this agent
      // already held used to go on claiming cards on the archived thread.
      let refusal = 'none';
      for (let attempt = 0; attempt < 50 && refusal === 'none'; attempt++) {
        try {
          await agent.call('todos.list', { threadId });
          await Bun.sleep(20);
        } catch (error) {
          refusal = (error as Error).message;
        }
      }
      expect(refusal).toContain('closed');
    } finally {
      agent.close();
    }
  });
});

describe('the environment a thread launches with', () => {
  test('agentEnvFor writes the three variables and puts the CLI first on PATH', () => {
    // No drive letter in these: a colon is the delimiter itself off Windows.
    const cliDir = join('opt', 'boite', 'bin');
    const before = `${join('usr', 'bin')}${delimiter}${join('usr', 'other')}`;
    const fields = { threadId: 'thr_one', coreUrl: 'http://127.0.0.1:7777', token: 'secret', cliDir };
    const env = agentEnvFor({ Path: before, KEEP: 'kept' }, fields);
    expect(env[AGENT_ENV.threadId]).toBe('thr_one');
    expect(env[AGENT_ENV.coreUrl]).toBe('http://127.0.0.1:7777');
    expect(env[AGENT_ENV.token]).toBe('secret');
    expect(env['KEEP']).toBe('kept');
    // Windows spells it `Path`; a second PATH would be the one nothing reads.
    expect(env['Path']).toBe(`${cliDir}${delimiter}${before}`);
    expect(env['PATH']).toBeUndefined();

    // A second turn must not grow PATH by one entry.
    expect(agentEnvFor(env, fields)['Path']).toBe(`${cliDir}${delimiter}${before}`);
  });

  test('the shim directory is the named one, the one beside a compiled core, or the sources', () => {
    const dir = join(harness.dataDir, 'cli');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'boite'), '');
    writeFileSync(join(dir, 'boite.cmd'), '');
    expect(resolveCliDir({ BOITE_CLI_DIR: dir }, '/usr/bin/bun')).toBe(dir);
    // A compiled core offers the directory it sits in, when the shims were staged there.
    expect(resolveCliDir({}, join(dir, 'boite-core'))).toBe(dir);
    expect(resolveCliDir({}, join(harness.dataDir, 'boite-core'))).toBeNull();
    // From the sources it is packages/core/bin, tracked with both shims.
    expect(resolveCliDir({}, '/usr/bin/bun')).toBe(join(import.meta.dir, '..', 'bin'));

    const empty = join(harness.dataDir, 'empty');
    mkdirSync(empty, { recursive: true });
    const shim = process.platform === 'win32' ? 'boite.cmd' : 'boite';
    expect(() => resolveCliDir({ BOITE_CLI_DIR: empty }, '/usr/bin/bun')).toThrow(
      `BOITE_CLI_DIR is ${empty}, which holds no ${shim}: expected the directory of the boite shims`,
    );
  });

  test('no CLI directory leaves PATH alone, and an empty one is still written', () => {
    const none = agentEnvFor(
      { PATH: '/usr/bin' },
      { threadId: 'thr_one', coreUrl: 'http://127.0.0.1:7777', token: 'secret', cliDir: null },
    );
    expect(none['PATH']).toBe('/usr/bin');
    expect(none[AGENT_ENV.token]).toBe('secret');

    const empty = agentEnvFor(
      {},
      { threadId: 'thr_one', coreUrl: 'http://127.0.0.1:7777', token: 'secret', cliDir: '/opt/boite' },
    );
    expect(empty['PATH']).toBe('/opt/boite');
  });
});

describe('agent.where', () => {
  test('the thread, its project and its working directory, with no branch outside a worktree', async () => {
    const agent = await agentClient();
    try {
      const where = await agent.call('agent.where', { threadId });
      expect(where.threadId).toBe(threadId);
      expect(where.title).toBe('echo thread');
      expect(where.projectPath).toBe(harness.dataDir);
      expect(where.cwd).toBe(harness.dataDir);
      expect(where.branch).toBe(null);
      expect(where.worktree).toBe(false);
      expect(where.providerId).toBe('echo');
    } finally {
      agent.close();
    }
  });
});

describe('panel.open', () => {
  test('a file, a directory and a url are checked, and anything outside the working directory is refused', async () => {
    writeFileSync(join(harness.dataDir, 'panel.txt'), 'shown');
    mkdirSync(join(harness.dataDir, 'panel-dir'), { recursive: true });
    const agent = await agentClient();
    try {
      const failures: string[] = [];
      const attempts: (() => Promise<unknown>)[] = [
        () => agent.call('panel.open', { threadId, surface: { kind: 'file', path: 'nowhere.txt' } }),
        () => agent.call('panel.open', { threadId, surface: { kind: 'file', path: '../escaped.txt' } }),
        () => agent.call('panel.open', { threadId, surface: { kind: 'files', path: 'panel.txt' } }),
        () => agent.call('panel.open', { threadId, surface: { kind: 'browser', url: 'file:///etc/passwd' } }),
        () => agent.call('panel.open', { threadId, surface: { kind: 'nope' } as never }),
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
        'panel.open file path does not exist: nowhere.txt',
        "panel.open file path leaves the thread's working directory: ../escaped.txt",
        'panel.open files path is not a directory: panel.txt',
        'panel.open browser takes http or https, not file',
        'panel.open does not know the surface nope',
      ]);

      // What passes comes back relative, whatever the caller named it with.
      const seen = client.next<'panel.requested'>('panel.requested', (event) => event.threadId === threadId);
      await client.call('threads.subscribe', { threadId });
      const shown = await agent.call('panel.open', {
        threadId,
        surface: { kind: 'file', path: join(harness.dataDir, 'panel.txt'), line: 3 },
      });
      expect(shown).toEqual({ shown: true });
      expect((await seen).surface).toEqual({ kind: 'file', path: 'panel.txt', line: 3 });

      const directory = await agent.call('panel.open', { threadId, surface: { kind: 'files', path: 'panel-dir' } });
      expect(directory).toEqual({ shown: true });
    } finally {
      agent.close();
    }
  });

  test('nobody watching the thread means shown is false, and the diff keeps a path that is gone', async () => {
    const agent = await agentClient();
    const elsewhere = await harness.connect();
    const seenElsewhere: string[] = [];
    elsewhere.on('panel.requested', (event) => seenElsewhere.push(event.surface.kind));
    try {
      expect(await agent.call('panel.open', { threadId, surface: { kind: 'trace' } })).toEqual({ shown: false });
      const gone = client.next<'panel.requested'>('panel.requested', (event) => event.surface.kind === 'diff');
      await client.call('threads.subscribe', { threadId });
      // A diff names a file the working tree may no longer have.
      expect(await agent.call('panel.open', { threadId, surface: { kind: 'diff', path: 'deleted.txt' } })).toEqual({
        shown: true,
      });
      expect((await gone).surface).toEqual({ kind: 'diff', path: 'deleted.txt' });
      // The request went to the thread's own watchers: a second window on
      // nothing in particular keeps its panel.
      expect(seenElsewhere).toEqual([]);
    } finally {
      agent.close();
    }
  });
});

describe('the task list', () => {
  test('threads.tasks.set reaches thread.activity and threads.tasks.get reads it back', async () => {
    const agent = await agentClient();
    try {
      const activity = client.next<'thread.activity'>('thread.activity', (event) => event.threadId === threadId);
      const result = await agent.call('threads.tasks.set', {
        threadId,
        tasks: [
          { id: '1', text: 'read the contract', status: 'completed' },
          { id: '2', text: 'write the core', status: 'in_progress' },
        ],
      });
      expect(result.tasks.map((task) => task.status)).toEqual(['completed', 'in_progress']);
      expect((await activity).activity.tasks).toHaveLength(2);
      expect(harness.core.activity.get(threadId).tasks[1]?.text).toBe('write the core');
      expect(await agent.call('threads.tasks.get', { threadId })).toEqual(result.tasks);

      const failures: string[] = [];
      const attempts: (() => Promise<unknown>)[] = [
        () => agent.call('threads.tasks.set', { threadId, tasks: [{ id: '3', text: 'x', status: 'started' }] as never }),
        () => agent.call('threads.tasks.set', { threadId, tasks: [{ id: '', text: 'x', status: 'pending' }] }),
        () =>
          agent.call('threads.tasks.set', {
            threadId,
            tasks: Array.from({ length: 201 }, (_unused, index) => ({ id: String(index), text: 'x', status: 'pending' as const })),
          }),
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
        'task 3 is pending, in_progress, completed, not started',
        'task 0 needs an id',
        'threads.tasks.set takes at most 200 tasks, got 201',
      ]);
      // Nothing of the refused calls landed.
      expect(harness.core.activity.get(threadId).tasks).toHaveLength(2);
    } finally {
      agent.close();
    }
  });

  test('a thread with no plan answers an empty list', async () => {
    const agent = await agentClient();
    try {
      expect(await agent.call('threads.tasks.get', { threadId })).toEqual([]);
    } finally {
      agent.close();
    }
  });
});
