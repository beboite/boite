import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Options, PermissionResult, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { MessagePart, RpcEvents } from '@boite/contracts';
import type { CoreClient } from '../src/client.ts';
import { createClaudeDriver } from '../src/drivers/claude.ts';
import type { QueryFn } from '../src/drivers/claude.ts';
import { setDriver } from '../src/drivers/index.ts';
import { startTestCore, waitFor } from './harness.ts';
import type { TestCore } from './harness.ts';

let harness: TestCore;
let restore: (() => void) | null = null;

beforeEach(async () => {
  harness = await startTestCore();
});

afterEach(async () => {
  restore?.();
  restore = null;
  await harness.stop();
});

/** A logged-in claude account whose login is a file in the test data directory. */
async function claudeThread(client: CoreClient): Promise<string> {
  const project = await client.call('projects.add', { path: harness.dataDir, name: 'claude' });
  const account = await client.call('accounts.add', { providerId: 'claude', label: 'scripted' });
  if (account.isolationDir === null) throw new Error('the scripted account must be isolated');
  writeFileSync(join(account.isolationDir, '.credentials.json'), '{}');
  const checked = await client.call('accounts.check', { accountId: account.id });
  expect(checked.status).toBe('ok');
  const thread = await client.call('threads.create', {
    projectId: project.id,
    providerId: 'claude',
    accountId: account.id,
    title: 'scripted claude',
  });
  await client.call('threads.subscribe', { threadId: thread.id });
  return thread.id;
}

/** The SDK's `Query` as far as the driver uses it: an async iterable plus interrupt and close. */
class FakeQuery {
  private readonly queue: SDKMessage[] = [];
  private notify: (() => void) | null = null;
  private ended = false;
  interrupts = 0;
  closes = 0;

  emit(message: SDKMessage): void {
    this.queue.push(message);
    this.wake();
  }

  end(): void {
    this.ended = true;
    this.wake();
  }

  interrupt(): Promise<undefined> {
    this.interrupts += 1;
    this.end();
    return Promise.resolve(undefined);
  }

  close(): void {
    this.closes += 1;
    this.end();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage, void> {
    for (;;) {
      const next = this.queue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.notify = resolve;
      });
    }
  }

  private wake(): void {
    const notify = this.notify;
    this.notify = null;
    notify?.();
  }
}

const queries: FakeQuery[] = [];

function scripted(script: (fake: FakeQuery, options: Options) => void): void {
  queries.length = 0;
  const query: QueryFn = ({ options }) => {
    const fake = new FakeQuery();
    queries.push(fake);
    script(fake, options);
    return fake as unknown as Query;
  };
  restore = setDriver('claude-sdk', createClaudeDriver({ loadQuery: () => Promise.resolve(query) }));
}

// -- scripted messages, shaped like the CLI's own ---------------------------

function sdk(message: unknown): SDKMessage {
  return message as SDKMessage;
}

function init(sessionId: string): SDKMessage {
  return sdk({ type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-opus-5', tools: [] });
}

function streamEvent(sessionId: string, event: unknown): SDKMessage {
  return sdk({ type: 'stream_event', session_id: sessionId, parent_tool_use_id: null, event });
}

function assistant(sessionId: string, content: unknown[]): SDKMessage {
  return sdk({
    type: 'assistant',
    session_id: sessionId,
    parent_tool_use_id: null,
    message: { id: 'msg_1', role: 'assistant', model: 'claude-opus-5', content },
  });
}

function toolResult(sessionId: string, toolId: string, text: string): SDKMessage {
  return sdk({
    type: 'user',
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolId, content: [{ type: 'text', text }] }],
    },
  });
}

function success(sessionId: string): SDKMessage {
  return sdk({
    type: 'result',
    subtype: 'success',
    session_id: sessionId,
    is_error: false,
    result: 'pong',
    duration_ms: 12,
    duration_api_ms: 10,
    num_turns: 1,
    stop_reason: 'end_turn',
    total_cost_usd: 0.0125,
    usage: {
      input_tokens: 11,
      output_tokens: 3,
      cache_read_input_tokens: 5,
      cache_creation_input_tokens: 7,
    },
    modelUsage: {},
    permission_denials: [],
  });
}

function failure(sessionId: string): SDKMessage {
  return sdk({
    type: 'result',
    subtype: 'error_during_execution',
    session_id: sessionId,
    is_error: true,
    duration_ms: 12,
    duration_api_ms: 10,
    num_turns: 1,
    stop_reason: null,
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 0 },
    modelUsage: {},
    permission_denials: [],
    errors: ['the tool loop gave up'],
  });
}

describe('claude driver', () => {
  test('a scripted turn maps deltas, the tool pair, the usage and the session id', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);

    scripted((fake) => {
      fake.emit(init('sess-map'));
      fake.emit(streamEvent('sess-map', { type: 'message_start', message: { id: 'msg_1' } }));
      fake.emit(
        streamEvent('sess-map', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      );
      fake.emit(streamEvent('sess-map', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'po' } }));
      fake.emit(streamEvent('sess-map', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ng' } }));
      fake.emit(streamEvent('sess-map', { type: 'content_block_stop', index: 0 }));
      fake.emit(assistant('sess-map', [{ type: 'text', text: 'pong' }]));
      fake.emit(
        assistant('sess-map', [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'echo hi' } }]),
      );
      fake.emit(toolResult('sess-map', 'toolu_1', 'hi'));
      fake.emit(success('sess-map'));
      fake.end();
    });

    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 10000);
    await client.call('turns.start', { threadId, prompt: 'ping' });
    const done = await finished;

    expect(done.status).toBe('done');
    expect(done.usage).toEqual({
      inputTokens: 11,
      outputTokens: 3,
      cacheReadTokens: 5,
      cacheWriteTokens: 7,
      costUsdEquivalent: 0.0125,
    });

    const thread = await client.call('threads.get', { threadId });
    expect(thread.sessionId).toBe('sess-map');
    const assistants = thread.messages.filter((message) => message.role === 'assistant');
    expect(assistants).toHaveLength(1);

    const parts: MessagePart[] = assistants[0]?.parts ?? [];
    expect(parts.filter((part) => part.type === 'text')).toEqual([{ type: 'text', text: 'pong' }]);
    const tools = parts.filter((part) => part.type === 'tool');
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ toolId: 'toolu_1', name: 'Bash', status: 'done', output: 'hi' });
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
    expect((await finished).status).toBe('stopped');
    expect(queries[0]?.interrupts).toBe(1);
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

  test('spawnClaudeCodeProcess goes through the registry and is traced', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);

    scripted((fake, options) => {
      const spawn = options.spawnClaudeCodeProcess;
      if (spawn === undefined) throw new Error('the driver must pass spawnClaudeCodeProcess');
      const child = spawn({
        command: 'cmd',
        args: ['/c', 'echo', 'hi'],
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
    expect(started[0]?.commandLine).toContain('echo hi');
    expect((await exited).exitCode).toBe(0);

    const trace = await client.call('trace.get', { threadId });
    expect(trace).toHaveLength(1);
    expect(trace[0]?.exitCode).toBe(0);
  });
});
