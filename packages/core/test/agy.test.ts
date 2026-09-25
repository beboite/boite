/**
 * The agy driver on a fake Antigravity CLI that speaks the real stream-json
 * print mode (`fixtures/agy-agent.ts`): the text, the tools, the usage and the
 * context meter of a turn, an ERROR result, a stop, a crash, the resume of a
 * conversation by a later process, the warm process, the permission flags, the
 * `agy models` probe with its effort grouping, and the refusals.
 */
import shippedAgy from '../src/providers/shipped/antigravity-cli.json';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'bun:test';
import type { MessagePart, PermissionMode, Settings } from '@boite/contracts';
import type { CoreClient } from '../src/client.ts';
import { getDriver } from '../src/drivers/index.ts';
import { modelsFromListing, parseModelLines } from '../src/drivers/agy.ts';
import { browserNoopPath } from '../src/paths.ts';
import { startTestCore, waitFor } from './harness.ts';
import type { TestCore } from './harness.ts';

/** The fake agy: a real stream-json process over stdio, run by bun. */
const FAKE_AGENT = fileURLToPath(new URL('./fixtures/agy-agent.ts', import.meta.url));

let harness: TestCore | null = null;
let logFile = '';

afterEach(async () => {
  const open = harness;
  harness = null;
  delete process.env['AGY_FAKE_LOG'];
  delete process.env['AGY_FAKE_SIGNED_OUT'];
  delete process.env['AGY_FAKE_MODELS_DELAY_MS'];
  if (open !== null) await open.stop();
});

async function startCore(settings?: Partial<Settings>): Promise<CoreClient> {
  const started = await startTestCore(settings === undefined ? {} : { settings });
  harness = started;
  logFile = join(started.dataDir, 'agy-fake.log');
  // `spawnChild` gets `process.env` plus the account environment, so this is
  // what reaches the fake.
  process.env['AGY_FAKE_LOG'] = logFile;
  return started.connect();
}

function fakeLog(): string {
  return existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
}

function linesStarting(prefix: string): string[] {
  return fakeLog()
    .split('\n')
    .filter((line) => line.startsWith(prefix));
}

/** One `argv ...` line per conversation process the fake started. */
function argvLines(): string[] {
  return linesStarting('argv ');
}

/** The shipped descriptor's shape, launched as `bun <fixture>` instead of `agy`. */
function writeDescriptor(dataDir: string): void {
  const dir = join(dataDir, 'providers');
  mkdirSync(dir, { recursive: true });
  const profile = {
    detect: {},
    executable: [{ kind: 'path', value: 'bun' }],
    launch: { args: [FAKE_AGENT] },
    isolation: {},
    // The shipped environment, so a variable it drops shows up here.
    env: shippedAgy.profiles.windows.env,
    close: { processes: [] },
  };
  writeFileSync(
    join(dir, 'agy-fake.json'),
    JSON.stringify({
      id: 'agy-fake',
      schemaVersion: 1,
      name: 'Fake agy',
      shortName: 'AgyFake',
      protocol: 'agy',
      roots: ['{home}/.gemini/antigravity-cli'],
      profiles: { windows: profile, linux: profile, macos: profile },
      auth: { kind: 'none' },
      models: [{ id: 'default', name: 'Antigravity CLI default', default: true }],
      capabilities: {
        approvals: false,
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

async function agyAccount(client: CoreClient): Promise<{ dataDir: string; projectId: string; accountId: string }> {
  const dataDir = harness?.dataDir ?? '';
  writeDescriptor(dataDir);
  const loaded = await client.call('providers.reload', {});
  expect(loaded.rejected).toEqual([]);
  expect(loaded.loaded.some((provider) => provider.id === 'agy-fake' && provider.available)).toBe(true);
  const project = await client.call('projects.add', { path: dataDir, name: 'agy' });
  const account = await client.call('accounts.add', { providerId: 'agy-fake', label: 'Fake', useDefaultLocation: true });
  return { dataDir, projectId: project.id, accountId: account.id };
}

async function agyThread(
  client: CoreClient,
  options: { model?: string; effort?: string; permissionMode?: PermissionMode; probe?: boolean } = {},
): Promise<{ threadId: string; accountId: string }> {
  const { projectId, accountId } = await agyAccount(client);
  if (options.probe === true) await client.call('providers.probe', { providerId: 'agy-fake', accountId });
  const thread = await client.call('threads.create', {
    projectId,
    providerId: 'agy-fake',
    accountId,
    title: 'agy thread',
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.effort === undefined ? {} : { effort: options.effort }),
    ...(options.permissionMode === undefined ? {} : { permissionMode: options.permissionMode }),
  });
  await client.call('threads.subscribe', { threadId: thread.id });
  return { threadId: thread.id, accountId };
}

async function runTurn(client: CoreClient, threadId: string, prompt: string): Promise<{ status: string; error: string | null }> {
  const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 20000);
  await client.call('turns.start', { threadId, prompt });
  return finished;
}

describe('agy driver', () => {
  test('getDriver returns the agy driver', () => {
    expect(getDriver('agy').protocol).toBe('agy');
  });

  test('a prompt streams back as one text part, with the usage, the context and the conversation id', async () => {
    const client = await startCore();
    const { threadId } = await agyThread(client);
    const deltas: string[] = [];
    client.on('message.delta', (event) => {
      if (event.threadId === threadId) deltas.push(event.text);
    });

    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 20000);
    await client.call('turns.start', { threadId, prompt: 'hello there agy' });
    const done = await finished;
    expect(done.error).toBeNull();
    expect(done.status).toBe('done');
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.join('')).toBe('hello there agy');
    // input excludes the cache reads; thinking counts as output.
    expect(done.usage).toEqual({ inputTokens: 10, outputTokens: 6, cacheReadTokens: 6, cacheWriteTokens: 0, costUsdEquivalent: null });

    const thread = await client.call('threads.get', { threadId });
    expect(thread.sessionId).toMatch(/^conv-[0-9a-f-]{36}$/);
    expect(thread.messages[1]?.parts).toEqual([{ type: 'text', text: 'hello there agy' }]);
    expect(thread.context).toMatchObject({ tokens: 20, window: null, breakdown: { input: 10, cache: 6, output: 4 } });
    expect(argvLines()).toEqual(['argv conversation=new model=configured mode=default skip=false stream=true']);
    // The browser the CLI would open for a sign-in is the no-op, never a window.
    expect(linesStarting('env BROWSER=')).toEqual([`env BROWSER=${browserNoopPath(harness?.dataDir ?? '')}`]);
    // agy's own updater spawns a detached `agy --version` that opens a console window.
    expect(linesStarting('env AGY_CLI_DISABLE_AUTO_UPDATE=')).toEqual(['env AGY_CLI_DISABLE_AUTO_UPDATE=true']);
  });

  test('a tool step is one part, running then done, between the two answers, and usage adds both', async () => {
    const client = await startCore();
    const { threadId } = await agyThread(client);
    const parts: MessagePart[] = [];
    client.on('message.part', (event) => {
      if (event.threadId === threadId) parts.push(event.part);
    });

    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 20000);
    await client.call('turns.start', { threadId, prompt: '[tool]' });
    const done = await finished;
    expect(done.status).toBe('done');
    expect(done.usage).toEqual({ inputTokens: 13, outputTokens: 12, cacheReadTokens: 26, cacheWriteTokens: 0, costUsdEquivalent: null });

    const tools = parts.filter((part) => part.type === 'tool');
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({ name: 'run_command', status: 'running', output: null, input: { CommandLine: 'echo hi' } });
    // The finished step carries what the command printed.
    expect(tools[1]).toMatchObject({ name: 'run_command', status: 'done', output: 'hi\n' });
    // agy's print mode works in its own scratch directory unless the thread's is named.
    expect(fakeLog()).toContain(`workspace ${(await client.call('threads.get', { threadId })).cwd}`);
    expect(tools[0]?.type === 'tool' && tools[1]?.type === 'tool' && tools[0].toolId === tools[1].toolId).toBe(true);

    const thread = await client.call('threads.get', { threadId });
    const answer = thread.messages[1]?.parts ?? [];
    expect(answer.map((part) => part.type)).toEqual(['text', 'tool', 'text']);
    expect(answer[0]).toEqual({ type: 'text', text: 'checking' });
    expect(answer[2]).toEqual({ type: 'text', text: 'checked' });
    // The meter reads the last request of the turn, not the sum.
    expect(thread.context).toMatchObject({ tokens: 28, breakdown: { input: 3, cache: 20, output: 5 } });
  });

  test('a tool step that fails is an error card with the message agy gave', async () => {
    const client = await startCore();
    const { threadId } = await agyThread(client);
    expect((await runTurn(client, threadId, '[toolerror]')).status).toBe('done');
    const thread = await client.call('threads.get', { threadId });
    const tool = thread.messages[1]?.parts.find((part) => part.type === 'tool');
    expect(tool).toMatchObject({ status: 'error', output: 'the command was denied' });
  });

  test('an ERROR result fails the turn with its message, and the process takes the next turn', async () => {
    const client = await startCore({ warmProcessMinutes: 5 });
    const { threadId } = await agyThread(client);
    const failed = await runTurn(client, threadId, '[error]');
    expect(failed.status).toBe('error');
    expect(failed.error).toBe('the quota is exhausted');
    expect((await runTurn(client, threadId, 'after')).status).toBe('done');
    expect(argvLines()).toHaveLength(1);
  });

  test('a turn that streamed nothing shows the answer the result carries', async () => {
    const client = await startCore();
    const { threadId } = await agyThread(client);
    expect((await runTurn(client, threadId, '[silent]')).status).toBe('done');
    const thread = await client.call('threads.get', { threadId });
    expect(thread.messages[1]?.parts).toEqual([{ type: 'text', text: 'from the result' }]);
  });

  test('a stop kills the process tree, and the next turn resumes the conversation', async () => {
    const client = await startCore();
    const { threadId } = await agyThread(client);
    await runTurn(client, threadId, 'first');
    const sessionId = (await client.call('threads.get', { threadId })).sessionId ?? '';

    const started = client.next('process.started', (record) => record.threadId === threadId, 20000);
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 20000);
    await client.call('turns.start', { threadId, prompt: '[slow]' });
    await started;
    await waitFor(() => linesStarting('prompt [slow]').length === 1);
    expect(await client.call('turns.stop', { threadId })).toEqual({ stopped: true });
    expect((await finished).status).toBe('stopped');
    await waitFor(() => harness?.core.procs.liveCount(threadId) === 0);

    expect((await runTurn(client, threadId, 'again')).status).toBe('done');
    expect(argvLines()).toHaveLength(3);
    expect(argvLines()[1]).toContain(`conversation=${sessionId}`);
    expect(argvLines()[2]).toContain(`conversation=${sessionId}`);
    expect((await client.call('threads.get', { threadId })).sessionId).toBe(sessionId);
  });

  test('an agent that dies fails the turn with its exit code and stderr, and the next turn works', async () => {
    const client = await startCore();
    const { threadId } = await agyThread(client);
    const failure = await runTurn(client, threadId, '[crash]');
    expect(failure.status).toBe('error');
    expect(failure.error).toContain('exited with code 3');
    expect(failure.error).toContain('boom');
    expect((await runTurn(client, threadId, 'still here')).status).toBe('done');
  });

  test('cold, each turn is a process of its own that resumes the conversation', async () => {
    const client = await startCore();
    const { threadId } = await agyThread(client);
    await runTurn(client, threadId, 'first');
    const sessionId = (await client.call('threads.get', { threadId })).sessionId ?? '';
    await runTurn(client, threadId, 'second');
    expect(argvLines()).toHaveLength(2);
    expect(argvLines()[0]).toContain('conversation=new');
    expect(argvLines()[1]).toContain(`conversation=${sessionId}`);
    // The first process was told it was done, and left on its own.
    expect(linesStarting('stdin closed').length).toBeGreaterThanOrEqual(1);
  });

  test('warm, two turns share one process and one stdin', async () => {
    const client = await startCore({ warmProcessMinutes: 5 });
    const { threadId } = await agyThread(client);
    await runTurn(client, threadId, 'first');
    await runTurn(client, threadId, 'second');
    expect(argvLines()).toHaveLength(1);
    expect(linesStarting('prompt ')).toEqual(['prompt first', 'prompt second']);
    expect(harness?.core.procs.liveCount(threadId)).toBe(1);
  });

  test('the permission mode is a launch flag, and a change starts a process on the same conversation', async () => {
    const client = await startCore({ warmProcessMinutes: 5 });
    const { threadId } = await agyThread(client, { permissionMode: 'plan' });
    await runTurn(client, threadId, 'first');
    const sessionId = (await client.call('threads.get', { threadId })).sessionId ?? '';
    for (const [mode, expected] of [
      ['acceptEdits', 'mode=accept-edits skip=false'],
      ['bypassPermissions', 'mode=default skip=true'],
      ['dontAsk', 'mode=default skip=true'],
      ['default', 'mode=default skip=false'],
    ] as const) {
      await client.call('threads.update', { threadId, permissionMode: mode });
      await runTurn(client, threadId, mode);
      expect(argvLines().at(-1)).toContain(expected);
      expect(argvLines().at(-1)).toContain(`conversation=${sessionId}`);
    }
    expect(argvLines()[0]).toContain('mode=plan skip=false');
  });

  test('the probe groups the reasoning variants into one model with an effort scale', async () => {
    const client = await startCore();
    const { accountId } = await agyAccount(client);
    const result = await client.call('providers.probe', { providerId: 'agy-fake', accountId });
    expect(result.models).toEqual([
      { id: 'default', name: 'Antigravity CLI default', default: true },
      {
        id: 'gemini-3.8-flash',
        name: 'Gemini 3.8 Flash',
        default: false,
        effort: {
          levels: [
            { id: 'low', label: 'Low' },
            { id: 'medium', label: 'Medium' },
            { id: 'high', label: 'High' },
          ],
          default: 'medium',
        },
      },
      {
        id: 'gemini-3.1-pro',
        name: 'Gemini 3.1 Pro',
        default: false,
        effort: {
          levels: [
            { id: 'low', label: 'Low' },
            { id: 'high', label: 'High' },
          ],
          default: 'high',
        },
      },
      { id: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6 (Thinking)', default: false },
      { id: 'gemini-solo-high', name: 'Gemini Solo (High)', default: false },
    ]);
    // Cached, and nothing is left running under the probe's thread.
    await client.call('providers.probe', { providerId: 'agy-fake', accountId });
    expect(linesStarting('models')).toHaveLength(1);
    expect(linesStarting('probe env ')).toEqual(['probe env AGY_CLI_DISABLE_AUTO_UPDATE=true']);
    await waitFor(() => harness?.core.procs.liveCount(`probe:agy-fake:${accountId}`) === 0);
  });

  test('a grouped model goes out as the variant its effort names, or its default level', async () => {
    const client = await startCore();
    const { threadId, accountId } = await agyThread(client, { model: 'gemini-3.8-flash', effort: 'low', probe: true });
    await runTurn(client, threadId, 'first');
    expect(argvLines().at(-1)).toContain('model=gemini-3.8-flash-low');

    await client.call('threads.update', { threadId, effort: null });
    await runTurn(client, threadId, 'second');
    expect(argvLines().at(-1)).toContain('model=gemini-3.8-flash-medium');

    await client.call('threads.update', { threadId, model: 'gemini-3.1-pro', effort: null });
    await runTurn(client, threadId, 'third');
    expect(argvLines().at(-1)).toContain('model=gemini-3.1-pro-high');

    await client.call('threads.update', { threadId, model: 'claude-opus-4-6-thinking', effort: null });
    await runTurn(client, threadId, 'fourth');
    expect(argvLines().at(-1)).toContain('model=claude-opus-4-6-thinking');

    await client.call('threads.update', { threadId, model: 'default', effort: null });
    await runTurn(client, threadId, 'fifth');
    expect(argvLines().at(-1)).toContain('model=configured');
    expect(accountId.length).toBeGreaterThan(0);
  });

  test('with no probe cached, a turn on a grouped model lists the models itself first', async () => {
    const client = await startCore();
    const { threadId } = await agyThread(client, { model: 'gemini-3.8-flash', probe: true });
    // What a core restart leaves: the thread keeps its model, the cache is gone.
    getDriver('agy').forgetProbes?.({});
    await runTurn(client, threadId, 'first');
    expect(linesStarting('models')).toHaveLength(2);
    expect(argvLines().at(-1)).toContain('model=gemini-3.8-flash-medium');
  });

  test('a signed-out agy fails the probe with what to do about it', async () => {
    const client = await startCore();
    const { accountId } = await agyAccount(client);
    process.env['AGY_FAKE_SIGNED_OUT'] = '1';
    await expect(client.call('providers.probe', { providerId: 'agy-fake', accountId })).rejects.toThrow(/not signed in/);
  });

  test('a probe outlives another account changing, and is refused when its own account changes', async () => {
    const client = await startCore();
    const { accountId } = await agyAccount(client);
    process.env['AGY_FAKE_MODELS_DELAY_MS'] = '800';

    const kept = client.call('providers.probe', { providerId: 'agy-fake', accountId });
    await waitFor(() => linesStarting('models').length === 1);
    await client.call('accounts.add', { providerId: 'echo', label: 'Another' });
    expect((await kept).models.some((model) => model.id === 'gemini-3.8-flash')).toBe(true);

    const refused = client.call('providers.probe', { providerId: 'agy-fake', accountId, refresh: true });
    await waitFor(() => linesStarting('models').length === 2);
    await client.call('accounts.check', { accountId });
    await expect(refused).rejects.toThrow(/changed during discovery/);
  });

  test('an account of its own is refused: nothing moves the agy login', async () => {
    const client = await startCore();
    await agyAccount(client);
    const before = (await client.call('accounts.list', {})).length;
    await expect(
      client.call('accounts.add', { providerId: 'agy-fake', label: 'Second', useDefaultLocation: false }),
    ).rejects.toThrow(/default account/);
    await expect(
      client.call('accounts.add', { providerId: 'antigravity-cli', label: 'Second', useDefaultLocation: false }),
    ).rejects.toThrow(/no variable that moves its login/);
    // Nothing was created on the way to the refusal.
    expect((await client.call('accounts.list', {})).length).toBe(before);
  });

  test('a compaction is refused: print mode takes no /compact', async () => {
    const client = await startCore();
    const { threadId } = await agyThread(client);
    await runTurn(client, threadId, 'first');
    await expect(client.call('threads.compact', { threadId })).rejects.toThrow(/no \/compact/);
  });
});

describe('agy models listing', () => {
  test('only id and label lines are models, whatever else the command prints', () => {
    const listed = parseModelLines('Fetching available models...\r\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\r\n\nnot a model line\n');
    expect(listed).toEqual([{ id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' }]);
  });

  test('an empty listing leaves the descriptor models standing', async () => {
    await startCore();
    const provider = harness?.core.providers.require('antigravity-cli');
    if (provider === undefined) throw new Error('the shipped descriptor did not load');
    expect(modelsFromListing(provider, [])).toEqual(provider.models);
  });
});
