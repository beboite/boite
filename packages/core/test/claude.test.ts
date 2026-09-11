import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type {
  Options,
  PermissionResult,
  Query,
  SDKMessage,
  SDKUserMessage,
  SlashCommand,
} from '@anthropic-ai/claude-agent-sdk';
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
  try {
    // The core closes first, so its shutdown reaches the scripted driver's sessions.
    await harness.stop();
  } finally {
    restore?.();
    restore = null;
  }
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
  // A title the user typed: the first finished turn asks the agent for none, so
  // every query and every process these tests count is a turn's own.
  await client.call('threads.update', { threadId: thread.id, title: 'scripted claude' });
  await client.call('threads.subscribe', { threadId: thread.id });
  return thread.id;
}

/**
 * The SDK's `Query` as far as the driver uses it: an async iterable, interrupt
 * and close, and the three setters that change a live session's model, effort
 * and permission mode.
 */
class FakeQuery {
  private readonly queue: SDKMessage[] = [];
  private notify: (() => void) | null = null;
  private ended = false;
  interrupts = 0;
  closes = 0;
  /** Every live setter the driver reached for, in order, as `<name> <value>`. */
  readonly setters: string[] = [];
  /** The name of the one setter this CLI refuses, the way an older one would. */
  refuse: string | null = null;
  /** What `supportedCommands()` answers, scripted before the query is used. */
  commandsAnswer: SlashCommand[] = [];

  supportedCommands(): Promise<SlashCommand[]> {
    return Promise.resolve(this.commandsAnswer);
  }

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

  setModel(model?: string): Promise<void> {
    return this.setter('setModel', model ?? 'the default');
  }

  setPermissionMode(mode: string): Promise<void> {
    return this.setter('setPermissionMode', mode);
  }

  applyFlagSettings(settings: { effortLevel?: string | null }): Promise<void> {
    return this.setter('effortLevel', settings.effortLevel ?? 'the default');
  }

  private setter(name: string, value: string): Promise<void> {
    if (this.refuse === name) return Promise.reject(new Error(`${name} is not available on this CLI`));
    this.setters.push(`${name} ${value}`);
    return Promise.resolve();
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
/** What the driver handed the SDK, query by query: the options and every prompt it pushed. */
const calls: { options: Options; prompts: string[] }[] = [];

/**
 * `script` runs when the driver opens a query, `reply` on every user message it
 * pushes into that query's stream: a warm session takes several.
 */
function scripted(
  script: (fake: FakeQuery, options: Options) => void,
  reply?: (fake: FakeQuery, prompt: string, index: number) => void,
): void {
  queries.length = 0;
  calls.length = 0;
  const query: QueryFn = ({ prompt, options }) => {
    const fake = new FakeQuery();
    const call = { options, prompts: [] as string[] };
    queries.push(fake);
    calls.push(call);
    void readPrompts(prompt, call.prompts, fake, reply);
    script(fake, options);
    return fake as unknown as Query;
  };
  restore = setDriver('claude-sdk', createClaudeDriver({ loadQuery: () => Promise.resolve(query) }));
}

/** The CLI exits when its input closes, so the fake ends with the prompt stream. */
async function readPrompts(
  stream: AsyncIterable<SDKUserMessage>,
  into: string[],
  fake: FakeQuery,
  reply?: (fake: FakeQuery, prompt: string, index: number) => void,
): Promise<void> {
  for await (const message of stream) {
    const content = message.message.content;
    const text = typeof content === 'string' ? content : JSON.stringify(content);
    reply?.(fake, text, into.length);
    into.push(text);
  }
  fake.end();
}

/** Answers every prompt of a warm session with one assistant text and one result. */
function answerEach(sessionId: string): (fake: FakeQuery, prompt: string, index: number) => void {
  return (fake, _prompt, index) => {
    fake.emit(init(sessionId));
    fake.emit(assistant(sessionId, [{ type: 'text', text: `answer ${index}` }]));
    fake.emit(success(sessionId));
  };
}

/** One turn, from the call to `turn.finished`. */
async function runTurn(client: CoreClient, threadId: string, prompt: string): Promise<string> {
  const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 10000);
  await client.call('turns.start', { threadId, prompt });
  return (await finished).status;
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

  test('a thinking block streams into its own part, ahead of the text, and is not repeated', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);

    scripted((fake) => {
      fake.emit(init('sess-think'));
      fake.emit(streamEvent('sess-think', { type: 'message_start', message: { id: 'msg_1' } }));
      fake.emit(
        streamEvent('sess-think', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '' },
        }),
      );
      fake.emit(
        streamEvent('sess-think', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'let me ' } }),
      );
      fake.emit(
        streamEvent('sess-think', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'check' } }),
      );
      fake.emit(streamEvent('sess-think', { type: 'content_block_stop', index: 0 }));
      fake.emit(
        streamEvent('sess-think', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
      );
      fake.emit(streamEvent('sess-think', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'pong' } }));
      fake.emit(streamEvent('sess-think', { type: 'content_block_stop', index: 1 }));
      // The assistant frame repeats both blocks; neither may be written twice.
      fake.emit(
        assistant('sess-think', [
          { type: 'thinking', thinking: 'let me check', signature: 'sig' },
          { type: 'text', text: 'pong' },
        ]),
      );
      fake.emit(success('sess-think'));
      fake.end();
    });

    expect(await runTurn(client, threadId, 'ping')).toBe('done');

    const thread = await client.call('threads.get', { threadId });
    const assistants = thread.messages.filter((message) => message.role === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0]?.parts).toEqual([
      { type: 'thinking', text: 'let me check' },
      { type: 'text', text: 'pong' },
    ]);
  });

  test('a tool input streams as partial json, then the assistant frame parses it', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);
    await client.call('threads.subscribe', { threadId });

    const parts: { partIndex: number; part: MessagePart }[] = [];
    const deltas: { partIndex: number; text: string }[] = [];
    client.on('message.part', (event) => {
      if (event.threadId === threadId) parts.push({ partIndex: event.partIndex, part: event.part });
    });
    client.on('message.delta', (event) => {
      if (event.threadId === threadId) deltas.push({ partIndex: event.partIndex, text: event.text });
    });

    scripted((fake) => {
      fake.emit(init('sess-json'));
      fake.emit(streamEvent('sess-json', { type: 'message_start', message: { id: 'msg_1' } }));
      fake.emit(
        streamEvent('sess-json', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_json', name: 'Bash', input: {} },
        }),
      );
      fake.emit(
        streamEvent('sess-json', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"command":"ech' },
        }),
      );
      fake.emit(
        streamEvent('sess-json', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: 'o hi"}' },
        }),
      );
      fake.emit(streamEvent('sess-json', { type: 'content_block_stop', index: 0 }));
      fake.emit(
        assistant('sess-json', [{ type: 'tool_use', id: 'toolu_json', name: 'Bash', input: { command: 'echo hi' } }]),
      );
      fake.emit(toolResult('sess-json', 'toolu_json', 'hi'));
      fake.emit(success('sess-json'));
      fake.end();
    });

    expect(await runTurn(client, threadId, 'ping')).toBe('done');

    // The block opens with no input and an empty streamed text.
    const opened = parts[0];
    expect(opened?.part).toMatchObject({ type: 'tool', toolId: 'toolu_json', input: {}, inputText: '' });
    const at = opened?.partIndex ?? -1;

    // Every delta lands on that part, and they concatenate to the whole json.
    expect(deltas.filter((delta) => delta.partIndex === at).map((delta) => delta.text).join('')).toBe(
      '{"command":"echo hi"}',
    );

    // The assistant frame replaces the streamed text with the parsed input.
    const parsed = parts.find((entry) => entry.part.type === 'tool' && entry.part.inputText === null);
    expect(parsed?.part).toMatchObject({ type: 'tool', input: { command: 'echo hi' }, inputText: null });

    const thread = await client.call('threads.get', { threadId });
    const tools = (thread.messages.at(-1)?.parts ?? []).filter((part) => part.type === 'tool');
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      toolId: 'toolu_json',
      name: 'Bash',
      input: { command: 'echo hi' },
      inputText: null,
      output: 'hi',
      status: 'done',
    });
  });

  test('Edit, Write and MultiEdit inputs become diff documents on their tool parts', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);
    await client.call('threads.subscribe', { threadId });

    scripted((fake) => {
      fake.emit(init('sess-docs'));
      // A streamed input first: nothing to read a diff out of until it parses.
      fake.emit(streamEvent('sess-docs', { type: 'message_start', message: { id: 'msg_1' } }));
      fake.emit(
        streamEvent('sess-docs', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_edit', name: 'Edit', input: {} },
        }),
      );
      fake.emit(
        assistant('sess-docs', [
          {
            type: 'tool_use',
            id: 'toolu_edit',
            name: 'Edit',
            input: { file_path: 'src/app.ts', old_string: 'const a = 1;', new_string: 'const a = 2;' },
          },
          {
            type: 'tool_use',
            id: 'toolu_write',
            name: 'Write',
            input: { file_path: 'src/new.ts', content: 'export const answer = 42;\n' },
          },
          {
            type: 'tool_use',
            id: 'toolu_multi',
            name: 'MultiEdit',
            input: {
              file_path: 'src/many.ts',
              edits: [
                { old_string: 'one', new_string: 'ONE' },
                { old_string: 'two', new_string: 'TWO' },
              ],
            },
          },
          { type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: { command: 'echo hi' } },
        ]),
      );
      fake.emit(toolResult('sess-docs', 'toolu_edit', 'edited'));
      fake.emit(success('sess-docs'));
      fake.end();
    });

    expect(await runTurn(client, threadId, 'ping')).toBe('done');

    const thread = await client.call('threads.get', { threadId });
    const tools = (thread.messages.at(-1)?.parts ?? []).filter((part) => part.type === 'tool');
    const documentsOf = (toolId: string): unknown =>
      tools.find((part) => part.type === 'tool' && part.toolId === toolId)?.documents;

    expect(documentsOf('toolu_edit')).toEqual([
      { kind: 'diff', path: 'src/app.ts', oldText: 'const a = 1;', newText: 'const a = 2;' },
    ]);
    // A written file is a diff against nothing.
    expect(documentsOf('toolu_write')).toEqual([
      { kind: 'diff', path: 'src/new.ts', oldText: '', newText: 'export const answer = 42;\n' },
    ]);
    // One document per edit, all on the same path.
    expect(documentsOf('toolu_multi')).toEqual([
      { kind: 'diff', path: 'src/many.ts', oldText: 'one', newText: 'ONE' },
      { kind: 'diff', path: 'src/many.ts', oldText: 'two', newText: 'TWO' },
    ]);
    // No other tool describes a file change in its input.
    expect(documentsOf('toolu_bash')).toBeUndefined();
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

  /** One plain turn on a thread set to `effort`, so the test can read what the SDK got. */
  async function turnWithEffort(effort: string | null): Promise<{ options: Options; prompt: string }> {
    const client = await harness.connect();
    const threadId = await claudeThread(client);
    const updated = await client.call('threads.update', { threadId, effort });
    expect(updated.effort).toBe(effort);

    scripted((fake) => {
      fake.emit(init('sess-effort'));
      fake.emit(success('sess-effort'));
      fake.end();
    });

    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 10000);
    await client.call('turns.start', { threadId, prompt: 'ping' });
    expect((await finished).status).toBe('done');

    const call = calls[0];
    if (call === undefined) throw new Error('the driver never called the SDK');
    await waitFor(() => call.prompts.length > 0);
    return { options: call.options, prompt: call.prompts[0] ?? '' };
  }

  test('a named effort level goes to the SDK as an option and leaves the prompt alone', async () => {
    const { options, prompt } = await turnWithEffort('xhigh');
    expect(options.effort).toBe('xhigh');
    expect(prompt).toBe('ping');
  });

  test('ultrathink passes no effort option and appends the word to the prompt once', async () => {
    const { options, prompt } = await turnWithEffort('ultrathink');
    expect(options.effort).toBeUndefined();
    expect(prompt).toBe('ping ultrathink');
  });

  test('a thread with no effort sends none, so the CLI keeps its own default', async () => {
    const { options, prompt } = await turnWithEffort(null);
    expect(options.effort).toBeUndefined();
    expect(prompt).toBe('ping');
  });
  // -- warm sessions --------------------------------------------------------

  test('two turns on a warm thread share one query and one prompt stream', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);
    await client.call('settings.set', { warmProcessMinutes: 5 });

    scripted(() => undefined, answerEach('sess-warm'));

    expect(await runTurn(client, threadId, 'first')).toBe('done');
    expect(await runTurn(client, threadId, 'second')).toBe('done');

    expect(queries).toHaveLength(1);
    expect(calls[0]?.prompts).toEqual(['first', 'second']);
    expect((await client.call('threads.get', { threadId })).sessionId).toBe('sess-warm');
  });

  test('warmProcessMinutes at zero keeps one query per turn', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);
    expect((await client.call('settings.get', {})).warmProcessMinutes).toBe(0);

    scripted(() => undefined, answerEach('sess-cold'));

    expect(await runTurn(client, threadId, 'first')).toBe('done');
    expect(await runTurn(client, threadId, 'second')).toBe('done');

    expect(queries).toHaveLength(2);
    expect(calls[0]?.prompts).toEqual(['first']);
    expect(calls[1]?.prompts).toEqual(['second']);
  });

  test('a model, an effort and a mode changed between the turns go to the live query', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);
    await client.call('settings.set', { warmProcessMinutes: 5 });

    scripted(() => undefined, answerEach('sess-live'));

    expect(await runTurn(client, threadId, 'first')).toBe('done');
    // Nothing moved yet: the query opened on all three.
    expect(queries[0]?.setters).toEqual([]);

    // `plan` and not `bypassPermissions`: that one is in the session key, and
    // the test under this one is what covers it.
    await client.call('threads.update', {
      threadId,
      model: 'claude-opus-5',
      effort: 'xhigh',
      permissionMode: 'plan',
    });
    expect(await runTurn(client, threadId, 'second')).toBe('done');

    // One query and one prompt stream: the CLI took all three in place.
    expect(queries).toHaveLength(1);
    expect(calls[0]?.prompts).toEqual(['first', 'second']);
    expect(calls[0]?.options.model).toBe('claude-sonnet-5');
    expect(calls[0]?.options.effort).toBeUndefined();
    expect(calls[0]?.options.permissionMode).toBe('default');
    expect(queries[0]?.setters).toEqual([
      'setModel claude-opus-5',
      'effortLevel xhigh',
      'setPermissionMode plan',
    ]);
  });

  test('a switch into bypassPermissions opens a second query, and back out a third', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);
    await client.call('settings.set', { warmProcessMinutes: 5 });

    scripted(() => undefined, answerEach('sess-bypass'));

    expect(await runTurn(client, threadId, 'first')).toBe('done');

    // `allowDangerouslySkipPermissions` is a query-start option with no setter
    // beside it, so the warm query cannot be talked into the skip: it closes and
    // the turn lands on a query opened with the flag.
    await client.call('threads.update', { threadId, permissionMode: 'bypassPermissions' });
    expect(await runTurn(client, threadId, 'second')).toBe('done');

    expect(queries).toHaveLength(2);
    expect(queries[0]?.setters).toEqual([]);
    expect(calls[0]?.options.allowDangerouslySkipPermissions).toBe(false);
    expect(calls[1]?.options.allowDangerouslySkipPermissions).toBe(true);
    expect(calls[1]?.options.permissionMode).toBe('bypassPermissions');
    expect(calls[1]?.prompts).toEqual(['second']);

    // And the way back is the same: a query opened with the skip keeps it.
    await client.call('threads.update', { threadId, permissionMode: 'default' });
    expect(await runTurn(client, threadId, 'third')).toBe('done');

    expect(queries).toHaveLength(3);
    expect(calls[2]?.options.allowDangerouslySkipPermissions).toBe(false);
    expect(calls[2]?.prompts).toEqual(['third']);
  });

  test('a turn that changed nothing reaches for no setter at all', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);
    await client.call('settings.set', { warmProcessMinutes: 5 });

    scripted(() => undefined, answerEach('sess-still'));

    expect(await runTurn(client, threadId, 'first')).toBe('done');
    expect(await runTurn(client, threadId, 'second')).toBe('done');

    expect(queries).toHaveLength(1);
    expect(queries[0]?.setters).toEqual([]);
  });

  test('ultrathink on a warm query clears the effort level back to the model default', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);
    await client.call('settings.set', { warmProcessMinutes: 5 });
    await client.call('threads.update', { threadId, effort: 'xhigh' });

    scripted(() => undefined, answerEach('sess-ultra'));

    expect(await runTurn(client, threadId, 'first')).toBe('done');
    await client.call('threads.update', { threadId, effort: 'ultrathink' });
    expect(await runTurn(client, threadId, 'second')).toBe('done');

    expect(queries).toHaveLength(1);
    // `ultrathink` is no SDK level: the flag layer is cleared and the word goes
    // in the prompt, exactly what a query opened on `ultrathink` does.
    expect(queries[0]?.setters).toEqual(['effortLevel the default']);
    expect(calls[0]?.prompts).toEqual(['first', 'second ultrathink']);
  });

  test('a setter the CLI refuses starts a fresh query on the new setup, and the turn still runs', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);
    await client.call('settings.set', { warmProcessMinutes: 5 });
    const logs: string[] = [];
    client.on('core.log', (entry) => {
      logs.push(`${entry.level} ${entry.message}`);
    });

    scripted((fake) => {
      // Only the first query refuses; the second opens on the new model.
      if (queries.length === 1) fake.refuse = 'setModel';
    }, answerEach('sess-refused'));

    expect(await runTurn(client, threadId, 'first')).toBe('done');
    await client.call('threads.update', { threadId, model: 'claude-opus-5' });
    expect(await runTurn(client, threadId, 'second')).toBe('done');

    expect(queries).toHaveLength(2);
    expect(calls[0]?.options.model).toBe('claude-sonnet-5');
    expect(calls[1]?.options.model).toBe('claude-opus-5');
    expect(calls[1]?.prompts).toEqual(['second']);
    await waitFor(() => logs.some((line) => line.startsWith('warn claude: the warm session refused')));
  });

  test('the idle window ends the session and the next turn starts a new query', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);
    // Fractions are minutes too: 0.002 is the 120 ms this test can afford to wait.
    await client.call('settings.set', { warmProcessMinutes: 0.002 });

    scripted(() => undefined, answerEach('sess-idle'));

    expect(await runTurn(client, threadId, 'first')).toBe('done');
    expect(queries).toHaveLength(1);
    await waitFor(() => (queries[0]?.closes ?? 0) > 0);

    expect(await runTurn(client, threadId, 'second')).toBe('done');
    expect(queries).toHaveLength(2);
    expect(calls[1]?.prompts).toEqual(['second']);
  });

  test('stop on a warm session closes it and the next turn starts a new query', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);
    await client.call('settings.set', { warmProcessMinutes: 5 });

    scripted(
      (fake) => {
        fake.emit(init('sess-warm-stop'));
      },
      (fake, prompt, index) => {
        // The first prompt is the one the test stops: nothing answers it.
        if (prompt === 'take your time') return;
        fake.emit(init('sess-warm-again'));
        fake.emit(assistant('sess-warm-again', [{ type: 'text', text: `answer ${index}` }]));
        fake.emit(success('sess-warm-again'));
      },
    );

    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 10000);
    await client.call('turns.start', { threadId, prompt: 'take your time' });
    await waitFor(() => queries.length === 1);
    expect(await client.call('turns.stop', { threadId })).toEqual({ stopped: true });
    expect((await finished).status).toBe('stopped');
    expect(queries[0]?.interrupts).toBe(1);

    expect(await runTurn(client, threadId, 'again')).toBe('done');
    expect(queries).toHaveLength(2);
    expect(calls[1]?.prompts).toEqual(['again']);
  });

  test('an image attachment rides beside the text as a content block', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);

    scripted((fake) => {
      fake.emit(init('sess-image'));
      fake.emit(assistant('sess-image', [{ type: 'text', text: 'i see it' }]));
      fake.emit(success('sess-image'));
    });

    const PNG =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 10000);
    await client.call('turns.start', {
      threadId,
      prompt: 'what is this',
      attachments: [{ kind: 'image', mimeType: 'image/png', data: PNG, name: 'pixel.png' }],
    });
    expect((await finished).status).toBe('done');

    const sent = JSON.parse(calls[0]?.prompts[0] ?? '[]') as unknown[];
    expect(sent).toEqual([
      { type: 'text', text: 'what is this' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
    ]);
  });

  test('supportedCommands lists the slash commands, and commands_changed moves the list', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);
    await client.call('settings.set', { warmProcessMinutes: 5 });

    scripted(
      (fake) => {
        fake.commandsAnswer = [
          { name: 'shout', description: 'The prompt back in capitals', argumentHint: '<text>' },
          { name: 'whisper', description: 'The prompt back as it came', argumentHint: '' },
        ];
      },
      (fake, _prompt, index) => {
        fake.emit(init('sess-commands'));
        if (index === 1) {
          fake.emit(
            sdk({
              type: 'system',
              subtype: 'commands_changed',
              session_id: 'sess-commands',
              uuid: 'uuid-commands',
              commands: [{ name: 'yell', description: 'louder still', argumentHint: '' }],
            }),
          );
        }
        fake.emit(assistant('sess-commands', [{ type: 'text', text: `answer ${index}` }]));
        fake.emit(success('sess-commands'));
      },
    );

    expect(await runTurn(client, threadId, 'first')).toBe('done');
    expect((await client.call('threads.get', { threadId })).commands).toEqual([
      { name: 'shout', description: 'The prompt back in capitals', hint: '<text>' },
      { name: 'whisper', description: 'The prompt back as it came', hint: null },
    ]);

    // One query the whole time: the second list arrives mid-session, on the CLI's own say-so.
    expect(await runTurn(client, threadId, 'second')).toBe('done');
    expect(queries).toHaveLength(1);
    expect((await client.call('threads.get', { threadId })).commands).toEqual([
      { name: 'yell', description: 'louder still', hint: null },
    ]);
  });

  test('the last request of a turn is the context meter, the result names the window, and a compaction is a divider', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);

    scripted(() => undefined, (fake) => {
      fake.emit(init('sess-context'));
      // The first request is a tool call: not the reading, the second request is.
      fake.emit(
        sdk({
          type: 'assistant',
          session_id: 'sess-context',
          parent_tool_use_id: null,
          message: {
            id: 'msg_a',
            role: 'assistant',
            model: 'claude-opus-5',
            content: [{ type: 'text', text: 'looking' }],
            usage: { input_tokens: 4_000, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 1_000 },
          },
        }),
      );
      fake.emit(
        sdk({
          type: 'system',
          subtype: 'compact_boundary',
          session_id: 'sess-context',
          uuid: 'uuid-compact',
          compact_metadata: { trigger: 'auto', pre_tokens: 95_000, post_tokens: 20_000 },
        }),
      );
      fake.emit(
        sdk({
          type: 'assistant',
          session_id: 'sess-context',
          parent_tool_use_id: null,
          message: {
            id: 'msg_b',
            role: 'assistant',
            model: 'claude-opus-5',
            content: [{ type: 'text', text: 'done' }],
            usage: { input_tokens: 500, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 0 },
          },
        }),
      );
      const result = success('sess-context') as SDKMessage & { modelUsage: Record<string, unknown> };
      result.modelUsage = { 'claude-opus-5-20260401': { contextWindow: 200_000 } };
      fake.emit(result);
    });

    expect(await runTurn(client, threadId, 'measure')).toBe('done');
    const thread = await client.call('threads.get', { threadId });
    expect(thread.context).toMatchObject({ tokens: 20_500, window: 200_000 });
    expect(thread.messages[1]?.parts).toEqual([
      { type: 'text', text: 'looking' },
      { type: 'compaction', trigger: 'auto', preTokens: 95_000, postTokens: 20_000 },
      { type: 'text', text: 'done' },
    ]);
  });
});
