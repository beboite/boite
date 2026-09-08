import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'bun:test';
import type { MessagePart, RpcEvents, Settings } from '@boite/contracts';
import type { CoreClient } from '../src/client.ts';
import { getDriver } from '../src/drivers/index.ts';
import { startTestCore, waitFor } from './harness.ts';
import type { TestCore } from './harness.ts';

/** The fake ACP agent: a real ACP process over stdio, run by bun. */
const FAKE_AGENT = fileURLToPath(new URL('./fixtures/acp-agent.ts', import.meta.url));

let harness: TestCore | null = null;
let logFile = '';

afterEach(async () => {
  const open = harness;
  harness = null;
  delete process.env['ACP_FAKE_LOG'];
  if (open !== null) await open.stop();
});

async function startCore(settings?: Partial<Settings>): Promise<CoreClient> {
  const started = await startTestCore(settings === undefined ? {} : { settings });
  harness = started;
  logFile = join(started.dataDir, 'acp-fake.log');
  // `spawnChild` gets `process.env` plus the account environment, so this is
  // what reaches the fake agent.
  process.env['ACP_FAKE_LOG'] = logFile;
  return started.connect();
}

function fakeLog(): string {
  return existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
}

/** A user descriptor for the fake agent: `protocol: "acp"`, launched as `bun <fixture>`. */
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
    join(dir, 'acp-fake.json'),
    JSON.stringify({
      id: 'acp-fake',
      schemaVersion: 1,
      name: 'Fake ACP agent',
      shortName: 'AcpFake',
      protocol: 'acp',
      roots: ['{isolationDir}'],
      profiles: { windows: profile, linux: profile, macos: profile },
      auth: { kind: 'none' },
      models: [
        { id: 'fake-fast', name: 'Fast', default: true },
        { id: 'fake-smart', name: 'Smart' },
      ],
      capabilities: {
        approvals: true,
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

async function acpThread(client: CoreClient, model?: string): Promise<string> {
  const dataDir = harness?.dataDir ?? '';
  writeDescriptor(dataDir);
  const loaded = await client.call('providers.reload', {});
  expect(loaded.rejected).toEqual([]);
  expect(loaded.loaded.some((provider) => provider.id === 'acp-fake' && provider.available)).toBe(true);

  const project = await client.call('projects.add', { path: dataDir, name: 'acp' });
  const account = await client.call('accounts.add', {
    providerId: 'acp-fake',
    label: 'Fake',
    useDefaultLocation: true,
  });
  const thread = await client.call('threads.create', {
    projectId: project.id,
    providerId: 'acp-fake',
    accountId: account.id,
    title: 'acp thread',
    ...(model === undefined ? {} : { model }),
  });
  await client.call('threads.subscribe', { threadId: thread.id });
  return thread.id;
}

describe('acp driver', () => {
  test('getDriver returns the acp driver', () => {
    expect(getDriver('acp').protocol).toBe('acp');
  });

  test('a plain prompt streams back as one text part, and the session id is kept', async () => {
    const client = await startCore();
    const threadId = await acpThread(client);

    const deltas: string[] = [];
    client.on('message.delta', (event) => {
      if (event.threadId === threadId) deltas.push(event.text);
    });

    const prompt = 'the fake acp agent echoes this back';
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 20000);
    await client.call('turns.start', { threadId, prompt });

    const done = await finished;
    expect(done.error).toBeNull();
    expect(done.status).toBe('done');
    // The agent sent three chunks; the journal coalesces them per thread every
    // 16 ms, so what a client sees is one or more deltas, never a whole part.
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.join('')).toBe(prompt);

    const thread = await client.call('threads.get', { threadId });
    expect(thread.sessionId).toMatch(/^acp-fake-/);
    expect(thread.messages[1]?.parts).toEqual([{ type: 'text', text: prompt }]);
  });

  test('a tool call arrives running, then done with its output', async () => {
    const client = await startCore();
    const threadId = await acpThread(client);

    const parts: MessagePart[] = [];
    client.on('message.part', (event) => {
      if (event.threadId === threadId) parts.push(event.part);
    });

    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 20000);
    await client.call('turns.start', { threadId, prompt: '[tool]' });
    expect((await finished).status).toBe('done');

    const tools = parts.filter((part) => part.type === 'tool');
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({ toolId: 'fake-1', name: 'fake_tool', status: 'running', output: null });
    expect(tools[1]).toMatchObject({ toolId: 'fake-1', name: 'fake_tool', status: 'done', output: 'ok' });
  });

  test('a permission is asked, answered, and the answer reaches the agent', async () => {
    const client = await startCore();
    const threadId = await acpThread(client);

    const allowed = await answerPermission(client, threadId, 'allow');
    expect(allowed.status).toBe('done');
    expect(allowed.text).toBe('allowed');
    expect(allowed.permission).toMatchObject({ type: 'permission', toolName: 'fake_tool', decision: 'allow' });

    const denied = await answerPermission(client, threadId, 'deny');
    expect(denied.status).toBe('done');
    expect(denied.text).toBe('denied');
    expect(denied.permission).toMatchObject({ type: 'permission', toolName: 'fake_tool', decision: 'deny' });
  });

  async function answerPermission(
    client: CoreClient,
    threadId: string,
    decision: 'allow' | 'deny',
  ): Promise<{ status: string; text: string; permission: MessagePart | undefined }> {
    const requested = client.next('permission.requested', (request) => request.threadId === threadId, 20000);
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 20000);
    await client.call('turns.start', { threadId, prompt: '[permission]' });

    const request = await requested;
    expect(request.toolName).toBe('fake_tool');
    expect(request.input).toEqual({ echo: true });
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
    };
  }

  test('the turn usage carries the agent tokens and the USD cost it reported', async () => {
    const client = await startCore();
    const threadId = await acpThread(client);

    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 20000);
    await client.call('turns.start', { threadId, prompt: '[usage]' });

    const done = await finished;
    expect(done.status).toBe('done');
    expect(done.usage).toEqual({
      inputTokens: 8,
      outputTokens: 4,
      cacheReadTokens: 2,
      cacheWriteTokens: 0,
      costUsdEquivalent: 0.0042,
    });
  });

  test('stopping a turn cancels the session and the agent process is gone', async () => {
    const client = await startCore();
    const threadId = await acpThread(client);

    const started = client.next('process.started', (record) => record.threadId === threadId, 20000);
    const exited = client.next('process.exited', (record) => record.threadId === threadId, 20000);
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 20000);
    await client.call('turns.start', { threadId, prompt: '[slow]' });
    await started;

    expect(await client.call('turns.stop', { threadId })).toEqual({ stopped: true });
    expect((await finished).status).toBe('stopped');
    await exited;

    await waitFor(() => harness?.core.procs.liveCount(threadId) === 0);
    const trace = await client.call('trace.get', { threadId });
    expect(trace).toHaveLength(1);
    expect(trace[0]?.exitedAt).not.toBeNull();
  });

  test('a refusal ends the turn on an error naming the stop reason', async () => {
    const client = await startCore();
    const threadId = await acpThread(client);

    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 20000);
    await client.call('turns.start', { threadId, prompt: '[refuse]' });

    const done = await finished;
    expect(done.status).toBe('error');
    expect(done.error).toBe('the agent stopped: refusal');
  });

  test('an agent that dies fails the turn with its exit code and stderr, and the next turn works', async () => {
    const client = await startCore();
    const threadId = await acpThread(client);

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

  test('a warm thread keeps one agent process for two turns, a cold one starts a second', async () => {
    const warmClient = await startCore({ warmProcessMinutes: 5 });
    const warmThread = await acpThread(warmClient);
    const warm = countProcesses(warmClient, warmThread);
    await runTurn(warmClient, warmThread, 'first');
    expect(warm.started).toHaveLength(1);
    expect(warm.exited).toHaveLength(0);
    await runTurn(warmClient, warmThread, 'second');
    expect(warm.started).toHaveLength(1);
    expect(warm.exited).toHaveLength(0);
    await harness?.stop();
    harness = null;

    const coldClient = await startCore({ warmProcessMinutes: 0 });
    const coldThread = await acpThread(coldClient);
    const cold = countProcesses(coldClient, coldThread);
    await runTurn(coldClient, coldThread, 'first');
    await runTurn(coldClient, coldThread, 'second');
    expect(cold.started).toHaveLength(2);
  });

  test('the thread model becomes a config option, and a dropped session is loaded back', async () => {
    const client = await startCore({ warmProcessMinutes: 0 });
    const threadId = await acpThread(client, 'fake-smart');

    await runTurn(client, threadId, 'first');
    const first = await client.call('threads.get', { threadId });
    const sessionId = first.sessionId ?? '';
    expect(sessionId).not.toBe('');
    await waitFor(() => fakeLog().includes('set_config_option model fake-smart'));

    // The session went with the turn, so the second one resumes through session/load.
    await runTurn(client, threadId, 'second');
    await waitFor(() => fakeLog().includes(`loaded:${sessionId}`));
    expect((await client.call('threads.get', { threadId })).sessionId).toBe(sessionId);
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
