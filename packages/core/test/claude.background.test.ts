import { describe, expect, test } from 'bun:test';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
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
  success,
  toolResult,
  useClaudeHarness,
} from './fixtures/claude-query.ts';

useClaudeHarness();

describe('claude driver: questions and background work', () => {
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

  test('a resume that reports the dead background work of the previous CLI still answers the prompt', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);
    const sessionId = 'sess-dead-bg';
    // CLI 2.1.284, probed on 2026-09-30: a resumed process first reports each
    // background task the previous process left running, closes that report
    // with an empty result of its own, then runs the prompt.
    scripted((fake, options) => {
      if (options.resume !== sessionId) return;
      fake.emit(sdk({ type: 'system', subtype: 'task_notification', session_id: sessionId, task_id: 'bash-old', tool_use_id: 'toolu_old', status: 'stopped', output_file: '', summary: "Background shell command didn't finish before the previous session ended" }));
      fake.emit(init(sessionId));
      fake.emit(sdk({ ...(success(sessionId) as object), num_turns: 0, duration_api_ms: 0, stop_reason: null, total_cost_usd: 0, result: '', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }));
    }, answerEach(sessionId));

    expect(await runTurn(client, threadId, 'start it')).toBe('done');
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 10000);
    await client.call('turns.start', { threadId, prompt: 'merge' });
    const turn = await finished;
    expect(turn.status).toBe('done');
    expect(turn.usage?.outputTokens).toBe(3);
    expect(calls.map((call) => call.options.resume ?? null)).toEqual([null, sessionId]);
    const answer = harness.core.journal.listMessages(threadId).filter((m) => m.turnId === turn.id && m.role === 'assistant');
    expect(answer.flatMap((m) => m.parts)).toEqual([{ type: 'text', text: 'answer 0' }]);
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
      fake.emit(sdk({ type: 'system', subtype: 'task_started', session_id: sessionId, task_id: 'agent-1', tool_use_id: 'toolu_agent', description: 'dig', task_type: 'local_agent', is_backgrounded: true }));
      fake.emit(sdk({ type: 'system', subtype: 'background_tasks_changed', session_id: sessionId, tasks: [{ task_id: 'agent-1', task_type: 'local_agent', description: 'dig' }] }));
      fake.emit(toolResult(sessionId, 'toolu_agent', 'Async agent launched'));
      fake.emit(success(sessionId));
    });
    expect(await runTurn(client, threadId, 'dig in the background')).toBe('done');
    const team = await client.call('delegation.get', { threadId });
    expect(team.nativeAgents).toHaveLength(1);
    expect(team.nativeAgents[0]).toMatchObject({ toolId: 'toolu_agent', task: 'dig', status: 'running' });

    queries[0]!.emit(sdk({ type: 'assistant', session_id: sessionId, parent_tool_use_id: 'toolu_agent', message: { id: 'msg_bg', role: 'assistant', content: [{ type: 'text', text: 'still digging' }] } }));
    await Bun.sleep(300);
    expect(harness.core.journal.listTurns(threadId)).toHaveLength(1);
    expect((await client.call('threads.get', { threadId })).status).toBe('idle');
    await client.call('turns.stop', { threadId });
    expect((await client.call('delegation.get', { threadId })).nativeAgents[0]?.status).toBe('unknown');
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
    const threads = harness.core.threads.deferred;
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

  test('a monitor left past the turn reaches every row, and the row forgets it once it ends', async () => {
    const client = await harness.connect();
    const threadId = await claudeThread(client);
    scripted((fake) => {
      fake.emit(init('sess-monitor'));
      fake.emit(sdk({ type: 'system', subtype: 'background_tasks_changed', session_id: 'sess-monitor', tasks: [{ task_id: 'mon-1', task_type: 'monitor', description: 'watch CI' }] }));
      fake.emit(success('sess-monitor'));
    });
    const watching = client.next('thread.updated', (summary) => summary.id === threadId && (summary.backgroundWork?.kinds.length ?? 0) > 0, 10000);
    expect(await runTurn(client, threadId, 'watch CI')).toBe('done');
    const row = await watching;
    expect(row.backgroundWork).toEqual({ kinds: ['monitor'], since: expect.any(Number) });
    await waitFor(() => harness.core.journal.getThread(threadId)?.status === 'idle');
    // A client that connects later reads it from the list, not from an event it missed.
    const listed = (await client.call('threads.list', {})).find((summary) => summary.id === threadId);
    expect(listed?.status).toBe('idle');
    expect(listed?.backgroundWork?.kinds).toEqual(['monitor']);

    const ended = client.next('thread.updated', (summary) => summary.id === threadId && summary.backgroundWork === null, 10000);
    queries[0]!.emit(sdk({ type: 'system', subtype: 'background_tasks_changed', session_id: 'sess-monitor', tasks: [] }));
    expect((await ended).backgroundWork).toBeNull();
    await client.call('turns.stop', { threadId }).catch(() => undefined);
  });
});
