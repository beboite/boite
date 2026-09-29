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
  success,
  useClaudeHarness,
} from './fixtures/claude-query.ts';

useClaudeHarness();

describe('claude driver', () => {
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
