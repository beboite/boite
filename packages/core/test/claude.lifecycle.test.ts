import { describe, expect, test } from 'bun:test';
import type { MessagePart, RpcEvents } from '@boite/contracts';
import { waitFor } from './harness.ts';
import {
  assistant,
  calls,
  claudeThread,
  failure,
  harness,
  init,
  interrupted,
  queries,
  runTurn,
  scripted,
  sdk,
  streamEvent,
  success,
  useClaudeHarness,
} from './fixtures/claude-query.ts';

useClaudeHarness();

describe('claude driver', () => {
  test('a rejected Claude login updates the account and passive checks do not restore it', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);
    const accountId = harness.core.threads.require(threadId).accountId;
    scripted(fake => {
      fake.emit(sdk({ ...(assistant('sess-expired', []) as object), error: 'authentication_failed' }));
      fake.emit(sdk({ ...(failure('sess-expired') as object), errors: ['Failed to authenticate: OAuth session expired and could not be refreshed'] }));
      fake.end();
    });
    expect(await runTurn(client, threadId, 'test')).toBe('error');
    expect(harness.core.accounts.require(accountId).status).toBe('unauthenticated');
    expect((await client.call('accounts.check', { accountId })).status).toBe('unauthenticated');
    expect((await client.call('accounts.list', {})).find(account => account.id === accountId)?.status).toBe('unauthenticated');
  });

  test('an API error keeps the reason the CLI wrote with it', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);
    const said = 'Request too large (max 32MB). Accumulated images and attachments in the conversation pushed the request over the limit.';
    scripted(fake => {
      // What CLI 2.1.289 emits when a proxy answers 413 to a request carrying screenshots.
      fake.emit(sdk({ ...(assistant('sess-413', [{ type: 'text', text: said }]) as object), error: 'invalid_request', is_api_error_message: true }));
      fake.emit(sdk({ ...(success('sess-413') as object), is_error: true, result: said, api_error_status: 413 }));
      fake.end();
    });
    expect(await runTurn(client, threadId, 'show the screenshots')).toBe('error');
    expect(harness.core.journal.listTurns(threadId).at(-1)?.error).toBe(`Claude refused the request as invalid. ${said}`);
  });

  test('an API error the CLI cannot name shows its text, once', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);
    const said = 'API Error: upstream stream interrupted';
    scripted(fake => {
      // A proxy cut the stream: the CLI has no code for it, only its text.
      fake.emit(sdk({ ...(assistant('sess-cut', [{ type: 'text', text: said }]) as object), error: 'unknown', is_api_error_message: true }));
      fake.emit(sdk({ ...(success('sess-cut') as object), is_error: true, result: said }));
      fake.end();
    });
    expect(await runTurn(client, threadId, 'go on')).toBe('error');
    expect(harness.core.journal.listTurns(threadId).at(-1)?.error).toBe(said);
    const thread = await client.call('threads.get', { threadId });
    const parts: MessagePart[] = thread.messages[thread.messages.length - 1]?.parts ?? [];
    expect(parts.filter(part => part.type === 'error')).toEqual([{ type: 'error', message: said }]);
  });

  test('an OAuth failure before the first prompt marks the focused account signed out', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);
    const accountId = harness.core.threads.require(threadId).accountId;
    scripted(fake => {
      fake.emit(sdk({ ...(failure('') as object), errors: ['Failed to authenticate: OAuth session expired and could not be refreshed'] }));
      fake.end();
    });
    const updated = client.next('accounts.updated', account => account.id === accountId && account.status === 'unauthenticated', 5000);
    await client.call('threads.focus', { threadId });
    expect((await updated).status).toBe('unauthenticated');
    expect(harness.core.journal.listTurns(threadId)).toHaveLength(0);
  });

  test('stop interrupts the query and the turn ends stopped', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);

    scripted((fake) => {
      fake.emit(init('sess-stop'));
    });

    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 10000);
    await client.call('turns.start', { threadId, prompt: 'take your time' });
    await waitFor(() => queries.length === 1);

    expect(await client.call('turns.stop', { threadId })).toEqual({ stopped: true });
    const done = await finished;
    expect(done.status).toBe('stopped');
    expect(queries[0]?.interrupts).toBe(1);
    // The CLI's own error result for the interrupt is the stop, not a failure.
    expect(done.error).toBeNull();
    // Its usage is still counted.
    expect(done.usage?.costUsdEquivalent).toBe(0.002);
    const thread = await client.call('threads.get', { threadId });
    expect(thread.messages.flatMap((message) => message.parts).some((part) => part.type === 'error')).toBe(false);
    expect(thread.status).toBe('idle');
  });

  test('a stop while a tool call is still being typed closes its card', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);
    scripted((fake) => {
      fake.emit(init('sess-stop-tool'));
      fake.emit(streamEvent('sess-stop-tool', { type: 'message_start', message: { id: 'msg_api' } }));
      fake.emit(streamEvent('sess-stop-tool', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool_cut', name: 'Bash', input: {} } }));
      fake.emit(streamEvent('sess-stop-tool', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command": "c' } }));
    });
    const opened = client.next('message.delta', ({ threadId: id, text }) => id === threadId && text === '{"command": "c', 5000);
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 10000);
    await client.call('turns.start', { threadId, prompt: 'look around' });
    await opened;
    await client.call('turns.stop', { threadId });
    expect((await finished).status).toBe('stopped');
    const thread = await client.call('threads.get', { threadId });
    const tools = thread.messages.flatMap((message) => message.parts).filter((part) => part.type === 'tool');
    expect(tools.map((part) => part.status)).toEqual(['error']);
  });

  test('the CLI exiting on its interrupt result after a stop is not reported as an error', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);
    const errors: string[] = [];
    const off = harness.core.bus.onAny((name, payload) => {
      const log = payload as { level?: string; message?: string };
      if (name === 'core.log' && log.level === 'error') errors.push(log.message ?? '');
    });
    try {
      scripted((fake) => {
        fake.exitError = '[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use';
        fake.emit(init('sess-stop-exit'));
      });
      const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 10000);
      await client.call('turns.start', { threadId, prompt: 'take your time' });
      await waitFor(() => queries.length === 1);
      await client.call('turns.stop', { threadId });
      expect((await finished).status).toBe('stopped');
      await waitFor(() => (queries[0]?.closes ?? 0) > 0 || errors.length > 0, 5000).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(errors).toEqual([]);
    } finally { off(); }
  });

  test('an aborted result nobody asked for is still an error', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);

    scripted((fake) => {
      fake.emit(init('sess-aborted'));
      fake.emit(interrupted());
      fake.end();
    });

    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 10000);
    await client.call('turns.start', { threadId, prompt: 'go' });
    const done = await finished;
    expect(done.status).toBe('error');
    expect(done.error).toContain('[ede_diagnostic]');
  });

  test('an error result ends the turn with the reason the CLI gave', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);

    scripted((fake) => {
      fake.emit(init('sess-fail'));
      fake.emit(failure('sess-fail'));
      fake.end();
    });

    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 10000);
    await client.call('turns.start', { threadId, prompt: 'break' });
    const done = await finished;
    expect(done.status).toBe('error');
    expect(done.error).toBe('the tool loop gave up');

    const thread = await client.call('threads.get', { threadId });
    const parts: MessagePart[] = thread.messages[thread.messages.length - 1]?.parts ?? [];
    expect(parts).toEqual([{ type: 'error', message: 'the tool loop gave up' }]);
    expect(thread.status).toBe('error');
  });

  test('a resume whose transcript is gone starts a fresh session with the history, once', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);

    // Query 1 opens the session, query 2 asks to resume it and the CLI no longer
    // has it (its answer, word for word), query 3 is the fresh start.
    scripted((fake, options) => {
      if (options.resume === 'sess-gone') {
        fake.emit(sdk({ ...(failure('sess-gone') as object), errors: ['No conversation found with session ID: sess-gone'] }));
        fake.end();
        return;
      }
      const id = calls.length === 1 ? 'sess-gone' : 'sess-fresh';
      fake.emit(init(id));
      fake.emit(assistant(id, [{ type: 'text', text: calls.length === 1 ? 'first answer' : 'second answer' }]));
      fake.emit(success(id));
      fake.end();
    });

    expect(await runTurn(client, threadId, 'first question')).toBe('done');
    expect((await client.call('threads.get', { threadId })).sessionId).toBe('sess-gone');

    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 10000);
    await client.call('turns.start', { threadId, prompt: 'second question' });
    const done = await finished;
    expect(done.status).toBe('done');
    expect(done.error).toBeNull();

    expect(calls.map((call) => call.options.resume ?? null)).toEqual([null, 'sess-gone', null]);
    await waitFor(() => (calls[2]?.prompts.length ?? 0) > 0);
    // The fresh session is told what the lost one knew.
    expect(calls[2]?.prompts[0]).toContain('first answer');
    expect(calls[2]?.prompts[0]).toContain('second question');

    const thread = await client.call('threads.get', { threadId });
    expect(thread.sessionId).toBe('sess-fresh');
    expect(thread.sessionGeneration).toBe(1);
    expect(thread.status).toBe('idle');
    const parts = thread.messages.flatMap((message) => message.parts);
    expect(parts.some((part) => part.type === 'error')).toBe(false);
    expect(thread.messages.filter((message) => message.role === 'assistant')).toHaveLength(2);
  });

  test('a failed resume for any other reason keeps the session', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);

    scripted((fake, options) => {
      if (options.resume === 'sess-kept') {
        fake.emit(failure('sess-kept'));
        fake.end();
        return;
      }
      fake.emit(init('sess-kept'));
      fake.emit(success('sess-kept'));
      fake.end();
    });

    expect(await runTurn(client, threadId, 'first')).toBe('done');
    expect(await runTurn(client, threadId, 'second')).toBe('error');
    expect(calls).toHaveLength(2);
    const thread = await client.call('threads.get', { threadId });
    expect(thread.sessionId).toBe('sess-kept');
    expect(thread.sessionGeneration ?? 0).toBe(0);
  });

  test('spawnClaudeCodeProcess goes through the registry and is traced', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);

    scripted((fake, options) => {
      const spawn = options.spawnClaudeCodeProcess;
      if (spawn === undefined) throw new Error('the driver must pass spawnClaudeCodeProcess');
      const child = spawn({
        command: process.execPath,
        args: ['-e', "console.log('hi')"],
        env: { ...process.env },
        signal: new AbortController().signal,
      });
      child.once('exit', () => {
        fake.emit(success('sess-spawn'));
        fake.end();
      });
    });

    const started: RpcEvents['process.started'][] = [];
    client.on('process.started', (record) => {
      if (record.threadId === threadId) started.push(record);
    });
    const exited = client.next('process.exited', (record) => record.threadId === threadId, 15000);
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 15000);

    await client.call('turns.start', { threadId, prompt: 'spawn the cli' });
    expect((await finished).status).toBe('done');

    expect(started).toHaveLength(1);
    expect(started[0]?.commandLine).toContain("console.log('hi')");
    expect((await exited).exitCode).toBe(0);

    const trace = await client.call('trace.get', { threadId });
    expect(trace).toHaveLength(1);
    expect(trace[0]?.exitCode).toBe(0);
  });
});
