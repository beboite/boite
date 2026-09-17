/*
 * The project's cards: one list per project, shared by its threads, ordered
 * open first and confirmed last. The agent connects with its thread's token,
 * so what it may do to a card is the gate's answer as much as this file's.
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { CoreClient } from '../src/client.ts';
import { connect } from '../src/client.ts';
import { echoThread, startTestCore } from './harness.ts';
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

async function agentClient(): Promise<CoreClient> {
  return await connect(harness.url, harness.core.agents.tokenFor(threadId), {
    client: { name: 'boite-cli', version: 'test' },
  });
}

describe('the todo list of a project', () => {
  test('cards are added newest first, claimed in the middle and confirmed last', async () => {
    const agent = await agentClient();
    try {
      const first = await agent.call('todos.add', { threadId, text: 'read the contract' });
      const second = await agent.call('todos.add', { threadId, text: 'write the core' });
      const third = await agent.call('todos.add', { threadId, text: '  run the tests  ' });
      expect(third.text).toBe('run the tests');
      expect(third.status).toBe('open');
      expect(third.threadId).toBe(threadId);
      expect((await agent.call('todos.list', { threadId })).map((todo) => todo.id)).toEqual([
        third.id,
        second.id,
        first.id,
      ]);

      // An agent claims a card; only the user confirms one.
      const claimed = await agent.call('todos.update', { threadId, todoId: second.id, status: 'claimed' });
      expect(claimed.status).toBe('claimed');
      await client.call('todos.update', { threadId, todoId: first.id, status: 'done' });
      expect((await client.call('todos.list', { threadId })).map((todo) => [todo.id, todo.status])).toEqual([
        [third.id, 'open'],
        [second.id, 'claimed'],
        [first.id, 'done'],
      ]);
    } finally {
      agent.close();
    }
  });

  test('every change sends the whole list, with the project it belongs to', async () => {
    const projectId = harness.core.threads.require(threadId).projectId;
    const added = client.next<'todos.updated'>('todos.updated');
    const todo = await client.call('todos.add', { threadId, text: 'one card' });
    const event = await added;
    expect(event.projectId).toBe(projectId);
    expect(event.todos.map((entry) => entry.id)).toEqual([todo.id]);
    expect(event.todos[0]?.threadId).toBe(threadId);

    const removed = client.next<'todos.updated'>('todos.updated');
    expect(await client.call('todos.remove', { threadId, todoId: todo.id })).toEqual({ ok: true });
    expect((await removed).todos).toEqual([]);
  });

  test('an unknown card, an unknown status and empty text are refused by name', async () => {
    const todo = await client.call('todos.add', { threadId, text: 'one card' });
    const failures: string[] = [];
    const attempts: (() => Promise<unknown>)[] = [
      () => client.call('todos.update', { threadId, todoId: 'todo_nope', status: 'done' }),
      () => client.call('todos.update', { threadId, todoId: todo.id, status: 'finished' as never }),
      () => client.call('todos.add', { threadId, text: '   ' }),
      () => client.call('todos.remove', { threadId, todoId: 'todo_nope' }),
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
      'unknown todo todo_nope',
      'a todo is open, claimed, done, not finished',
      'a todo needs text',
      'unknown todo todo_nope',
    ]);
    // The refused status change never landed.
    expect((await client.call('todos.list', { threadId }))[0]?.status).toBe('open');
  });

  test('a card belongs to its project, not to the thread that wrote it', async () => {
    const path = join(harness.dataDir, 'second-project');
    mkdirSync(path, { recursive: true });
    const other = await client.call('projects.add', { path, name: 'second' });
    const accounts = await client.call('accounts.list', {});
    const account = accounts.find((entry) => entry.providerId === 'echo');
    const elsewhere = await client.call('threads.create', {
      projectId: other.id,
      providerId: 'echo',
      accountId: account?.id ?? '',
      title: 'another project',
    });

    await client.call('todos.add', { threadId, text: 'for the first project' });
    await client.call('todos.add', { threadId: elsewhere.id, text: 'for the second' });
    expect((await client.call('todos.list', { threadId })).map((todo) => todo.text)).toEqual(['for the first project']);
    expect((await client.call('todos.list', { threadId: elsewhere.id })).map((todo) => todo.text)).toEqual([
      'for the second',
    ]);

    // A second thread of the same project reads the same cards.
    const sibling = await echoThread(harness, client, 'sibling');
    expect((await client.call('todos.list', { threadId: sibling.threadId })).map((todo) => todo.text)).toEqual([
      'for the first project',
    ]);
  });

  test('an agent claims a card and is refused the confirmation, which belongs to the user', async () => {
    const todo = await client.call('todos.add', { threadId, text: 'one card' });
    const agent = await agentClient();
    try {
      let message = 'none';
      try {
        await agent.call('todos.update', { threadId, todoId: todo.id, status: 'done' });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toBe("todos.update status done is the owner's: an agent claims a card, the user confirms it");
      expect((await client.call('todos.list', { threadId }))[0]?.status).toBe('open');
    } finally {
      agent.close();
    }
  });

  test('the cards of a project reach its own agents and no agent of another project', async () => {
    const path = join(harness.dataDir, 'second-project');
    mkdirSync(path, { recursive: true });
    const other = await client.call('projects.add', { path, name: 'second' });
    const accounts = await client.call('accounts.list', {});
    const account = accounts.find((entry) => entry.providerId === 'echo');
    const elsewhere = await client.call('threads.create', {
      projectId: other.id,
      providerId: 'echo',
      accountId: account?.id ?? '',
      title: 'another project',
    });
    const mine = await agentClient();
    const stranger = await connect(harness.url, harness.core.agents.tokenFor(elsewhere.id), {
      client: { name: 'boite-cli', version: 'test' },
    });
    try {
      const seenByStranger: string[] = [];
      // A listener, not `next`: waiting for what must never come would time out into a later test.
      stranger.on('todos.updated', (event) => seenByStranger.push(event.projectId));
      const seenByMine = mine.next<'todos.updated'>('todos.updated');
      const seenByOwner = client.next<'todos.updated'>('todos.updated');
      await client.call('todos.add', { threadId, text: 'for the first project' });
      expect((await seenByMine).todos.map((todo) => todo.text)).toEqual(['for the first project']);
      await seenByOwner;
      // Both of the others have it by now, on the same loop of the same server.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(seenByStranger).toEqual([]);
    } finally {
      mine.close();
      stranger.close();
    }
  });

  test('the list survives a core that reads it back from the journal', async () => {
    const projectId = harness.core.threads.require(threadId).projectId;
    const todo = await client.call('todos.add', { threadId, text: 'kept across a restart' });
    const saved = harness.core.journal.getSetting(`todos:${projectId}`) as { id: string; text: string }[];
    expect(saved.map((entry) => entry.id)).toEqual([todo.id]);
    expect(saved[0]?.text).toBe('kept across a restart');
  });
});
