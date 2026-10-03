import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { RpcErrorCode } from '@boite/contracts';
import type { CoreClient } from '../src/client.ts';
import { setDriver } from '../src/drivers/index.ts';
import type { TurnContext, TurnResult } from '../src/drivers/types.ts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';

let h: TestCore;
let client: CoreClient;
let restore: (() => void) | undefined;
beforeEach(async () => {
  h = await startTestCore();
  client = await h.connect();
});
afterEach(async () => {
  restore?.();
  restore = undefined;
  await h.stop();
});

/** An echo driver that answers `reply <prompt>` and names each native session, recording what every turn was handed. */
function recordingEcho(): TurnContext[] {
  const seen: TurnContext[] = [];
  restore = setDriver('echo', {
    protocol: 'echo',
    startTurn(ctx) {
      seen.push(ctx);
      const id = ctx.emit.startMessage('assistant');
      ctx.emit.part(id, 0, { type: 'text', text: `reply ${ctx.prompt}` });
      ctx.emit.complete(id, 'complete');
      return { stop() {}, done: Promise.resolve({ status: 'done', sessionId: `native-${seen.length}`, usage: null }) };
    },
  });
  return seen;
}

async function run(threadId: string, prompt: string): Promise<string> {
  const turn = await client.call('turns.start', { threadId, prompt });
  await waitFor(() => h.core.journal.getTurn(turn.id)?.finishedAt != null);
  expect(h.core.journal.getTurn(turn.id)?.status).toBe('done');
  return turn.id;
}

function userMessages(threadId: string) {
  return h.core.threads.get(threadId).messages.filter((message) => message.role === 'user');
}

async function refusal(call: Promise<unknown>): Promise<{ code: number; data: Record<string, unknown> }> {
  try {
    await call;
  } catch (error) {
    const failure = (error as { rpc: { code: number; data: Record<string, unknown> } }).rpc;
    return { code: failure.code, data: failure.data };
  }
  throw new Error('the call was expected to be refused');
}

describe('threads.rewind', () => {
  test('drops the message and what follows it, and hands its content back', async () => {
    recordingEcho();
    const { threadId } = await echoThread(h, client);
    await client.call('threads.subscribe', { threadId });
    await run(threadId, 'first');
    const second = await run(threadId, 'second');
    await run(threadId, 'third');
    const target = userMessages(threadId)[1];
    if (!target) throw new Error('no second prompt');

    const rewound = await client.call('threads.rewind', { threadId, messageId: target.id });
    expect(rewound.prompt).toBe('second');
    expect(rewound.attachments).toEqual([]);
    expect(rewound.session).toBe('seeded');
    expect(rewound.thread.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(rewound.thread.turns).toHaveLength(1);
    expect(rewound.thread.sessionId).toBeNull();

    const fresh = await client.call('threads.get', { threadId });
    expect(fresh.messages.map((message) => message.id)).toEqual(rewound.thread.messages.map((message) => message.id));
    expect(fresh.turns.map((turn) => turn.id)).not.toContain(second);
    const lastKept = fresh.messages.at(-1);
    if (!lastKept) throw new Error('nothing kept');
    const listed = await client.call('messages.list', { threadId, before: lastKept.id });
    expect(listed.messages.map((message) => message.role)).toEqual(['user']);
    await expect(client.call('messages.list', { threadId, before: target.id })).rejects.toThrow('is not a message of thread');

    // Append-only: the removal is an event of its own, naming what went.
    const events = h.core.journal.db.query<{ payload: string }, [string]>("SELECT payload FROM events WHERE type = 'thread.rewound' AND thread_id = ?").all(threadId);
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]?.payload ?? '{}') as { removedMessageIds: string[]; removedTurnIds: string[] };
    expect(payload.removedMessageIds).toContain(target.id);
    expect(payload.removedMessageIds).toHaveLength(4);
    expect(payload.removedTurnIds).toContain(second);
  });

  test('the next turn starts a fresh session carrying only the kept history', async () => {
    const seen = recordingEcho();
    const { threadId } = await echoThread(h, client);
    await run(threadId, 'the widgets are blue');
    await run(threadId, 'the gadgets are red');
    const target = userMessages(threadId)[1];
    if (!target) throw new Error('no second prompt');
    await client.call('threads.rewind', { threadId, messageId: target.id });
    await run(threadId, 'what colour');
    const last = seen.at(-1);
    expect(last?.sessionId).toBeNull();
    expect(last?.prompt).toContain('the widgets are blue');
    expect(last?.prompt).not.toContain('gadgets');
    expect(last?.prompt).toContain('what colour');
    // The fresh session is the thread's from then on.
    await run(threadId, 'again');
    expect(seen.at(-1)?.sessionId).toBe(`native-${seen.length - 1}`);
  });

  test('rewinding the first prompt leaves an empty thread with no session', async () => {
    const seen = recordingEcho();
    const { threadId } = await echoThread(h, client);
    await run(threadId, 'only');
    const target = userMessages(threadId)[0];
    if (!target) throw new Error('no prompt');
    const rewound = await client.call('threads.rewind', { threadId, messageId: target.id });
    expect(rewound.thread.messages).toEqual([]);
    expect(rewound.thread.turns).toEqual([]);
    await run(threadId, 'anew');
    expect(seen.at(-1)?.sessionId).toBeNull();
    expect(seen.at(-1)?.prompt).not.toContain('only');
  });

  test('refuses while a turn runs, and a message that is not a user message of the thread', async () => {
    let finish!: (result: TurnResult) => void;
    restore = setDriver('echo', {
      protocol: 'echo',
      startTurn(ctx) {
        const id = ctx.emit.startMessage('assistant');
        ctx.emit.part(id, 0, { type: 'text', text: 'working' });
        ctx.emit.complete(id, 'complete');
        return {
          stop: () => finish({ status: 'stopped', sessionId: null, usage: null }),
          done: new Promise((resolve) => { finish = resolve; }),
        };
      },
    });
    const { threadId } = await echoThread(h, client);
    const turn = await client.call('turns.start', { threadId, prompt: 'long' });
    await waitFor(() => h.core.threads.get(threadId).messages.length === 2);
    const [user, reply] = h.core.threads.get(threadId).messages;
    if (!user || !reply) throw new Error('missing messages');

    const running = await refusal(client.call('threads.rewind', { threadId, messageId: user.id }));
    expect(running.code).toBe(RpcErrorCode.Refused);
    expect(running.data).toMatchObject({ reason: 'turn-in-flight', expected: 'an idle thread' });

    finish({ status: 'done', sessionId: 'native', usage: null });
    await waitFor(() => h.core.journal.getTurn(turn.id)?.finishedAt != null);

    const assistant = await refusal(client.call('threads.rewind', { threadId, messageId: reply.id }));
    expect(assistant.code).toBe(RpcErrorCode.Refused);
    expect(assistant.data).toMatchObject({ field: 'messageId', role: 'assistant', expected: 'user' });

    const other = await echoThread(h, client, 'other');
    const foreign = await refusal(client.call('threads.rewind', { threadId: other.threadId, messageId: user.id }));
    expect(foreign.data).toMatchObject({ field: 'messageId', expected: 'a user message of this thread' });
    expect(h.core.threads.get(threadId).messages).toHaveLength(2);
  });

  test('a second subscribed client receives the removal', async () => {
    recordingEcho();
    const { threadId } = await echoThread(h, client);
    await run(threadId, 'keep');
    await run(threadId, 'drop');
    const watcher = await h.connect();
    await watcher.call('threads.subscribe', { threadId });
    const target = userMessages(threadId)[1];
    if (!target) throw new Error('no second prompt');
    const truncated = watcher.next('message.truncated', (event) => event.threadId === threadId, 5000);
    const updated = watcher.next('thread.updated', (event) => event.id === threadId, 5000);
    await client.call('threads.rewind', { threadId, messageId: target.id });
    expect(await truncated).toEqual({ threadId, messageId: target.id });
    expect((await updated).sessionId).toBeNull();
    watcher.close();
  });
});

describe('threads.fork', () => {
  test('copies the history up to the message into an independent thread', async () => {
    const seen = recordingEcho();
    const { threadId } = await echoThread(h, client, 'source');
    await run(threadId, 'alpha');
    await run(threadId, 'beta');
    const before = h.core.threads.get(threadId);
    const reply = before.messages[1];
    if (!reply) throw new Error('no reply');

    const created = client.next('thread.created', (event) => event.title === 'source (fork)', 5000);
    const fork = await client.call('threads.fork', { threadId, messageId: reply.id });
    expect((await created).id).toBe(fork.id);
    expect(fork.title).toBe('source (fork)');
    expect(fork.sessionId).toBeNull();
    const copied = h.core.threads.get(fork.id);
    expect(copied.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(copied.messages.every((message) => message.threadId === fork.id)).toBe(true);
    expect(copied.messages.map((message) => message.id)).not.toContain(reply.id);
    expect(copied.turns).toHaveLength(1);
    expect(copied.turns[0]?.usage).toBeNull();

    await run(fork.id, 'gamma');
    expect(seen.at(-1)?.sessionId).toBeNull();
    expect(seen.at(-1)?.prompt).toContain('alpha');
    expect(seen.at(-1)?.prompt).not.toContain('beta');

    const after = h.core.threads.get(threadId);
    expect(after.messages.map((message) => message.id)).toEqual(before.messages.map((message) => message.id));
    expect(after.sessionId).toBe(before.sessionId);
    await run(threadId, 'delta');
    expect(seen.at(-1)?.sessionId).toBe(before.sessionId);
  });

  test.each(['metadata', 'boundary'] as const)('a seeded worktree snapshot revalidates %s while placement waits', async change => {
    const path = join(h.dataDir, 'running-repo');
    mkdirSync(path);
    for (const args of [['init', '-q'], ['commit', '-q', '--allow-empty', '-m', 'init']]) {
      const git = Bun.spawnSync({ cmd: ['git', ...args], cwd: path,
        env: { ...process.env, GIT_AUTHOR_NAME: 'boite test', GIT_AUTHOR_EMAIL: 'test@boite.invalid', GIT_COMMITTER_NAME: 'boite test', GIT_COMMITTER_EMAIL: 'test@boite.invalid' },
        stdout: 'pipe', stderr: 'pipe', windowsHide: true });
      if (!git.success) throw new Error(git.stderr.toString());
    }
    const project = await client.call('projects.add', { path, name: 'running repo' });
    const account = (await client.call('accounts.list', {})).find(entry => entry.providerId === 'echo')!;
    const source = await client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: account.id, title: 'source' });
    const done = Promise.withResolvers<TurnResult>();
    restore = setDriver('echo', { protocol: 'echo', startTurn() {
      return { done: done.promise, stop: () => done.resolve({ status: 'stopped', sessionId: null, usage: null }) };
    } });
    const turn = await client.call('turns.start', { threadId: source.id, prompt: 'captured prompt' });
    await waitFor(() => h.core.journal.getTurn(turn.id)?.status === 'running');
    const user = userMessages(source.id)[0]!;
    const add = h.core.worktrees.add.bind(h.core.worktrees);
    const entered = Promise.withResolvers<void>(), proceed = Promise.withResolvers<void>();
    const placement = spyOn(h.core.worktrees, 'add').mockImplementation(async (...args) => {
      entered.resolve(); await proceed.promise; return add(...args);
    });
    try {
      const forked = h.core.threads.fork(source.id, user.id, true);
      await entered.promise;
      if (change === 'boundary') h.core.journal.putMessage({ ...user, parts: [{ type: 'text', text: 'changed boundary' }] });
      else {
        const current = h.core.threads.require(source.id);
        h.core.journal.putThread({ ...current, title: 'new source title', selectionVersion: (current.selectionVersion ?? 0) + 1, updatedAt: current.updatedAt + 1 });
      }
      proceed.resolve();
      if (change === 'boundary') {
        await expect(forked).rejects.toThrow('source thread changed');
        expect(h.core.journal.listThreads()).toHaveLength(1);
        expect(h.core.journal.getTurn(turn.id)?.status).toBe('running');
        return;
      }
      const fork = await forked;
      expect(fork.sessionId).toBeNull();
      expect(fork.forkOrigin?.mode).toBe('seeded');
      expect(fork.cwd).not.toBe(source.cwd);
      const snapshot = h.core.threads.get(fork.id);
      expect(snapshot.messages.map(message => message.parts)).toEqual([user.parts]);
      expect(snapshot.turns[0]?.status).toBe('stopped');
      expect(h.core.journal.getTurn(turn.id)?.status).toBe('running');
      expect(h.core.threads.require(source.id).title).toBe('new source title');
    } finally { proceed.resolve(); placement.mockRestore(); }
  });

  test('with worktree, the fork runs in a git worktree of its own', async () => {
    recordingEcho();
    const path = join(h.dataDir, 'repo');
    mkdirSync(path, { recursive: true });
    const git = (...args: string[]) => {
      const done = Bun.spawnSync({
        cmd: ['git', ...args],
        cwd: path,
        env: { ...process.env, GIT_AUTHOR_NAME: 'boite test', GIT_AUTHOR_EMAIL: 'test@boite.invalid', GIT_COMMITTER_NAME: 'boite test', GIT_COMMITTER_EMAIL: 'test@boite.invalid' },
        stdout: 'pipe',
        stderr: 'pipe',
        windowsHide: true,
      });
      if (!done.success) throw new Error(done.stderr.toString());
    };
    git('init', '-q');
    git('commit', '-q', '--allow-empty', '-m', 'init');
    const project = await client.call('projects.add', { path, name: 'repo' });
    const account = (await client.call('accounts.list', {})).find((entry) => entry.providerId === 'echo');
    if (!account) throw new Error('no echo account');
    const source = await client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: account.id, title: 'source' });
    await run(source.id, 'alpha');
    const user = userMessages(source.id)[0];
    if (!user) throw new Error('no prompt');

    const fork = await client.call('threads.fork', { threadId: source.id, messageId: user.id, worktree: true });
    expect(fork.cwd).not.toBe(source.cwd);
    expect(fork.branch).toBeTruthy();
    expect(existsSync(fork.cwd)).toBe(true);
    expect(h.core.threads.get(fork.id).messages.map((message) => message.role)).toEqual(['user']);
    expect(h.core.threads.require(source.id).cwd).toBe(source.cwd);
  });
});
