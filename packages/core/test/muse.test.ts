import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'bun:test';
import type { MessagePart, PermissionMode, ProviderDescriptor, RpcEvents, Settings } from '@boite/contracts';
import type { CoreClient } from '../src/client.ts';
import { getDriver } from '../src/drivers/index.ts';
import { choiceFor, mintUuidV7, museExecutable } from '../src/drivers/muse.ts';
import { startTestCore, waitFor } from './harness.ts';
import type { TestCore } from './harness.ts';

/** The fake `muse serve`: a real ndjson JSON-RPC process over stdio, run by bun. */
const FAKE_SERVER = fileURLToPath(new URL('./fixtures/muse-server.ts', import.meta.url));
const PROVIDER = 'muse-fake';

let harness: TestCore | null = null;
let logFile = '';

afterEach(async () => {
  const open = harness;
  harness = null;
  delete process.env['MUSE_FAKE_LOG'];
  delete process.env['MUSE_FAKE_HOME'];
  if (open !== null) await open.stop();
});

async function startCore(settings?: Partial<Settings>): Promise<CoreClient> {
  const started = await startTestCore(settings === undefined ? {} : { settings });
  harness = started;
  logFile = join(started.dataDir, 'muse-fake.log');
  process.env['MUSE_FAKE_LOG'] = logFile;
  return started.connect();
}

async function stopCore(): Promise<void> {
  const open = harness;
  harness = null;
  if (open !== null) await open.stop();
}

function fakeLog(): string {
  return existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
}

function countLines(line: string): number {
  return fakeLog()
    .split('\n')
    .filter((entry) => entry === line).length;
}

/** A user descriptor for the fake host: `protocol: "muse"`, launched as `bun <fixture>`. */
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
    join(dir, `${PROVIDER}.json`),
    JSON.stringify({
      id: PROVIDER,
      schemaVersion: 1,
      name: 'Fake Muse host',
      shortName: 'MuseFake',
      protocol: 'muse',
      roots: ['{isolationDir}'],
      profiles: { windows: profile, linux: profile, macos: profile },
      auth: { kind: 'none' },
      models: [
        { id: 'default', name: 'Muse default' },
        {
          id: 'muse-spark-1.3',
          name: 'Muse Spark 1.3',
          default: true,
          effort: {
            levels: [
              { id: 'low', label: 'Low' },
              { id: 'high', label: 'High' },
            ],
            default: 'high',
          },
        },
      ],
      capabilities: { approvals: true, hooks: false, checkpoint: false, images: true, planMode: true, resume: true },
    }),
    'utf8',
  );
}

async function museAccount(client: CoreClient): Promise<{ dataDir: string; projectId: string; accountId: string }> {
  const dataDir = harness?.dataDir ?? '';
  writeDescriptor(dataDir);
  const loaded = await client.call('providers.reload', {});
  expect(loaded.rejected).toEqual([]);
  expect(loaded.loaded.some((provider) => provider.id === PROVIDER && provider.available)).toBe(true);
  const project = await client.call('projects.add', { path: dataDir, name: 'muse' });
  const account = await client.call('accounts.add', { providerId: PROVIDER, label: 'Fake', useDefaultLocation: true });
  return { dataDir, projectId: project.id, accountId: account.id };
}

async function museThread(
  client: CoreClient,
  options: { permissionMode?: PermissionMode; effort?: string; model?: string } = {},
): Promise<string> {
  const { projectId, accountId } = await museAccount(client);
  const thread = await client.call('threads.create', {
    projectId,
    providerId: PROVIDER,
    accountId,
    title: 'muse thread',
    model: options.model ?? 'muse-spark-1.3',
    ...(options.effort === undefined ? {} : { effort: options.effort }),
    ...(options.permissionMode === undefined ? {} : { permissionMode: options.permissionMode }),
  });
  await client.call('threads.subscribe', { threadId: thread.id });
  return thread.id;
}

async function runTurn(client: CoreClient, threadId: string, prompt: string): Promise<RpcEvents['turn.finished']> {
  const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 20000);
  await client.call('turns.start', { threadId, prompt });
  return finished;
}

async function lastParts(client: CoreClient, threadId: string): Promise<MessagePart[]> {
  const thread = await client.call('threads.get', { threadId });
  return thread.messages[thread.messages.length - 1]?.parts ?? [];
}

function textsOf(parts: MessagePart[]): string[] {
  return parts.flatMap((part) => (part.type === 'text' ? [part.text] : []));
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

describe('muse driver', () => {
  test('getDriver returns the muse driver', () => {
    expect(getDriver('muse').protocol).toBe('muse');
  });

  test('a plain prompt streams back once, over snapshots and deltas, and the session id is kept', async () => {
    const client = await startCore();
    const threadId = await museThread(client, { effort: 'high' });

    const deltas: string[] = [];
    client.on('message.delta', (event) => {
      if (event.threadId === threadId) deltas.push(event.text);
    });
    const prompt = 'the fake muse host echoes this back';
    const done = await runTurn(client, threadId, prompt);
    expect(done.error).toBeNull();
    expect(done.status).toBe('done');
    // The first chunk came as an `item/updated` snapshot, the rest as deltas,
    // then the whole text once more on `item/completed`: written exactly once.
    expect(deltas.join('')).toBe(prompt);
    expect(await lastParts(client, threadId)).toEqual([{ type: 'text', text: prompt }]);

    const thread = await client.call('threads.get', { threadId });
    expect(thread.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const log = fakeLog();
    expect(log).toContain('initialize client=boite dialogs=true flags=\n');
    expect(log).toContain('initialized\n');
    expect(log).toContain('session/start uuid=true approvalMode=promptUnmatched model=muse-spark-1.3 provider=meta');
    expect(log).toContain('turn/start uuid=true effort=high display=true');
    // The session already runs the thread's model: nothing to switch.
    expect(log).not.toContain('session/setModel');
  });

  test('an image attachment rides turn/start as base64 with its media type', async () => {
    const client = await startCore();
    const threadId = await museThread(client);
    const PNG =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 20000);
    await client.call('turns.start', {
      threadId,
      prompt: 'what is this',
      attachments: [{ kind: 'image', mimeType: 'image/png', data: PNG, name: 'pixel.png' }],
    });
    expect((await finished).status).toBe('done');
    expect(fakeLog()).toContain(`image image/png ${PNG}`);
  });

  test('reasoning becomes a thinking part ahead of the answer', async () => {
    const client = await startCore();
    const threadId = await museThread(client);
    expect((await runTurn(client, threadId, '[thought]the answer')).status).toBe('done');
    expect(await lastParts(client, threadId)).toEqual([
      { type: 'thinking', text: 'thinking about it' },
      { type: 'text', text: 'the answer' },
    ]);
  });

  test('a shell tool call is one card, running then done with its output', async () => {
    const client = await startCore();
    const threadId = await museThread(client);
    const parts: MessagePart[] = [];
    client.on('message.part', (event) => {
      if (event.threadId === threadId) parts.push(event.part);
    });
    expect((await runTurn(client, threadId, '[command]')).status).toBe('done');
    const tools = parts.filter((part) => part.type === 'tool');
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({ name: 'Bash', status: 'running', output: null, input: { command: 'echo hello' } });
    expect(tools[1]).toMatchObject({ name: 'Bash', status: 'done', output: 'ok' });
  });

  test('an approval is asked, and allow and deny pick the matching choice', async () => {
    const client = await startCore();
    const threadId = await museThread(client);

    for (const decision of ['allow', 'deny'] as const) {
      const requested = client.next('permission.requested', (request) => request.threadId === threadId, 20000);
      const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 20000);
      await client.call('turns.start', { threadId, prompt: '[approve]' });
      const request = await requested;
      expect(request.toolName).toBe('Bash');
      expect(request.input).toMatchObject({ kind: 'shell', command: 'echo hello' });
      await client.call('permissions.answer', { requestId: request.id, decision });
      expect((await finished).status).toBe('done');

      const parts = await lastParts(client, threadId);
      expect(textsOf(parts)).toEqual([decision === 'allow' ? 'allowed' : 'denied']);
      expect(parts.find((part) => part.type === 'permission')).toMatchObject({ toolName: 'Bash', decision });
      expect(parts.find((part) => part.type === 'tool')).toMatchObject({
        name: 'Bash',
        status: decision === 'allow' ? 'done' : 'denied',
      });
    }
    // Allow takes the narrowest approving choice, not the session-wide one listed first.
    expect(countLines('approval/decide c-once stage=0')).toBe(1);
    expect(countLines('approval/decide c-deny stage=0')).toBe(1);
  });

  test('acceptEdits approves a write inside the folder and asks for one outside it, through a link too', async () => {
    const client = await startCore();
    const threadId = await museThread(client, { permissionMode: 'acceptEdits' });
    const asked: string[] = [];
    client.on('permission.requested', (request) => {
      if (request.threadId === threadId) asked.push(request.id);
    });

    const inside = await runTurn(client, threadId, '[edit]');
    expect(inside.status).toBe('done');
    expect(asked).toHaveLength(0);
    expect(textsOf(await lastParts(client, threadId))).toEqual(['wrote']);
    expect(countLines('approval/decide c-once stage=0')).toBe(1);

    const requested = client.next('permission.requested', (request) => request.threadId === threadId, 20000);
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 20000);
    await client.call('turns.start', { threadId, prompt: '[edit-out]' });
    const request = await requested;
    expect(request.input).toMatchObject({ kind: 'fileAccess', access: 'write', path: '../outside.md' });
    await client.call('permissions.answer', { requestId: request.id, decision: 'deny' });
    expect((await finished).status).toBe('done');
    expect(textsOf(await lastParts(client, threadId))).toEqual(['kept']);

    // A junction inside the folder that points out of it: the path reads as inside, the write would not be.
    const outside = mkdtempSync(join(tmpdir(), 'muse-outside-'));
    try {
      symlinkSync(outside, join(harness?.dataDir ?? '', 'out-link'), 'junction');
      const linked = client.next('permission.requested', (request) => request.threadId === threadId, 20000);
      const linkedDone = client.next('turn.finished', (turn) => turn.threadId === threadId, 20000);
      await client.call('turns.start', { threadId, prompt: '[edit-link]' });
      const linkRequest = await linked;
      expect(linkRequest.input).toMatchObject({ kind: 'fileAccess', access: 'write', path: 'out-link/notes.md' });
      await client.call('permissions.answer', { requestId: linkRequest.id, decision: 'deny' });
      expect((await linkedDone).status).toBe('done');
      expect(textsOf(await lastParts(client, threadId))).toEqual(['kept']);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('a question draws a card, and the picked label reaches the host', async () => {
    const client = await startCore();
    const threadId = await museThread(client);
    const asked = client.next('question.asked', (request) => request.threadId === threadId, 20000);
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 20000);
    await client.call('turns.start', { threadId, prompt: '[input]' });

    const question = await asked;
    expect(question.text).toBe('Pick: which one?');
    expect(question.options).toEqual([
      { id: 'Red', label: 'Red' },
      { id: 'Blue', label: 'Blue', description: 'the calm one' },
    ]);
    expect(question.allowText).toBe(true);
    expect(question.multiple).toBe(false);
    await client.call('questions.answer', { threadId, questionId: question.id, optionIds: ['Blue'] });

    expect((await finished).status).toBe('done');
    const parts = await lastParts(client, threadId);
    expect(parts.find((part) => part.type === 'question')).toMatchObject({ answer: { optionIds: ['Blue'] } });
    expect(textsOf(parts)).toEqual(['input answered Blue']);
    expect(fakeLog()).toContain('userInput/answer [{"questionId":"q1","selectedLabel":"Blue"}]');
  });

  test('stopping a turn interrupts it, cancels nothing else, and the process goes', async () => {
    const client = await startCore({ warmProcessMinutes: 0 });
    const threadId = await museThread(client);
    const started = client.next('process.started', (record) => record.threadId === threadId, 20000);
    const exited = client.next('process.exited', (record) => record.threadId === threadId, 20000);
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 20000);
    await client.call('turns.start', { threadId, prompt: '[slow]' });
    await started;
    await waitFor(() => fakeLog().includes('turn/start'));

    expect(await client.call('turns.stop', { threadId })).toEqual({ stopped: true });
    expect((await finished).status).toBe('stopped');
    await exited;
    expect(fakeLog()).toContain('turn/interrupt turn');
    await waitFor(() => harness?.core.procs.liveCount(threadId) === 0);
  });

  test('a host that dies fails the turn with its exit code and stderr, and the next turn resumes', async () => {
    const client = await startCore();
    const threadId = await museThread(client);
    const failure = await runTurn(client, threadId, '[crash]');
    expect(failure.status).toBe('error');
    expect(failure.error).toContain('exited with code 3');
    expect(failure.error).toContain('boom');

    const sessionId = (await client.call('threads.get', { threadId })).sessionId ?? '';
    const again = await runTurn(client, threadId, 'still here');
    expect(again.error).toBeNull();
    expect(again.status).toBe('done');
    expect(fakeLog()).toContain(`session/resume ${sessionId} excludeItems=true`);
  });

  test('a missing login fails the turn with the sentence that fixes it', async () => {
    const client = await startCore();
    const threadId = await museThread(client);
    const failed = await runTurn(client, threadId, '[auth]');
    expect(failed.status).toBe('error');
    expect(failed.error).toContain('Muse Code is not signed in');
  });

  test('a server request is declined: approvals are answered through their notification', async () => {
    const client = await startCore();
    const threadId = await museThread(client);
    expect((await runTurn(client, threadId, '[server-request]')).status).toBe('done');
    expect(fakeLog()).toContain('approval/request refused');
  });

  test('the todo list becomes the thread tasks, cancelled items left out', async () => {
    const client = await startCore();
    const threadId = await museThread(client);
    expect((await runTurn(client, threadId, '[tasks]')).status).toBe('done');
    expect((await client.call('threads.get', { threadId })).activity?.tasks).toEqual([
      { id: '0', text: 'Inspect source', status: 'completed' },
      { id: '1', text: 'Run checks', status: 'in_progress' },
    ]);
  });

  test('the turn usage and the context meter carry what the host reported', async () => {
    const client = await startCore();
    const threadId = await museThread(client);
    const done = await runTurn(client, threadId, '[usage]');
    expect(done.usage).toEqual({
      inputTokens: 8,
      outputTokens: 4,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      costUsdEquivalent: null,
    });
    const thread = await client.call('threads.get', { threadId });
    expect(thread.context?.tokens).toBe(90);
    expect(thread.context?.window).toBe(200000);
  });

  test('manual compaction goes through session/compact and draws its part', async () => {
    const client = await startCore();
    const threadId = await museThread(client);
    await runTurn(client, threadId, 'remember this');
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 20000);
    const turn = await client.call('threads.compact', { threadId });
    expect(turn.execution?.operation).toBe('compact');
    expect((await finished).status).toBe('done');

    const thread = await client.call('threads.get', { threadId });
    expect(thread.context?.tokens).toBe(32000);
    expect(thread.messages.flatMap((message) => message.parts)).toContainEqual({
      type: 'compaction',
      trigger: 'manual',
      preTokens: 90000,
      postTokens: 32000,
    });
    expect(fakeLog()).toContain('session/compact');
  });

  test('a warm host takes a model switch and a new approval mode without restarting', async () => {
    const client = await startCore({ warmProcessMinutes: 5 });
    const { projectId, accountId } = await museAccount(client);
    await client.call('providers.probe', { providerId: PROVIDER, accountId });
    const thread = await client.call('threads.create', {
      projectId,
      providerId: PROVIDER,
      accountId,
      title: 'switch',
      model: 'muse-spark-1.3',
    });
    await client.call('threads.subscribe', { threadId: thread.id });
    const counted = countProcesses(client, thread.id);

    expect((await runTurn(client, thread.id, 'first')).status).toBe('done');
    await client.call('threads.update', {
      threadId: thread.id,
      model: 'muse-fake-fast',
      effort: 'max',
      permissionMode: 'acceptEdits',
    });
    expect((await runTurn(client, thread.id, 'second')).status).toBe('done');
    // acceptEdits keeps promptUnmatched and no host flag: same process, same session.
    expect(counted.started).toHaveLength(1);
    expect(countLines('session/setModel muse-fake-fast provider=meta')).toBe(1);
    expect(fakeLog()).toContain('turn/start uuid=true effort=max display=true');
    expect(fakeLog()).not.toContain('session/setApprovalMode');
    expect(fakeLog()).not.toContain('session/resume');

    // bypassPermissions needs `--disable-sandbox`, a host flag: a new host resumes the session.
    await client.call('threads.update', { threadId: thread.id, permissionMode: 'bypassPermissions' });
    expect((await runTurn(client, thread.id, 'third')).status).toBe('done');
    expect(counted.started).toHaveLength(2);
    const sessionId = (await client.call('threads.get', { threadId: thread.id })).sessionId ?? '';
    expect(fakeLog()).toContain(`session/resume ${sessionId} excludeItems=true`);
    expect(fakeLog()).toContain('flags=--disable-sandbox');
    expect(fakeLog()).toContain('session/setApprovalMode allowAll');
  });

  test('plan mode starts a host that cannot write or run a shell, and denies the rest', async () => {
    const client = await startCore();
    const threadId = await museThread(client, { permissionMode: 'plan' });
    expect((await runTurn(client, threadId, 'first')).status).toBe('done');
    expect(fakeLog()).toContain('flags=--disable-write --disable-shell');
    expect(fakeLog()).toContain('approvalMode=denyUnmatched');
  });

  test('a cold thread resumes its session on a new host', async () => {
    const client = await startCore({ warmProcessMinutes: 0 });
    const threadId = await museThread(client);
    await runTurn(client, threadId, 'first');
    const sessionId = (await client.call('threads.get', { threadId })).sessionId ?? '';
    expect(sessionId).not.toBe('');
    await runTurn(client, threadId, 'second');
    expect(fakeLog()).toContain(`session/resume ${sessionId} excludeItems=true`);
    expect(fakeLog().split('\n').filter((line) => line.startsWith('initialize '))).toHaveLength(2);
    expect((await client.call('threads.get', { threadId })).sessionId).toBe(sessionId);
  });

  test('the model "default" puts no model on the wire', async () => {
    const client = await startCore();
    const threadId = await museThread(client, { model: 'default' });
    await runTurn(client, threadId, 'first');
    expect(fakeLog()).toContain('session/start uuid=true approvalMode=promptUnmatched model= provider=\n');
    expect(fakeLog()).not.toContain('session/setModel');
  });

  test('a probe lists the Meta models, with efforts from the cached catalog', async () => {
    const home = mkdtempSync(join(tmpdir(), 'muse-home-'));
    try {
      mkdirSync(join(home, 'model-catalog'));
      writeFileSync(
        join(home, 'model-catalog', 'meta-fake.json'),
        JSON.stringify({
          schema_version: 1,
          provider_id: 'meta',
          profile_id: 'fake-profile',
          source: 'provider_catalog',
          rows: [
            {
              model_id: 'muse-spark-1.3',
              provider_id: 'meta',
              profile_id: 'fake-profile',
              visibility: 'visible',
              reasoning_effort_variants: [
                { tier: 'low', description: 'quick' },
                { tier: 'high', description: 'deep' },
                { tier: 'ultra', description: 'deepest' },
                { tier: 'bogus' },
              ],
            },
          ],
        }),
        'utf8',
      );
      // Another profile's catalog is not this account's.
      writeFileSync(
        join(home, 'model-catalog', 'other.json'),
        JSON.stringify({ profile_id: 'other', rows: [{ model_id: 'muse-fake-fast', provider_id: 'meta', visibility: 'visible', reasoning_effort_variants: [{ tier: 'none' }] }] }),
        'utf8',
      );
      const client = await startCore();
      process.env['MUSE_FAKE_HOME'] = home;
      const { accountId } = await museAccount(client);

      const result = await client.call('providers.probe', { providerId: PROVIDER, accountId });
      expect(result.models.map((model) => model.id)).toEqual(['default', 'muse-spark-1.3', 'muse-fake-fast']);
      expect(result.models[0]).toEqual({ id: 'default', name: 'Muse default', default: false });
      expect(result.models[1]).toMatchObject({ name: 'Muse Spark 1.3', default: true });
      expect(result.models[1]?.effort).toEqual({
        levels: [
          { id: 'low', label: 'Low', description: 'quick' },
          { id: 'high', label: 'High', description: 'deep' },
          { id: 'ultra', label: 'Ultra', description: 'deepest' },
        ],
        default: 'high',
      });
      expect(result.models[2]).toMatchObject({ name: 'Muse Fake Fast', default: false });
      expect(result.models[2]?.effort?.levels.map((level) => level.id)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);

      // The probe host runs read-only, keeps no log, and is gone afterwards.
      expect(fakeLog()).toContain('flags=--no-session-log --disable-write --disable-shell');
      expect(countLines('model/list')).toBe(1);
      await waitFor(() => harness?.core.procs.liveCount(`probe:${PROVIDER}:${accountId}`) === 0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a host on another envelope version is refused by name', async () => {
    const client = await startCore();
    process.env['MUSE_FAKE_SCHEMA'] = '2';
    try {
      const threadId = await museThread(client);
      const failed = await runTurn(client, threadId, 'hello');
      expect(failed.status).toBe('error');
      expect(failed.error).toContain('MSP envelope version 2');
    } finally {
      delete process.env['MUSE_FAKE_SCHEMA'];
    }
  });
});

describe('muse wire helpers', () => {
  test('command ids are UUIDv7 and sort in minting order within one millisecond', () => {
    const ids = Array.from({ length: 50 }, () => mintUuidV7(1_800_000_000_000));
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('an answer becomes the narrowest matching choice', () => {
    const choices = [
      { choiceId: 'persist', decision: 'approvedPolicyAmendment', scope: 'localPersistent' },
      { choiceId: 'session', decision: 'approvedForSession', scope: 'session' },
      { choiceId: 'once', decision: 'approved', scope: 'once' },
      { choiceId: 'deny', decision: 'denied', scope: 'once' },
    ];
    expect(choiceFor(choices, 'allow')?.choiceId).toBe('once');
    expect(choiceFor(choices, 'deny')?.choiceId).toBe('deny');
    // No `abort` offered: a stop falls back to the denial.
    expect(choiceFor(choices, 'abort')?.choiceId).toBe('deny');
    expect(choiceFor([...choices, { choiceId: 'abort', decision: 'abort' }], 'abort')?.choiceId).toBe('abort');
    expect(choiceFor(choices.slice(0, 2), 'allow')?.choiceId).toBe('session');
  });

  test("the Windows launcher script resolves to the versioned binary beside it", () => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-install-'));
    try {
      const shim = join(dir, 'muse.cmd');
      // This Windows-layout fixture also runs through the POSIX executable resolver.
      writeFileSync(shim, '@echo off\r\n', { encoding: 'utf8', mode: 0o755 });
      const descriptor = (path: string): ProviderDescriptor => {
        const profile = { detect: {}, executable: [{ kind: 'file', value: path }], isolation: {} };
        return {
          id: 'muse',
          protocol: 'muse',
          profiles: { windows: profile, linux: profile, macos: profile },
          models: [],
        } as unknown as ProviderDescriptor;
      };
      expect(() => museExecutable(descriptor(shim))).toThrow(/launcher script/);

      writeFileSync(join(dir, '.muse-version'), '1.3.0-R3401.1\n', 'utf8');
      const binary = join(dir, 'muse-bin-1.3.0-R3401.1.exe');
      writeFileSync(binary, '', { encoding: 'utf8', mode: 0o755 });
      expect(museExecutable(descriptor(shim))).toBe(binary);
      // Anything but a `.cmd` is spawned as it is.
      expect(museExecutable(descriptor(binary))).toBe(binary);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
