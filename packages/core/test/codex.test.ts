import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { MessagePart, PermissionMode, RpcEvents, Settings } from '@boite/contracts';
import type { CoreClient } from '../src/client.ts';
import { getDriver } from '../src/drivers/index.ts';
import { memoryLimitOfJob, cpuRateOfGlobalJob } from '../src/platform/windows/jobs.ts';
import { startTestCore, waitFor } from './harness.ts';
import type { TestCore } from './harness.ts';

/** The fake Codex app-server: a real ndjson JSON-RPC process over stdio, run by bun. */
const FAKE_SERVER = fileURLToPath(new URL('./fixtures/codex-server.ts', import.meta.url));
/** The fixture's environment switches a test may set; every one is cleared after it. */
const FAKE_SWITCHES = ['CODEX_FAKE_LOST', 'CODEX_FAKE_DEAF', 'CODEX_FAKE_SLOW_START', 'CODEX_FAKE_HOOKS', 'CODEX_FAKE_INIT_FAILURES', 'CODEX_FAKE_INIT_ERROR', 'CODEX_FAKE_CRASH_ERROR', 'CODEX_FAKE_INIT_RPC_ERROR', 'CODEX_FAKE_LOGIN_WAIT'];

test('native collaboration is journalled and appears in Team with delegation disabled', async () => {
  const client = await startCore();
  const threadId = await codexThread(client);
  const finished = client.next('turn.finished', turn => turn.threadId === threadId);
  await client.call('turns.start', { threadId, prompt: '[agents]' });
  expect((await finished).status).toBe('done');
  const thread = await client.call('threads.get', { threadId });
  expect(JSON.stringify(thread.messages)).not.toContain('Private child work');
  expect(JSON.stringify(thread.messages)).not.toContain('Private command output');
  expect(thread.messages.flatMap(m => m.parts).filter(p => p.type === 'tool' && p.name === 'Agent')).toHaveLength(4);
  const team = await client.call('delegation.get', { threadId });
  expect(team.config.enabled).toBe(false);
  expect(team.agents).toHaveLength(0);
  expect(team.nativeAgents).toEqual([
    expect.objectContaining({ id: 'native-reviewer', task: 'Review parser boundaries', model: 'fake-smart', status: 'done', result: 'Parser checked' }),
    expect.objectContaining({ id: 'native-other', name: '/root/research', status: 'done' }),
  ]);
});

test('coordination steers the current Codex turn without creating a user turn', async () => {
  const client = await startCore();
  const threadId = await codexThread(client);
  await client.call('turns.start', { threadId, prompt: '[slow] Deploy' });
  await waitFor(() => fakeLog().includes('waiting for interrupt'));
  await waitFor(() => harness!.core.journal.listMessages(threadId).some(m => m.role === 'assistant'));
  expect(await harness!.core.threads.steer(threadId, 'Boite agent coordination. Wait for the VM.')).toBe(true);
  expect(fakeLog()).toContain('turn/steer codex-fake-turn-1 Boite agent coordination');
  const turn = harness!.core.journal.listTurns(threadId)[0]!;
  expect(await client.call('turns.steer', { threadId, turnId: turn.id, prompt: 'User correction',
    attachments: [{ kind: 'image', mimeType: 'image/png', data: 'aGVsbG8=', name: 'sample.png' }], clientRequestId: 'codex_steer_01' })).toEqual({ accepted: true });
  expect(fakeLog()).toContain('turn/steer codex-fake-turn-1 User correction');
  expect(fakeLog()).toContain('steer-images 1 data:image/png;base64,');
  expect(harness!.core.journal.listTurns(threadId)).toHaveLength(1);
  expect(harness!.core.journal.listMessages(threadId).filter(m => m.role === 'user')).toHaveLength(2);
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
  await keepTitle(client, thread.id);
  await client.call('threads.subscribe', { threadId: thread.id });
  return thread.id;
}

/**
 * A title the user typed: no title call follows the first turn, so the
 * app-servers, `initialize` and `thread/start` lines a test counts are the turns' own.
 */
async function keepTitle(client: CoreClient, threadId: string): Promise<void> {
  const thread = await client.call('threads.get', { threadId });
  await client.call('threads.update', { threadId, title: thread.title });
}

describe('codex driver', () => {
  test('viewing prepares one session without a turn and reuses it with retention disabled', async () => {
    const client = await startCore({ warmProcessMinutes: 0 });
    const threadId = await codexThread(client);
    await client.call('threads.focus', { threadId });
    await waitFor(() => fakeLog().includes('thread/start'));
    expect(countLines('initialize')).toBe(1);
    expect(fakeLog()).not.toContain('turn/start');
    expect(harness!.core.journal.listTurns(threadId)).toHaveLength(0);
    expect(harness!.core.journal.listMessages(threadId)).toHaveLength(0);
    for (const prompt of ['first', 'second']) {
      const finished = client.next('turn.finished', turn => turn.threadId === threadId);
      await client.call('turns.start', { threadId, prompt });
      expect((await finished).status).toBe('done');
    }
    expect(countLines('initialize')).toBe(1);
    expect(harness!.core.procs.liveCount(threadId)).toBe(1);
    const other = await harness!.connect();
    await other.call('threads.focus', { threadId });
    await client.call('threads.focus', { threadId: null });
    const finished = other.next('turn.finished', turn => turn.threadId === threadId);
    await other.call('turns.start', { threadId, prompt: 'another viewer' });
    expect((await finished).status).toBe('done');
    expect(countLines('initialize')).toBe(1);
    other.close();
    await waitFor(() => harness!.core.procs.liveCount(threadId) === 0, 35_000);
  }, 40_000);

  test('sending while preparation is opening waits for the same process', async () => {
    const client = await startCore();
    const threadId = await codexThread(client);
    process.env['CODEX_FAKE_SLOW_START'] = '200';
    await client.call('threads.focus', { threadId });
    await waitFor(() => fakeLog().includes('thread/start'));
    const finished = client.next('turn.finished', turn => turn.threadId === threadId);
    await client.call('turns.start', { threadId, prompt: 'during startup' });
    expect((await finished).status).toBe('done');
    expect(countLines('initialize')).toBe(1);
    expect(fakeLog().split('\n').filter(line => line.startsWith('turn/start'))).toHaveLength(1);
  });

  test('a viewed selection change replaces setup without creating a turn', async () => {
    const client = await startCore();
    const threadId = await codexThread(client);
    await client.call('threads.focus', { threadId });
    await waitFor(() => fakeLog().includes('thread/start'));
    await client.call('threads.update', { threadId, permissionMode: 'bypassPermissions' });
    await waitFor(() => countLines('initialize') === 2);
    await waitFor(() => fakeLog().includes('sandbox=danger-full-access'));
    expect(harness!.core.journal.listTurns(threadId)).toHaveLength(0);
    const finished = client.next('turn.finished', turn => turn.threadId === threadId);
    await client.call('turns.start', { threadId, prompt: 'new setup' });
    expect((await finished).status).toBe('done');
    expect(countLines('initialize')).toBe(2);
    await client.call('threads.archive', { threadId });
    await waitFor(() => harness!.core.procs.liveCount(threadId) === 0);
    await client.call('threads.focus', { threadId });
    expect(countLines('initialize')).toBe(2);
  });

  test('an unsuccessful preparation leaves a later prompt able to recover', async () => {
    const client = await startCore();
    const threadId = await codexThread(client);
    process.env['CODEX_FAKE_INIT_FAILURES'] = '1';
    process.env['CODEX_FAKE_INIT_ERROR'] = 'startup failed without a retryable SQLite error';
    const failed = client.next('core.log', entry => entry.message.includes('preparing the visible conversation failed'));
    await client.call('threads.focus', { threadId });
    await waitFor(() => countLines('initialize') === 1);
    await failed;
    await waitFor(() => harness!.core.procs.liveCount(threadId) === 0);
    expect(harness!.core.journal.listTurns(threadId)).toHaveLength(0);
    delete process.env['CODEX_FAKE_INIT_ERROR'];
    delete process.env['CODEX_FAKE_INIT_FAILURES'];
    const finished = client.next('turn.finished', turn => turn.threadId === threadId);
    await client.call('turns.start', { threadId, prompt: 'recover' });
    expect((await finished).status).toBe('done');
    expect(countLines('initialize')).toBe(2);
  });

  test('archiving before lazy preparation starts cannot launch an abandoned process', async () => {
    const client = await startCore();
    const threadId = await codexThread(client);
    const contexts = harness!.core.threads.contexts;
    const make = contexts.makeSessionContext.bind(contexts);
    let archived = false;
    const setup = spyOn(contexts, 'makeSessionContext').mockImplementation((...args) => {
      const context = make(...args);
      void harness!.core.threads.archive(threadId, true);
      archived = true;
      return context;
    });
    try {
      await client.call('threads.focus', { threadId });
      await waitFor(() => archived);
      // The next RPC follows archive and the resolved preparation microtasks.
      expect((await client.call('threads.get', { threadId })).archived).toBe(true);
      expect(countLines('initialize')).toBe(0);
      expect(harness!.core.procs.liveCount(threadId)).toBe(0);
      expect(harness!.core.journal.listTurns(threadId)).toHaveLength(0);
    } finally { setup.mockRestore(); }
  });

  test('preparation honors SQLite backoff without an active turn', async () => {
    const client = await startCore();
    const threadId = await codexThread(client);
    process.env['CODEX_FAKE_INIT_FAILURES'] = '1';
    process.env['CODEX_FAKE_INIT_RPC_ERROR'] = 'exit';
    const procs = harness!.core.procs;
    const spawn = procs.spawnChild.bind(procs);
    const launches: number[] = [];
    const launch = spyOn(procs, 'spawnChild').mockImplementation((...args) => {
      if (args[0] === threadId) launches.push(performance.now());
      return spawn(...args);
    });
    let retryAt = 0;
    const log = harness!.core.log.bind(harness!.core);
    const logging = spyOn(harness!.core, 'log').mockImplementation((level, message) => {
      if (message.includes('retrying SQLite initialization')) retryAt = performance.now();
      log(level, message);
    });
    try {
      await client.call('threads.focus', { threadId });
      await waitFor(() => fakeLog().includes('thread/start'));
      expect(launches).toHaveLength(2);
      expect(retryAt).toBeGreaterThan(0);
      expect(launches[1]! - retryAt).toBeGreaterThanOrEqual(450);
      expect(harness!.core.journal.listTurns(threadId)).toHaveLength(0);
      const finished = client.next('turn.finished', turn => turn.threadId === threadId);
      await client.call('turns.start', { threadId, prompt: 'after preparation recovered' });
      expect((await finished).status).toBe('done');
      expect(countLines('initialize')).toBe(2);
    } finally { launch.mockRestore(); logging.mockRestore(); }
  });

  test('an initialize RPC error waits for late SQLite stderr and exit before retrying', async () => {
    const client = await startCore();
    const threadId = await codexThread(client);
    process.env['CODEX_FAKE_INIT_FAILURES'] = '1';
    process.env['CODEX_FAKE_INIT_RPC_ERROR'] = 'exit';
    const finished = client.next('turn.finished', turn => turn.threadId === threadId, 20000);
    await client.call('turns.start', { threadId, prompt: 'Sent once' });
    expect((await finished).status).toBe('done');
    expect(countLines('initialize')).toBe(2);
    expect(fakeLog().match(/^turn\/start /gm)).toHaveLength(1);
  });

  test('an initialize RPC error from a live process fails within a bounded wait', async () => {
    const client = await startCore();
    const threadId = await codexThread(client);
    process.env['CODEX_FAKE_INIT_FAILURES'] = '99';
    process.env['CODEX_FAKE_INIT_RPC_ERROR'] = 'live';
    const finished = client.next('turn.finished', turn => turn.threadId === threadId, 20000);
    await client.call('turns.start', { threadId, prompt: 'Never sent' });
    await waitFor(() => fakeLog().includes('initialize RPC error'), 20000);
    const waiting = performance.now();
    expect((await finished).status).toBe('error');
    expect(performance.now() - waiting).toBeLessThan(4000);
    expect(countLines('initialize')).toBe(1);
    expect(fakeLog()).not.toContain('turn/start');
    await waitFor(() => harness!.core.procs.liveCount(threadId) === 0);
  });

  test('late messages and close from a failed initialization cannot affect the recovered turn', async () => {
    const client = await startCore();
    const threadId = await codexThread(client);
    process.env['CODEX_FAKE_INIT_FAILURES'] = '1';
    const procs = harness!.core.procs;
    const spawn = procs.spawnChild.bind(procs);
    let releaseClose: (() => void) | undefined;
    let sendLateMessages: (() => void) | undefined;
    let first = true;
    const intercepted = spyOn(procs, 'spawnChild').mockImplementation((...args) => {
      const child = spawn(...args);
      if (!first) return child;
      first = false;
      sendLateMessages = () => {
        child.stdout.emit('data', `${JSON.stringify({ id: 'stale-approval', method: 'item/commandExecution/requestApproval', params: { command: 'echo stale', reason: 'old startup' } })}\n`);
        child.stdout.emit('data', `${JSON.stringify({ method: 'item/agentMessage/delta', params: { itemId: 'stale-output', delta: 'stale startup output' } })}\n`);
      };
      const emit = child.emit.bind(child);
      child.emit = (event: string | symbol, ...values: unknown[]) => {
        if (event !== 'close') return emit(event, ...values);
        // The process has exited and stderr is drained, but another inherited
        // pipe can defer close after an initialize error response was received.
        releaseClose = () => { releaseClose = undefined; child.emit = emit; emit(event, ...values); };
        queueMicrotask(() => child.stdout.emit('data', '{"id":1,"error":{"code":-32603,"message":"SQLite initialization failed"}}\n'));
        return true;
      };
      return child;
    });
    try {
      const finished = client.next('turn.finished', turn => turn.threadId === threadId, 20000);
      await client.call('turns.start', { threadId, prompt: '[slow]' });
      await waitFor(() => fakeLog().includes('waiting for interrupt'), 20000);
      expect(releaseClose).toBeDefined();
      sendLateMessages!();
      expect(await client.call('permissions.list', { threadId })).toEqual([]);
      releaseClose!();
      await client.call('turns.stop', { threadId });
      expect((await finished).status).toBe('stopped');
      expect(countLines('initialize')).toBe(2);
      expect(fakeLog().match(/^turn\/start /gm)).toHaveLength(1);
      expect(harness!.core.journal.listMessages(threadId).flatMap(message => message.parts).some(part => part.type === 'text' && part.text.includes('stale startup output'))).toBe(false);
    } finally {
      releaseClose?.();
      intercepted.mockRestore();
    }
  });

  test('SQLite initialization retries before sending a prompt and keeps the recovered session warm', async () => {
    const client = await startCore({ warmProcessMinutes: 1 });
    const threadId = await codexThread(client);
    process.env['CODEX_FAKE_INIT_FAILURES'] = '1';
    const finished = client.next('turn.finished', turn => turn.threadId === threadId, 20000);
    await client.call('turns.start', { threadId, prompt: 'First' });
    expect((await finished).status).toBe('done');
    const second = client.next('turn.finished', turn => turn.threadId === threadId, 20000);
    await client.call('turns.start', { threadId, prompt: 'Second' });
    expect((await second).status).toBe('done');
    expect(fakeLog().split('\n').filter(line => line === 'initialize')).toHaveLength(2);
    expect(fakeLog().match(/^thread\/start /gm)).toHaveLength(1);
    expect(fakeLog().match(/^turn\/start /gm)).toHaveLength(2);
    expect(harness!.core.journal.listMessages(threadId).filter(message => message.role === 'assistant').some(message => message.parts.some(part => part.type === 'error'))).toBe(false);
  });

  test.each(['close', 'RPC error'])('SQLite initialization gives up after three attempts without sending a prompt: %s', async failure => {
    const client = await startCore();
    const threadId = await codexThread(client);
    process.env['CODEX_FAKE_INIT_FAILURES'] = '99';
    if (failure === 'RPC error') process.env['CODEX_FAKE_INIT_RPC_ERROR'] = 'exit';
    const finished = client.next('turn.finished', turn => turn.threadId === threadId, 20000);
    await client.call('turns.start', { threadId, prompt: 'Never sent' });
    const turn = await finished;
    expect(turn.status).toBe('error');
    expect(turn.error).toContain('database is locked');
    expect(fakeLog().split('\n').filter(line => line === 'initialize')).toHaveLength(3);
    expect(fakeLog()).not.toContain('thread/start');
    expect(fakeLog()).not.toContain('turn/start');
    await waitFor(() => harness!.core.procs.liveCount(threadId) === 0);
  });

  test('other initialization failures are not retried', async () => {
    const client = await startCore();
    const threadId = await codexThread(client);
    process.env['CODEX_FAKE_INIT_FAILURES'] = '99';
    process.env['CODEX_FAKE_INIT_ERROR'] = 'invalid configuration';
    const finished = client.next('turn.finished', turn => turn.threadId === threadId, 20000);
    await client.call('turns.start', { threadId, prompt: 'Never sent' });
    expect((await finished).status).toBe('error');
    expect(fakeLog().split('\n').filter(line => line === 'initialize')).toHaveLength(1);
    expect(fakeLog()).not.toContain('turn/start');
  });

  test('stopping during SQLite initialization backoff prevents another process and prompt', async () => {
    const client = await startCore();
    const threadId = await codexThread(client);
    process.env['CODEX_FAKE_INIT_FAILURES'] = '99';
    const core = harness!.core;
    let stopped = false;
    const unsubscribe = core.bus.onAny((name, payload) => {
      if (name === 'core.log' && (payload as RpcEvents['core.log']).message.includes('retrying SQLite initialization')) {
        stopped = core.threads.stopTurn(threadId);
      }
    });
    const finished = client.next('turn.finished', turn => turn.threadId === threadId, 20000);
    try {
      await client.call('turns.start', { threadId, prompt: 'Never sent' });
      expect((await finished).status).toBe('stopped');
      expect(stopped).toBe(true);
      expect(fakeLog().split('\n').filter(line => line === 'initialize')).toHaveLength(1);
      expect(fakeLog()).not.toContain('turn/start');
    } finally {
      unsubscribe();
    }
  });

  test('a SQLite error after sending the prompt is not retried', async () => {
    const client = await startCore();
    const threadId = await codexThread(client);
    process.env['CODEX_FAKE_CRASH_ERROR'] = 'failed to initialize sqlite state runtime under test-home';
    const finished = client.next('turn.finished', turn => turn.threadId === threadId, 20000);
    await client.call('turns.start', { threadId, prompt: '[crash]' });
    const turn = await finished;
    expect(turn.status).toBe('error');
    expect(turn.error).toContain('failed to initialize sqlite state runtime');
    expect(fakeLog().split('\n').filter(line => line === 'initialize')).toHaveLength(1);
    expect(fakeLog().match(/^turn\/start /gm)).toHaveLength(1);
    await waitFor(() => harness!.core.procs.liveCount(threadId) === 0);
  });

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
    expect(models.find(m => m.id === 'fake-fast')?.speeds?.map(s => s.id)).toEqual(['fast', 'ultrafast']);
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

  /** Starts a turn on `prompt`, answers its one permission card, and returns what the agent said. */
  async function answerCard(
    client: CoreClient,
    threadId: string,
    prompt: string,
    decision: 'allow' | 'deny',
  ): Promise<{ request: RpcEvents['permission.requested']; text: string; permission: MessagePart | undefined }> {
    const requested = client.next('permission.requested', (request) => request.threadId === threadId, 20000);
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 20000);
    await client.call('turns.start', { threadId, prompt });
    const request = await requested;
    await client.call('permissions.answer', { requestId: request.id, decision });
    expect((await finished).status).toBe('done');
    const thread = await client.call('threads.get', { threadId });
    const parts = thread.messages[thread.messages.length - 1]?.parts ?? [];
    const text = parts.find((part) => part.type === 'text');
    return { request, text: text?.type === 'text' ? text.text : '', permission: parts.find((part) => part.type === 'permission') };
  }

  test('an MCP tool approval elicited by a server is a permission card, answered accept or decline', async () => {
    const client = await startCore();
    const threadId = await codexThread(client);

    const allowed = await answerCard(client, threadId, '[elicit]', 'allow');
    expect(allowed.request.toolName).toBe('mcp:fake-mcp');
    expect(allowed.request.input).toMatchObject({ message: 'Allow the fake tool to run?', tool_title: 'Fake tool', tool_params: { path: 'a.txt' } });
    expect(allowed.text).toBe('elicit accept');
    expect(allowed.permission).toMatchObject({ type: 'permission', toolName: 'mcp:fake-mcp', decision: 'allow' });

    const denied = await answerCard(client, threadId, '[elicit]', 'deny');
    expect(denied.text).toBe('elicit decline');
    expect(denied.permission).toMatchObject({ type: 'permission', toolName: 'mcp:fake-mcp', decision: 'deny' });
    expect(fakeLog()).toContain('elicit {"action":"accept","content":{}}');
    expect(fakeLog()).toContain('elicit {"action":"decline"}');
  });

  test('a stop during a pending elicitation cancels it', async () => {
    const client = await startCore();
    const threadId = await codexThread(client);
    const requested = client.next('permission.requested', (request) => request.threadId === threadId, 20000);
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 20000);
    await client.call('turns.start', { threadId, prompt: '[elicit][slow]' });
    await requested;
    await client.call('turns.stop', { threadId });
    expect((await finished).status).toBe('stopped');
    await waitFor(() => fakeLog().includes('elicit {"action":"cancel"}'), 3000);
  });

  test('an elicitation boite cannot show is declined without a card', async () => {
    const client = await startCore();
    const threadId = await codexThread(client);
    let cards = 0;
    client.on('permission.requested', (request) => {
      if (request.threadId === threadId) cards += 1;
    });
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 20000);
    await client.call('turns.start', { threadId, prompt: '[elicit-url]' });
    const done = await finished;
    expect(done.status).toBe('done');
    expect(cards).toBe(0);
    expect(fakeLog()).toContain('elicit-url {"action":"decline"}');
  });

  test('a permissions request is a card, granted for the turn or refused', async () => {
    const client = await startCore();
    const threadId = await codexThread(client);

    const allowed = await answerCard(client, threadId, '[permissions]', 'allow');
    expect(allowed.request.input).toMatchObject({ permissions: { network: { enabled: true } } });
    expect(allowed.request.description).toBe('the fake wants the network');
    expect(allowed.text).toBe('permissions granted');

    const denied = await answerCard(client, threadId, '[permissions]', 'deny');
    expect(denied.text).toBe('permissions refused');
    expect(fakeLog()).toContain('permissions {"permissions":{"network":{"enabled":true},"fileSystem":null},"scope":"turn"}');
    expect(fakeLog()).toContain('permissions {"permissions":{}}');
  });

  test('currentTime/read is answered in whole Unix seconds', async () => {
    const client = await startCore();
    const threadId = await codexThread(client);
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 20000);
    await client.call('turns.start', { threadId, prompt: '[time]' });
    expect((await finished).status).toBe('done');
    const thread = await client.call('threads.get', { threadId });
    expect(thread.messages[1]?.parts).toEqual([{ type: 'text', text: 'time ok' }]);
  });

  test('reasoning summary sections are kept apart, the deltas of one section are not', async () => {
    const client = await startCore();
    const threadId = await codexThread(client);
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 20000);
    await client.call('turns.start', { threadId, prompt: '[summary][thought]the answer' });
    expect((await finished).status).toBe('done');
    const thread = await client.call('threads.get', { threadId });
    expect(thread.messages[1]?.parts).toEqual([
      { type: 'thinking', text: 'thinking about it\n\n**Reading** the file\n\n**Editing** it' },
      { type: 'text', text: 'the answer' },
    ]);
  });

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
    if (process.platform === 'win32') {
      expect(memoryLimitOfJob(threadId)?.priority).toBe(0x20);
      expect(cpuRateOfGlobalJob()).toEqual({ flags: 5, rate: 7500 });
    }
    expect(await client.call('turns.stop', { threadId })).toEqual({ stopped: true });
    const done = await finished;
    expect(done.status).toBe('stopped');
    expect(done.error).toBeNull();
    expect(fakeLog()).not.toContain('turn/start');
    if (process.platform === 'win32') expect(memoryLimitOfJob(threadId)?.priority).toBe(0x4000);
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
    if (process.platform === 'win32') expect(memoryLimitOfJob(warmThread)?.priority).toBe(0x4000);
    await runTurn(warmClient, warmThread, 'second');
    expect(warm.started).toHaveLength(1);
    expect(warm.exited).toHaveLength(0);
    if (process.platform === 'win32') expect(memoryLimitOfJob(warmThread)?.priority).toBe(0x4000);
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
    await keepTitle(client, thread.id);
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

    // One startup fails before a third prompt resumes the same native thread.
    process.env['CODEX_FAKE_INIT_FAILURES'] = '3';
    await runTurn(client, threadId, 'third');
    expect(countLines('initialize')).toBe(4);
    expect(countLines('turn/start model=fake-codex effort=')).toBe(3);
    expect(fakeLog().split('\n').filter(line => line.startsWith(`thread/resume ${sessionId} `))).toHaveLength(2);
    expect((await client.call('threads.get', { threadId })).sessionId).toBe(sessionId);
  });

  test('a moved thread resumes its codex session in the new folder, told where it went', async () => {
    const client = await startCore();
    const threadId = await codexThread(client);
    await runTurn(client, threadId, 'first');
    const sessionId = (await client.call('threads.get', { threadId })).sessionId ?? '';
    expect(sessionId).not.toBe('');

    const path = join(harness!.dataDir, 'elsewhere');
    mkdirSync(path, { recursive: true });
    const target = await client.call('projects.add', { path, name: 'elsewhere' });
    const moved = await client.call('threads.move', { threadId, projectId: target.id });
    expect(moved).toMatchObject({ cwd: path, sessionId });

    await runTurn(client, threadId, 'second');
    // The warm process was started in the old folder: a new one resumes the same thread with the new cwd.
    await waitFor(() => fakeLog().includes(`thread/resume ${sessionId} `));
    expect(fakeLog()).toContain(`cwd=${path}`);
    expect(countLines('initialize')).toBe(2);
    expect((await client.call('threads.get', { threadId })).sessionId).toBe(sessionId);
    const prompt = harness!.core.threads.get(threadId).messages.filter((message) => message.role === 'user').at(-1)?.parts[0];
    expect(prompt?.type === 'text' ? prompt.moved?.to.cwd : null).toBe(path);
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

  test('a stop that lands while a lost thread resumes ends the turn stopped and starts nothing fresh', async () => {
    const client = await startCore({ warmProcessMinutes: 0 });
    const threadId = await codexThread(client);
    await runTurn(client, threadId, 'remember the word pelican');
    const lost = (await client.call('threads.get', { threadId })).sessionId ?? '';
    expect(lost).not.toBe('');

    process.env['CODEX_FAKE_LOST'] = '1';
    process.env['CODEX_FAKE_SLOW_START'] = '800';
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 15000);
    await client.call('turns.start', { threadId, prompt: 'expensive prompt' });
    await waitFor(() => fakeLog().includes(`thread/resume ${lost} `));
    expect(await client.call('turns.stop', { threadId })).toEqual({ stopped: true });
    const done = await finished;
    expect(done.status).toBe('stopped');
    expect(done.error).toBeNull();
    // The resume was refused and nothing followed it: no fresh process, thread or prompt.
    const log = fakeLog();
    const afterResume = log.slice(log.indexOf('thread/resume'));
    expect(afterResume).not.toContain('initialize');
    expect(afterResume).not.toContain('thread/start');
    expect(afterResume).not.toContain('turn/start');
    const stopped = await client.call('threads.get', { threadId });
    expect(stopped.messages.flatMap((message) => message.parts).some((part) => part.type === 'error')).toBe(false);
    // The lost id goes all the same: the next prompt opens a fresh thread with the history.
    expect(stopped.sessionId).toBeNull();
    expect(stopped.sessionGeneration).toBe(1);

    delete process.env['CODEX_FAKE_SLOW_START'];
    await runTurn(client, threadId, 'which word?');
    expect(countLines('initialize')).toBe(3);
    const thread = await client.call('threads.get', { threadId });
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

  test('the first turn is titled on an ephemeral read-only thread, on the small model at low effort', async () => {
    const client = await startCore();
    const { projectId, accountId } = await codexAccount(client);
    const thread = await client.call('threads.create', {
      projectId,
      providerId: 'codex-fake',
      accountId,
      title: 'remember the word pelican',
      model: 'fake-codex',
    });
    await client.call('threads.subscribe', { threadId: thread.id });
    const titled = client.next(
      'thread.updated',
      (summary) => summary.id === thread.id && summary.titleSource === 'agent',
      20000,
    );
    await runTurn(client, thread.id, 'remember the word pelican');

    // The core's one cleaning rule: quotes and the closing period go.
    expect((await titled).title).toBe('Pelican notes');
    // No small model was listed by a probe, so the first of Codex's picks goes out.
    expect(fakeLog()).toContain('thread/start approvalPolicy=never sandbox=read-only model=gpt-6-luna ephemeral');
    expect(fakeLog()).toContain('turn/start model=gpt-6-luna effort=low');
    // Its app-server is gone with the answer, traced under the thread.
    await waitFor(() => harness?.core.procs.liveCount(thread.id) === 0);
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

describe('codex hooks', () => {
  test('a prompt a hook refused shows why in the thread, and a hook Codex skips is reported once', async () => {
    process.env['CODEX_FAKE_HOOKS'] = '1';
    const client = await startCore();
    const threadId = await codexThread(client);
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 10000);
    await client.call('turns.start', { threadId, prompt: '[hook-block]' });
    expect((await finished).status).toBe('done');
    await waitFor(() => fakeLog().includes('hooks/list'));

    const thread = await client.call('threads.get', { threadId });
    expect(thread.messages.at(-1)?.parts).toEqual([
      { type: 'hook', event: 'userPromptSubmit', outcome: 'blocked', message: 'blocked by test hook' },
    ]);
    await waitFor(() => harness!.core.hooks.status().recent.length === 2);
    const status = await client.call('hooks.status', {});
    expect(status.providers.find((provider) => provider.providerId === 'codex-fake'))
      .toMatchObject({ runs: 1, blocked: 1, failed: 0, skipped: 1 });
    expect(status.recent.map((run) => [run.event, run.outcome])).toEqual(
      expect.arrayContaining([['userPromptSubmit', 'blocked'], ['preToolUse', 'skipped']]),
    );
    expect(status.recent.find((run) => run.outcome === 'skipped')?.message).toContain('not reviewed yet');

    // No warm process in tests: the next turn starts a second one, which asks again and adds nothing.
    const again = client.next('turn.finished', (turn) => turn.threadId === threadId, 10000);
    await client.call('turns.start', { threadId, prompt: 'hello' });
    expect((await again).status).toBe('done');
    await waitFor(() => fakeLog().split('hooks/list').length === 3);
    expect((await client.call('hooks.status', {})).recent).toHaveLength(2);
  });
});


test('connection checks refresh Codex auth and never mistake models for a login', async () => {
  const client = await startCore();
  const { accountId } = await codexAccount(client);
  const checked = await client.call('accounts.check', { accountId, refresh: true });
  expect(checked.status).toBe('unauthenticated');
  expect(checked.identity).toBeNull();
  expect(fakeLog()).toContain('account/read refresh=true');
  expect(fakeLog()).not.toContain('model/list');
});


test('Codex device login keeps its code, checks the completed login and returns the email', async () => {
  const client = await startCore();
  await codexAccount(client);
  harness!.core.providers.require('codex-fake').login = { command: ['unused-cli-login'] };
  const { id: accountId } = await client.call('accounts.add', { providerId: 'codex-fake', label: 'Isolated' });
  const link = client.next('account.login', event => event.accountId === accountId && event.url !== null);
  const finished = client.next('account.login', event => event.accountId === accountId && event.state !== 'running');
  await client.call('accounts.login', { accountId });
  expect((await link).output).toContain('TEST-CODE');
  expect((await client.call('accounts.logins', {}))[0]?.output).toContain('TEST-CODE');
  expect((await finished).state).toBe('done');
  expect(harness!.core.accounts.require(accountId)).toMatchObject({ status: 'ok', identity: 'work@example.com' });
  expect(fakeLog()).toContain('account/login/start chatgptDeviceCode');
  expect(fakeLog()).toContain('account/read refresh=true');
  expect(harness!.core.providers.installs.leaseCount('codex-fake')).toBe(0);
});

test('cancelling a Codex device login closes its process and releases the install', async () => {
  process.env['CODEX_FAKE_LOGIN_WAIT'] = '1';
  const client = await startCore();
  await codexAccount(client);
  harness!.core.providers.require('codex-fake').login = { command: ['unused-cli-login'] };
  const { id: accountId } = await client.call('accounts.add', { providerId: 'codex-fake', label: 'Isolated' });
  const link = client.next('account.login', event => event.accountId === accountId && event.url !== null);
  await client.call('accounts.login', { accountId });
  await link;
  await client.call('accounts.loginCancel', { accountId });
  expect(await client.call('accounts.logins', {})).toEqual([]);
  expect(harness!.core.procs.liveCount(`login:${accountId}`)).toBe(0);
  expect(harness!.core.providers.installs.leaseCount('codex-fake')).toBe(0);
});
