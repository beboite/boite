import { describe, expect, test } from 'bun:test';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { MessagePart } from '@boite/contracts';
import { waitFor } from './harness.ts';
import {
  assistant,
  calls,
  claudeThread,
  harness,
  init,
  queries,
  runTurn,
  scripted,
  sdk,
  streamEvent,
  success,
  toolResult,
  useClaudeHarness,
} from './fixtures/claude-query.ts';

useClaudeHarness();

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
