import { describe, expect, test } from 'bun:test';
import { crc32, deflateSync } from 'node:zlib';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { MessagePart } from '@boite/contracts';
import { waitFor } from './harness.ts';
import {
  answerEach,
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

/** A grey 8-bit PNG of the given size, written by hand so the test needs no encoder. */
function greyPng(width: number, height: number): string {
  const chunk = (type: string, body: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(type, 'ascii'), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed) >>> 0);
    return Buffer.concat([length, typed, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 0; // greyscale
  const rows = Buffer.alloc((width + 1) * height, 128);
  for (let row = 0; row < height; row += 1) rows[row * (width + 1)] = 0; // no filter
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

test('Claude Agent tools reach Team while child text remains on its sidechain', async () => {
  const client = await harness.connect();
  const threadId = await claudeThread(client);
  scripted(fake => {
    fake.emit(init('sess-native'));
    fake.emit(assistant('sess-native', [{ type: 'tool_use', id: 'native-claude', name: 'Agent', input: { description: 'Parser review', prompt: 'Review parser boundaries', model: 'sonnet' } }]));
    fake.emit(sdk({ ...assistant('sess-native', [{ type: 'text', text: 'Private child work' }]), parent_tool_use_id: 'native-claude' }));
    fake.emit(toolResult('sess-native', 'native-claude', 'Parser checked'));
    fake.emit(success('sess-native'));
  });
  expect(await runTurn(client, threadId, 'Review')).toBe('done');
  expect((await client.call('delegation.get', { threadId })).nativeAgents).toEqual([
    expect.objectContaining({ toolId: 'native-claude', name: 'Parser review', model: 'sonnet', status: 'done', result: 'Parser checked' }),
  ]);
  expect(JSON.stringify((await client.call('threads.get', { threadId })).messages)).not.toContain('Private child work');
});

describe('claude driver', () => {
  test('a retried stream discards its incomplete blocks and preserves the preceding tool exchange', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);
    const answer = '{"answer":"complete"}';
    scripted(fake => {
      const event = (body: unknown) => fake.emit(streamEvent('sess-retry', body));
      fake.emit(init('sess-retry'));
      event({ type: 'message_start', message: { id: 'msg_before' } });
      event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Reading fixture.' } });
      event({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tool_kept', name: 'Read', input: {} } });
      fake.emit(sdk({ ...assistant('sess-retry', []), message: { id: 'msg_before', content: [{ type: 'tool_use', id: 'tool_kept', name: 'Read', input: { file_path: '/fixture.txt' } }] } }));
      event({ type: 'message_delta', delta: { stop_reason: 'tool_use' } });
      event({ type: 'message_stop' });
      fake.emit(toolResult('sess-retry', 'tool_kept', 'fixture contents'));

      event({ type: 'message_start', message: { id: 'msg_cut' } });
      event({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
      event({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Abandoned reasoning' } });
      event({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
      event({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '{"answer":' } });
      event({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tool_abandoned', name: 'Read', input: {} } });
      // The real CLI synthesizes stops on interruption, without a successful message_delta.
      event({ type: 'content_block_stop', index: 2 });
      event({ type: 'message_stop' });
      fake.emit(sdk({ type: 'system', subtype: 'api_retry', session_id: 'sess-retry', attempt: 1, max_retries: 10, retry_delay_ms: 500, error_status: null, error: 'unknown' }));

      event({ type: 'message_start', message: { id: 'msg_retry' } });
      event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: answer } });
      fake.emit(sdk({ ...assistant('sess-retry', []), message: { id: 'msg_retry', content: [{ type: 'text', text: answer }] } }));
      event({ type: 'message_delta', delta: { stop_reason: 'end_turn' } });
      event({ type: 'message_stop' });
      fake.emit(success('sess-retry'));
      fake.end();
    });
    expect(await runTurn(client, threadId, 'Read the fixture and return JSON')).toBe('done');
    const thread = await client.call('threads.get', { threadId });
    const parts = thread.messages.filter(message => message.role === 'assistant').flatMap(message => message.parts);
    expect(parts.filter(part => part.type === 'text' && part.text.length > 0)).toEqual([
      { type: 'text', text: 'Reading fixture.' },
      { type: 'text', text: answer },
    ]);
    expect(parts.filter(part => part.type === 'thinking' && part.text.length > 0)).toHaveLength(0);
    expect(parts.filter(part => part.type === 'tool')).toEqual([
      expect.objectContaining({ toolId: 'tool_kept', status: 'done', output: 'fixture contents' }),
    ]);
  });

  test('a retry before response headers preserves the completed response of the preceding request', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);
    scripted(fake => {
      const event = (body: unknown) => fake.emit(streamEvent('sess-retry-headers', body));
      fake.emit(init('sess-retry-headers'));
      event({ type: 'message_start', message: { id: 'msg_complete' } });
      event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Keep this response.' } });
      event({ type: 'message_delta', delta: { stop_reason: 'end_turn' } });
      event({ type: 'message_stop' });
      fake.emit(sdk({ type: 'system', subtype: 'api_retry', session_id: 'sess-retry-headers', attempt: 1, max_retries: 10, retry_delay_ms: 500, error_status: 503, error: 'server_error' }));
      fake.emit(success('sess-retry-headers'));
      fake.end();
    });
    expect(await runTurn(client, threadId, 'Continue')).toBe('done');
    const thread = await client.call('threads.get', { threadId });
    expect(thread.messages.filter(message => message.role === 'assistant').flatMap(message => message.parts)).toEqual([
      { type: 'text', text: 'Keep this response.' },
    ]);
  });

  test('the prompt cache clock starts at the last main-loop request, not at a subagent one or the turn end', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);
    let mainAt = 0;
    scripted((fake) => {
      void (async () => {
        fake.emit(init('sess-clock'));
        mainAt = Date.now();
        fake.emit(streamEvent('sess-clock', { type: 'message_start', message: { id: 'msg_1' } }));
        fake.emit(sdk({
          type: 'assistant', session_id: 'sess-clock', parent_tool_use_id: null,
          message: { id: 'msg_1', role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'pong' }], usage: { input_tokens: 5, cache_creation_input_tokens: 900, cache_creation: { ephemeral_5m_input_tokens: 900, ephemeral_1h_input_tokens: 0 } } },
        }));
        await Bun.sleep(100);
        fake.emit(sdk({ type: 'stream_event', session_id: 'sess-clock', parent_tool_use_id: 'toolu_task', event: { type: 'message_start', message: { id: 'msg_sub' } } }));
        await Bun.sleep(100);
        fake.emit(success('sess-clock'));
        fake.end();
      })();
    });
    expect(await runTurn(client, threadId, 'ping')).toBe('done');
    const thread = await client.call('threads.get', { threadId });
    const cache = thread.promptCache!;
    expect(cache.ttlSeconds).toBe(300);
    expect(cache.at).toBeGreaterThanOrEqual(mainAt);
    expect(cache.at).toBeLessThan(mainAt + 80);
    expect(thread.turns.at(-1)!.finishedAt! - cache.at).toBeGreaterThanOrEqual(150);
  });
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
      // No split in the result: Claude Code writes for an hour.
      cacheWriteHourTokens: 7,
      buckets: 1,
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
      { type: 'thinking', text: 'let me check', startedAt: expect.any(Number), finishedAt: expect.any(Number) },
      { type: 'text', text: 'pong' },
    ]);
  });

  test('tool summaries stay off until the owner turns them on, each one being a small-model request', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);
    scripted((fake) => {
      fake.emit(init('sess-off'));
      fake.emit(success('sess-off'));
      fake.end();
    });

    expect(await runTurn(client, threadId, 'hello')).toBe('done');

    const options = calls.at(-1)!.options;
    expect(options.extraArgs).toEqual({ 'thinking-display': 'summarized' });
    expect(options.env).toBeDefined();
    expect(options.env?.CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES).toBeUndefined();
  });

  test('short answers silence the CLI\'s own reminder to report progress mid-turn; turned off, the CLI decides', async () => {
    const client = await harness.connect();
    // The test core starts with short answers off.
    await client.call('settings.set', { shortAnswers: true });
    const quiet = await claudeThread(client);
    scripted((fake) => {
      fake.emit(init('sess-quiet'));
      fake.emit(success('sess-quiet'));
      fake.end();
    });
    expect(await runTurn(client, quiet, 'hello')).toBe('done');
    expect(calls.at(-1)!.options.env?.CLAUDE_CODE_SILENT_TURN_REMINDER).toBe('0');

    await client.call('settings.set', { shortAnswers: false });
    const chatty = await claudeThread(client);
    scripted((fake) => {
      fake.emit(init('sess-chatty'));
      fake.emit(success('sess-chatty'));
      fake.end();
    });
    expect(await runTurn(client, chatty, 'hello')).toBe('done');
    expect(calls.at(-1)!.options.env?.CLAUDE_CODE_SILENT_TURN_REMINDER).toBeUndefined();
  });

  test('the CLI is asked for summarized thinking and tool summaries, and a summary labels the calls it names', async () => {
    const client = await harness.connect();
    await client.call('settings.set', { toolSummaries: true });
    const threadId = await claudeThread(client);

    scripted((fake) => {
      fake.emit(init('sess-sum'));
      fake.emit(assistant('sess-sum', [
        { type: 'tool_use', id: 'toolu_a', name: 'Read', input: { file_path: 'rules.md' } },
        { type: 'tool_use', id: 'toolu_b', name: 'Read', input: { file_path: 'data.txt' } },
      ]));
      fake.emit(toolResult('sess-sum', 'toolu_a', 'rules'));
      fake.emit(toolResult('sess-sum', 'toolu_b', 'data'));
      fake.emit(assistant('sess-sum', [{ type: 'tool_use', id: 'toolu_c', name: 'Bash', input: { command: 'wc -l data.txt' } }]));
      // Written once the first batch finished; it names only that batch, and an
      // id this turn never drew is skipped rather than drawn as an empty card.
      fake.emit(sdk({ type: 'tool_use_summary', summary: ' Read rules.md and data.txt ', preceding_tool_use_ids: ['toolu_a', 'toolu_b', 'toolu_gone'], uuid: 'u1', session_id: 'sess-sum' }));
      fake.emit(toolResult('sess-sum', 'toolu_c', '4 data.txt'));
      fake.emit(success('sess-sum'));
      fake.end();
    });

    expect(await runTurn(client, threadId, 'count')).toBe('done');

    const options = calls.at(-1)!.options;
    expect(options.extraArgs).toEqual({ 'thinking-display': 'summarized' });
    expect(options.thinking).toBeUndefined();
    expect(options.env?.CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES).toBe('1');

    const thread = await client.call('threads.get', { threadId });
    const tools = thread.messages.flatMap((message) => message.parts).filter((part) => part.type === 'tool');
    expect(tools.map((part) => [part.toolId, part.summary ?? null])).toEqual([
      ['toolu_a', 'Read rules.md and data.txt'],
      ['toolu_b', 'Read rules.md and data.txt'],
      ['toolu_c', null],
    ]);
    expect(tools.every((part) => part.status === 'done')).toBe(true);
  });

  test('a summary that lands after the cards were written keeps their input and output', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);
    scripted(fake => fake.emit(init('sess-late')));
    const turn = await client.call('turns.start', { threadId, prompt: 'write it' });
    await waitFor(() => calls[0]?.prompts.length === 1);
    const fake = queries[0]!;
    const content = 'x'.repeat(4096);
    fake.emit(assistant('sess-late', [{ type: 'tool_use', id: 'toolu_w', name: 'Write', input: { file_path: 'a.txt', content } }]));
    fake.emit(toolResult('sess-late', 'toolu_w', 'written'));
    // A result ahead of its call: the card gets its input after it finished.
    fake.emit(toolResult('sess-late', 'toolu_r', 'rules'));
    fake.emit(assistant('sess-late', [{ type: 'tool_use', id: 'toolu_r', name: 'Read', input: { file_path: 'rules.md' } }]));
    await waitFor(() => harness.core.journal.listMessages(threadId).some(m => m.parts.some(p => p.type === 'tool' && p.toolId === 'toolu_r' && p.name === 'Read')));
    // A follow-up cuts the answer, so the cards' message is closed and written before the label lands.
    expect(await client.call('turns.steer', { threadId, turnId: turn.id, prompt: 'and?', clientRequestId: 'claude_late_01' })).toEqual({ accepted: true });
    await waitFor(() => calls[0]?.prompts.length === 2);
    const finished = client.next('turn.finished', record => record.id === turn.id);
    fake.emit(sdk({ type: 'tool_use_summary', summary: 'Wrote a.txt, read rules.md', preceding_tool_use_ids: ['toolu_w', 'toolu_r'], uuid: 'u-late', session_id: 'sess-late' }));
    fake.emit(success('sess-late'));
    expect((await finished).status).toBe('done');

    const tools = harness.core.journal.listMessages(threadId).flatMap(m => m.parts).filter(p => p.type === 'tool');
    expect(tools).toEqual([
      expect.objectContaining({ toolId: 'toolu_w', name: 'Write', input: { file_path: 'a.txt', content }, output: 'written', status: 'done', summary: 'Wrote a.txt, read rules.md', documents: [expect.objectContaining({ newText: content })] }),
      expect.objectContaining({ toolId: 'toolu_r', name: 'Read', input: { file_path: 'rules.md' }, inputText: null, output: 'rules', status: 'done', summary: 'Wrote a.txt, read rules.md' }),
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

  test('on Claude 5.1+, the second of two thinking blocks before a tool call is the progress text', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);
    const reasoning = 'The failure points at the parser.';
    const update = "Now I'll run the parser tests.";
    // One API message per model: what 5.1+ and 5.0 send ahead of the same call.
    const turn = (model: string, sessionId: string, toolId: string) => (fake: { emit(message: SDKMessage): void; end(): void }) => {
      const event = (body: unknown) => fake.emit(streamEvent(sessionId, body));
      fake.emit(init(sessionId));
      event({ type: 'message_start', message: { id: `msg_${model}`, model } });
      [reasoning, update].forEach((text, index) => {
        event({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } });
        event({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: text } });
        event({ type: 'content_block_stop', index });
      });
      event({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: toolId, name: 'Bash', input: {} } });
      event({ type: 'content_block_stop', index: 2 });
      fake.emit(sdk({ ...(assistant(sessionId, [{ type: 'thinking', thinking: reasoning, signature: 's' }]) as object), message: { id: `msg_${model}`, model, content: [{ type: 'thinking', thinking: reasoning, signature: 's' }] } }));
      fake.emit(sdk({ ...(assistant(sessionId, []) as object), message: { id: `msg_${model}`, model, content: [{ type: 'thinking', thinking: update, signature: 's' }] } }));
      fake.emit(sdk({ ...(assistant(sessionId, []) as object), message: { id: `msg_${model}`, model, content: [{ type: 'tool_use', id: toolId, name: 'Bash', input: { command: 'bun test' } }] } }));
      fake.emit(toolResult(sessionId, toolId, 'ok'));
      fake.emit(success(sessionId));
      fake.end();
    };
    const partsOf = async () => {
      const thread = await client.call('threads.get', { threadId });
      return (thread.messages.filter((message) => message.role === 'assistant').at(-1)?.parts ?? []).map((part: MessagePart) => part.type === 'tool' ? { type: 'tool' } : { type: part.type, text: (part as { text?: string }).text });
    };

    scripted(turn('claude-opus-5-5', 'sess-progress', 'tool_new'));
    expect(await runTurn(client, threadId, 'fix it')).toBe('done');
    // The reasoning stays folded, the update reads as the agent's own words.
    expect(await partsOf()).toEqual([{ type: 'thinking', text: reasoning }, { type: 'text', text: update }, { type: 'tool' }]);

    scripted(turn('claude-opus-5', 'sess-reasoning', 'tool_old'));
    expect(await runTurn(client, threadId, 'fix it again')).toBe('done');
    // A 5.0 model writes its updates as text: both blocks are reasoning.
    expect(await partsOf()).toEqual([{ type: 'thinking', text: reasoning + update }, { type: 'tool' }]);
  });

  test('an image attachment rides beside the text as a content block', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);

    // Like the CLI, the fake answers once it has read the prompt.
    scripted(() => undefined, answerEach('sess-image'));

    const PNG =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    // Stored when the composer's cap was 2048 px, or sent by a client that does not reduce.
    const WIDE = greyPng(2048, 64);
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 10000);
    await client.call('turns.start', {
      threadId,
      prompt: 'what is this',
      attachments: [
        { kind: 'image', mimeType: 'image/png', data: PNG, name: 'pixel.png' },
        { kind: 'image', mimeType: 'image/png', data: WIDE, name: 'wide.png' },
      ],
    });
    expect((await finished).status).toBe('done');

    const sent = JSON.parse(calls[0]?.prompts[0] ?? '[]') as { type: string; text?: string; source?: { type: string; media_type: string; data: string } }[];
    expect(sent.slice(0, 2)).toEqual([
      { type: 'text', text: 'what is this' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
    ]);
    // Past 2000 px Claude refuses a request with more than 20 images: the wide one is fitted.
    const fitted = await new Bun.Image(Buffer.from(sent[2]?.source?.data ?? '', 'base64')).metadata();
    expect({ width: fitted.width, height: fitted.height, format: fitted.format }).toEqual({ width: 2000, height: 63, format: 'png' });
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
