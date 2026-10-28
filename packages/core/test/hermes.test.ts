/**
 * Hermes Agent's half of the ACP driver, on a fake that speaks its dialect:
 * the shipped descriptor, the account's own `HERMES_HOME`, the models read out
 * of `session/new` and chosen with `session/set_model` because the agent has
 * no model config option, its three session modes, its permission options, and
 * the empty answer it gives a `session/load` of a session it no longer has.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'bun:test';
import type { PermissionMode, Settings } from '@boite/contracts';
import type { CoreClient } from '../src/client.ts';
import { getDriver } from '../src/drivers/index.ts';
import { variableHome } from '../src/profile-share.ts';
import { startTestCore, waitFor } from './harness.ts';
import type { TestCore } from './harness.ts';

/** The fake Hermes agent: a real ACP process over stdio, run by bun. */
const FAKE_AGENT = fileURLToPath(new URL('./fixtures/hermes-agent.ts', import.meta.url));
/** The shipped descriptor's own launch line, which the fixture is given verbatim. */
const LAUNCH_ARGS = ['acp'];
const UNSET = ['HERMES_SESSION_ID', 'HERMES_TUI_GATEWAY_URL', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENROUTER_API_KEY', 'OPENROUTER_BASE_URL'];
const QWEN = 'custom:qwen2.5:0.5b';
const LLAMA = 'custom:llama3.2:1b';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

let harness: TestCore | null = null;
let logFile = '';
/** The variables these tests set, as the process had them: a later test file gets them back. */
const TOUCHED = ['HERMES_FAKE_LOG', 'HERMES_FAKE_FORGET', 'HERMES_FAKE_LOAD_BARE', 'HERMES_FAKE_LOAD_OPTION', 'HERMES_FAKE_NEW_FAIL', 'OPENAI_API_KEY', 'LOCALAPPDATA'];
const outer = new Map(TOUCHED.map((name) => [name, process.env[name]]));

afterEach(async () => {
  const open = harness;
  harness = null;
  for (const [name, value] of outer) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  if (open !== null) await open.stop();
});

async function startCore(settings?: Partial<Settings>): Promise<CoreClient> {
  const started = await startTestCore(settings === undefined ? {} : { settings });
  harness = started;
  logFile = join(started.dataDir, 'hermes-fake.log');
  process.env['HERMES_FAKE_LOG'] = logFile;
  // A key the user set for their own calls: the descriptor unsets it.
  process.env['OPENAI_API_KEY'] = 'the-users-own-key';
  return started.connect();
}

function fakeLog(): string {
  return existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
}

function loggedLines(prefix: string): string[] {
  return fakeLog()
    .split('\n')
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length));
}

/** The shipped descriptor's shape, pointed at the fake instead of the real CLI. */
function writeDescriptor(dataDir: string): void {
  const dir = join(dataDir, 'providers');
  mkdirSync(dir, { recursive: true });
  const profile = {
    detect: {},
    executable: [{ kind: 'path', value: 'bun' }],
    launch: { args: [FAKE_AGENT, ...LAUNCH_ARGS] },
    isolation: { HERMES_HOME: '{isolationDir}' },
    env: { NO_COLOR: '1' },
    unsetEnv: UNSET,
  };
  writeFileSync(
    join(dir, 'hermes-fake.json'),
    JSON.stringify({
      id: 'hermes-fake',
      schemaVersion: 1,
      name: 'Fake Hermes',
      shortName: 'HermesFake',
      protocol: 'acp',
      roots: ['{isolationDir}'],
      profiles: { windows: profile, linux: profile, macos: profile },
      auth: { kind: 'api-key', session: ['config.yaml'] },
      quirks: ['hermes'],
      models: [{ id: 'default', name: 'Hermes default', default: true }],
      capabilities: { approvals: true, hooks: false, checkpoint: false, images: true, planMode: false, resume: true },
    }),
    'utf8',
  );
}

async function hermesAccount(client: CoreClient): Promise<{ projectId: string; accountId: string; home: string }> {
  const dataDir = harness?.dataDir ?? '';
  writeDescriptor(dataDir);
  const loaded = await client.call('providers.reload', {});
  expect(loaded.rejected).toEqual([]);
  expect(loaded.loaded.some((provider) => provider.id === 'hermes-fake' && provider.available)).toBe(true);

  const project = await client.call('projects.add', { path: dataDir, name: 'hermes' });
  const account = await client.call('accounts.add', { providerId: 'hermes-fake', label: 'Local' });
  const home = account.isolationDir ?? '';
  // Hermes is signed in once `hermes model` wrote the account's config.
  expect((await client.call('accounts.check', { accountId: account.id })).status).toBe('unauthenticated');
  writeFileSync(join(home, 'config.yaml'), 'model:\n  provider: custom\n  default: qwen2.5:0.5b\n', 'utf8');
  expect((await client.call('accounts.check', { accountId: account.id })).status).toBe('ok');
  return { projectId: project.id, accountId: account.id, home };
}

interface HermesThread {
  threadId: string;
  projectId: string;
  accountId: string;
  home: string;
}

async function hermesThread(client: CoreClient, model?: string): Promise<HermesThread> {
  const { projectId, accountId, home } = await hermesAccount(client);
  if (model !== undefined && model !== 'default') {
    await client.call('providers.probe', { providerId: 'hermes-fake', accountId });
  }
  const thread = await client.call('threads.create', {
    projectId,
    providerId: 'hermes-fake',
    accountId,
    title: 'hermes thread',
    ...(model === undefined ? {} : { model }),
  });
  await client.call('threads.subscribe', { threadId: thread.id });
  return { threadId: thread.id, projectId, accountId, home };
}

async function runTurn(client: CoreClient, threadId: string, prompt: string): Promise<void> {
  const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 20000);
  await client.call('turns.start', { threadId, prompt });
  const done = await finished;
  expect(done.error).toBeNull();
  expect(done.status).toBe('done');
}

function lastText(thread: { messages: { parts: { type: string; text?: string }[] }[] }): string {
  const part = thread.messages.at(-1)?.parts.find((entry) => entry.type === 'text');
  return part?.text ?? '';
}

describe('hermes', () => {
  test('the shipped descriptor loads: acp, the hermes quirk, its own home and `hermes acp`', async () => {
    const client = await startCore();
    await client.call('providers.list', {});
    const descriptor = harness?.core.providers.require('hermes');
    expect(descriptor).toBeDefined();
    if (descriptor === undefined) return;

    expect(descriptor.protocol).toBe('acp');
    expect(descriptor.quirks).toEqual(['hermes']);
    expect(descriptor.auth).toEqual({ kind: 'api-key', session: ['config.yaml'] });
    expect(descriptor.login?.command).toEqual(['hermes', 'model']);
    expect(descriptor.login?.terminal).toBe(true);
    expect(descriptor.models).toEqual([{ id: 'default', name: 'Hermes default', default: true }]);
    // No plan mode: Hermes offers `default`, `accept_edits` and `dont_ask`.
    expect(descriptor.capabilities.planMode).toBe(false);
    expect(descriptor.capabilities.images).toBe(true);
    expect(descriptor.capabilities.resume).toBe(true);

    for (const os of ['windows', 'linux', 'macos'] as const) {
      const profile = descriptor.profiles[os];
      expect(profile?.launch?.args).toEqual(LAUNCH_ARGS);
      expect(profile?.isolation).toEqual({ HERMES_HOME: '{isolationDir}' });
      expect(profile?.unsetEnv).toEqual(UNSET);
      // The default account reads the user's own home.
      expect(profile?.unsetEnv).not.toContain('HERMES_HOME');
    }
    // The installer's virtual environment on Windows, PATH first elsewhere.
    const windows = descriptor.profiles.windows?.executable ?? [];
    expect(windows[0]?.kind).toBe('file');
    expect(windows[0]?.value.endsWith(join(homedir(), 'AppData', 'Local', 'hermes', 'hermes-agent', 'venv', 'Scripts', 'hermes.exe'))).toBe(true);
    expect(windows[1]).toEqual({ kind: 'path', value: 'hermes' });
    expect(descriptor.profiles.linux?.executable[0]).toEqual({ kind: 'path', value: 'hermes' });
    // With no `HERMES_HOME` set, the default account's login is in Hermes' own
    // home: `~/.hermes`, or `%LOCALAPPDATA%\hermes` on Windows wherever that points.
    const saved = process.env['HERMES_HOME'];
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    delete process.env['HERMES_HOME'];
    try {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      expect(variableHome('HERMES_HOME')).toBe(join(homedir(), '.hermes'));
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      process.env['LOCALAPPDATA'] = join(harness?.dataDir ?? homedir(), 'elsewhere');
      expect(variableHome('HERMES_HOME')).toBe(join(harness?.dataDir ?? homedir(), 'elsewhere', 'hermes'));
      expect(variableHome('HERMES_HOME', { env: { LOCALAPPDATA: join(harness?.dataDir ?? homedir(), 'profile') } })).toBe(join(harness?.dataDir ?? homedir(), 'profile', 'hermes'));
      delete process.env['LOCALAPPDATA'];
      expect(variableHome('HERMES_HOME')).toBe(join(homedir(), 'AppData', 'Local', 'hermes'));
    } finally {
      if (platform !== undefined) Object.defineProperty(process, 'platform', platform);
      if (saved !== undefined) process.env['HERMES_HOME'] = saved;
    }
  });

  test('a probe lists the configured models, the agent own one first', async () => {
    const client = await startCore();
    const { accountId } = await hermesAccount(client);
    const result = await client.call('providers.probe', { providerId: 'hermes-fake', accountId });
    expect(result.models.map((model) => model.id)).toEqual(['default', QWEN, LLAMA]);
    expect(result.models.find((model) => model.default === true)?.id).toBe(QWEN);
    // A probe chooses nothing.
    expect(fakeLog()).not.toContain('set_model');
  });

  test('a model goes out as session/set_model, without effort, never as a config option', async () => {
    const client = await startCore({ warmProcessMinutes: 5 });
    const { threadId, home } = await hermesThread(client, LLAMA);
    await runTurn(client, threadId, 'hello');

    expect(loggedLines('set_model ')).toEqual([LLAMA]);
    expect(loggedLines('prompt ').at(-1)?.split(' ')[1]).toBe(LLAMA);
    expect(fakeLog()).not.toContain('set_config_option');
    // The account's own home and none of the user's keys reach the agent.
    expect(loggedLines('env HERMES_HOME=').at(-1)).toBe(home);
    expect(loggedLines('env OPENAI_API_KEY=').at(-1)).toBe('');
    expect(loggedLines('env NO_COLOR=').at(-1)).toBe('1');

    // A warm session follows a change, and going back to the agent's own model asks for it.
    await client.call('threads.update', { threadId, model: QWEN });
    await runTurn(client, threadId, 'again');
    await client.call('threads.update', { threadId, model: LLAMA });
    await runTurn(client, threadId, 'and again');
    await client.call('threads.update', { threadId, model: 'default' });
    await runTurn(client, threadId, 'back');
    expect(loggedLines('set_model ')).toEqual([LLAMA, QWEN, LLAMA, QWEN]);
    expect(loggedLines('initialize').length).toBe(2);
  });

  test('a session already on the thread model, or a thread on the agent own model, sends no set_model', async () => {
    const client = await startCore({ warmProcessMinutes: 0 });
    const { threadId, projectId, accountId } = await hermesThread(client, QWEN);
    await runTurn(client, threadId, 'hello');
    expect(fakeLog()).not.toContain('set_model');

    const own = await client.call('threads.create', { projectId, providerId: 'hermes-fake', accountId, title: 'own' });
    await client.call('threads.subscribe', { threadId: own.id });
    await runTurn(client, own.id, 'hello');
    expect(fakeLog()).not.toContain('set_model');
  });

  test('a cold turn loads the session and opens no second one to look for options', async () => {
    const client = await startCore({ warmProcessMinutes: 0 });
    const { threadId } = await hermesThread(client, LLAMA);
    await runTurn(client, threadId, 'remember the word apricot');
    const sessionId = (await client.call('threads.get', { threadId })).sessionId ?? '';
    await waitFor(() => harness?.core.procs.liveCount(threadId) === 0);

    await runTurn(client, threadId, 'second message');
    expect(loggedLines('loaded:')).toEqual([sessionId]);
    // The load listed the models: no throwaway session was opened beside it.
    expect(loggedLines('new:')).toHaveLength(2);
    // The probe's session and the thread's: the thread's survives.
    const thread = await client.call('threads.get', { threadId });
    expect(thread.sessionId).toBe(sessionId);
    expect(lastText(thread)).toBe('second message');
    // The replayed history did not land in the thread.
    expect(JSON.stringify(thread.messages)).not.toContain('replayed question');
  });

  test('a cold turn back on the agent own model asks for the configured default, not the model the session was left on', async () => {
    const client = await startCore({ warmProcessMinutes: 0 });
    const { threadId } = await hermesThread(client, LLAMA);
    await runTurn(client, threadId, 'first');
    await waitFor(() => harness?.core.procs.liveCount(threadId) === 0);

    await client.call('threads.update', { threadId, model: 'default' });
    await runTurn(client, threadId, 'second');
    expect(loggedLines('set_model ')).toEqual([LLAMA, QWEN]);
    expect(loggedLines('prompt ').at(-1)?.split(' ')[1]).toBe(QWEN);
  });

  test('with no probe of the account left, that cold turn reads the agent own model from a throwaway session', async () => {
    const client = await startCore({ warmProcessMinutes: 0 });
    const { threadId } = await hermesThread(client, LLAMA);
    await runTurn(client, threadId, 'first');
    await waitFor(() => harness?.core.procs.liveCount(threadId) === 0);
    // A reload of a changed descriptor drops the account's probe.
    const descriptorPath = join(harness?.dataDir ?? '', 'providers', 'hermes-fake.json');
    writeFileSync(descriptorPath, readFileSync(descriptorPath, 'utf8').replace('"Fake Hermes"', '"Fake Hermes reloaded"'), 'utf8');
    await client.call('providers.reload', {});
    const opened = loggedLines('new:').length;

    await client.call('threads.update', { threadId, model: 'default' });
    await runTurn(client, threadId, 'second');
    expect(loggedLines('new:')).toHaveLength(opened + 1);
    expect(loggedLines('set_model ')).toEqual([LLAMA, QWEN]);
    expect(loggedLines('prompt ').at(-1)?.split(' ')[1]).toBe(QWEN);
  });

  test('a load with a config option that is not the model still reads the agent own model', async () => {
    const client = await startCore({ warmProcessMinutes: 0 });
    const { threadId } = await hermesThread(client, LLAMA);
    await runTurn(client, threadId, 'first');
    await waitFor(() => harness?.core.procs.liveCount(threadId) === 0);
    const descriptorPath = join(harness?.dataDir ?? '', 'providers', 'hermes-fake.json');
    writeFileSync(descriptorPath, readFileSync(descriptorPath, 'utf8').replace('"Fake Hermes"', '"Fake Hermes reloaded"'), 'utf8');
    await client.call('providers.reload', {});

    process.env['HERMES_FAKE_LOAD_OPTION'] = '1';
    await client.call('threads.update', { threadId, model: 'default' });
    await runTurn(client, threadId, 'second');
    expect(loggedLines('set_model ')).toEqual([LLAMA, QWEN]);
    expect(loggedLines('prompt ').at(-1)?.split(' ')[1]).toBe(QWEN);
  });

  test('a refused lookup of the agent own model leaves the loaded session usable', async () => {
    const client = await startCore({ warmProcessMinutes: 0 });
    const { threadId } = await hermesThread(client, LLAMA);
    await runTurn(client, threadId, 'first');
    await waitFor(() => harness?.core.procs.liveCount(threadId) === 0);
    const descriptorPath = join(harness?.dataDir ?? '', 'providers', 'hermes-fake.json');
    writeFileSync(descriptorPath, readFileSync(descriptorPath, 'utf8').replace('"Fake Hermes"', '"Fake Hermes reloaded"'), 'utf8');
    await client.call('providers.reload', {});

    process.env['HERMES_FAKE_NEW_FAIL'] = '1';
    await client.call('threads.update', { threadId, model: 'default' });
    await runTurn(client, threadId, 'second');
    expect(loggedLines('new-refused')).toHaveLength(1);
    expect(loggedLines('loaded:')).toHaveLength(1);
    expect(loggedLines('prompt ').at(-1)?.split(' ')[1]).toBe(LLAMA);
  });

  test('with no probe left, a warm process going back to the agent own model reads it the same way', async () => {
    const client = await startCore({ warmProcessMinutes: 0 });
    const { threadId } = await hermesThread(client, LLAMA);
    await runTurn(client, threadId, 'first');
    await waitFor(() => harness?.core.procs.liveCount(threadId) === 0);
    const descriptorPath = join(harness?.dataDir ?? '', 'providers', 'hermes-fake.json');
    writeFileSync(descriptorPath, readFileSync(descriptorPath, 'utf8').replace('"Fake Hermes"', '"Fake Hermes reloaded"'), 'utf8');
    await client.call('providers.reload', {});
    await client.call('settings.set', { warmProcessMinutes: 5 });
    // Loaded on Llama, which the thread asks for: nothing to look up yet.
    await runTurn(client, threadId, 'second');
    const opened = loggedLines('new:').length;

    await client.call('threads.update', { threadId, model: 'default' });
    await runTurn(client, threadId, 'third');
    expect(loggedLines('initialize').length).toBe(3);
    expect(loggedLines('new:')).toHaveLength(opened + 1);
    expect(loggedLines('prompt ').at(-1)?.split(' ')[1]).toBe(QWEN);
  });

  test('a catalog read from a prepared, loaded session does not become the agent own model', async () => {
    const client = await startCore({ warmProcessMinutes: 0 });
    const { threadId, accountId } = await hermesThread(client, LLAMA);
    await runTurn(client, threadId, 'first');
    await waitFor(() => harness?.core.procs.liveCount(threadId) === 0);
    // A prepared process loads the session, left on Llama, and the picker
    // reads its catalog: there Llama is the current model.
    const core = harness!.core;
    const ctx = core.threads.contexts.makeSessionContext(core.threads.get(threadId), core.providers.require('hermes-fake'), core.accounts.require(accountId));
    const driver = getDriver('acp');
    driver.setViewed!(threadId, true);
    await driver.prepare!(ctx);
    expect(loggedLines('loaded:')).toHaveLength(1);
    const probed = await driver.probe!({
      catalogThread: ctx.thread, provider: ctx.provider, accountId, accountEnv: ctx.accountEnv, cwd: core.dataDir, log: ctx.log,
      spawnChild: (cmd, args, opts) => core.procs.spawnChild('hermes-catalog-probe', cmd, args, opts),
      killTree: () => { core.procs.killTree('hermes-catalog-probe'); },
    });
    expect(probed.models.find((model) => model.default === true && model.id !== 'default')?.id).toBe(LLAMA);
    driver.setViewed!(threadId, false);
    driver.releaseThread!(threadId);
    await waitFor(() => core.procs.liveCount(threadId) === 0);

    await client.call('threads.update', { threadId, model: 'default' });
    await runTurn(client, threadId, 'second');
    expect(loggedLines('set_model ')).toEqual([LLAMA, QWEN]);
    expect(loggedLines('prompt ').at(-1)?.split(' ')[1]).toBe(QWEN);
  });

  for (const probe of ['kept', 'dropped'] as const) test(`a load answered without models goes back to the agent own model, the account probe ${probe}`, async () => {
    const client = await startCore({ warmProcessMinutes: 0 });
    const { threadId } = await hermesThread(client, LLAMA);
    await runTurn(client, threadId, 'first');
    await waitFor(() => harness?.core.procs.liveCount(threadId) === 0);
    if (probe === 'dropped') {
      const descriptorPath = join(harness?.dataDir ?? '', 'providers', 'hermes-fake.json');
      writeFileSync(descriptorPath, readFileSync(descriptorPath, 'utf8').replace('"Fake Hermes"', '"Fake Hermes reloaded"'), 'utf8');
      await client.call('providers.reload', {});
    }

    process.env['HERMES_FAKE_LOAD_BARE'] = '1';
    await client.call('settings.set', { warmProcessMinutes: 5 });
    await client.call('threads.update', { threadId, model: 'default' });
    await runTurn(client, threadId, 'second');
    expect(loggedLines('set_model ')).toEqual([LLAMA, QWEN]);
    expect(loggedLines('prompt ').at(-1)?.split(' ')[1]).toBe(QWEN);
    // The same warm process then takes an explicit model.
    await client.call('threads.update', { threadId, model: LLAMA });
    await runTurn(client, threadId, 'third');
    expect(loggedLines('loaded:')).toHaveLength(1);
    expect(loggedLines('set_model ')).toEqual([LLAMA, QWEN, LLAMA]);
    expect(loggedLines('prompt ').at(-1)?.split(' ')[1]).toBe(LLAMA);
  });

  test('a load answered without models still moves the session to the thread model', async () => {
    const client = await startCore({ warmProcessMinutes: 0 });
    const { threadId } = await hermesThread(client, LLAMA);
    await runTurn(client, threadId, 'first');
    await waitFor(() => harness?.core.procs.liveCount(threadId) === 0);

    process.env['HERMES_FAKE_LOAD_BARE'] = '1';
    await client.call('threads.update', { threadId, model: QWEN });
    await runTurn(client, threadId, 'second');
    expect(loggedLines('loaded:')).toHaveLength(1);
    expect(loggedLines('set_model ')).toEqual([LLAMA, QWEN]);
    expect(loggedLines('prompt ').at(-1)?.split(' ')[1]).toBe(QWEN);
  });

  test('a load Hermes answers with no session is replaced in the same turn, carrying the history', async () => {
    const client = await startCore({ warmProcessMinutes: 0 });
    const { threadId } = await hermesThread(client);
    await runTurn(client, threadId, 'remember the word apricot');
    const forgotten = (await client.call('threads.get', { threadId })).sessionId ?? '';
    expect(forgotten.length).toBeGreaterThan(0);
    await waitFor(() => harness?.core.procs.liveCount(threadId) === 0);

    process.env['HERMES_FAKE_FORGET'] = '1';
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 20000);
    await client.call('turns.start', { threadId, prompt: 'second message' });
    const turn = await finished;
    expect(turn.error).toBeNull();
    expect(turn.status).toBe('done');
    expect(loggedLines('load-missing:')).toEqual([forgotten]);
    // Never a prompt on the id Hermes no longer has: that one stops as a refusal.
    expect(loggedLines(`prompt ${forgotten}`)).toHaveLength(1);

    const thread = await client.call('threads.get', { threadId });
    expect(thread.sessionId).not.toBe(forgotten);
    expect(thread.sessionGeneration).toBe(1);
    const text = lastText(thread);
    expect(text).toContain('<conversation-history>');
    expect(text).toContain('remember the word apricot');
    expect(text).toContain('second message');
  });

  test('the permission modes map onto default, accept_edits and dont_ask', async () => {
    const client = await startCore({ warmProcessMinutes: 5 });
    const { threadId } = await hermesThread(client);
    await runTurn(client, threadId, 'hello');
    // Already in `default`: nothing to send.
    expect(fakeLog()).not.toContain('set_mode');

    const wanted: [PermissionMode, string][] = [
      ['acceptEdits', 'accept_edits'],
      ['dontAsk', 'dont_ask'],
      ['default', 'default'],
    ];
    for (const [mode, modeId] of wanted) {
      await client.call('threads.update', { threadId, permissionMode: mode });
      await runTurn(client, threadId, `as ${mode}`);
      expect(loggedLines('set_mode ').at(-1)).toBe(modeId);
      expect(loggedLines('prompt ').at(-1)?.split(' ')[2]).toBe(modeId);
    }
  });

  test('a permission request with Hermes options is answered with allow_once or deny', async () => {
    const client = await startCore();
    const { threadId } = await hermesThread(client);
    for (const [decision, option] of [['allow', 'allow_once'], ['deny', 'deny']] as const) {
      const requested = client.next('permission.requested', (request) => request.threadId === threadId, 20000);
      const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 20000);
      await client.call('turns.start', { threadId, prompt: '[permission]' });
      const request = await requested;
      await client.call('permissions.answer', { requestId: request.id, decision });
      expect((await finished).status).toBe('done');
      expect(loggedLines('permission ').at(-1)).toBe(option);
    }
  });

  test('an image attachment reaches Hermes as an image block', async () => {
    const client = await startCore();
    const { threadId } = await hermesThread(client);
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 20000);
    await client.call('turns.start', {
      threadId,
      prompt: 'what is this',
      attachments: [{ kind: 'image', mimeType: 'image/png', data: PNG, name: 'pixel.png' }],
    });
    const done = await finished;
    expect(done.error).toBeNull();
    expect(loggedLines('image ')).toEqual(['image/png']);
  });
});
