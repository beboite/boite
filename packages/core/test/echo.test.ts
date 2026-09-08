import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { MessagePart, RpcEvents } from '@boite/contracts';
import { echoThread, startTestCore } from './harness.ts';
import type { TestCore } from './harness.ts';

let harness: TestCore;

beforeEach(async () => {
  harness = await startTestCore();
});

afterEach(async () => {
  await harness.stop();
});

describe('echo driver', () => {
  test('a turn streams the prompt back, then finishes with usage', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    await client.call('threads.subscribe', { threadId });

    const prompt = 'the echo driver streams this prompt back in small chunks';
    const deltas: string[] = [];
    client.on('message.delta', (event) => {
      if (event.threadId === threadId) deltas.push(event.text);
    });

    const started = client.next('message.started', (message) => message.role === 'assistant');
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 10000);

    const turn = await client.call('turns.start', { threadId, prompt });
    expect(turn.status).toBe('queued');

    const assistant = await started;
    expect(assistant.threadId).toBe(threadId);

    const completed = await client.next(
      'message.completed',
      (event) => event.messageId === assistant.id,
      10000,
    );
    expect(completed.state).toBe('complete');
    expect(deltas.join('')).toBe(prompt);

    const done = await finished;
    expect(done.status).toBe('done');
    expect(done.usage?.outputTokens).toBe(prompt.split(' ').length);
    expect(done.usage?.inputTokens).toBe(prompt.split(' ').length);
    expect(done.usage?.cacheReadTokens).toBe(0);
    expect(done.usage?.costUsdEquivalent).toBeNull();

    const thread = await client.call('threads.get', { threadId });
    expect(thread.status).toBe('idle');
    expect(thread.sessionId).toBe(`echo-${threadId}`);
    expect(thread.messages).toHaveLength(2);
    expect(thread.messages[0]?.role).toBe('user');
    expect(thread.messages[1]?.parts).toEqual([{ type: 'text', text: prompt }]);
  });

  test('a tool directive produces a running then a done tool part', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    await client.call('threads.subscribe', { threadId });

    const parts: MessagePart[] = [];
    client.on('message.part', (event) => {
      if (event.threadId === threadId) parts.push(event.part);
    });

    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 10000);
    await client.call('turns.start', { threadId, prompt: 'run [tool] now' });
    await finished;

    const tools = parts.filter((part) => part.type === 'tool');
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({ name: 'fake_tool', status: 'running', output: null });
    expect(tools[1]).toMatchObject({ name: 'fake_tool', status: 'done', output: 'ok' });
  });

  test('a permission directive waits for the answer, then continues', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    await client.call('threads.subscribe', { threadId });

    const requested = client.next('permission.requested', (request) => request.threadId === threadId, 10000);
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 10000);
    await client.call('turns.start', { threadId, prompt: '[permission]' });

    const request = await requested;
    expect(request.toolName).toBe('fake_tool');
    expect((await client.call('threads.get', { threadId })).status).toBe('waiting');

    const resolved = client.next('permission.resolved', (event) => event.requestId === request.id, 10000);
    await client.call('permissions.answer', { requestId: request.id, decision: 'allow' });
    expect((await resolved).decision).toBe('allow');

    const done = await finished;
    expect(done.status).toBe('done');

    const thread = await client.call('threads.get', { threadId });
    const assistant = thread.messages[thread.messages.length - 1];
    expect(assistant?.parts[0]).toMatchObject({ type: 'permission', requestId: request.id, decision: 'allow' });
    expect(assistant?.parts[1]).toEqual({ type: 'text', text: 'allowed' });
  });

  test('an unsubscribed connection gets thread.updated but no message.delta', async () => {
    const subscriber = await harness.connect();
    const watcher = await harness.connect();
    const { threadId } = await echoThread(harness, subscriber);
    await subscriber.call('threads.subscribe', { threadId });

    const seen: string[] = [];
    watcher.onAny((event) => seen.push(event));

    const finished = subscriber.next('turn.finished', (turn) => turn.threadId === threadId, 10000);
    await subscriber.call('turns.start', { threadId, prompt: 'nobody is watching this one closely' });
    await finished;

    expect(seen).toContain('thread.updated');
    expect(seen).not.toContain('message.delta');
    expect(seen).not.toContain('message.started');
  });

  test('a spawn directive traces the child and appends its output', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    await client.call('threads.subscribe', { threadId });

    const started: RpcEvents['process.started'][] = [];
    client.on('process.started', (record) => {
      if (record.threadId === threadId) started.push(record);
    });
    const exited = client.next('process.exited', (record) => record.threadId === threadId, 10000);
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 15000);

    await client.call('turns.start', { threadId, prompt: '[spawn:echo hello]' });
    const done = await finished;
    expect(done.status).toBe('done');

    expect(started).toHaveLength(1);
    expect(started[0]?.commandLine).toContain('echo hello');
    expect((await exited).exitCode).toBe(0);

    const thread = await client.call('threads.get', { threadId });
    const assistant = thread.messages[thread.messages.length - 1];
    const text = assistant?.parts.map((part) => (part.type === 'text' ? part.text : '')).join('') ?? '';
    expect(text).toContain('hello');

    const trace = await client.call('trace.get', { threadId });
    expect(trace).toHaveLength(1);
    expect(trace[0]?.exitCode).toBe(0);
  });

  test('an error directive fails the turn loudly', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    await client.call('threads.subscribe', { threadId });

    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 10000);
    await client.call('turns.start', { threadId, prompt: 'this [error] ends it' });
    const done = await finished;
    expect(done.status).toBe('error');
    expect(done.error).toBe('echo error requested');
    expect((await client.call('threads.get', { threadId })).status).toBe('error');
  });

  test('turns.start on a claude account with no login fails with Unavailable', async () => {
    const client = await harness.connect();
    const project = await client.call('projects.add', { path: harness.dataDir, name: 'claude project' });
    const account = await client.call('accounts.add', { providerId: 'claude', label: 'no login' });
    expect(account.status).toBe('unauthenticated');

    const thread = await client.call('threads.create', {
      projectId: project.id,
      providerId: 'claude',
      accountId: account.id,
    });
    expect(thread.model).toBe('claude-sonnet-5');

    let failure = 'none';
    try {
      await client.call('turns.start', { threadId: thread.id, prompt: 'hello' });
    } catch (error) {
      failure = (error as Error).message;
    }
    expect(failure).toBe('the account no login is not logged in');
  });

  test('a finished turn on an unwatched thread marks it unread until markRead', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);

    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 10000);
    await client.call('turns.start', { threadId, prompt: 'unread please' });
    await finished;

    expect((await client.call('threads.get', { threadId })).unread).toBe(true);
    await client.call('threads.markRead', { threadId });
    expect((await client.call('threads.get', { threadId })).unread).toBe(false);
  });
});
