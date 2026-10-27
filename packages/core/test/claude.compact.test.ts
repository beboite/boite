import { expect, test } from 'bun:test';
import { answerEach, calls, claudeThread, harness, queries, runTurn, scripted, sdk, useClaudeHarness } from './fixtures/claude-query.ts';
import { waitFor } from './harness.ts';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { COMPACT_FOCUS, compactFocus, openWithCompaction } from '../src/drivers/claude/compaction.ts';

useClaudeHarness();

test('the independent token threshold is verified at launch before the first prompt, without guessing a reserve', async () => {
  const client = await harness.connect();
  try {
    const threadId = await claudeThread(client);
    await client.call('settings.set', { autoCompact: { tokens: 200_000, moments: ['cache-expiry'] } });
    const atPrompt: (number | undefined)[] = [];
    scripted(fake => { fake.compactionReserve = 27_419; }, (fake, prompt, index) => {
      atPrompt.push(fake.compactionThreshold);
      answerEach('sess-native-compact')(fake, prompt, index);
    });
    expect(await runTurn(client, threadId, 'work')).toBe('done');
    expect(atPrompt).toEqual([200_000]);
    expect(queries).toHaveLength(2);
    expect(calls[0]!.prompts).toEqual([]);
    expect(calls[0]!.options.persistSession).toBe(false);
    expect(calls[1]!.options.settings).toMatchObject({ autoCompactWindow: 227_419, autoCompactEnabled: true, autoMemoryEnabled: false, fastMode: false });
    expect(calls[1]!.options.hooks?.PreCompact).toEqual([{ hooks: [compactFocus] }]);
    expect(calls[1]!.prompts).toEqual(['work']);
    expect(queries.every(query => query.contextUsageCalls.every(options => options.detail === 'summary'))).toBe(true);
    expect(queries.every(query => query.interrupts === 0 && query.compactionSettings.length === 0)).toBe(true);
  } finally { client.close(); }
});

test('unchanged warm policy reuses the query; a new threshold resumes between turns, and null restores native policy', async () => {
  const client = await harness.connect();
  try {
    const threadId = await claudeThread(client);
    await client.call('settings.set', { warmProcessMinutes: 5, autoCompact: { tokens: 200_000, moments: ['cache-expiry'] } });
    const atPrompt: (number | undefined)[] = [];
    scripted(fake => { fake.nativeCompactionWindow = 600_000; fake.nativeCompactionEnabled = false; }, (fake, prompt, index) => {
      atPrompt.push(fake.compactionThreshold);
      answerEach('sess-warm-compact')(fake, prompt, index);
    });
    expect(await runTurn(client, threadId, 'first')).toBe('done');
    expect(await runTurn(client, threadId, 'unchanged')).toBe('done');
    expect(queries).toHaveLength(2);
    await client.call('settings.set', { autoCompact: { tokens: 250_000, moments: ['cache-expiry'] } });
    expect(await runTurn(client, threadId, 'second')).toBe('done');
    expect(calls[3]!.options.resume).toBe('sess-warm-compact');
    await client.call('settings.set', { autoCompact: { tokens: null, moments: ['cache-expiry'] } });
    expect(await runTurn(client, threadId, 'third')).toBe('done');
    expect(queries).toHaveLength(5);
    expect(atPrompt).toEqual([200_000, 200_000, 250_000, undefined]);
    expect(calls[4]!.options.settings).not.toHaveProperty('autoCompactWindow');
    expect(calls[4]!.options.settings).not.toHaveProperty('autoCompactEnabled');
    expect(calls[4]!.options.resume).toBe('sess-warm-compact');
    expect(queries.every(query => query.interrupts === 0)).toBe(true);
  } finally { client.close(); }
});

test('a warm Claude session follows type overrides and returns to live common defaults', async () => {
  const client = await harness.connect();
  try {
    const threadId = await claudeThread(client);
    await client.call('settings.set', { warmProcessMinutes: 5, autoCompact: { tokens: 300_000, moments: [] },
      compactionByType: { agent: { autoCompact: { tokens: 200_000, moments: [] }, backgroundCompaction: false } } });
    const thresholds: (number | undefined)[] = [];
    scripted(fake => { fake.nativeCompactionEnabled = false; }, (fake, prompt, index) => {
      thresholds.push(fake.compactionThreshold);
      answerEach('sess-type-policy')(fake, prompt, index);
    });
    expect(await runTurn(client, threadId, 'override')).toBe('done');
    await client.call('settings.set', { autoCompact: { tokens: 400_000, moments: [] } });
    expect(await runTurn(client, threadId, 'common changed')).toBe('done');
    expect(queries).toHaveLength(2);
    await client.call('settings.set', { compactionByType: {} });
    expect(await runTurn(client, threadId, 'inherit')).toBe('done');
    expect(calls[3]!.options.resume).toBe('sess-type-policy');
    await client.call('settings.set', { compactionByType: { agent: { autoCompact: null, backgroundCompaction: false } } });
    expect(await runTurn(client, threadId, 'off')).toBe('done');
    expect(thresholds).toEqual([200_000, 200_000, 400_000, undefined]);
    expect(calls[4]!.options.resume).toBe('sess-type-policy');
    expect(queries.every(query => query.interrupts === 0)).toBe(true);
  } finally { client.close(); }
});

test('a model limit that prevents the exact threshold falls back to an unmodified native query', async () => {
  const client = await harness.connect();
  try {
    const threadId = await claudeThread(client);
    await client.call('settings.set', { autoCompact: { tokens: 200_000, moments: ['cache-expiry'] } });
    scripted(fake => { fake.modelWindow = 200_000; }, answerEach('sess-clamped-compact'));
    expect(await runTurn(client, threadId, 'work')).toBe('done');
    expect(queries).toHaveLength(3);
    expect(calls.map(call => call.prompts)).toEqual([[], [], ['work']]);
    expect(calls[2]!.options.settings).not.toHaveProperty('autoCompactWindow');
    expect(queries[2]!.compactionThreshold).toBe(167_000);
  } finally { client.close(); }
});

test('a changed threshold never restarts an active turn or a query holding background tasks', async () => {
  const client = await harness.connect();
  const release = Promise.withResolvers<void>();
  try {
    const threadId = await claudeThread(client);
    await client.call('settings.set', { warmProcessMinutes: 5, autoCompact: { tokens: 200_000, moments: ['cache-expiry'] } });
    const atPrompt: (number | undefined)[] = [];
    scripted(() => undefined, (fake, prompt, index) => {
      atPrompt.push(fake.compactionThreshold);
      const answer = () => answerEach('sess-held-compact')(fake, prompt, index);
      if (index > 0) { answer(); return; }
      void release.promise.then(() => {
        fake.emit(sdk({ type: 'system', subtype: 'background_tasks_changed', session_id: 'sess-held-compact',
          tasks: [{ task_id: 'held-task', task_type: 'local_bash', description: 'offline background fixture' }] }));
        answer();
      });
    });
    const finished = client.next('turn.finished', turn => turn.threadId === threadId);
    await client.call('turns.start', { threadId, prompt: 'active' });
    await waitFor(() => atPrompt.length === 1);
    await client.call('settings.set', { autoCompact: { tokens: 250_000, moments: ['cache-expiry'] } });
    expect(queries).toHaveLength(2);
    expect(queries[1]!.closes).toBe(0);
    release.resolve();
    expect((await finished).status).toBe('done');
    expect(await runTurn(client, threadId, 'background still running')).toBe('done');
    expect(queries).toHaveLength(2);
    expect(atPrompt).toEqual([200_000, 200_000]);
    expect(queries[1]!.closes).toBe(0);
    expect(queries[1]!.interrupts).toBe(0);
  } finally { release.resolve(); client.close(); }
});

test('a model change measures its own reserve before resuming the warm transcript', async () => {
  const client = await harness.connect();
  try {
    const threadId = await claudeThread(client);
    await client.call('settings.set', { warmProcessMinutes: 5, autoCompact: { tokens: 200_000, moments: ['cache-expiry'] } });
    const atPrompt: (number | undefined)[] = [];
    scripted((fake, options) => { if (options.model === 'claude-opus-5') fake.compactionReserve = 19_215; }, (fake, prompt, index) => {
      atPrompt.push(fake.compactionThreshold);
      answerEach('sess-model-compact')(fake, prompt, index);
    });
    expect(await runTurn(client, threadId, 'first')).toBe('done');
    await client.call('threads.update', { threadId, model: 'claude-opus-5' });
    expect(await runTurn(client, threadId, 'second')).toBe('done');
    expect(queries).toHaveLength(4);
    expect(atPrompt).toEqual([200_000, 200_000]);
    expect(calls[3]!.options.settings).toMatchObject({ autoCompactWindow: 219_215 });
    expect(calls[3]!.options.resume).toBe('sess-model-compact');
  } finally { client.close(); }
});

test('Stop while native measurement is pending sends no prompt and opens no replacement query', async () => {
  const client = await harness.connect();
  const read = Promise.withResolvers<void>();
  try {
    const threadId = await claudeThread(client);
    await client.call('settings.set', { autoCompact: { tokens: 200_000, moments: ['cache-expiry'] } });
    let reading = false;
    scripted(fake => {
      const getContextUsage = fake.getContextUsage.bind(fake);
      fake.getContextUsage = async options => {
        reading = true;
        await read.promise;
        return getContextUsage(options);
      };
    });
    const finished = client.next('turn.finished', turn => turn.threadId === threadId);
    await client.call('turns.start', { threadId, prompt: 'must not run' });
    await waitFor(() => reading);
    await client.call('turns.stop', { threadId });
    read.resolve();
    expect((await finished).status).toBe('stopped');
    expect(queries).toHaveLength(1);
    expect(calls[0]!.prompts).toEqual([]);
    expect(queries[0]!.closes).toBe(1);
  } finally { read.resolve(); client.close(); }
});

test('an older CLI without local context controls keeps its native policy and answers', async () => {
  const client = await harness.connect();
  try {
    const threadId = await claudeThread(client);
    await client.call('settings.set', { autoCompact: { tokens: 200_000, moments: ['cache-expiry'] } });
    scripted(fake => { fake.getContextUsage = () => Promise.reject(new Error('unsupported control')); }, answerEach('sess-old-compact'));
    expect(await runTurn(client, threadId, 'work')).toBe('done');
    expect(queries).toHaveLength(2);
    expect(calls[1]!.options.settings).not.toHaveProperty('autoCompactWindow');
    expect(calls.map(call => call.prompts)).toEqual([[], ['work']]);
  } finally { client.close(); }
});

/** Real native loop, isolated account and a loopback-only simulated Anthropic API. */
test.skipIf(process.env['BOITE_TEST_CLAUDE_CONTROLS'] !== '1')('the installed CLI verifies the exact threshold before a prompt and compacts after a tool boundary', async () => {
  const executable = Bun.which('claude');
  if (executable === null) throw new Error('claude must be installed for the offline native control check');
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const dir = join(harness.dataDir, 'offline-claude');
  mkdirSync(dir);
  const fixture = join(dir, 'fixture.txt');
  writeFileSync(fixture, 'Offline read fixture.');
  let requests = 0;
  let counts = 0;
  let summaryPrompt = '';
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.endsWith('/count_tokens')) { counts++; return new Response('token counting forbidden in this test', { status: 400 }); }
    if (path !== '/v1/messages') return new Response('unexpected route', { status: 404 });
    const body = await request.json() as { stream?: boolean; messages: { content: string | { text?: string }[] }[] };
    requests++;
    if (requests > 4) return new Response('unexpected extra inference', { status: 400 });
    if (requests === 3) {
      summaryPrompt = body.messages.flatMap(({ content }) => typeof content === 'string' ? [content] : content.map(block => block.text ?? '')).join('\n');
    }
    const tool = requests <= 2;
    const content = tool
      ? { type: 'tool_use', id: `toolu_offline_${requests}`, name: 'Read', input: { file_path: fixture } }
      : { type: 'text', text: requests === 3 ? 'Offline compacted context. Continue the task.' : 'Offline task complete.' };
    const input = requests === 1 ? 190_000 : requests === 2 ? 210_000 : 1_000;
    const message = { id: `msg_offline_${requests}`, type: 'message', role: 'assistant', model: 'claude-opus-5', content: [content],
      stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: input, output_tokens: 10 } };
    if (!body.stream) return Response.json(message);
    const event = (type: string, value: unknown): string => `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`;
    return new Response([
      event('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { input_tokens: input, output_tokens: 0 } } }),
      event('content_block_start', { type: 'content_block_start', index: 0, content_block: tool ? { ...content, input: {} } : { type: 'text', text: '' } }),
      event('content_block_delta', { type: 'content_block_delta', index: 0, delta: tool
        ? { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: fixture }) }
        : { type: 'text_delta', text: (content as { text: string }).text } }),
      event('content_block_stop', { type: 'content_block_stop', index: 0 }),
      event('message_delta', { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 10 } }),
      event('message_stop', { type: 'message_stop' }),
    ].join(''), { headers: { 'content-type': 'text/event-stream' } });
  } });
  const env: Record<string, string | undefined> = Object.fromEntries(Object.keys(process.env).map(key => [key, undefined]));
  Object.assign(env, {
    PATH: process.env.PATH, HOME: dir, USERPROFILE: dir, TMPDIR: dir, TEMP: dir, TMP: dir,
    CLAUDE_CONFIG_DIR: dir, ANTHROPIC_API_KEY: 'sk-ant-offline-controls-not-a-credential',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1',
  });
  const controller = new AbortController();
  const warnings: string[] = [];
  const opened = await openWithCompaction(query, {
    cwd: dir, pathToClaudeCodeExecutable: executable, settingSources: [],
    model: 'claude-opus-5', tools: ['Read'], strictMcpConfig: true, mcpServers: {},
    permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true,
    systemPrompt: 'Offline control test', persistSession: false, env, abortController: controller,
    hooks: { PreCompact: [{ hooks: [compactFocus] }] },
    spawnClaudeCodeProcess(options) {
      const child = harness.core.procs.spawnChild('claude-compact-controls', options.command, options.args, { cwd: options.cwd, env: options.env });
      child.stderr.resume();
      return child;
    },
  }, 200_000, () => false, message => warnings.push(message));
  if (opened === null) throw new Error('offline query unexpectedly cancelled');
  const { query: native, prompts } = opened;
  try {
    const after = await native.getContextUsage({ detail: 'summary' });
    expect(warnings).toEqual([]);
    expect(after.autoCompactThreshold).toBe(200_000);
    expect(controller.signal.aborted).toBe(false);
    expect(requests).toBe(0);
    console.log(`offline Claude controls: verified threshold ${after.autoCompactThreshold}, window ${after.rawMaxTokens}, no prompt sent`);
    const deadline = setTimeout(() => controller.abort(), 15_000);
    let compactAt = 0;
    let result: string | null = null;
    try {
      prompts.push('Read the offline fixture twice, then finish.', []);
      for await (const message of native) {
        if (message.type === 'system' && message.subtype === 'compact_boundary') compactAt = requests;
        if (message.type === 'result') { result = message.subtype; break; }
      }
    } finally { clearTimeout(deadline); }
    expect(result).toBe('success');
    expect(compactAt).toBe(3);
    expect(requests).toBe(4);
    expect(counts).toBe(0);
    expect(summaryPrompt).toContain(`Additional Instructions:\n${COMPACT_FOCUS}`);
    console.log('offline native loop: no compact at 190000 tokens; compact after tool at 210000 with Boite\'s summary focus; fourth request continues the same turn; no token-count call');
  } finally {
    prompts.end();
    controller.abort();
    native.close();
    await waitFor(() => harness.core.procs.liveCount('claude-compact-controls') === 0, 10_000);
    await server.stop(true);
  }
}, 30_000);
