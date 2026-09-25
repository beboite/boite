import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'bun:test';
import type { MessagePart, PermissionMode, RpcEvents, Settings } from '@boite/contracts';
import type { CoreClient } from '../src/client.ts';
import { getDriver } from '../src/drivers/index.ts';
import { startTestCore, waitFor } from './harness.ts';
import type { TestCore } from './harness.ts';

/** The fake Codex app-server: a real ndjson JSON-RPC process over stdio, run by bun. */
const FAKE_SERVER = fileURLToPath(new URL('./fixtures/codex-server.ts', import.meta.url));
/** The fixture's environment switches a test may set; every one is cleared after it. */
const FAKE_SWITCHES = ['CODEX_FAKE_LOST', 'CODEX_FAKE_DEAF', 'CODEX_FAKE_SLOW_START'];

test('coordination steers the current Codex turn without creating a user turn', async () => {
  const client = await startCore();
  const threadId = await codexThread(client);
  await client.call('turns.start', { threadId, prompt: '[slow] Deploy' });
  await waitFor(() => fakeLog().includes('waiting for interrupt'));
  await waitFor(() => harness!.core.journal.listMessages(threadId).some(m => m.role === 'assistant'));
  expect(await harness!.core.threads.steer(threadId, 'Boite agent coordination. Wait for the VM.')).toBe(true);
  expect(fakeLog()).toContain('turn/steer codex-fake-turn-1 Boite agent coordination');
  expect(harness!.core.journal.listTurns(threadId)).toHaveLength(1);
  expect(harness!.core.journal.listMessages(threadId).filter(m => m.role === 'user')).toHaveLength(1);
  expect(harness!.core.journal.listMessages(threadId).some(m => m.role === 'system')).toBe(true);
  await client.call('turns.stop', { threadId });
});

let harness: TestCore | null = null;
let logFile = '';

afterEach(async () => {
  const open = harness;
  harness = null;
  delete process.env['CODEX_FAKE_LOG'];
  for (const name of FAKE_SWITCHES) delete process.env[name];
  if (open !== null) await open.stop();
});

async function startCore(settings?: Partial<Settings>): Promise<CoreClient> {
  const started = await startTestCore(settings === undefined ? {} : { settings });
  harness = started;
  logFile = join(started.dataDir, 'codex-fake.log');
  // `spawnChild` gets `process.env` plus the account environment, so this is
  // what reaches the fake server.
  process.env['CODEX_FAKE_LOG'] = logFile;
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

/** A user descriptor for the fake server: `protocol: "codex-appserver"`, launched as `bun <fixture>`. */
function writeDescriptor(dataDir: string): void {
  const dir = join(dataDir, 'providers');
  mkdirSync(dir, { recursive: true });
  const profile = {
    detect: {},
    executable: [{ kind: 'path', value: 'bun' }],
    launch: { args: [FAKE_SERVER] },
    isolation: {},
  };
  writeFileSync(
    join(dir, 'codex-fake.json'),
    JSON.stringify({
      id: 'codex-fake',
      schemaVersion: 1,
      name: 'Fake Codex app-server',
      shortName: 'CodexFake',
      protocol: 'codex-appserver',
      roots: ['{isolationDir}'],
      profiles: { windows: profile, linux: profile, macos: profile },
      auth: { kind: 'none' },
      models: [
        {
          id: 'fake-codex',
          name: 'Fake Codex',
          default: true,
          effort: {
            levels: [
              { id: 'low', label: 'Low' },
              { id: 'high', label: 'High' },
            ],
            default: 'low',
          },
        },
        // The shipped descriptor's one model: "the agent keeps its own". A probe
        // keeps it first, and the driver never puts it on the wire.
        { id: 'default', name: 'Agent default' },
      ],
      capabilities: {
        approvals: true,
        hooks: false,
        checkpoint: false,
        images: true,
        planMode: true,
        resume: true,
      },
    }),
    'utf8',
  );
}

async function codexAccount(client: CoreClient): Promise<{ dataDir: string; projectId: string; accountId: string }> {
  const dataDir = harness?.dataDir ?? '';
  writeDescriptor(dataDir);
  const loaded = await client.call('providers.reload', {});
  expect(loaded.rejected).toEqual([]);
  expect(loaded.loaded.some((provider) => provider.id === 'codex-fake' && provider.available)).toBe(true);

  const project = await client.call('projects.add', { path: dataDir, name: 'codex' });
  const account = await client.call('accounts.add', {
    providerId: 'codex-fake',
    label: 'Fake',
    useDefaultLocation: true,
  });
  return { dataDir, projectId: project.id, accountId: account.id };
}

async function codexThread(client: CoreClient, permissionMode?: PermissionMode, effort?: string): Promise<string> {
  const { projectId, accountId } = await codexAccount(client);
  const thread = await client.call('threads.create', {
    projectId,
    providerId: 'codex-fake',
    accountId,
    title: 'codex thread',
    model: 'fake-codex',
    ...(effort === undefined ? {} : { effort }),
    ...(permissionMode === undefined ? {} : { permissionMode }),
  });
  await client.call('threads.subscribe', { threadId: thread.id });
  return thread.id;
}

describe('codex driver', () => {
  test('an asynchronous question draws a card without waiting, and its answer steers the running turn', async () => {
    const client = await startCore();
    const threadId = await codexThread(client);
    const asked = client.next('question.asked', (q) => q.threadId === threadId);
    await client.call('turns.start', { threadId, prompt: 'Build [async][slow]' });
    const question = await asked;
    expect(question).toMatchObject({ text: 'Which name?', async: true, allowText: true, multiple: false });
    expect(question.options.map((option) => option.label)).toEqual(['later.txt', 'extra.txt']);
    await waitFor(() => fakeLog().includes('waiting for interrupt'));
    // Nothing waits on the card: the thread keeps running.
    expect(harness!.core.journal.getThread(threadId)?.status).toBe('running');
    // The question's own text is the card, not a line of the answer.
    const texts = harness!.core.journal.listMessages(threadId).flatMap((m) => m.parts).filter((p) => p.type === 'text' && p.text.includes('- later.txt'));
    expect(texts).toEqual([]);

    await client.call('questions.answer', { threadId, questionId: question.id, optionIds: [question.options[0]!.id] });
    await waitFor(() => fakeLog().includes('turn/steer codex-fake-turn-1 > Which name?'));
    const card = harness!.core.journal.listMessages(threadId).flatMap((m) => m.parts).find((p) => p.type === 'question');
    expect(card).toMatchObject({ async: true, answer: { optionIds: [question.options[0]!.id] } });
    expect(harness!.core.journal.listTurns(threadId)).toHaveLength(1);
    await client.call('turns.stop', { threadId });
  });

  test('an asynchronous question answered after its turn ended goes out as the next prompt', async () => {
    const client = await startCore();
    const threadId = await codexThread(client);
    const asked = client.next('question.asked', (q) => q.threadId === threadId);
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 20000);
    await client.call('turns.start', { threadId, prompt: 'Build [async]' });
    const question = await asked;
    expect((await finished).status).toBe('done');
    // The card outlives its turn.
    expect(await client.call('questions.list', { threadId })).toHaveLength(1);

    const next = client.next('turn.finished', (turn) => turn.threadId === threadId, 20000);
    await client.call('questions.answer', { threadId, questionId: question.id, optionIds: [], text: 'notes-2.txt' });
    expect((await next).status).toBe('done');
    const prompts = harness!.core.journal.listMessages(threadId).filter((m) => m.role === 'user').map((m) => m.parts[0]?.type === 'text' ? m.parts[0].text : '');
    expect(prompts).toEqual(['Build [async]', '> Which name?\n\nnotes-2.txt']);
    expect(await client.call('questions.list', { threadId })).toEqual([]);
  });

  test('a running command draws its output live, a sleep is a card, and both carry their times', async () => {
    const client = await startCore();
    const threadId = await codexThread(client);
    const seen: MessagePart[] = [];
    client.on('message.part', (event) => { if (event.threadId === threadId) seen.push(event.part); });
    await runTurn(client, threadId, 'Run [stream]');
    const live = seen.find((part) => part.type === 'tool' && part.status === 'running' && part.output === 'line one\n');
    expect(live).toBeDefined();
    const parts = harness!.core.journal.listMessages(threadId).flatMap((m) => m.parts);
    const command = parts.find((part) => part.type === 'tool' && part.name === 'Bash');
    const sleep = parts.find((part) => part.type === 'tool' && part.name === 'Sleep');
    expect(command).toMatchObject({ status: 'done', output: 'line one\nline two\n' });
    expect(sleep).toMatchObject({ status: 'done', input: { durationMs: 50 } });
    for (const part of [command, sleep]) {
      if (part?.type !== 'tool') throw new Error('no tool part');
      expect(typeof part.startedAt).toBe('number');
      expect(part.finishedAt! - part.startedAt!).toBeGreaterThanOrEqual(400);
    }
  });

  test('service tiers are model-specific, persisted and sent on the frozen turn', async () => {
    const client = await startCore();
    const { projectId, accountId } = await codexAccount(client);
    const models = (await client.call('providers.probe', { providerId: 'codex-fake', accountId })).models;
    expect(models.find(m => m.id === 'fake-smart')?.speeds?.map(s => s.id)).toEqual(['fast', 'ultrafast']);
    expect(models.find(m => m.id === 'fake-plain')?.speeds).toBeUndefined();
    const thread = await client.call('threads.create', { projectId, providerId: 'codex-fake', accountId, model: 'fake-smart', speed: 'ultrafast' });
    expect((await client.call('threads.get', { threadId: thread.id })).speed).toBe('ultrafast');
    const finished = client.next('turn.finished', t => t.threadId === thread.id);
    const turn = await client.call('turns.start', { threadId: thread.id, prompt: 'hello' });
    expect(turn.execution?.speed).toBe('ultrafast');
    await client.call('threads.update', { threadId: thread.id, speed: null });
    expect((await finished).status).toBe('done');
    expect(fakeLog()).toContain('"serviceTier":"ultrafast"');
    const switched = await client.call('threads.update', { threadId: thread.id, model: 'fake-plain' });
    expect(switched.speed).toBeNull();
    expect(() => harness!.core.threads.update({ threadId: thread.id, speed: 'fast' })).toThrow(/does not offer this speed/);
  });

  test('manual compaction resumes the native session and waits for its completed turn', async () => {
    const client = await startCore();
    const threadId = await codexThread(client);
    let finished = client.next('turn.finished', (turn) => turn.threadId === threadId);
    await client.call('turns.start', { threadId, prompt: 'remember this' });
    await finished;
    const before = await client.call('threads.get', { threadId });
    finished = client.next('turn.finished', (turn) => turn.threadId === threadId);
    const turn = await client.call('threads.compact', { threadId });
    expect(turn.execution?.operation).toBe('compact');
    expect((await finished).status).toBe('done');
    const after = await client.call('threads.get', { threadId });
    expect(after.sessionId).toBe(before.sessionId);
    expect(after.context?.tokens).toBe(32000);
    expect(after.context?.window).toBe(200000);
    expect(after.messages.flatMap((m) => m.parts).some((p) => p.type === 'compaction')).toBe(true);
    expect(fakeLog()).toContain('thread/compact/start');
    client.close();
  });
  test('getDriver returns the codex driver', () => {
    expect(getDriver('codex-appserver').protocol).toBe('codex-appserver');
  });

  test('native plan tools are enabled on new and resumed sessions and populate activity', async () => {
    const client = await startCore({ warmProcessMinutes: 0 });
    const threadId = await codexThread(client);
    for (let i = 0; i < 2; i++) {
      harness!.core.activity.tasks(threadId, []);
      const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 20000);
      await client.call('turns.start', { threadId, prompt: '[tasks]' });
      expect((await finished).status).toBe('done');
      expect((await client.call('threads.get', { threadId })).activity?.tasks).toEqual([
        { id: '0', text: 'Inspect source', status: 'completed' },
        { id: '1', text: 'Run checks', status: 'in_progress' },
      ]);
    }
    expect(fakeLog()).toContain('thread/resume');
  });

  test('a plain prompt streams back as one text part, and the codex thread id is kept', async () => {
    const client = await startCore();
    const threadId = await codexThread(client, undefined, 'high');

    const deltas: string[] = [];
    client.on('message.delta', (event) => {
      if (event.threadId === threadId) deltas.push(event.text);
    });

    const prompt = 'the fake codex server echoes this back';
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 20000);
    await client.call('turns.start', { threadId, prompt });

    const done = await finished;
    expect(done.error).toBeNull();
    expect(done.status).toBe('done');
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.join('')).toBe(prompt);

    const thread = await client.call('threads.get', { threadId });
    expect(thread.sessionId).toMatch(/^codex-fake-/);
    expect(thread.messages[1]?.parts).toEqual([{ type: 'text', text: prompt }]);
    // The thread's model and effort ride on `turn/start`.
    expect(fakeLog()).toContain('turn/start model=fake-codex effort=high');
    // The client says hello the way the protocol asks, request then notification.
    expect(fakeLog()).toContain('initialize\n');
    expect(fakeLog()).toContain('initialized\n');
  });

  test('an image attachment rides turn/start as a data url', async () => {
    const client = await startCore();
    const threadId = await codexThread(client);

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

    expect(fakeLog()).toContain(`image data:image/png;base64,${PNG}`);
  });

  test('a reasoning delta becomes a thinking part ahead of the answer', async () => {
    const client = await startCore();
    const threadId = await codexThread(client);

    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 20000);
    await client.call('turns.start', { threadId, prompt: '[thought]the answer' });
    expect((await finished).status).toBe('done');

    const thread = await client.call('threads.get', { threadId });
    expect(thread.messages[1]?.parts).toEqual([
      { type: 'thinking', text: 'thinking about it' },
      { type: 'text', text: 'the answer' },
    ]);
  });

  test('a command execution item arrives running, then done with its output', async () => {
    const client = await startCore();
    const threadId = await codexThread(client);

    const parts: MessagePart[] = [];
    client.on('message.part', (event) => {
      if (event.threadId === threadId) parts.push(event.part);
    });

    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 20000);
    await client.call('turns.start', { threadId, prompt: '[command]' });
    expect((await finished).status).toBe('done');

    const tools = parts.filter((part) => part.type === 'tool');
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({ name: 'Bash', status: 'running', output: null });
    expect(tools[0]).toMatchObject({ input: { command: 'echo hello' } });
    expect(tools[1]).toMatchObject({ name: 'Bash', status: 'done', output: 'ok' });
  });

  test('an approval is asked, answered, and the decision reaches the agent', async () => {
    const client = await startCore();
    const threadId = await codexThread(client);

    const allowed = await answerApproval(client, threadId, 'allow');
    expect(allowed.status).toBe('done');
    expect(allowed.text).toBe('allowed');
    expect(allowed.permission).toMatchObject({ type: 'permission', toolName: 'Bash', decision: 'allow' });
    expect(allowed.tool).toMatchObject({ name: 'Bash', status: 'done' });

    const denied = await answerApproval(client, threadId, 'deny');
    expect(denied.status).toBe('done');
    expect(denied.text).toBe('denied');
    expect(denied.permission).toMatchObject({ type: 'permission', toolName: 'Bash', decision: 'deny' });
    expect(denied.tool).toMatchObject({ name: 'Bash', status: 'denied' });
  });

  async function answerApproval(
    client: CoreClient,
    threadId: string,
    decision: 'allow' | 'deny',
  ): Promise<{ status: string; text: string; permission: MessagePart | undefined; tool: MessagePart | undefined }> {
    const requested = client.next('permission.requested', (request) => request.threadId === threadId, 20000);
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 20000);
    await client.call('turns.start', { threadId, prompt: '[approve]' });

    const request = await requested;
    expect(request.toolName).toBe('Bash');
    expect(request.input).toMatchObject({ command: 'echo hello' });
    await client.call('permissions.answer', { requestId: request.id, decision });

    const done = await finished;
    const thread = await client.call('threads.get', { threadId });
    const assistant = thread.messages[thread.messages.length - 1];
    const parts = assistant?.parts ?? [];
    const text = parts.find((part) => part.type === 'text');
    return {
      status: done.status,
      text: text?.type === 'text' ? text.text : '',
      permission: parts.find((part) => part.type === 'permission'),
      tool: parts.find((part) => part.type === 'tool'),
    };
  }

  test('context reported after completion is retained, including a missing total', async () => {
    const client = await startCore({warmProcessMinutes: 1});
    const threadId = await codexThread(client);
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 20000);
    await client.call('turns.start', { threadId, prompt: '[late-context]' });
    await finished;
    await waitFor(() => harness?.core.journal.getThread(threadId)?.context?.tokens === 90, 1500);
    const thread = await client.call('threads.get', {threadId});
    expect(thread.context?.window).toBe(200000);
    expect(thread.context?.breakdown).toEqual({input:60,cache:20,output:10});
  });

  test('late usage from a previous turn does not overwrite the current turn', async () => {
    const client = await startCore({ warmProcessMinutes: 1 });
    const threadId = await codexThread(client);
    await runTurn(client, threadId, '[late-context]');
    const finished = client.next('turn.finished', turn => turn.threadId === threadId, 20000);
    await client.call('turns.start', { threadId, prompt: '[slow]' });
    await waitFor(() => harness!.core.threads.get(threadId).context?.tokens === 90);
    await client.call('turns.stop', { threadId });
    expect((await finished).usage).toBeNull();
  });

  test('the turn usage carries the tokens the agent reported, with no price', async () => {
    const client = await startCore();
    const threadId = await codexThread(client);

    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 20000);
    await client.call('turns.start', { threadId, prompt: '[usage]' });

    const done = await finished;
    expect(done.status).toBe('done');
    expect(done.usage).toEqual({
      inputTokens: 8,
      outputTokens: 4,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      costUsdEquivalent: null,
    });
  });

  test('stopping a turn interrupts it and the agent process is gone', async () => {
    const client = await startCore();
    const threadId = await codexThread(client);

    const started = client.next('process.started', (record) => record.threadId === threadId, 20000);
    const exited = client.next('process.exited', (record) => record.threadId === threadId, 20000);
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 20000);
    await client.call('turns.start', { threadId, prompt: '[slow]' });
    await started;
    // A turn under way: a stop during the start sends no prompt at all (below).
    await waitFor(() => fakeLog().includes('waiting for interrupt'));

    expect(await client.call('turns.stop', { threadId })).toEqual({ stopped: true });
    expect((await finished).status).toBe('stopped');
    await exited;

    expect(fakeLog()).toContain('turn/interrupt codex-fake-turn-1');
    await waitFor(() => harness?.core.procs.liveCount(threadId) === 0);
    const trace = await client.call('trace.get', { threadId });
    expect(trace).toHaveLength(1);
    expect(trace[0]?.exitedAt).not.toBeNull();
  });

  test('a stop the agent never acts on ends the turn stopped after the grace, and the thread goes on', async () => {
    const client = await startCore();
    const threadId = await codexThread(client);
    process.env['CODEX_FAKE_DEAF'] = '1';

    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 15000);
    await client.call('turns.start', { threadId, prompt: '[slow]' });
    await waitFor(() => fakeLog().includes('waiting for interrupt'));
    const stoppedAt = Date.now();
    expect(await client.call('turns.stop', { threadId })).toEqual({ stopped: true });
    const done = await finished;
    expect(done.status).toBe('stopped');
    expect(done.error).toBeNull();
    // The grace, then the process: never the whole scheduler drain.
    expect(Date.now() - stoppedAt).toBeLessThan(4500);
    expect(fakeLog()).toContain('turn/interrupt codex-fake-turn-1');
    await waitFor(() => harness?.core.procs.liveCount(threadId) === 0);
    expect((await client.call('threads.get', { threadId })).status).toBe('idle');

    delete process.env['CODEX_FAKE_DEAF'];
    await runTurn(client, threadId, 'still here');
  });

  test('a stop that lands while the thread opens sends no prompt', async () => {
    const client = await startCore();
    const threadId = await codexThread(client);
    process.env['CODEX_FAKE_SLOW_START'] = '800';

    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 15000);
    await client.call('turns.start', { threadId, prompt: 'expensive prompt' });
    await waitFor(() => fakeLog().includes('thread/start'));
    expect(await client.call('turns.stop', { threadId })).toEqual({ stopped: true });
    const done = await finished;
    expect(done.status).toBe('stopped');
    expect(done.error).toBeNull();
    expect(fakeLog()).not.toContain('turn/start');
    // The thread the agent opened is kept for the next turn.
    expect((await client.call('threads.get', { threadId })).sessionId).not.toBeNull();
  });

  test('a server that dies fails the turn with its exit code and stderr, and the next turn works', async () => {
    const client = await startCore();
    const threadId = await codexThread(client);

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

  test('a free-form question draws a card, and the answer reaches the agent', async () => {
    const client = await startCore();
    const threadId = await codexThread(client);
    await client.call('threads.subscribe', { threadId });

    const asked = client.next('question.asked', (request) => request.threadId === threadId, 20000);
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 20000);
    await client.call('turns.start', { threadId, prompt: '[input]' });

    const question = await asked;
    expect(question.text).toBe('Pick: which one?');
    expect(question.options).toEqual([
      { id: 'red', label: 'Red' },
      { id: 'blue', label: 'Blue' },
    ]);
    // `isOther` is the server saying the user may write their own answer.
    expect(question.allowText).toBe(true);
    expect(question.multiple).toBe(false);
    expect(await client.call('questions.list', { threadId })).toHaveLength(1);

    await client.call('questions.answer', { threadId, questionId: question.id, optionIds: ['blue'] });

    const done = await finished;
    expect(done.status).toBe('done');
    const thread = await client.call('threads.get', { threadId });
    const parts = thread.messages[thread.messages.length - 1]?.parts ?? [];
    expect(parts.find((part) => part.type === 'question')).toMatchObject({
      type: 'question',
      questionId: question.id,
      answer: { optionIds: ['blue'] },
    });
    // What the fake server received: the label of what the user picked.
    const text = parts.find((part) => part.type === 'text');
    expect(text?.type === 'text' ? text.text : '').toBe('input answered Blue');
    expect(await client.call('questions.list', {})).toEqual([]);
  });

  test('a warm thread keeps one agent process for two turns, a cold one starts a second', async () => {
    const warmClient = await startCore({ warmProcessMinutes: 5 });
    const warmThread = await codexThread(warmClient);
    const warm = countProcesses(warmClient, warmThread);
    await runTurn(warmClient, warmThread, 'first');
    expect(warm.started).toHaveLength(1);
    expect(warm.exited).toHaveLength(0);
    await runTurn(warmClient, warmThread, 'second');
    expect(warm.started).toHaveLength(1);
    expect(warm.exited).toHaveLength(0);
    // One process, so one `initialize` and one `thread/start` for the two turns.
    expect(countLines('initialize')).toBe(1);
    await stopCore();

    const coldClient = await startCore({ warmProcessMinutes: 0 });
    const coldThread = await codexThread(coldClient);
    const cold = countProcesses(coldClient, coldThread);
    await runTurn(coldClient, coldThread, 'first');
    await runTurn(coldClient, coldThread, 'second');
    expect(cold.started).toHaveLength(2);
  });

  test('a model and an effort changed on a warm thread ride the next turn/start', async () => {
    const client = await startCore({ warmProcessMinutes: 5 });
    const { projectId, accountId } = await codexAccount(client);
    // The picker's probe first: `fake-smart` is the server's model, not the
    // descriptor's, so nothing may put it on a thread before the agent listed it.
    await client.call('providers.probe', { providerId: 'codex-fake', accountId });
    const thread = await client.call('threads.create', {
      projectId,
      providerId: 'codex-fake',
      accountId,
      title: 'codex switch',
      model: 'fake-codex',
      effort: 'low',
    });
    await client.call('threads.subscribe', { threadId: thread.id });
    const counted = countProcesses(client, thread.id);

    await runTurn(client, thread.id, 'first');
    expect(countLines('turn/start model=fake-codex effort=low')).toBe(1);

    await client.call('threads.update', { threadId: thread.id, model: 'fake-smart', effort: 'high' });
    await runTurn(client, thread.id, 'second');

    // Neither is in the session key: the same app-server took the new pair on
    // the turn itself, and its thread was neither restarted nor resumed.
    expect(countLines('turn/start model=fake-smart effort=high')).toBe(1);
    expect(counted.started).toHaveLength(1);
    expect(counted.exited).toHaveLength(0);
    expect(fakeLog()).not.toContain('thread/resume');
  });

  test('a dropped session is resumed on the codex thread id the first turn minted', async () => {
    const client = await startCore({ warmProcessMinutes: 0 });
    const threadId = await codexThread(client);

    await runTurn(client, threadId, 'first');
    const sessionId = (await client.call('threads.get', { threadId })).sessionId ?? '';
    expect(sessionId).not.toBe('');

    // The process went with the turn, so the second one resumes on a new one.
    await runTurn(client, threadId, 'second');
    await waitFor(() => fakeLog().includes(`thread/resume ${sessionId} `));
    expect(countLines('initialize')).toBe(2);
    expect((await client.call('threads.get', { threadId })).sessionId).toBe(sessionId);
  });

  test('a thread whose rollout is gone starts over with the history instead of failing for good', async () => {
    const client = await startCore({ warmProcessMinutes: 0 });
    const threadId = await codexThread(client);

    await runTurn(client, threadId, 'remember the word pelican');
    const lost = (await client.call('threads.get', { threadId })).sessionId ?? '';
    expect(lost).not.toBe('');

    process.env['CODEX_FAKE_LOST'] = '1';
    await runTurn(client, threadId, 'which word?');
    expect(fakeLog()).toContain(`thread/resume ${lost} `);
    // Resume refused, then one fresh start in the same turn.
    expect(countLines('initialize')).toBe(3);
    expect(fakeLog().split('\n').filter((line) => line.startsWith('thread/start'))).toHaveLength(2);

    const thread = await client.call('threads.get', { threadId });
    expect(thread.sessionId).not.toBe(lost);
    expect(thread.sessionId).not.toBeNull();
    expect(thread.sessionGeneration).toBe(1);
    const parts = thread.messages.flatMap((message) => message.parts);
    expect(parts.some((part) => part.type === 'error')).toBe(false);
    // The fake echoes its prompt: the fresh thread was told what the lost one knew.
    const answer = thread.messages.at(-1)?.parts.find((part) => part.type === 'text');
    expect(answer?.type === 'text' ? answer.text : '').toContain('remember the word pelican');
  });

  test('the permission mode becomes the approval policy and the sandbox codex takes', async () => {
    const planning = await startCore();
    const planThread = await codexThread(planning, 'plan');
    await runTurn(planning, planThread, 'first');
    expect(fakeLog()).toContain('thread/start approvalPolicy=never sandbox=read-only');

    await stopCore();

    const client = await startCore();
    const threadId = await codexThread(client);
    await runTurn(client, threadId, 'first');
    expect(fakeLog()).toContain('thread/start approvalPolicy=on-request sandbox=workspace-write');

    await stopCore();

    const loose = await startCore();
    const looseThread = await codexThread(loose, 'bypassPermissions');
    await runTurn(loose, looseThread, 'first');
    expect(fakeLog()).toContain('thread/start approvalPolicy=never sandbox=danger-full-access');
  });

  test('a probe lists the models the server offers, each with its own effort scale', async () => {
    const client = await startCore();
    const { accountId } = await codexAccount(client);

    const probed = client.next(
      'providers.probed',
      (event) => event.providerId === 'codex-fake' && event.accountId === accountId,
      20000,
    );
    const result = await client.call('providers.probe', { providerId: 'codex-fake', accountId });

    expect(result.models.map((model) => model.id)).toEqual(['default', 'fake-fast', 'fake-smart', 'fake-plain']);
    // The descriptor's own entry stays first and never claims to be the default.
    expect(result.models[0]).toEqual({ id: 'default', name: 'Agent default', default: false });
    expect(result.models.find((model) => model.default === true)?.id).toBe('fake-smart');

    // Unlike ACP's one session-wide scale, each Codex model carries its own.
    expect(result.models[1]?.effort).toEqual({
      levels: [
        { id: 'low', label: 'Low', description: 'quick' },
        { id: 'medium', label: 'Medium', description: 'balanced' },
      ],
      default: 'medium',
    });
    expect(result.models[2]?.effort?.default).toBe('high');
    // A model with no reasoning control carries no effort block at all.
    expect(result.models[3]?.effort).toBeUndefined();
    expect(result.probedAt).toBeGreaterThan(0);

    // A second client learns the same list from the event.
    expect((await probed).models.map((model) => model.id)).toEqual([
      'default',
      'fake-fast',
      'fake-smart',
      'fake-plain',
    ]);

    // The agent process is gone: nothing is left running for a probe.
    await waitFor(() => harness?.core.procs.liveCount(`probe:codex-fake:${accountId}`) === 0);
    const trace = await client.call('trace.get', { threadId: `probe:codex-fake:${accountId}` });
    expect(trace.every((row) => row.exitedAt !== null)).toBe(true);
    expect(countLines('model/list')).toBe(1);
  });

  test('a thread on a probed model sends that model and its effort on turn/start', async () => {
    const client = await startCore();
    const { projectId, accountId } = await codexAccount(client);

    let failure = 'none';
    try {
      await client.call('threads.create', {
        projectId,
        providerId: 'codex-fake',
        accountId,
        title: 'too early',
        model: 'fake-smart',
      });
    } catch (error) {
      failure = (error as Error).message;
    }
    expect(failure).toBe('the agent has not listed this model: open the model picker so Boite reads its models first');

    await client.call('providers.probe', { providerId: 'codex-fake', accountId });
    const thread = await client.call('threads.create', {
      projectId,
      providerId: 'codex-fake',
      accountId,
      title: 'after the probe',
      model: 'fake-smart',
      effort: 'high',
    });
    expect(thread.model).toBe('fake-smart');
    expect(thread.effort).toBe('high');

    await client.call('threads.subscribe', { threadId: thread.id });
    await runTurn(client, thread.id, 'first');
    expect(fakeLog()).toContain('turn/start model=fake-smart effort=high');
  });

  test('the model "default" means the agent keeps its own, so no model reaches the wire', async () => {
    const client = await startCore();
    const { projectId, accountId } = await codexAccount(client);
    const thread = await client.call('threads.create', {
      projectId,
      providerId: 'codex-fake',
      accountId,
      title: 'agent default',
      model: 'default',
    });
    await client.call('threads.subscribe', { threadId: thread.id });
    await runTurn(client, thread.id, 'first');

    expect(fakeLog()).toContain('thread/start approvalPolicy=on-request sandbox=workspace-write model=');
    expect(fakeLog()).toContain('turn/start model= effort=');
    expect(fakeLog()).not.toContain('model=default');
  });

  /** How many lines of the fake log are exactly this one. */
  function countLines(line: string): number {
    return fakeLog()
      .split('\n')
      .filter((entry) => entry === line).length;
  }

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
