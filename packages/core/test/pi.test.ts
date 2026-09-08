import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'bun:test';
import type { MessagePart, RpcEvents, Settings } from '@boite/contracts';
import type { CoreClient } from '../src/client.ts';
import { getDriver } from '../src/drivers/index.ts';
import { startTestCore, waitFor } from './harness.ts';
import type { TestCore } from './harness.ts';

/** The fake pi in RPC mode: a real JSON-lines process over stdio, run by bun. */
const FAKE_AGENT = fileURLToPath(new URL('./fixtures/pi-agent.ts', import.meta.url));

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

/** A user descriptor for the fake agent: `protocol: "pi"`, launched as `bun <fixture>`. */
function writeDescriptor(dataDir: string): void {
  const dir = join(dataDir, 'providers');
  mkdirSync(dir, { recursive: true });
  const profile = {
    detect: {},
    executable: [{ kind: 'path', value: 'bun' }],
    launch: { args: [FAKE_AGENT] },
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
        images: false,
        planMode: false,
        resume: true,
      },
    }),
    'utf8',
  );
}

async function piAccount(client: CoreClient): Promise<{ dataDir: string; projectId: string; accountId: string }> {
  const dataDir = harness?.dataDir ?? '';
  writeDescriptor(dataDir);
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

  test('an extension dialog is refused and the turn still ends', async () => {
    const client = await startCore();
    const threadId = await piThread(client);
    const logs = collectLogs(client);

    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 20000);
    await client.call('turns.start', { threadId, prompt: '[ask]' });

    const done = await finished;
    expect(done.status).toBe('done');
    const thread = await client.call('threads.get', { threadId });
    const parts = thread.messages[thread.messages.length - 1]?.parts ?? [];
    const text = parts.find((part) => part.type === 'text');
    expect(text?.type === 'text' ? text.text : '').toBe('dialog cancelled');
    await waitFor(() =>
      logs.some((line) => line.includes('an extension asked the user a confirm, which Boite refuses')),
    );
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
