import { describe, expect, test } from 'bun:test';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { MessagePart } from '@boite/contracts';
import { waitFor } from './harness.ts';
import {
  calls,
  claudeThread,
  harness,
  init,
  scripted,
  success,
  useClaudeHarness,
} from './fixtures/claude-query.ts';

useClaudeHarness();

test('coordination arrives once through Claude PostToolUse with agent provenance', async () => {
  scripted(fake => fake.emit(init('coordination-session')));
  const client = await harness.connect();
  const threadId = await claudeThread(client);
  const projectId = harness.core.projects.require(harness.core.threads.require(threadId).projectId).id;
  const account = (await client.call('accounts.list', {})).find(a => a.providerId === 'echo')!;
  const source = await client.call('threads.create', { projectId, providerId: 'echo', accountId: account.id, title: 'Maintenance' });
  const config = { mode: 'brief' as const, resources: 'shared VM', remote: false, paused: false };
  for (const id of [source.id, threadId]) harness.core.coordination.configure(id, config);
  await client.call('turns.start', { threadId, prompt: 'Deploy the service' });
  await waitFor(() => !!calls[0]?.prompts.length);
  await harness.core.coordination.send({ threadId: source.id, to: harness.core.coordination.get(threadId).self, text: 'May I reboot?', requestId: 'claude-hook' });
  const hook = calls[0]!.options.hooks!.PostToolUse![0]!.hooks[0]!;
  const input = { hook_event_name: 'PostToolUse' as const, session_id: 'coordination-session', transcript_path: '', cwd: harness.dataDir, tool_use_id: 'read-1', tool_name: 'Read', tool_input: {}, tool_response: 'file content' };
  const result = await hook(input, 'read-1', { signal: new AbortController().signal });
  expect(JSON.stringify(result)).toContain('OTHER AGENTS, NOT the user');
  expect(JSON.stringify(result)).toContain('May I reboot?');
  expect(JSON.stringify(result)).not.toContain('classifierContext');
  const again = await hook(input, 'read-2', { signal: new AbortController().signal });
  expect(JSON.stringify(again)).not.toContain('May I reboot?');
  expect(harness.core.coordination.get(threadId).messages[0]?.status).toBe('delivered');
  await client.call('turns.stop', { threadId });
});

test('an async answer reaches a running Claude turn at its next PostToolUse, not at its end', async () => {
  scripted(fake => fake.emit(init('answer-session')));
  const client = await harness.connect();
  const threadId = await claudeThread(client);
  await client.call('turns.start', { threadId, prompt: 'Migrate the schema' });
  await waitFor(() => !!calls[0]?.prompts.length);
  harness.core.threads.deferred.deliverAnswer(threadId, '> Which database?\n\nSQLite');
  expect((await client.call('threads.get', { threadId })).pendingAnswers).toEqual(['> Which database?\n\nSQLite']);
  const hook = calls[0]!.options.hooks!.PostToolUse![0]!.hooks[0]!;
  const input = { hook_event_name: 'PostToolUse' as const, session_id: 'answer-session', transcript_path: '', cwd: harness.dataDir, tool_use_id: 'read-1', tool_name: 'Read', tool_input: {}, tool_response: 'file content' };
  // A subagent's tool call is its own conversation: the answer waits for the main agent.
  const sub = await hook({ ...input, agent_id: 'agent-1', agent_type: 'Explore' }, 'read-0', { signal: new AbortController().signal });
  expect(JSON.stringify(sub)).not.toContain('SQLite');
  expect(harness.core.threads.deferred.deferredAnswers.has(threadId)).toBe(true);
  const result = JSON.stringify(await hook(input, 'read-1', { signal: new AbortController().signal }));
  expect(result).toContain('Which database?');
  expect(result).toContain('SQLite');
  expect(harness.core.threads.deferred.deferredAnswers.has(threadId)).toBe(false);
  const delivered = await client.call('threads.get', { threadId });
  expect(delivered.pendingAnswers).toEqual([]);
  expect(delivered.messages.filter(message => message.role === 'user').map(message => message.parts[0])).toEqual([
    { type: 'text', text: 'Migrate the schema' }, { type: 'text', text: '> Which database?\n\nSQLite' }
  ]);
  const again = await hook(input, 'read-2', { signal: new AbortController().signal });
  expect(JSON.stringify(again)).not.toContain('SQLite');
  await client.call('turns.stop', { threadId });
});

describe('claude driver', () => {
  test('YOLO disables configured hooks and accepts a tool request without a permission card', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);
    await client.call('threads.update', { threadId, permissionMode: 'yolo' });
    const requested: string[] = [];
    client.on('permission.requested', request => {
      requested.push(request.id);
      void client.call('permissions.answer', { requestId: request.id, decision: 'deny' });
    });
    const answers: (PermissionResult | null)[] = [];
    scripted((fake, options) => {
      fake.emit(init('sess-yolo'));
      void options.canUseTool!('Bash', { command: 'agent-browser --profile ./browser snapshot' }, {
        signal: new AbortController().signal, toolUseID: 'toolu_yolo', requestId: 'req_yolo',
      }).then(answer => {
        answers.push(answer);
        fake.emit(success('sess-yolo'));
        fake.end();
      });
    });
    const finished = client.next('turn.finished', turn => turn.threadId === threadId, 10000);
    await client.call('turns.start', { threadId, prompt: 'use the browser' });
    expect((await finished).status).toBe('done');
    expect(answers).toEqual([{ behavior: 'allow', updatedInput: { command: 'agent-browser --profile ./browser snapshot' } }]);
    expect(requested).toEqual([]);
    expect(calls[0]?.options).toMatchObject({
      permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true,
      settings: { disableAllHooks: true },
    });
    expect((await client.call('threads.get', { threadId })).messages.flatMap(message => message.parts)
      .filter(part => part.type === 'permission')).toEqual([]);
  });

  test('canUseTool routes to the permission gate and answers the CLI', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);

    const answers: (PermissionResult | null)[] = [];
    scripted((fake, options) => {
      const ask = options.canUseTool;
      if (ask === undefined) throw new Error('the driver must pass canUseTool');
      fake.emit(init('sess-ask'));
      void (async () => {
        const answer = await ask(
          'Bash',
          { command: 'ls' },
          { signal: new AbortController().signal, toolUseID: 'toolu_ask', requestId: 'req_ask' },
        );
        answers.push(answer);
        fake.emit(success('sess-ask'));
        fake.end();
      })();
    });

    const requested = client.next('permission.requested', (request) => request.threadId === threadId, 10000);
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 10000);
    await client.call('turns.start', { threadId, prompt: 'list the files' });

    const request = await requested;
    expect(request.toolName).toBe('Bash');
    expect((await client.call('threads.get', { threadId })).status).toBe('waiting');
    await client.call('permissions.answer', { requestId: request.id, decision: 'allow' });

    expect((await finished).status).toBe('done');
    expect(answers).toEqual([{ behavior: 'allow', updatedInput: { command: 'ls' } }]);

    const thread = await client.call('threads.get', { threadId });
    const parts: MessagePart[] = thread.messages[thread.messages.length - 1]?.parts ?? [];
    expect(parts.filter((part) => part.type === 'permission')).toEqual([
      { type: 'permission', requestId: request.id, toolName: 'Bash', decision: 'allow' },
    ]);
  });

  test('a card the CLI cancels is taken back, and the turn goes on', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);

    const answers: (PermissionResult | null)[] = [];
    const cancel = new AbortController();
    let resumed = (): void => undefined;
    scripted((fake, options) => {
      const ask = options.canUseTool;
      if (ask === undefined) throw new Error('the driver must pass canUseTool');
      fake.emit(init('sess-cancel'));
      void (async () => {
        answers.push(await ask('Bash', { command: 'ls' }, { signal: cancel.signal, toolUseID: 'toolu_cancel', requestId: 'req_cancel' }));
        // The CLI moved on: the turn keeps running after the cancel.
        await new Promise<void>((resolve) => { resumed = resolve; });
        fake.emit(success('sess-cancel'));
        fake.end();
      })();
    });

    const requested = client.next('permission.requested', (request) => request.threadId === threadId, 10000);
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 10000);
    await client.call('turns.start', { threadId, prompt: 'list the files' });
    const request = await requested;
    const resolved = client.next('permission.resolved', (event) => event.requestId === request.id, 10000);
    cancel.abort();

    expect((await resolved).decision).toBe('deny');
    await waitFor(() => answers.length === 1, 5000);
    expect(answers).toEqual([{ behavior: 'deny', message: expect.any(String) }]);
    expect(await client.call('permissions.list', { threadId })).toEqual([]);
    expect((await client.call('threads.get', { threadId })).status).toBe('running');
    await expect(client.call('permissions.answer', { requestId: request.id, decision: 'allow' })).rejects.toThrow();

    resumed();
    expect((await finished).status).toBe('done');
    const thread = await client.call('threads.get', { threadId });
    const parts: MessagePart[] = thread.messages[thread.messages.length - 1]?.parts ?? [];
    expect(parts.filter((part) => part.type === 'permission')).toEqual([
      { type: 'permission', requestId: request.id, toolName: 'Bash', decision: 'deny' },
    ]);
  });

  test('a CLI that dies with a card open writes nothing behind the completed message', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);

    const answers: (PermissionResult | null)[] = [];
    scripted((fake, options) => {
      const ask = options.canUseTool;
      if (ask === undefined) throw new Error('the driver must pass canUseTool');
      fake.emit(init('sess-late'));
      void (async () => {
        answers.push(
          await ask(
            'Bash',
            { command: 'rm -rf /' },
            { signal: new AbortController().signal, toolUseID: 'toolu_late', requestId: 'req_late' },
          ),
        );
      })();
      // The CLI dies with the card still open: no result message, no answer.
      fake.end();
    });

    // Everything written on the assistant message, in the order the clients see it.
    let assistantId = '';
    const written: string[] = [];
    client.on('message.started', (message) => {
      if (message.threadId === threadId && message.role === 'assistant') assistantId = message.id;
    });
    client.on('message.part', (event) => {
      if (event.messageId === assistantId) written.push(`part ${event.part.type}`);
    });
    client.on('message.completed', (event) => {
      if (event.messageId === assistantId) written.push('completed');
    });

    const requested = client.next('permission.requested', (request) => request.threadId === threadId, 10000);
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 10000);
    await client.call('turns.start', { threadId, prompt: 'clean up' });
    const request = await requested;
    await finished;

    // The core denies the card the turn left open, which is what wakes the
    // continuation the dead CLI parked here.
    await waitFor(() => answers.length === 1);
    expect(answers).toEqual([{ behavior: 'deny', message: 'Denied in Boite' }]);

    // A round trip on the same socket: every event the core emitted is delivered
    // by the time the answer comes back, so the order below is the whole order.
    const thread = await client.call('threads.get', { threadId });
    const parts: MessagePart[] = thread.messages[thread.messages.length - 1]?.parts ?? [];
    expect(parts.filter((part) => part.type === 'permission')).toEqual([
      { type: 'permission', requestId: request.id, toolName: 'Bash', decision: null },
    ]);
    expect(written).toEqual(['part permission', 'completed']);
  });

});

describe('claude driver: questions and background work', () => {
  test.each(['default', 'yolo'] as const)('AskUserQuestion still asks for real answers in %s', async permissionMode => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);
    await client.call('threads.update', { threadId, permissionMode });
    const input = {
      questions: [
        { question: 'Which database?', header: 'DB', multiSelect: false, options: [{ label: 'Postgres', description: 'relational' }, { label: 'SQLite' }] },
        { question: 'Which extras?', header: 'Extras', multiSelect: true, options: [{ label: 'Auth' }, { label: 'Search' }, { label: 'Billing' }] },
      ],
    };
    const answers: (PermissionResult | null)[] = [];
    scripted((fake, options) => {
      const ask = options.canUseTool!;
      fake.emit(init('sess-askq'));
      void (async () => {
        answers.push(await ask('AskUserQuestion', input, { signal: new AbortController().signal, toolUseID: 'toolu_q', requestId: 'req_q' }));
        fake.emit(success('sess-askq'));
        fake.end();
      })();
    });
    const first = client.next('question.asked', (q) => q.threadId === threadId, 10000);
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 10000);
    await client.call('turns.start', { threadId, prompt: 'set it up' });
    const one = await first;
    expect(one).toMatchObject({ text: 'Which database?', multiple: false, allowText: true });
    expect(one.options).toEqual([{ id: '1', label: 'Postgres', description: 'relational' }, { id: '2', label: 'SQLite' }]);
    expect((await client.call('threads.get', { threadId })).status).toBe('waiting');
    const second = client.next('question.asked', (q) => q.threadId === threadId, 10000);
    await client.call('questions.answer', { threadId, questionId: one.id, optionIds: ['2'] });
    const two = await second;
    expect(two.multiple).toBe(true);
    await client.call('questions.answer', { threadId, questionId: two.id, optionIds: ['1', '3'], text: 'and logs' });
    expect((await finished).status).toBe('done');
    expect(answers).toEqual([{
      behavior: 'allow',
      updatedInput: { ...input, answers: { 'Which database?': 'SQLite', 'Which extras?': 'Auth, Billing, and logs' } },
    }]);
    const parts = (await client.call('threads.get', { threadId })).messages.flatMap((m) => m.parts);
    // Cards, never a permission to use the tool.
    expect(parts.filter((part) => part.type === 'permission')).toEqual([]);
    expect(parts.filter((part) => part.type === 'question').map((part) => part.type === 'question' ? part.answer?.optionIds : null)).toEqual([['2'], ['1', '3']]);
  });

});
