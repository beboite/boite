import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'bun:test';
import type { MessagePart, RpcEvents, Settings } from '@boite/contracts';
import type { CoreClient } from '../src/client.ts';
import { getDriver } from '../src/drivers/index.ts';
import { setPiStopDeadlineForTests } from '../src/drivers/pi.ts';
import { startTestCore, waitFor } from './harness.ts';
import type { TestCore } from './harness.ts';

/** The fake pi in RPC mode: a real JSON-lines process over stdio, run by bun. */
const FAKE_AGENT = fileURLToPath(new URL('./fixtures/pi-agent.ts', import.meta.url));

test('coordination steers a running pi turn over its RPC connection', async () => {
  const client = await startCore();
  const threadId = await piThread(client);
  await client.call('turns.start', { threadId, prompt: '[slow] Deploy' });
  await waitFor(() => fakeLog().includes('waiting for abort'));
  await waitFor(() => harness!.core.journal.listMessages(threadId).some(m => m.role === 'assistant'));
  expect(await harness!.core.threads.steer(threadId, 'Boite agent coordination. Wait for the VM.')).toBe(true);
  expect(fakeLog()).toContain('steering Boite agent coordination');
  expect(harness!.core.journal.listTurns(threadId)).toHaveLength(1);
  await client.call('turns.stop', { threadId });
  await waitFor(() => fakeLog().includes('clear_queue\nabort'));
  expect(fakeLog()).toContain('clear_queue\nabort');
});

let harness: TestCore | null = null;
let logFile = '';

afterEach(async () => {
  const open = harness;
  harness = null;
  delete process.env['PI_FAKE_LOG'];
  if (open !== null) await open.stop();
});

async function startCore(settings?: Partial<Settings>): Promise<CoreClient> {
  const started = await startTestCore(settings === undefined ? {} : { settings });
  harness = started;
  logFile = join(started.dataDir, 'pi-fake.log');
  // `spawnChild` gets `process.env` plus the account environment, so this is
  // what reaches the fake agent.
  process.env['PI_FAKE_LOG'] = logFile;
  return started.connect();
}

/** Ends the running core so the next `startCore` gets a fresh data directory and log. */
async function stopCore(): Promise<void> {
  const open = harness;
  harness = null;
  if (open !== null) await open.stop();
}

function fakeLog(): string {
  return existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
}

/** Every `argv ...` line the fake wrote, one per agent process it started. */
function argvLines(): string[] {
  return fakeLog()
    .split('\n')
    .filter((line) => line.startsWith('argv '));
}

/** How many times the fake was sent one command, so a cached probe is provable. */
function countLines(line: string): number {
  return fakeLog()
    .split('\n')
    .filter((entry) => entry === line).length;
}

/**
 * Waits for something without failing on the wait, so the assertion that
 * follows is what names whatever did not happen.
 */
async function settle(predicate: () => boolean): Promise<void> {
  try {
    await waitFor(predicate, 3000);
  } catch {
    // the expectation after this call reports what is missing
  }
}

/**
 * A second fake pi, as small as the one thing it proves: it raises an extension
 * dialog once the run has settled, which is a dialog reaching the client with
 * no prompt in flight. The shared fixture only ever asks inside a run.
 */
function writeLateDialogAgent(dataDir: string): string {
  const path = join(dataDir, 'pi-late-dialog.mjs');
  writeFileSync(
    path,
    [
      "import { appendFileSync } from 'node:fs';",
      "const LOG = process.env.PI_FAKE_LOG ?? '';",
      "function log(line) { if (LOG.length > 0) appendFileSync(LOG, line + '\\n', 'utf8'); }",
      "function send(payload) { process.stdout.write(JSON.stringify(payload) + '\\n'); }",
      'const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,',
      '  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };',
      'function run() {',
      "  send({ type: 'message_update', usage: ZERO,",
      "    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'done' } });",
      "  send({ type: 'agent_settled' });",
      '  // The extension finishes its own work after the run, so the driver has no',
      '  // turn to draw a card on and the agent still blocks on the answer.',
      '  setTimeout(() => {',
      "    send({ type: 'extension_ui_request', id: 'late-1', method: 'confirm',",
      "      title: 'Late', message: 'after the run' });",
      '  }, 30);',
      '}',
      'function handle(message) {',
      "  if (message.type === 'extension_ui_response') {",
      "    log('late-answer ' + message.id + ' cancelled=' + (message.cancelled === true));",
      '    return;',
      '  }',
      "  if (message.type === 'prompt') {",
      "    send({ id: message.id, type: 'response', command: 'prompt', success: true });",
      '    setTimeout(run, 0);',
      '    return;',
      '  }',
      "  if (message.type === 'get_commands') {",
      "    send({ id: message.id, type: 'response', command: 'get_commands', success: true, data: { commands: [] } });",
      '    return;',
      '  }',
      "  send({ id: message.id, type: 'response', command: message.type, success: false, error: 'not implemented' });",
      '}',
      "let buffer = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => {",
      '  buffer += chunk;',
      '  for (;;) {',
      "    const at = buffer.indexOf('\\n');",
      '    if (at < 0) break;',
      '    const line = buffer.slice(0, at).trim();',
      '    buffer = buffer.slice(at + 1);',
      '    if (line.length === 0) continue;',
      '    handle(JSON.parse(line));',
      '  }',
      '});',
      '',
    ].join('\n'),
    'utf8',
  );
  return path;
}

/** A user descriptor for the fake agent: `protocol: "pi"`, launched as `bun <fixture>`. */
function writeDescriptor(dataDir: string, agent: string = FAKE_AGENT): void {
  const dir = join(dataDir, 'providers');
  mkdirSync(dir, { recursive: true });
  const profile = {
    detect: {},
    executable: [{ kind: 'path', value: 'bun' }],
    launch: { args: [agent] },
    isolation: {},
  };
  writeFileSync(
    join(dir, 'pi-fake.json'),
    JSON.stringify({
      id: 'pi-fake',
      schemaVersion: 1,
      name: 'Fake pi',
      shortName: 'PiFake',
      protocol: 'pi',
      roots: ['{isolationDir}'],
      profiles: { windows: profile, linux: profile, macos: profile },
      auth: { kind: 'none' },
      models: [
        // Like the shipped descriptor: "the agent keeps its own", plus one entry
        // written down, so a thread can pick a model before anything is probed.
        { id: 'default', name: 'pi default', default: true },
        {
          id: 'anthropic/claude-sonnet-5',
          name: 'Fake pi model',
          effort: {
            levels: [
              { id: 'low', label: 'Low' },
              { id: 'high', label: 'High' },
            ],
            default: 'low',
          },
        },
      ],
      capabilities: {
        approvals: false,
        hooks: false,
        checkpoint: false,
        images: true,
        planMode: false,
        resume: true,
      },
    }),
    'utf8',
  );
}

async function piAccount(
  client: CoreClient,
  agent: string = FAKE_AGENT,
): Promise<{ dataDir: string; projectId: string; accountId: string }> {
  const dataDir = harness?.dataDir ?? '';
  writeDescriptor(dataDir, agent);
  const loaded = await client.call('providers.reload', {});
  expect(loaded.rejected).toEqual([]);
  expect(loaded.loaded.some((provider) => provider.id === 'pi-fake' && provider.available)).toBe(true);

  const project = await client.call('projects.add', { path: dataDir, name: 'pi' });
  const account = await client.call('accounts.add', {
    providerId: 'pi-fake',
    label: 'Fake',
    useDefaultLocation: true,
  });
  return { dataDir, projectId: project.id, accountId: account.id };
}

async function piThread(client: CoreClient, model?: string, effort?: string): Promise<string> {
  const { projectId, accountId } = await piAccount(client);
  const thread = await client.call('threads.create', {
    projectId,
    providerId: 'pi-fake',
    accountId,
    title: 'pi thread',
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
  });
  await client.call('threads.subscribe', { threadId: thread.id });
  return thread.id;
}

test('manual compaction uses the compact RPC response without sending a prompt', async () => {
  const client = await startCore();
  const threadId = await piThread(client);
  let finished = client.next('turn.finished', (turn) => turn.threadId === threadId);
  await client.call('turns.start', { threadId, prompt: 'remember this' });
  await finished;
  finished = client.next('turn.finished', (turn) => turn.threadId === threadId);
  await client.call('threads.compact', { threadId });
  expect((await finished).status).toBe('done');
  const thread = await client.call('threads.get', { threadId });
  expect(thread.messages.flatMap((m) => m.parts).some((p) => p.type === 'compaction' && p.preTokens === 150000)).toBe(true);
  expect(countLines('prompt')).toBe(1);
  expect(countLines('compact')).toBe(1);
  client.close();
});

/** The same thread, on a fake pi the test wrote rather than the shared fixture. */
async function threadOnAgent(client: CoreClient, agent: string): Promise<string> {
  const { projectId, accountId } = await piAccount(client, agent);
  const thread = await client.call('threads.create', {
    projectId,
    providerId: 'pi-fake',
    accountId,
    title: 'pi thread',
  });
  await client.call('threads.subscribe', { threadId: thread.id });
  return thread.id;
}

/** Everything the core logged on this connection, as `<level> <message>` lines. */
function collectLogs(client: CoreClient): string[] {
  const lines: string[] = [];
  client.on('core.log', (entry) => {
    lines.push(`${entry.level} ${entry.message}`);
  });
  return lines;
}

describe('pi driver', () => {
  test('getDriver returns the pi driver', () => {
    expect(getDriver('pi').protocol).toBe('pi');
  });

  test('a plain prompt streams back as one text part, and the session id is kept', async () => {
    const client = await startCore();
    const threadId = await piThread(client);

    const deltas: string[] = [];
    client.on('message.delta', (event) => {
      if (event.threadId === threadId) deltas.push(event.text);
    });

    const prompt = 'the fake pi agent echoes this back';
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 20000);
    await client.call('turns.start', { threadId, prompt });

    const done = await finished;
    expect(done.error).toBeNull();
    expect(done.status).toBe('done');
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.join('')).toBe(prompt);

    const thread = await client.call('threads.get', { threadId });
    // The driver minted a uuid and launched pi on it; it is the thread's session.
    expect(thread.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(thread.messages[1]?.parts).toEqual([{ type: 'text', text: prompt }]);
    expect(fakeLog()).toContain('prompt\n');
    expect(argvLines()).toHaveLength(1);
    expect(argvLines()[0]).toContain(`sessionId=${thread.sessionId ?? ''}`);
  });

  test('get_commands lists the agent commands once the process is up', async () => {
    const client = await startCore();
    const threadId = await piThread(client);

    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 20000);
    await client.call('turns.start', { threadId, prompt: 'hello' });
    expect((await finished).status).toBe('done');

    const thread = await client.call('threads.get', { threadId });
    expect(thread.commands).toEqual([
      { name: 'fake-report', description: 'Write a status report', hint: null },
      { name: 'skill:fake-search', description: 'Search fake docs', hint: null },
    ]);
    expect(fakeLog()).toContain('get_commands\n');
  });

  test('an image attachment rides the prompt command as an images entry', async () => {
    const client = await startCore();
    const threadId = await piThread(client);

    const PNG =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 20000);
    await client.call('turns.start', {
      threadId,
      prompt: 'what is this',
      attachments: [{ kind: 'image', mimeType: 'image/png', data: PNG, name: 'pixel.png' }],
    });
    const done = await finished;
    expect(done.error).toBeNull();
    expect(done.status).toBe('done');

    // The fake logs the mimeType and the length of the string it got, which
    // proves pi received the base64 data itself, not a reference to it.
    expect(fakeLog()).toContain(`image image/png ${PNG.length}`);
  });

  test('the session directory is the thread s own, under the account s location', async () => {
    const client = await startCore();
    const threadId = await piThread(client);
    await runTurn(client, threadId, 'first');

    // The account is on the provider's own location, so the transcript lives
    // under the core's data directory and never in the user's real `~/.pi`.
    const expected = join(harness?.dataDir ?? '', 'pi-sessions', threadId);
    expect(argvLines()[0]).toContain(`sessionDir=${expected}`);
    expect(existsSync(expected)).toBe(true);
  });

  test('the model and the effort ride on the command line, as pi takes them', async () => {
    const client = await startCore();
    const threadId = await piThread(client, 'anthropic/claude-sonnet-5', 'high');
    await runTurn(client, threadId, 'first');
    expect(argvLines()[0]).toContain('model=anthropic/claude-sonnet-5:high');
  });

  test('a thinking delta becomes a thinking part ahead of the answer', async () => {
    const client = await startCore();
    const threadId = await piThread(client);

    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 20000);
    await client.call('turns.start', { threadId, prompt: '[thought]the answer' });
    expect((await finished).status).toBe('done');

    const thread = await client.call('threads.get', { threadId });
    expect(thread.messages[1]?.parts).toEqual([
      { type: 'thinking', text: 'thinking about it' },
      { type: 'text', text: 'the answer' },
    ]);
  });

  test('a tool execution arrives running, then done with its output', async () => {
    const client = await startCore();
    const threadId = await piThread(client);

    const parts: MessagePart[] = [];
    client.on('message.part', (event) => {
      if (event.threadId === threadId) parts.push(event.part);
    });

    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 20000);
    await client.call('turns.start', { threadId, prompt: '[tool]' });
    expect((await finished).status).toBe('done');

    const tools = parts.filter((part) => part.type === 'tool');
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({ name: 'bash', status: 'running', output: null });
    expect(tools[0]).toMatchObject({ input: { command: 'echo hello' } });
    expect(tools[1]).toMatchObject({ name: 'bash', status: 'done', output: 'ok' });
  });

  test('the turn usage carries the tokens and the price the agent reported', async () => {
    const client = await startCore();
    const threadId = await piThread(client);

    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 20000);
    await client.call('turns.start', { threadId, prompt: '[usage]' });

    const done = await finished;
    expect(done.status).toBe('done');
    expect(done.usage).toEqual({
      inputTokens: 8,
      outputTokens: 4,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      costUsdEquivalent: 0.03,
    });
  });

  test('stopping a turn aborts it and the agent process is gone', async () => {
    const client = await startCore();
    const threadId = await piThread(client);

    const started = client.next('process.started', (record) => record.threadId === threadId, 20000);
    const exited = client.next('process.exited', (record) => record.threadId === threadId, 20000);
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 20000);
    await client.call('turns.start', { threadId, prompt: '[slow]' });
    await started;

    expect(await client.call('turns.stop', { threadId })).toEqual({ stopped: true });
    expect((await finished).status).toBe('stopped');
    await exited;

    expect(fakeLog()).toContain('abort\n');
    await waitFor(() => harness?.core.procs.liveCount(threadId) === 0);
    const trace = await client.call('trace.get', { threadId });
    expect(trace).toHaveLength(1);
    expect(trace[0]?.exitedAt).not.toBeNull();
  });

  test('an agent that dies fails the turn with its exit code and stderr, and the next turn works', async () => {
    const client = await startCore();
    const threadId = await piThread(client);

    const crashed = client.next('turn.finished', (turn) => turn.threadId === threadId, 20000);
    await client.call('turns.start', { threadId, prompt: '[crash]' });

    const failure = await crashed;
    expect(failure.status).toBe('error');
    expect(failure.error).toContain('exited with code 3');
    expect(failure.error).toContain('boom');

    const again = client.next('turn.finished', (turn) => turn.threadId === threadId, 20000);
    await client.call('turns.start', { threadId, prompt: 'still here' });
    const done = await again;
    expect(done.error).toBeNull();
    expect(done.status).toBe('done');
  });

  test('an extension dialog draws a question and returns the answer', async () => {
    const client = await startCore();
    const threadId = await piThread(client);
    const requested = client.next('question.asked', (request) => request.threadId === threadId);

    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 20000);
    await client.call('turns.start', { threadId, prompt: '[ask]' });
    const request = await requested;
    await client.call('questions.answer', { threadId, questionId: request.id, optionIds: ['yes'] });
    const done = await finished;
    expect(done.status).toBe('done');
    const thread = await client.call('threads.get', { threadId });
    const parts = thread.messages[thread.messages.length - 1]?.parts ?? [];
    const text = parts.find((part) => part.type === 'text');
    expect(text?.type === 'text' ? text.text : '').toBe('dialog answered');
  });

  for (const method of ['select', 'input', 'editor']) {
    test(`the ${method} dialog returns the value pi expects`, async () => {
      const client = await startCore();
      const threadId = await piThread(client);
      const asked = client.next('question.asked', (request) => request.threadId === threadId);
      const finished = client.next('turn.finished', (turn) => turn.threadId === threadId);
      await client.call('turns.start', { threadId, prompt: `[${method}]` });
      const request = await asked;
      const value = method === 'select' ? 'Second choice' : 'replacement text';
      await client.call('questions.answer', { threadId, questionId: request.id,
        optionIds: method === 'select' ? ['1'] : [], ...(method === 'select' ? {} : { text: value }) });
      expect((await finished).status).toBe('done');
      const thread = await client.call('threads.get', { threadId });
      expect(thread.messages.at(-1)?.parts.some((part) => part.type === 'text' && part.text === value)).toBe(true);
    });
  }

  test('a question on a warm session is filed under the turn that asked it', async () => {
    const client = await startCore({ warmProcessMinutes: 5 });
    const threadId = await piThread(client);

    const turnIds: string[] = [];
    client.on('turn.started', (turn) => {
      if (turn.threadId === threadId) turnIds.push(turn.id);
    });

    await runTurn(client, threadId, 'first');

    const asked = client.next('question.asked', (request) => request.threadId === threadId, 20000);
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 20000);
    await client.call('turns.start', { threadId, prompt: '[ask]' });
    const request = await asked;
    await client.call('questions.answer', { threadId, questionId: request.id, optionIds: ['yes'] });
    expect((await finished).status).toBe('done');

    // One process for the two turns, so the event handler still carries the
    // first turn's context: the question belongs to the second one all the same.
    expect(argvLines()).toHaveLength(1);
    expect(turnIds).toHaveLength(2);
    expect(request.turnId).toBe(turnIds[1] ?? '');
  });

  test('a dialog raised outside a turn is refused on its id, not dropped', async () => {
    const client = await startCore({ warmProcessMinutes: 5 });
    const threadId = await threadOnAgent(client, writeLateDialogAgent(harness?.dataDir ?? ''));
    const logs = collectLogs(client);

    await runTurn(client, threadId, 'first');

    // The process stays warm, so the extension's dialog lands with no turn to
    // draw a card on. Unanswered, it blocks that extension for the life of the
    // process and the agent waits on an id nobody holds.
    await settle(() => fakeLog().includes('late-answer'));
    expect(fakeLog()).toContain('late-answer late-1 cancelled=true');
    expect(logs.some((line) => line.includes('confirm') && line.includes('late-1'))).toBe(true);
  });

  test('stopping while a dialog waits cancels it and clears the question', async () => {
    const client = await startCore();
    const threadId = await piThread(client);
    const asked = client.next('question.asked', (request) => request.threadId === threadId);
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId);
    await client.call('turns.start', { threadId, prompt: '[ask]' });
    await asked;
    await client.call('turns.stop', { threadId });
    expect((await finished).status).toBe('stopped');
    expect(await client.call('questions.list', { threadId })).toEqual([]);
  });

  test('a warm thread keeps one agent process for two turns, a cold one starts a second', async () => {
    const warmClient = await startCore({ warmProcessMinutes: 5 });
    const warmThread = await piThread(warmClient);
    const warm = countProcesses(warmClient, warmThread);
    await runTurn(warmClient, warmThread, 'first');
    expect(warm.started).toHaveLength(1);
    expect(warm.exited).toHaveLength(0);
    await runTurn(warmClient, warmThread, 'second');
    expect(warm.started).toHaveLength(1);
    expect(warm.exited).toHaveLength(0);
    // One process, so one argv line for the two turns.
    expect(argvLines()).toHaveLength(1);
    await stopCore();

    const coldClient = await startCore({ warmProcessMinutes: 0 });
    const coldThread = await piThread(coldClient);
    const cold = countProcesses(coldClient, coldThread);
    await runTurn(coldClient, coldThread, 'first');
    await runTurn(coldClient, coldThread, 'second');
    expect(cold.started).toHaveLength(2);
  });

  test('a dropped session is reopened on the id and the directory the first turn used', async () => {
    const client = await startCore({ warmProcessMinutes: 0 });
    const threadId = await piThread(client);

    await runTurn(client, threadId, 'first');
    const sessionId = (await client.call('threads.get', { threadId })).sessionId ?? '';
    expect(sessionId).not.toBe('');

    // The process went with the turn, so the second one is a new pi launched on
    // the very same id and directory, which is how pi reopens its transcript.
    await runTurn(client, threadId, 'second');
    const lines = argvLines();
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(lines[0]);
    expect(lines[0]).toContain(`sessionId=${sessionId}`);
    expect((await client.call('threads.get', { threadId })).sessionId).toBe(sessionId);
  });

  test('a probe lists the models pi offers, each with the levels that model supports', async () => {
    const client = await startCore();
    const { accountId } = await piAccount(client);

    const probed = client.next(
      'providers.probed',
      (event) => event.providerId === 'pi-fake' && event.accountId === accountId,
      20000,
    );
    const result = await client.call('providers.probe', { providerId: 'pi-fake', accountId });

    // The id is what `--model` takes, and the name carries the provider.
    expect(result.models.map((model) => model.id)).toEqual([
      'default',
      'fake-a/smart',
      'fake-a/quick',
      'fake-b/plain',
    ]);
    expect(result.models[0]).toEqual({ id: 'default', name: 'pi default', default: false });
    expect(result.models[1]?.name).toBe('Fake-a / Fake Smart');
    // pi reports one model as current; that is the one the picker opens on.
    expect(result.models.find((model) => model.default === true)?.id).toBe('fake-a/smart');

    // The two opt-in levels are there only for the model that maps them, and the
    // session's own level is the default of every scale that carries it.
    expect(result.models[1]?.effort).toEqual({
      levels: [
        { id: 'off', label: 'Off' },
        { id: 'minimal', label: 'Minimal' },
        { id: 'low', label: 'Low' },
        { id: 'medium', label: 'Medium' },
        { id: 'high', label: 'High' },
        { id: 'xhigh', label: 'Extra high' },
        { id: 'max', label: 'Max' },
      ],
      default: 'medium',
    });
    expect(result.models[2]?.effort?.levels.map((level) => level.id)).toEqual([
      'off',
      'minimal',
      'low',
      'medium',
      'high',
    ]);
    // A model without reasoning has `off` and nothing else, which is no choice.
    expect(result.models[3]?.effort).toBeUndefined();
    expect(result.probedAt).toBeGreaterThan(0);

    // A second client learns the same list from the event.
    expect((await probed).models.map((model) => model.id)).toEqual([
      'default',
      'fake-a/smart',
      'fake-a/quick',
      'fake-b/plain',
    ]);

    // The answer is cached, and the agent process is gone: a probe leaves nothing.
    await client.call('providers.probe', { providerId: 'pi-fake', accountId });
    expect(countLines('get_available_models')).toBe(1);
    await waitFor(() => harness?.core.procs.liveCount(`probe:pi-fake:${accountId}`) === 0);
    const trace = await client.call('trace.get', { threadId: `probe:pi-fake:${accountId}` });
    expect(trace.length).toBeGreaterThan(0);
    expect(trace.every((row) => row.exitedAt !== null)).toBe(true);
  });

  test('a thread on a probed model launches pi with that model and its effort', async () => {
    const client = await startCore();
    const { projectId, accountId } = await piAccount(client);

    let failure = 'none';
    try {
      await client.call('threads.create', {
        projectId,
        providerId: 'pi-fake',
        accountId,
        title: 'too early',
        model: 'fake-a/quick',
      });
    } catch (error) {
      failure = (error as Error).message;
    }
    expect(failure).toBe('the agent has not listed this model: open the model picker so Boite reads its models first');

    await client.call('providers.probe', { providerId: 'pi-fake', accountId });
    const thread = await client.call('threads.create', {
      projectId,
      providerId: 'pi-fake',
      accountId,
      title: 'after the probe',
      model: 'fake-a/quick',
      effort: 'high',
    });
    expect(thread.model).toBe('fake-a/quick');
    expect(thread.effort).toBe('high');

    await client.call('threads.subscribe', { threadId: thread.id });
    await runTurn(client, thread.id, 'first');
    // The probe's own process wrote an argv line too; the turn's is the last one.
    expect(argvLines()[argvLines().length - 1]).toContain('model=fake-a/quick:high');
  });

  test('a 529 that pi retried by itself ends the turn done, with no error card', async () => {
    const client = await startCore();
    const threadId = await piThread(client);
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 20000);
    await client.call('turns.start', { threadId, prompt: '[retry]' });
    const done = await finished;
    expect(done.status).toBe('done');
    expect(done.error).toBeNull();
    const thread = await client.call('threads.get', { threadId });
    const parts = thread.messages.flatMap((message) => message.parts);
    expect(parts.some((part) => part.type === 'error')).toBe(false);
    expect(parts.some((part) => part.type === 'text' && part.text === 'recovered answer')).toBe(true);
    expect(thread.status).toBe('idle');
  });

  test('a 529 pi gave up on after its retries fails the turn with one error card', async () => {
    const client = await startCore();
    const threadId = await piThread(client);
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 20000);
    await client.call('turns.start', { threadId, prompt: '[giveup]' });
    const done = await finished;
    expect(done.status).toBe('error');
    expect(done.error).toBe('529 overloaded after 3 attempts');
    const thread = await client.call('threads.get', { threadId });
    const errors = thread.messages.flatMap((message) => message.parts).filter((part) => part.type === 'error');
    expect(errors).toEqual([{ type: 'error', message: '529 overloaded after 3 attempts' }]);
  });

  test('an extension command that starts no run ends the turn, and the process stays warm', async () => {
    const client = await startCore({ warmProcessMinutes: 5 });
    const threadId = await piThread(client);
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 10000);
    await client.call('turns.start', { threadId, prompt: '/fake-report' });
    const done = await finished;
    expect(done.status).toBe('done');
    expect(fakeLog()).toContain('extension command handled');
    expect(harness?.core.procs.liveCount(threadId)).toBe(1);
    // A normal turn on the same process still streams to its own agent_settled.
    await runTurn(client, threadId, '[tool] after the command');
    expect(argvLines()).toHaveLength(1);
  });

  test('a stop that pi never answers ends the turn stopped at the deadline, and the process is gone', async () => {
    setPiStopDeadlineForTests(300);
    try {
      const client = await startCore();
      const threadId = await piThread(client);
      const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 10000);
      await client.call('turns.start', { threadId, prompt: '[deaf]' });
      await waitFor(() => fakeLog().includes('waiting forever'));
      await client.call('turns.stop', { threadId });
      expect((await finished).status).toBe('stopped');
      expect(fakeLog()).toContain('abort ignored');
      await waitFor(() => harness?.core.procs.liveCount(threadId) === 0);
    } finally {
      setPiStopDeadlineForTests(null);
    }
  });

  test('a refused clear_queue after a steer still ends the turn stopped', async () => {
    const client = await startCore();
    const threadId = await piThread(client);
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 10000);
    await client.call('turns.start', { threadId, prompt: '[slow][noclear] Deploy' });
    await waitFor(() => fakeLog().includes('waiting for abort'));
    await waitFor(() => harness!.core.journal.listMessages(threadId).some((m) => m.role === 'assistant'));
    expect(await harness!.core.threads.steer(threadId, 'Boite agent coordination. Wait.')).toBe(true);
    await client.call('turns.stop', { threadId });
    expect((await finished).status).toBe('stopped');
    expect(fakeLog()).toContain('clear_queue\nabort');
  });

  test('a notify is drawn in the turn and no fire-and-forget method gets an answer', async () => {
    const client = await startCore();
    const threadId = await piThread(client);
    const logs = collectLogs(client);
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 20000);
    await client.call('turns.start', { threadId, prompt: '[notify]' });
    const done = await finished;
    expect(done.status).toBe('done');
    const thread = await client.call('threads.get', { threadId });
    const parts = thread.messages.flatMap((message) => message.parts);
    expect(parts).toContainEqual({ type: 'text', text: 'pi: heads up' });
    expect(parts).toContainEqual({ type: 'error', message: 'it broke' });
    expect(fakeLog()).not.toContain('ui-response');
    expect(logs.some((line) => line.includes('refused'))).toBe(false);
  });

  test('a dialog pi gave up on after its timeout takes its card away while the turn runs', async () => {
    const client = await startCore();
    const threadId = await piThread(client);
    const asked = client.next('question.asked', (request) => request.threadId === threadId, 20000);
    const withdrawn = client.next('question.answered', (event) => event.threadId === threadId, 20000);
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 20000);
    await client.call('turns.start', { threadId, prompt: '[timeout][slow]' });
    const request = await asked;
    const answered = await withdrawn;
    expect(answered.questionId).toBe(request.id);
    expect(answered.answer).toBeNull();
    await waitFor(() => fakeLog().includes('waiting for abort'));
    expect(await client.call('questions.list', { threadId })).toEqual([]);
    expect((await client.call('threads.get', { threadId })).status).toBe('running');
    expect(fakeLog()).not.toContain('ui-response');
    await client.call('turns.stop', { threadId });
    expect((await finished).status).toBe('stopped');
  });

  test('an automatic compaction draws its divider and the turn reports the context pi counts', async () => {
    const client = await startCore();
    const threadId = await piThread(client);
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 20000);
    await client.call('turns.start', { threadId, prompt: '[compacted] go on' });
    expect((await finished).status).toBe('done');
    const thread = await client.call('threads.get', { threadId });
    const parts = thread.messages.flatMap((message) => message.parts);
    expect(parts).toContainEqual({ type: 'compaction', trigger: 'auto', preTokens: 180000, postTokens: 30000 });
    expect(thread.context?.tokens).toBe(4321);
    expect(thread.context?.window).toBe(200000);
  });

  test('a warm process takes a new effort and a new model over RPC instead of restarting', async () => {
    const client = await startCore({ warmProcessMinutes: 5 });
    const { projectId, accountId } = await piAccount(client);
    await client.call('providers.probe', { providerId: 'pi-fake', accountId });
    const created = await client.call('threads.create', {
      projectId,
      providerId: 'pi-fake',
      accountId,
      title: 'switching',
      model: 'fake-a/smart',
      effort: 'low',
    });
    const threadId = created.id;
    await client.call('threads.subscribe', { threadId });
    await runTurn(client, threadId, 'first');
    await client.call('threads.update', { threadId, effort: 'high' });
    await runTurn(client, threadId, 'second');
    await client.call('threads.update', { threadId, model: 'fake-a/quick', effort: 'high' });
    await runTurn(client, threadId, 'third');
    const turnProcesses = argvLines().filter((line) => !line.includes('sessionId= '));
    expect(turnProcesses).toHaveLength(1);
    expect(turnProcesses[0]).toContain('model=fake-a/smart:low');
    expect(fakeLog()).toContain('level high\n');
    expect(fakeLog()).toContain('model fake-a/quick\nset_thinking_level\nlevel high\n');
  });

  test('core shutdown during a turn pi never settles ends it before the journal closes', async () => {
    const client = await startCore();
    const threadId = await piThread(client);
    await client.call('turns.start', { threadId, prompt: '[deaf]' });
    await waitFor(() => fakeLog().includes('waiting forever'));
    // Nothing may write to the closed journal once the child's close lands.
    await stopCore();
    await new Promise((resolve) => setTimeout(resolve, 500));
  }, 20000);

  function countProcesses(
    client: CoreClient,
    threadId: string,
  ): { started: RpcEvents['process.started'][]; exited: RpcEvents['process.exited'][] } {
    const started: RpcEvents['process.started'][] = [];
    const exited: RpcEvents['process.exited'][] = [];
    client.on('process.started', (record) => {
      if (record.threadId === threadId) started.push(record);
    });
    client.on('process.exited', (record) => {
      if (record.threadId === threadId) exited.push(record);
    });
    return { started, exited };
  }

  async function runTurn(client: CoreClient, threadId: string, prompt: string): Promise<void> {
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 20000);
    await client.call('turns.start', { threadId, prompt });
    const done = await finished;
    expect(done.error).toBeNull();
    expect(done.status).toBe('done');
  }
});
