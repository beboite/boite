import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect } from 'bun:test';
import type { Options, Query, SDKMessage, SDKUserMessage, SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import type { CoreClient } from '../../src/client.ts';
import { createClaudeDriver } from '../../src/drivers/claude.ts';
import type { QueryFn } from '../../src/drivers/claude/query.ts';
import { setDriver } from '../../src/drivers/index.ts';
import { scriptedClaude, startTestCore } from '../harness.ts';
import type { TestCore } from '../harness.ts';

export let harness: TestCore;
let restore: (() => void) | null = null;

/** A fresh core per test with the scripted Claude driver, restored after the core has closed. */
export function useClaudeHarness(): void {
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
}

/** A logged-in claude account whose login is a file in the test data directory. */
export async function claudeThread(client: CoreClient): Promise<string> {
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
export class FakeQuery {
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

export const queries: FakeQuery[] = [];
/** What the driver handed the SDK, query by query: the options and every prompt it pushed. */
export const calls: { options: Options; prompts: string[] }[] = [];

/**
 * `script` runs when the driver opens a query, `reply` on every user message it
 * pushes into that query's stream: a warm session takes several.
 */
export function scripted(
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
export function answerEach(sessionId: string): (fake: FakeQuery, prompt: string, index: number) => void {
  return (fake, _prompt, index) => {
    fake.emit(init(sessionId));
    fake.emit(assistant(sessionId, [{ type: 'text', text: `answer ${index}` }]));
    fake.emit(success(sessionId));
  };
}

/** One turn, from the call to `turn.finished`. */
export async function runTurn(client: CoreClient, threadId: string, prompt: string): Promise<string> {
  const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 10000);
  await client.call('turns.start', { threadId, prompt });
  return (await finished).status;
}

// -- scripted messages, shaped like the CLI's own ---------------------------

export function sdk(message: unknown): SDKMessage {
  return message as SDKMessage;
}

export function init(sessionId: string): SDKMessage {
  return sdk({ type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-opus-5', tools: [] });
}

export function streamEvent(sessionId: string, event: unknown): SDKMessage {
  return sdk({ type: 'stream_event', session_id: sessionId, parent_tool_use_id: null, event });
}

export function assistant(sessionId: string, content: unknown[]): SDKMessage {
  return sdk({
    type: 'assistant',
    session_id: sessionId,
    parent_tool_use_id: null,
    message: { id: 'msg_1', role: 'assistant', model: 'claude-opus-5', content },
  });
}

export function toolResult(sessionId: string, toolId: string, text: string): SDKMessage {
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

export function success(sessionId: string): SDKMessage {
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

export function failure(sessionId: string): SDKMessage {
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
export function interrupted(): SDKMessage {
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
