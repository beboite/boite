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
import { setDriver } from '../src/drivers/index.ts';
import { addTodo, AGENT_OPEN_TODOS_MAX } from '../src/todos.ts';
import { echoThread, startTestCore, waitFor } from './harness.ts';
import type { TestCore } from './harness.ts';
import { thrown } from './settle.ts';

let harness: TestCore;
let client: CoreClient;
let threadId: string;

beforeEach(async () => {
  harness = await startTestCore();
  client = await harness.connect();
  ({ threadId } = await echoThread(harness, client));
});

let restoreDriver: (() => void) | undefined;

afterEach(async () => {
  restoreDriver?.();
  restoreDriver = undefined;
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
    const projectId = harness.core.projects.require(harness.core.threads.require(threadId).projectId).id;
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

  test('an agent is refused a card past the open limit, the user is not, and a confirmed card frees a place', async () => {
    // Seed the boundary in one transaction; the permission checks below use real RPC.
    harness.core.journal.db.transaction(() => {
      for (let index = 0; index < AGENT_OPEN_TODOS_MAX; index++) {
        addTodo(harness.core, { threadId, text: `card ${index}` });
      }
    })();
    const agent = await agentClient();
    try {
      expect(await thrown(agent.call('todos.add', { threadId, text: 'one more' }))).toThrow(
        `an agent adds a card only while the project holds fewer than ${AGENT_OPEN_TODOS_MAX} open or claimed cards, this one has ${AGENT_OPEN_TODOS_MAX}`,
      );
      expect(await client.call('todos.list', { threadId })).toHaveLength(AGENT_OPEN_TODOS_MAX);
      const owners = await client.call('todos.add', { threadId, text: 'the user still adds' });
      await client.call('todos.update', { threadId, todoId: owners.id, status: 'done' });
      const [oldest] = (await client.call('todos.list', { threadId })).slice(-2);
      await client.call('todos.update', { threadId, todoId: oldest!.id, status: 'done' });
      const added = await agent.call('todos.add', { threadId, text: 'one more' });
      expect(added.status).toBe('open');
    } finally {
      agent.close();
    }
  });

  test('a second agent is refused a card the first already claimed', async () => {
    const todo = await client.call('todos.add', { threadId, text: 'one card, two agents' });
    const first = await agentClient();
    const second = await agentClient();
    try {
      const claimed = await first.call('todos.update', { threadId, todoId: todo.id, status: 'claimed' });
      expect(claimed.status).toBe('claimed');
      let message = 'none';
      try {
        await second.call('todos.update', { threadId, todoId: todo.id, status: 'claimed' });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toBe(`todo ${todo.id} is already claimed`);
      // The first claim still owns the card: the second took nothing.
      expect((await client.call('todos.list', { threadId }))[0]?.updatedAt).toBe(claimed.updatedAt);
    } finally {
      first.close();
      second.close();
    }
  });

  test('an agent cannot reopen or rewrite a card the user confirmed', async () => {
    const todo = await client.call('todos.add', { threadId, text: 'confirmed by the user' });
    await client.call('todos.update', { threadId, todoId: todo.id, status: 'done' });
    const agent = await agentClient();
    try {
      for (const params of [{ status: 'open' } as const, { text: 'rewritten' } as const]) {
        let message = 'none';
        try {
          await agent.call('todos.update', { threadId, todoId: todo.id, ...params });
        } catch (error) {
          message = (error as Error).message;
        }
        expect(message).toBe(`todo ${todo.id} is done: only the user reopens a card they confirmed`);
      }
      const after = (await client.call('todos.list', { threadId }))[0];
      expect(after?.status).toBe('done');
      expect(after?.text).toBe('confirmed by the user');
    } finally {
      agent.close();
    }
  });

  test('the owner reopens and rewrites a confirmed card, and reclaims a claimed one', async () => {
    const todo = await client.call('todos.add', { threadId, text: 'the user decides' });
    await client.call('todos.update', { threadId, todoId: todo.id, status: 'done' });
    const reopened = await client.call('todos.update', { threadId, todoId: todo.id, status: 'open', text: 'reworded' });
    expect(reopened.status).toBe('open');
    expect(reopened.text).toBe('reworded');
    await client.call('todos.update', { threadId, todoId: todo.id, status: 'claimed' });
    expect((await client.call('todos.update', { threadId, todoId: todo.id, status: 'claimed' })).status).toBe('claimed');
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

describe('the project board', () => {
  /** An echo agent that claims the goal at once, a tracker with one item it sees done, a reviewer that passes or fails. */
  function passingGoal(verdict = 'PASS'): void {
    restoreDriver = setDriver('echo', {
      protocol: 'echo',
      startTurn(ctx) {
        const id = ctx.emit.startMessage('assistant');
        const text = harness.core.activity.ownsTracker(ctx.thread.id)
          ? (ctx.prompt.includes('Say which open items') ? '```json\n{"done":[1]}\n```' : '```json\n{"items":[{"text":"Do the card","source":"objective"}]}\n```')
          : ctx.prompt.includes('You review a Boite goal') ? `Checked.\nVERDICT: ${verdict}` : 'Done.\n[BOITE_GOAL_COMPLETE]';
        ctx.emit.part(id, 0, { type: 'text', text });
        ctx.emit.complete(id, 'complete');
        return { stop() {}, done: Promise.resolve({ status: 'done', sessionId: null, usage: null }) };
      },
    });
  }

  test('a card started as a /goal2 carries its goal, and the passed review leaves it for the user to confirm', async () => {
    passingGoal();
    const card = await client.call('todos.add', { threadId, text: 'Do the card' });
    const goal = await echoThread(harness, client, 'Do the card');
    const linked = await client.call('todos.update', { threadId, todoId: card.id, goalThreadId: goal.threadId });
    expect(linked.goalThreadId).toBe(goal.threadId);
    expect(linked.goal).toBeUndefined();

    await client.call('threads.activity.set', { threadId: goal.threadId, goal: { objective: card.text, review: true } });
    await waitFor(() => harness.core.activity.get(goal.threadId).goal?.status === 'complete');
    const [claimed] = await client.call('todos.list', { threadId });
    expect(claimed).toMatchObject({ status: 'claimed', threadId: goal.threadId, goal: { status: 'complete', reviewing: false } });
    expect(claimed?.goal?.checklist?.items.map((item) => [item.text, item.status])).toEqual([['Do the card', 'done']]);
    // The goal is read on every send, never written into the stored list.
    const projectId = harness.core.threads.require(threadId).projectId;
    expect((harness.core.journal.getSetting(`todos:${projectId}`) as Record<string, unknown>[])[0]).not.toHaveProperty('goal');

    // Moved back to work after the pass, it stays open when the goal's thread moves again.
    await client.call('todos.update', { threadId, todoId: card.id, status: 'open' });
    const sent = client.next<'todos.updated'>('todos.updated');
    await client.call('threads.tasks.set', { threadId: goal.threadId, tasks: [{ id: '1', text: 'look again', status: 'pending' }] });
    await client.call('threads.activity.control', { threadId: goal.threadId, kind: 'goal', action: 'remove' });
    expect((await sent).todos[0]).toMatchObject({ id: card.id, status: 'open' });
    expect((await client.call('todos.list', { threadId }))[0]?.goal).toBeUndefined();
  });

  test('a goal completed by hand after a failed review claims nothing', async () => {
    passingGoal('FAIL');
    const card = await client.call('todos.add', { threadId, text: 'Do the card' });
    const goal = await echoThread(harness, client, 'Do the card');
    await client.call('todos.update', { threadId, todoId: card.id, goalThreadId: goal.threadId });
    await client.call('threads.activity.set', { threadId: goal.threadId, goal: { objective: card.text, review: true } });
    await waitFor(() => (harness.core.activity.get(goal.threadId).goal?.review?.verdicts.length ?? 0) > 0);
    await client.call('threads.activity.control', { threadId: goal.threadId, kind: 'goal', action: 'complete' });
    expect(harness.core.activity.get(goal.threadId).goal?.review?.verdicts.at(-1)?.verdict).toBe('fail');
    expect((await client.call('todos.list', { threadId }))[0]).toMatchObject({ status: 'open', goal: { status: 'complete' } });
  });

  test('a second start loses to the first link, and a conversation moved to another project lets go of its card', async () => {
    passingGoal();
    const card = await client.call('todos.add', { threadId, text: 'one agent only' });
    const first = await echoThread(harness, client, 'first');
    const second = await echoThread(harness, client, 'second');
    await client.call('todos.update', { threadId, todoId: card.id, goalThreadId: first.threadId });
    expect(await thrown(client.call('todos.update', { threadId, todoId: card.id, goalThreadId: second.threadId }))).toThrow(
      `todo ${card.id} already works in conversation ${first.threadId}`,
    );
    await client.call('threads.activity.set', { threadId: first.threadId, goal: { objective: card.text, review: true } });
    // Done, so no turn of the goal or its checklist holds the move back.
    await waitFor(() => harness.core.activity.get(first.threadId).goal?.status === 'complete' && harness.core.activity.get(first.threadId).goal?.checklist?.phase === 'idle');
    expect((await client.call('todos.list', { threadId }))[0]?.goal?.checklist?.items).toHaveLength(1);

    const path = join(harness.dataDir, 'moved-to');
    mkdirSync(path, { recursive: true });
    const other = await client.call('projects.add', { path, name: 'moved-to' });
    const heard = client.next<'todos.updated'>('todos.updated');
    await client.call('threads.move', { threadId: first.threadId, projectId: other.id });
    const sent = (await heard).todos[0];
    // The old project's agents no longer read the moved conversation's checklist.
    expect(sent).toMatchObject({ id: card.id, goalThreadId: null });
    expect(sent).not.toHaveProperty('goal');
    // Let go, the card takes a new conversation.
    expect((await client.call('todos.update', { threadId, todoId: card.id, goalThreadId: second.threadId })).goalThreadId).toBe(second.threadId);
  });

  test('a card links only a conversation of its own project, and null unlinks it', async () => {
    const path = join(harness.dataDir, 'board-elsewhere');
    mkdirSync(path, { recursive: true });
    const other = await client.call('projects.add', { path, name: 'elsewhere' });
    const account = (await client.call('accounts.list', {})).find((entry) => entry.providerId === 'echo');
    const stranger = await client.call('threads.create', { projectId: other.id, providerId: 'echo', accountId: account?.id ?? '', title: 'elsewhere' });
    const card = await client.call('todos.add', { threadId, text: 'stay home' });
    expect(await thrown(client.call('todos.update', { threadId, todoId: card.id, goalThreadId: stranger.id }))).toThrow(
      `goalThreadId ${stranger.id} is not a conversation of this card's project`,
    );
    const sibling = await echoThread(harness, client, 'sibling');
    expect((await client.call('todos.update', { threadId, todoId: card.id, goalThreadId: sibling.threadId })).goalThreadId).toBe(sibling.threadId);
    expect((await client.call('todos.update', { threadId, todoId: card.id, goalThreadId: null })).goalThreadId).toBeNull();
  });

  test('a paired device reads, moves and confirms cards, and hears every change', async () => {
    const { grant } = await client.call('pairing.grant', {});
    const phone = await connect(harness.url, '', { grant, client: { name: 'pwa', version: 'test' } });
    try {
      const heard = phone.next<'todos.updated'>('todos.updated');
      const card = await phone.call('todos.add', { threadId, text: 'from the phone' });
      expect((await heard).todos.map((todo) => todo.text)).toEqual(['from the phone']);
      await phone.call('todos.update', { threadId, todoId: card.id, status: 'claimed' });
      // The device is the user's: the confirmation an agent is refused is its own.
      expect((await phone.call('todos.update', { threadId, todoId: card.id, status: 'done' })).status).toBe('done');
      expect((await phone.call('todos.list', { threadId })).map((todo) => todo.status)).toEqual(['done']);
      await phone.call('todos.remove', { threadId, todoId: card.id });
      expect(await client.call('todos.list', { threadId })).toEqual([]);
    } finally {
      phone.close();
    }
  });
});
