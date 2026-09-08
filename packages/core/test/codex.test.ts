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

let harness: TestCore | null = null;
let logFile = '';

afterEach(async () => {
  const open = harness;
  harness = null;
  delete process.env['CODEX_FAKE_LOG'];
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
        images: false,
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

/** Everything the core logged on this connection, as `<level> <message>` lines. */
function collectLogs(client: CoreClient): string[] {
  const lines: string[] = [];
  client.on('core.log', (entry) => {
    lines.push(`${entry.level} ${entry.message}`);
  });
  return lines;
}

describe('codex driver', () => {
  test('getDriver returns the codex driver', () => {
    expect(getDriver('codex-appserver').protocol).toBe('codex-appserver');
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

    expect(await client.call('turns.stop', { threadId })).toEqual({ stopped: true });
    expect((await finished).status).toBe('stopped');
    await exited;

    expect(fakeLog()).toContain('turn/interrupt codex-fake-turn-1');
    await waitFor(() => harness?.core.procs.liveCount(threadId) === 0);
    const trace = await client.call('trace.get', { threadId });
    expect(trace).toHaveLength(1);
    expect(trace[0]?.exitedAt).not.toBeNull();
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

  test('a free-form question is refused and the turn still ends', async () => {
    const client = await startCore();
    const threadId = await codexThread(client);
    const logs = collectLogs(client);

    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 20000);
    await client.call('turns.start', { threadId, prompt: '[input]' });

    const done = await finished;
    expect(done.status).toBe('done');
    const thread = await client.call('threads.get', { threadId });
    const parts = thread.messages[thread.messages.length - 1]?.parts ?? [];
    const text = parts.find((part) => part.type === 'text');
    expect(text?.type === 'text' ? text.text : '').toBe('input refused');
    await waitFor(() =>
      logs.some((line) => line.includes('the agent asked the user a free-form question, which Boite refuses')),
    );
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
