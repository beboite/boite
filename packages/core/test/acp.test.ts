import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'bun:test';
import type { MessagePart, PermissionMode, RpcEvents, Settings } from '@boite/contracts';
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
  delete process.env['ACP_FAKE_NO_MODES'];
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
      // One model, like OpenCode's shipped descriptor: the agent owns the list,
      // and `providers.probe` is the only way to learn the rest.
      models: [{ id: 'default', name: 'Agent default', default: true }],
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

async function acpAccount(client: CoreClient): Promise<{ dataDir: string; projectId: string; accountId: string }> {
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
  return { dataDir, projectId: project.id, accountId: account.id };
}

async function acpThread(client: CoreClient, model?: string, permissionMode?: PermissionMode): Promise<string> {
  const { projectId, accountId } = await acpAccount(client);
  // A model the descriptor does not carry is only accepted once the agent has
  // listed it, which is what the picker does before it offers it.
  if (model !== undefined && model !== 'default') {
    await client.call('providers.probe', { providerId: 'acp-fake', accountId });
  }
  const project = { id: projectId };
  const account = { id: accountId };
  const thread = await client.call('threads.create', {
    projectId: project.id,
    providerId: 'acp-fake',
    accountId: account.id,
    title: 'acp thread',
    ...(model === undefined ? {} : { model }),
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

/** How many times the fake was told to switch to a given mode. */
function setModeCount(modeId: string): number {
  return fakeLog()
    .split('\n')
    .filter((line) => line === `set_mode ${modeId}`).length;
}

/** How many times a given `<configId> <value>` pair was set on the fake. */
function configCount(pair: string): number {
  return fakeLog()
    .split('\n')
    .filter((line) => line === `set_config_option ${pair}`).length;
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

  test('a line that is not json on stdout is logged, and the turn goes through anyway', async () => {
    const client = await startCore();
    const logs = collectLogs(client);
    const threadId = await acpThread(client);

    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 20000);
    await client.call('turns.start', { threadId, prompt: '[noise]the answer' });
    expect((await finished).status).toBe('done');

    // The sign-in link Antigravity prints in the middle of its ndjson stream.
    expect(logs.some((line) => line.includes('acp agent: Open the following link'))).toBe(true);
    const thread = await client.call('threads.get', { threadId });
    expect(thread.messages[1]?.parts).toEqual([{ type: 'text', text: 'the answer' }]);
  });

  test('a thought chunk becomes a thinking part ahead of the answer', async () => {
    const client = await startCore();
    const threadId = await acpThread(client);

    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 20000);
    await client.call('turns.start', { threadId, prompt: '[thought]the answer' });
    expect((await finished).status).toBe('done');

    const thread = await client.call('threads.get', { threadId });
    expect(thread.messages[1]?.parts).toEqual([
      { type: 'thinking', text: 'thinking about it' },
      { type: 'text', text: 'the answer' },
    ]);
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

  test("a tool call's content becomes the part's documents, and an update with none keeps them", async () => {
    const client = await startCore();
    const threadId = await acpThread(client);

    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 20000);
    await client.call('turns.start', { threadId, prompt: '[documents]' });
    expect((await finished).status).toBe('done');

    const thread = await client.call('threads.get', { threadId });
    const tools = (thread.messages[1]?.parts ?? []).filter((part) => part.type === 'tool');
    expect(tools).toHaveLength(2);

    // The diff survived the update that carried no content, and no `oldText`
    // means a new file.
    expect(tools[0]).toMatchObject({ toolId: 'fake-diff', status: 'done', output: 'written' });
    expect(tools[0]?.type === 'tool' ? tools[0].documents : []).toEqual([
      { kind: 'diff', path: '/work/src/app.ts', oldText: '', newText: 'const answer = 42;\n' },
    ]);

    // The text block is a document, not the output: the output stays `rawOutput`.
    expect(tools[1]).toMatchObject({ toolId: 'fake-shot', status: 'done', output: 'captured' });
    const documents = tools[1]?.type === 'tool' ? (tools[1].documents ?? []) : [];
    expect(documents).toHaveLength(2);
    expect(documents[0]).toEqual({ kind: 'markdown', title: null, text: '# the note\nwhat the tool saw' });
    expect(documents[1]).toMatchObject({ kind: 'image', mimeType: 'image/png', alt: null });
    expect(documents[1]?.kind === 'image' ? documents[1].data.startsWith('iVBORw0KGgo') : false).toBe(true);
  });

  test('an image over the 2 MB cap comes back as a line saying so, not as base64', async () => {
    const client = await startCore();
    const threadId = await acpThread(client);

    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 30000);
    await client.call('turns.start', { threadId, prompt: '[big-image]' });
    expect((await finished).status).toBe('done');

    const thread = await client.call('threads.get', { threadId });
    const tool = (thread.messages[1]?.parts ?? []).find((part) => part.type === 'tool');
    const documents = tool?.type === 'tool' ? (tool.documents ?? []) : [];
    expect(documents).toHaveLength(1);
    expect(documents[0]?.kind).toBe('markdown');
    const text = documents[0]?.kind === 'markdown' ? documents[0].text : '';
    expect(text).toContain('too large');
    expect(text).toContain('2.5 MB');
    // Nothing of the payload was journalled.
    expect(text).not.toContain('AAAA');
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
    // A loaded session is put on the thread's model too: the agent keeps the
    // one it was saved with otherwise, and the thread would silently answer on it.
    await waitFor(() => configCount('model fake-smart') === 2);
  });

  test('a warm session follows a model and an effort change without starting a second process', async () => {
    const client = await startCore({ warmProcessMinutes: 5 });
    const threadId = await acpThread(client, 'fake-fast');
    const counted = countProcesses(client, threadId);

    await runTurn(client, threadId, 'first');
    await waitFor(() => configCount('model fake-fast') === 1);

    await client.call('threads.update', { threadId, model: 'fake-smart', effort: 'high' });
    await runTurn(client, threadId, 'second');

    await waitFor(() => configCount('model fake-smart') === 1);
    await waitFor(() => configCount('thought_level high') === 1);
    // Neither is part of the session key any more, so the same agent kept the turn.
    expect(counted.started).toHaveLength(1);
    expect(counted.exited).toHaveLength(0);
    // Only what moved went out: the first turn's model is not sent twice.
    expect(configCount('model fake-fast')).toBe(1);
  });

  test('a thread on the model "default" lets the agent keep its own', async () => {
    const client = await startCore({ warmProcessMinutes: 0 });
    const threadId = await acpThread(client, 'default');

    await runTurn(client, threadId, 'first');
    const thread = await client.call('threads.get', { threadId });
    expect(thread.model).toBe('default');
    // The fake offers `default` as a real model value, so a log with no
    // set_config_option line is the driver skipping the call, not missing it.
    expect(fakeLog()).not.toContain('set_config_option');
  });

  test('a probe lists the models the agent offers, the current one flagged', async () => {
    const client = await startCore();
    const { accountId } = await acpAccount(client);

    const probed = client.next(
      'providers.probed',
      (event) => event.providerId === 'acp-fake' && event.accountId === accountId,
      20000,
    );
    const result = await client.call('providers.probe', { providerId: 'acp-fake', accountId });

    expect(result.models.map((model) => model.id)).toEqual(['default', 'fake-fast', 'fake-smart']);
    // The descriptor's own model stays first and never claims to be the default.
    expect(result.models[0]).toMatchObject({ id: 'default', name: 'Agent default', default: false });
    expect(result.models.find((model) => model.default === true)?.id).toBe('fake-fast');
    // `thought_level` is one scale for the session, so every model carries it.
    for (const model of result.models) {
      expect(model.effort).toEqual({
        levels: [
          { id: 'low', label: 'Low' },
          { id: 'medium', label: 'Medium' },
          { id: 'high', label: 'High' },
        ],
        default: 'medium',
      });
    }
    expect(result.probedAt).toBeGreaterThan(0);

    // A second client learns the same list from the event.
    expect((await probed).models.map((model) => model.id)).toEqual(['default', 'fake-fast', 'fake-smart']);

    // The agent process is gone: nothing is left running for a probe.
    await waitFor(() => harness?.core.procs.liveCount(`probe:acp-fake:${accountId}`) === 0);
    const trace = await client.call('trace.get', { threadId: `probe:acp-fake:${accountId}` });
    expect(trace).toHaveLength(1);
    expect(trace[0]?.exitedAt).not.toBeNull();
  });

  test('a second probe answers from the cache, and providers.reload empties it', async () => {
    const client = await startCore();
    const { accountId } = await acpAccount(client);

    const first = await client.call('providers.probe', { providerId: 'acp-fake', accountId });
    const second = await client.call('providers.probe', { providerId: 'acp-fake', accountId });
    expect(second.probedAt).toBe(first.probedAt);
    // One agent process for the two calls: the fake logs one line per process.
    expect(initializeCount()).toBe(1);

    await client.call('providers.reload', {});
    const third = await client.call('providers.probe', { providerId: 'acp-fake', accountId });
    expect(third.probedAt).toBeGreaterThanOrEqual(first.probedAt);
    expect(initializeCount()).toBe(2);
  });

  test('a model the agent listed is accepted, the same one before any probe is refused', async () => {
    const client = await startCore();
    const { projectId, accountId } = await acpAccount(client);

    let failure = 'none';
    try {
      await client.call('threads.create', {
        projectId,
        providerId: 'acp-fake',
        accountId,
        title: 'too early',
        model: 'fake-smart',
      });
    } catch (error) {
      failure = (error as Error).message;
    }
    expect(failure).toBe('the agent has not listed this model: open the model picker so Boite reads its models first');

    await client.call('providers.probe', { providerId: 'acp-fake', accountId });
    const thread = await client.call('threads.create', {
      projectId,
      providerId: 'acp-fake',
      accountId,
      title: 'after the probe',
      model: 'fake-smart',
      effort: 'high',
    });
    expect(thread.model).toBe('fake-smart');
    expect(thread.effort).toBe('high');
  });

  test('the thread permission mode becomes a session mode, and the one the agent is on sends nothing', async () => {
    const client = await startCore();
    const threadId = await acpThread(client, undefined, 'acceptEdits');

    await runTurn(client, threadId, 'first');
    // The fake spells it `accept_edits`; the mapping is what finds it.
    await waitFor(() => setModeCount('accept_edits') === 1);
    expect(fakeLog()).not.toContain('set_mode:refused');

    await harness?.stop();
    harness = null;

    const plain = await startCore();
    const plainThread = await acpThread(plain);
    await runTurn(plain, plainThread, 'first');
    // The agent already reports `default`: nothing to ask for.
    expect(fakeLog()).not.toContain('set_mode');
  });

  test('bypassPermissions and dontAsk both land on the agent mode yolo', async () => {
    const client = await startCore();
    const threadId = await acpThread(client, undefined, 'bypassPermissions');
    await runTurn(client, threadId, 'first');
    await waitFor(() => setModeCount('yolo') === 1);

    await harness?.stop();
    harness = null;

    const strict = await startCore();
    const strictThread = await acpThread(strict, undefined, 'dontAsk');
    await runTurn(strict, strictThread, 'first');
    await waitFor(() => setModeCount('yolo') === 1);
    expect(fakeLog()).not.toContain('set_mode:refused');
  });

  test('a warm session follows a mode change without starting a second process', async () => {
    const client = await startCore({ warmProcessMinutes: 5 });
    const threadId = await acpThread(client);
    const counted = countProcesses(client, threadId);

    await runTurn(client, threadId, 'first');
    expect(fakeLog()).not.toContain('set_mode');

    await client.call('threads.update', { threadId, permissionMode: 'plan' });
    await runTurn(client, threadId, 'second');

    await waitFor(() => setModeCount('plan') === 1);
    // The mode is not part of the session key, so the same agent kept the turn.
    expect(counted.started).toHaveLength(1);
    expect(counted.exited).toHaveLength(0);
  });

  test('a session loaded back is put in the thread mode again', async () => {
    const client = await startCore({ warmProcessMinutes: 0 });
    const threadId = await acpThread(client, undefined, 'acceptEdits');

    await runTurn(client, threadId, 'first');
    const sessionId = (await client.call('threads.get', { threadId })).sessionId ?? '';
    expect(sessionId).not.toBe('');
    await waitFor(() => setModeCount('accept_edits') === 1);

    // The process went with the turn, so the second one resumes through
    // session/load, which does not reliably keep the mode.
    await runTurn(client, threadId, 'second');
    await waitFor(() => fakeLog().includes(`loaded:${sessionId}`));
    await waitFor(() => setModeCount('accept_edits') === 2);
  });

  test('an agent that switched on its own is put back on the next turn', async () => {
    const client = await startCore({ warmProcessMinutes: 5 });
    const threadId = await acpThread(client);
    const logs = collectLogs(client);

    await runTurn(client, threadId, '[mode-switch yolo]drifting');
    // Nothing was sent yet: the thread and the agent both started on `default`.
    expect(fakeLog()).not.toContain('set_mode ');
    await waitFor(() => logs.some((line) => line.includes('the agent switched to the session mode yolo')));

    await runTurn(client, threadId, 'back to work');
    await waitFor(() => setModeCount('default') === 1);
  });

  test('an agent with no modes at all is one warning, and the turn still runs', async () => {
    const client = await startCore();
    process.env['ACP_FAKE_NO_MODES'] = '1';
    const threadId = await acpThread(client);
    const logs = collectLogs(client);

    await runTurn(client, threadId, 'first');
    expect(fakeLog()).not.toContain('set_mode');
    await waitFor(() =>
      logs.some(
        (line) => line === 'warn acp: no session mode matches the permission mode default; the agent offers none',
      ),
    );
  });

  /** One `initialize` per agent process, which is what the probe cache saves. */
  function initializeCount(): number {
    return fakeLog()
      .split('\n')
      .filter((line) => line === 'initialize').length;
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
