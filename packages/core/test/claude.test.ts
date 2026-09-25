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
import type { QueryFn } from '../src/drivers/claude/query.ts';
import { setDriver } from '../src/drivers/index.ts';
import { scriptedClaude, startTestCore, waitFor } from './harness.ts';
import type { TestCore } from './harness.ts';

let harness: TestCore;
let restore: (() => void) | null = null;

beforeEach(async () => {
  harness = await startTestCore();
  scriptedClaude(harness);
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
  /**
   * The real CLI (2.1.282) answers an interrupt with an error result before it
   * ends; true is an older fake that ends with no result at all.
   */
  silentInterrupt = false;
  /** Every live setter the driver reached for, in order, as `<name> <value>`. */
  readonly setters: string[] = [];
  /** The name of the one setter this CLI refuses, the way an older one would. */
  refuse: string | null = null;
  /** What `supportedCommands()` answers, scripted before the query is used. */
  commandsAnswer: SlashCommand[] = [];
  modelsAnswer: Awaited<ReturnType<Query["supportedModels"]>> = [];
  supportedModels() { return Promise.resolve(this.modelsAnswer); }

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
    if (!this.silentInterrupt) this.emit(interrupted());
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

/** What CLI 2.1.282 writes when an interrupt lands before any assistant block was committed. */
function interrupted(): SDKMessage {
  return sdk({
    ...(failure('') as object),
    // The fake does not know its session: no id, so the one it had stays.
    session_id: undefined,
    terminal_reason: 'aborted_streaming',
    usage: { input_tokens: 4, output_tokens: 1 },
    total_cost_usd: 0.002,
    errors: ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null'],
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

  test('one Edit writes its card three times, and the hooks never ship the original file', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);
    await client.call('threads.subscribe', { threadId });
    const written: MessagePart[] = [];
    client.on('message.part', (event) => {
      if (event.threadId === threadId && event.part.type === 'tool') written.push(event.part);
    });

    const originalFile = 'x'.repeat(100_000);
    const input = { file_path: 'a.ts', old_string: 'x', new_string: 'y' };
    const signal = new AbortController().signal;
    scripted((fake, options) => {
      const pre = options.hooks!.PreToolUse![0]!.hooks[0]!;
      const post = options.hooks!.PostToolUse![0]!.hooks[0]!;
      const base = { session_id: 'sess-edit', transcript_path: '', cwd: harness.dataDir, tool_use_id: 'toolu_edit', tool_name: 'Edit', tool_input: input };
      void (async () => {
        // The CLI's order: the streamed block, the assistant frame, the two hooks, the result.
        fake.emit(init('sess-edit'));
        fake.emit(streamEvent('sess-edit', { type: 'message_start', message: { id: 'msg_1' } }));
        fake.emit(streamEvent('sess-edit', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_edit', name: 'Edit', input: {} } }));
        fake.emit(streamEvent('sess-edit', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }));
        fake.emit(assistant('sess-edit', [{ type: 'tool_use', id: 'toolu_edit', name: 'Edit', input }]));
        await waitFor(() => written.length >= 2);
        await pre({ ...base, hook_event_name: 'PreToolUse' }, 'toolu_edit', { signal });
        await post({ ...base, hook_event_name: 'PostToolUse', tool_response: { filePath: 'a.ts', originalFile, structuredPatch: [] } }, 'toolu_edit', { signal });
        fake.emit(toolResult('sess-edit', 'toolu_edit', 'The file a.ts has been updated.'));
        fake.emit(success('sess-edit'));
        fake.end();
      })();
    });

    expect(await runTurn(client, threadId, 'edit it')).toBe('done');
    expect(written).toHaveLength(3);
    expect(written.some((part) => JSON.stringify(part).includes(originalFile))).toBe(false);
    const thread = await client.call('threads.get', { threadId });
    const tool = thread.messages.at(-1)?.parts.find((part) => part.type === 'tool');
    expect(tool).toMatchObject({ toolId: 'toolu_edit', status: 'done', output: 'The file a.ts has been updated.', input });
  });

  test('a PreToolUse with no assistant frame before it still draws the card', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);
    scripted((fake, options) => {
      const pre = options.hooks!.PreToolUse![0]!.hooks[0]!;
      void (async () => {
        fake.emit(init('sess-hook'));
        await pre({ hook_event_name: 'PreToolUse', session_id: 'sess-hook', transcript_path: '', cwd: harness.dataDir, tool_use_id: 'toolu_only', tool_name: 'Bash', tool_input: { command: 'ls' } }, 'toolu_only', { signal: new AbortController().signal });
        fake.emit(toolResult('sess-hook', 'toolu_only', 'a.ts'));
        fake.emit(success('sess-hook'));
        fake.end();
      })();
    });
    expect(await runTurn(client, threadId, 'list')).toBe('done');
    const thread = await client.call('threads.get', { threadId });
    expect(thread.messages.at(-1)?.parts.find((part) => part.type === 'tool')).toMatchObject({ toolId: 'toolu_only', name: 'Bash', input: { command: 'ls' }, output: 'a.ts', status: 'done' });
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

  test('a warm query reports a running total, and each turn is charged its own share', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);
    await client.call('settings.set', { warmProcessMinutes: 5 });

    // The CLI counts `total_cost_usd` from the start of its process: 0.25, then 0.25 + 0.05.
    scripted(() => undefined, (fake, _prompt, index) => {
      fake.emit(init('sess-cost'));
      fake.emit(sdk({ ...(success('sess-cost') as object), total_cost_usd: index === 0 ? 0.25 : 0.3 }));
    });

    const costs: (number | null)[] = [];
    for (const prompt of ['first', 'second']) {
      const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 10000);
      await client.call('turns.start', { threadId, prompt });
      costs.push((await finished).usage?.costUsdEquivalent ?? null);
    }

    expect(queries).toHaveLength(1);
    expect(costs[0]).toBeCloseTo(0.25, 10);
    expect(costs[1]).toBeCloseTo(0.05, 10);
  });

  test('a cold query that resumes a session is charged its own share, whether or not the CLI restored its totals', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);

    // Each turn uses 26 tokens. The second process restores the session (52 tokens held, 0.25 + 0.05);
    // the third has lost it and counts from zero.
    const held = (tokens: number) => ({ 'claude-test': { inputTokens: tokens, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0, contextWindow: 0, maxOutputTokens: 0 } });
    const results = [{ total_cost_usd: 0.25, modelUsage: held(26) }, { total_cost_usd: 0.3, modelUsage: held(52) }, { total_cost_usd: 0.07, modelUsage: held(26) }];
    let turn = 0;
    scripted(() => undefined, (fake) => {
      fake.emit(init('sess-resumed'));
      fake.emit(sdk({ ...(success('sess-resumed') as object), ...results[turn++] }));
    });

    const costs: (number | null)[] = [];
    for (const prompt of ['first', 'second', 'third']) {
      const finished = client.next('turn.finished', (finishedTurn) => finishedTurn.threadId === threadId, 10000);
      await client.call('turns.start', { threadId, prompt });
      costs.push((await finished).usage?.costUsdEquivalent ?? null);
    }

    expect(queries).toHaveLength(3);
    expect(costs[0]).toBeCloseTo(0.25, 10);
    expect(costs[1]).toBeCloseTo(0.05, 10);
    expect(costs[2]).toBeCloseTo(0.07, 10);
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


test('Claude discovery reports only its model capabilities, caches and refreshes without a prompt', async () => {
  scripted(fake => { fake.modelsAnswer = [
    { value: 'default', resolvedModel: 'claude-opus-5', displayName: 'Default (recommended)', description: '', supportsFastMode: true },
    { value: 'opus', resolvedModel: 'claude-opus-5', displayName: 'Opus', description: 'Opus 5 with 1M context', supportsEffort: true, supportedEffortLevels: ['low', 'high'], supportsAdaptiveThinking: true, supportsFastMode: true },
    { value: 'haiku', displayName: 'Haiku', description: '', supportsEffort: false, supportsFastMode: false },
  ]; }, answerEach('native-speeds'));
  const client = await harness.connect();
  const id = await claudeThread(client);
  const accountId = (await client.call('threads.get', { threadId: id })).accountId;
  const result = await client.call('providers.probe', { providerId: 'claude', accountId });
  expect(result.models[0]?.name).toBe('Claude Opus 5');
  expect(result.models.some(model => /default/i.test(model.name))).toBe(false);
  expect(result.models.find(model => model.id === 'claude-opus-4-8')).toMatchObject({ legacy: true, name: 'Claude Opus 4.8' });
  expect(result.models.find(model => model.id === 'claude-opus-4-8')?.speeds).toBeUndefined();
  expect(result.models[0]?.effort?.levels.map(level => level.id)).toEqual(['low', 'high', 'ultrathink']);
  expect(result.models[0]?.speeds).toEqual([{ id: 'fast', label: 'Fast' }]);
  expect(result.models[1]?.effort).toBeUndefined(); expect(result.models[1]?.speeds).toBeUndefined();
  await client.call('providers.probe', { providerId: 'claude', accountId });
  expect(calls).toHaveLength(1); expect(calls[0]?.prompts).toEqual([]); expect(queries[0]?.closes).toBe(1);
  await client.call('providers.probe', { providerId: 'claude', accountId, refresh: true });
  expect(calls).toHaveLength(2);
  await client.call('threads.update', { threadId: id, model: 'claude-opus-5', speed: 'fast' });
  expect(await runTurn(client, id, 'fast turn')).toBe('done');
  expect(calls.at(-1)?.options.settings).toEqual({ fastMode: true });
  await client.call('threads.update', { threadId: id, speed: null });
  expect(await runTurn(client, id, 'standard turn')).toBe('done');
  expect(calls.at(-1)?.options.settings).toEqual({ fastMode: false });
});

describe('claude driver: questions and background work', () => {
  test('AskUserQuestion draws one card per question and hands the answers back in the tool input', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);
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

  test('a background shell keeps the CLI after the turn, and what it writes when done opens a turn of its own', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);
    const sessionId = 'sess-bg';
    scripted((fake) => {
      fake.emit(init(sessionId));
      fake.emit(assistant(sessionId, [{ type: 'tool_use', id: 'toolu_bg', name: 'Bash', input: { command: 'sleep 25', run_in_background: true } }]));
      fake.emit(sdk({ type: 'system', subtype: 'task_started', session_id: sessionId, task_id: 'bash-1', tool_use_id: 'toolu_bg', description: 'sleep 25', task_type: 'local_bash', is_backgrounded: true }));
      fake.emit(sdk({ type: 'system', subtype: 'background_tasks_changed', session_id: sessionId, tasks: [
        { task_id: 'bash-1', task_type: 'local_bash', description: 'sleep 25' },
        { task_id: 'watch-1', task_type: 'monitor', description: 'file watcher', ambient: true },
      ] }));
      fake.emit(toolResult(sessionId, 'toolu_bg', 'Command running in background with ID: bash-1'));
      fake.emit(assistant(sessionId, [{ type: 'text', text: 'started' }]));
      fake.emit(success(sessionId));
    });
    const background = client.next('thread.background', (event) => event.threadId === threadId && event.tasks.length > 0, 10000);
    expect(await runTurn(client, threadId, 'run it in the background')).toBe('done');
    const running = await background;
    expect(running.tasks).toEqual([{ id: 'bash-1', kind: 'shell', description: 'sleep 25', toolId: 'toolu_bg', startedAt: expect.any(Number) }]);
    expect((await client.call('threads.get', { threadId })).background).toHaveLength(1);
    // warmProcessMinutes is 0, and still the CLI stays: closing it kills the shell.
    await Bun.sleep(300);
    expect(queries[0]!.closes).toBe(0);
    expect((queries[0] as unknown as { ended: boolean }).ended).toBe(false);

    const cleared = client.next('thread.background', (event) => event.threadId === threadId && event.tasks.length === 0, 10000);
    const woke = client.next('turn.finished', (turn) => turn.threadId === threadId, 10000);
    const fake = queries[0]!;
    fake.emit(sdk({ type: 'system', subtype: 'background_tasks_changed', session_id: sessionId, tasks: [] }));
    fake.emit(sdk({ type: 'system', subtype: 'task_notification', session_id: sessionId, task_id: 'bash-1', tool_use_id: 'toolu_bg', status: 'completed', output_file: '', summary: 'sleep 25 finished' }));
    fake.emit(init(sessionId));
    fake.emit(assistant(sessionId, [{ type: 'text', text: 'FINISHED' }]));
    fake.emit(success(sessionId));
    await cleared;
    const turn = await woke;
    expect(turn.status).toBe('done');
    expect(turn.execution?.operation).toBe('background');
    const messages = harness.core.journal.listMessages(threadId).filter((m) => m.turnId === turn.id);
    expect(messages.map((m) => m.role)).toEqual(['system', 'assistant']);
    expect(messages[0]?.parts[0]).toMatchObject({ type: 'text', displayText: 'Background work finished' });
    expect(messages[1]?.parts).toEqual([{ type: 'text', text: 'FINISHED' }]);
    // The background turn sent no prompt; the CLI went on by itself.
    expect(calls[0]!.prompts).toHaveLength(1);
    // Nothing left to keep it for: the cold rule closes it now.
    await waitFor(() => (queries[0] as unknown as { ended: boolean }).ended);
  });

  test('Stop on an idle thread, an archive and an account switch sweep what the released CLI left', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);
    const swept: string[] = [];
    harness.core.procs.sweepSoon = (id: string): void => {
      swept.push(id);
    };
    const withBackground = (sessionId: string): void => scripted((fake) => {
      fake.emit(init(sessionId));
      fake.emit(sdk({ type: 'system', subtype: 'background_tasks_changed', session_id: sessionId, tasks: [{ task_id: 'bash-1', task_type: 'local_bash', description: 'npm run dev' }] }));
      fake.emit(success(sessionId));
    });

    withBackground('sess-sweep');
    expect(await runTurn(client, threadId, 'start the dev server')).toBe('done');
    expect(await client.call('turns.stop', { threadId })).toEqual({ stopped: true });
    expect(swept).toEqual([threadId]);

    const echo = (await client.call('accounts.list', {})).find((account) => account.providerId === 'echo')!;
    await client.call('threads.update', { threadId, accountId: echo.id });
    expect(swept).toEqual([threadId, threadId]);

    await client.call('threads.archive', { threadId, archived: true });
    expect(swept).toEqual([threadId, threadId, threadId]);
  });

  test("a subagent's own messages stay off the main message, and its API error does not fail the turn", async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);
    const sessionId = 'sess-sub';
    /** What a subagent writes: the same shapes, tagged with the Agent call that runs it. */
    const sub = (type: 'assistant' | 'user', body: Record<string, unknown>): SDKMessage =>
      sdk({ type, session_id: sessionId, parent_tool_use_id: 'toolu_task', ...body });
    scripted((fake, options) => {
      fake.emit(init(sessionId));
      fake.emit(assistant(sessionId, [{ type: 'tool_use', id: 'toolu_task', name: 'Agent', input: { prompt: 'look around' } }]));
      // The hooks fire for the subagent's tools too, tagged with its agent id.
      const pre = options.hooks!.PreToolUse![0]!.hooks[0]!;
      void pre({ hook_event_name: 'PreToolUse', agent_id: 'agent-1', session_id: sessionId, transcript_path: '', cwd: harness.dataDir, tool_use_id: 'toolu_hooked', tool_name: 'Read', tool_input: {} }, 'toolu_hooked', { signal: new AbortController().signal });
      fake.emit(sub('assistant', { message: { id: 'msg_sub1', role: 'assistant', content: [
        { type: 'text', text: 'SUBAGENT THINKING ALOUD' },
        { type: 'tool_use', id: 'toolu_grep', name: 'Grep', input: { pattern: 'x' } },
      ], usage: { input_tokens: 50000 } } }));
      fake.emit(sdk({ type: 'stream_event', session_id: sessionId, parent_tool_use_id: 'toolu_task', event: { type: 'message_start', message: { id: 'msg_sub2' } } }));
      fake.emit(sdk({ type: 'stream_event', session_id: sessionId, parent_tool_use_id: 'toolu_task', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'SUBAGENT STREAM' } } }));
      fake.emit(sub('user', { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_grep', content: 'hit' }] } }));
      fake.emit(sub('assistant', { error: 'rate_limit', message: { id: 'msg_sub3', role: 'assistant', content: [{ type: 'text', text: 'API Error: 429' }] } }));
      fake.emit(toolResult(sessionId, 'toolu_task', 'the subagent report'));
      fake.emit(sdk({ type: 'assistant', session_id: sessionId, parent_tool_use_id: null, message: { id: 'msg_main', role: 'assistant', content: [{ type: 'text', text: 'MAIN ANSWER' }], usage: { input_tokens: 120, cache_read_input_tokens: 30 } } }));
      fake.emit(success(sessionId));
      fake.end();
    });

    expect(await runTurn(client, threadId, 'explore')).toBe('done');
    const thread = await client.call('threads.get', { threadId });
    const parts = thread.messages.filter((message) => message.role === 'assistant').flatMap((message) => message.parts);
    expect(parts.some((part) => part.type === 'error')).toBe(false);
    expect(parts.filter((part) => part.type === 'tool').map((part) => part.type === 'tool' ? part.toolId : '')).toEqual(['toolu_task']);
    const texts = parts.filter((part) => part.type === 'text').map((part) => part.type === 'text' ? part.text : '');
    expect(texts).toEqual(['MAIN ANSWER']);
    // The meter is the main loop's last request, never the subagent's prompt.
    expect(thread.context?.tokens).toBe(150);
  });

  test('a background subagent talking after the turn opens no turn of its own', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);
    const sessionId = 'sess-bg-sub';
    scripted((fake) => {
      fake.emit(init(sessionId));
      fake.emit(assistant(sessionId, [{ type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: { prompt: 'dig', run_in_background: true } }]));
      fake.emit(sdk({ type: 'system', subtype: 'background_tasks_changed', session_id: sessionId, tasks: [{ task_id: 'agent-1', task_type: 'local_agent', description: 'dig' }] }));
      fake.emit(toolResult(sessionId, 'toolu_agent', 'Async agent launched'));
      fake.emit(success(sessionId));
    });
    expect(await runTurn(client, threadId, 'dig in the background')).toBe('done');

    queries[0]!.emit(sdk({ type: 'assistant', session_id: sessionId, parent_tool_use_id: 'toolu_agent', message: { id: 'msg_bg', role: 'assistant', content: [{ type: 'text', text: 'still digging' }] } }));
    await Bun.sleep(300);
    expect(harness.core.journal.listTurns(threadId)).toHaveLength(1);
    expect((await client.call('threads.get', { threadId })).status).toBe('idle');
    await client.call('turns.stop', { threadId });
  });

  test('output the CLI writes while the last turn is still closing opens its turn right after', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);
    const sessionId = 'sess-bg-race';
    scripted((fake) => {
      fake.emit(init(sessionId));
      fake.emit(sdk({ type: 'system', subtype: 'background_tasks_changed', session_id: sessionId, tasks: [{ task_id: 'bash-3', task_type: 'local_bash', description: 'sleep 1' }] }));
      fake.emit(assistant(sessionId, [{ type: 'text', text: 'started' }]));
      fake.emit(success(sessionId));
      // Before the core saved that turn: the task ends and the CLI goes on by itself.
      fake.emit(sdk({ type: 'system', subtype: 'background_tasks_changed', session_id: sessionId, tasks: [] }));
      fake.emit(assistant(sessionId, [{ type: 'text', text: 'ON ITS OWN' }]));
      fake.emit(success(sessionId));
    });
    const woke = client.next('turn.finished', (turn) => turn.threadId === threadId && turn.execution?.operation === 'background', 10000);
    expect(await runTurn(client, threadId, 'run it')).toBe('done');
    const turn = await woke;
    expect(turn.status).toBe('done');
    const texts = (turnId: string) => harness.core.journal.listMessages(threadId).filter((m) => m.turnId === turnId && m.role === 'assistant').flatMap((m) => m.parts).map((p) => (p.type === 'text' ? p.text : ''));
    expect(texts(turn.id)).toEqual(['ON ITS OWN']);
    const first = harness.core.journal.listMessages(threadId).find((m) => m.role === 'user')!.turnId;
    expect(texts(first)).toEqual(['started']);
  });

  test('a turn of the user that takes over a run the CLI started by itself is not closed by that run', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);
    const sessionId = 'sess-bg-takeover';
    harness.core.settings.set({ warmProcessMinutes: 5 });
    scripted((fake) => {
      fake.emit(init(sessionId));
      fake.emit(success(sessionId));
    });
    expect(await runTurn(client, threadId, 'first')).toBe('done');
    // The core is told the output is there, but the user's prompt gets in first.
    const fake = queries[0]!;
    const threads = harness.core.threads as unknown as { wake(threadId: string, text: string): void };
    const wake = threads.wake.bind(threads);
    threads.wake = () => {};
    fake.emit(assistant(sessionId, [{ type: 'text', text: 'ON ITS OWN' }]));
    await Bun.sleep(50);
    threads.wake = wake;
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 10000);
    await client.call('turns.start', { threadId, prompt: 'second' });
    await Bun.sleep(100);
    // The CLI's own run ends: that result is not the user's.
    fake.emit(success(sessionId));
    await Bun.sleep(100);
    expect((await client.call('threads.get', { threadId })).status).toBe('running');
    fake.emit(assistant(sessionId, [{ type: 'text', text: 'answer to second' }]));
    fake.emit(success(sessionId));
    expect((await finished).status).toBe('done');
    harness.core.settings.set({ warmProcessMinutes: 0 });
  });

  test('Stop on an idle thread ends the work it still runs in the background', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);
    scripted((fake) => {
      fake.emit(init('sess-stop-bg'));
      fake.emit(sdk({ type: 'system', subtype: 'background_tasks_changed', session_id: 'sess-stop-bg', tasks: [{ task_id: 'bash-2', task_type: 'local_bash', description: 'npm run dev' }] }));
      fake.emit(success('sess-stop-bg'));
    });
    expect(await runTurn(client, threadId, 'serve')).toBe('done');
    await waitFor(() => (harness.core.threads.get(threadId).background ?? []).length === 1);
    const cleared = client.next('thread.background', (event) => event.threadId === threadId && event.tasks.length === 0, 10000);
    expect(await client.call('turns.stop', { threadId })).toEqual({ stopped: true });
    await cleared;
    await waitFor(() => (queries[0] as unknown as { ended: boolean }).ended);
  });
});

test('a new Claude session learns `boite ask` once, and the setting turns it off', async () => {
  harness.core.settings.set({ asyncQuestions: true, warmProcessMinutes: 5 });
  scripted(() => undefined, answerEach('sess-teach'));
  const client = await harness.connect();
  const threadId = await claudeThread(client);
  expect(await runTurn(client, threadId, 'first')).toBe('done');
  expect(await runTurn(client, threadId, 'second')).toBe('done');
  expect(calls[0]!.prompts[0]).toContain('boite ask "<question>"');
  // The session has it already.
  expect(calls[0]!.prompts[1]).toBe('second');

  harness.core.settings.set({ asyncQuestions: false, warmProcessMinutes: 0 });
  const other = await client.call('threads.create', { projectId: harness.core.threads.require(threadId).projectId!, providerId: 'claude', accountId: harness.core.threads.require(threadId).accountId, title: 'untaught' });
  await client.call('threads.update', { threadId: other.id, title: 'untaught' });
  expect(await runTurn(client, other.id, 'third')).toBe('done');
  expect(calls.at(-1)!.prompts[0]).toBe('third');
});
