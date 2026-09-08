/**
 * Grok's half of the ACP driver, on a fake that speaks the real dialect: the
 * shipped descriptor, the models and their per-model effort scales read out of
 * `session/new`, the thread's model and effort sent back as one
 * `session/set_model`, the permission mode spliced onto the command line
 * because the agent advertises no session modes, and the agent's own `_x.ai/*`
 * notifications ignored without a word.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'bun:test';
import type { PermissionMode, Settings } from '@boite/contracts';
import type { CoreClient } from '../src/client.ts';
import { startTestCore, waitFor } from './harness.ts';
import type { TestCore } from './harness.ts';

/** The fake Grok agent: a real ACP process over stdio, run by bun. */
const FAKE_AGENT = fileURLToPath(new URL('./fixtures/grok-agent.ts', import.meta.url));
/** The shipped descriptor's own launch line, which the fixture is given verbatim. */
const LAUNCH_ARGS = ['agent', 'stdio'];

let harness: TestCore | null = null;
let logFile = '';

afterEach(async () => {
  const open = harness;
  harness = null;
  delete process.env['GROK_FAKE_LOG'];
  delete process.env['XAI_API_KEY'];
  if (open !== null) await open.stop();
});

async function startCore(settings?: Partial<Settings>): Promise<CoreClient> {
  const started = await startTestCore(settings === undefined ? {} : { settings });
  harness = started;
  logFile = join(started.dataDir, 'grok-fake.log');
  process.env['GROK_FAKE_LOG'] = logFile;
  // A key the user set for their own xAI calls: the descriptor unsets it.
  process.env['XAI_API_KEY'] = 'the-users-own-key';
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
    isolation: { GROK_HOME: '{isolationDir}' },
    env: { NO_COLOR: '1', GROK_FEEDBACK_ENABLED: '0' },
    unsetEnv: ['XAI_API_KEY'],
  };
  writeFileSync(
    join(dir, 'grok-fake.json'),
    JSON.stringify({
      id: 'grok-fake',
      schemaVersion: 1,
      name: 'Fake Grok',
      shortName: 'GrokFake',
      protocol: 'acp',
      roots: ['{isolationDir}'],
      profiles: { windows: profile, linux: profile, macos: profile },
      auth: { kind: 'none' },
      quirks: ['grok'],
      models: [{ id: 'default', name: 'Grok default', default: true }],
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

async function grokAccount(client: CoreClient): Promise<{ dataDir: string; projectId: string; accountId: string }> {
  const dataDir = harness?.dataDir ?? '';
  writeDescriptor(dataDir);
  const loaded = await client.call('providers.reload', {});
  expect(loaded.rejected).toEqual([]);
  expect(loaded.loaded.some((provider) => provider.id === 'grok-fake' && provider.available)).toBe(true);

  const project = await client.call('projects.add', { path: dataDir, name: 'grok' });
  const account = await client.call('accounts.add', {
    providerId: 'grok-fake',
    label: 'Fake',
    useDefaultLocation: true,
  });
  return { dataDir, projectId: project.id, accountId: account.id };
}

async function grokThread(client: CoreClient, model?: string, effort?: string): Promise<string> {
  const { projectId, accountId } = await grokAccount(client);
  // A model the descriptor does not carry is only accepted once the agent has
  // listed it, which is what the picker does before it offers it.
  if (model !== undefined && model !== 'default') {
    await client.call('providers.probe', { providerId: 'grok-fake', accountId });
  }
  const thread = await client.call('threads.create', {
    projectId,
    providerId: 'grok-fake',
    accountId,
    title: 'grok thread',
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
  });
  await client.call('threads.subscribe', { threadId: thread.id });
  return thread.id;
}

async function runTurn(client: CoreClient, threadId: string, prompt: string): Promise<void> {
  const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 20000);
  await client.call('turns.start', { threadId, prompt });
  const done = await finished;
  expect(done.error).toBeNull();
  expect(done.status).toBe('done');
}

describe('grok', () => {
  test('the shipped descriptor loads: acp, the grok quirk, and the plain launch line', async () => {
    const client = await startCore();
    await client.call('providers.list', {});
    const descriptor = harness?.core.providers.require('grok');
    expect(descriptor).toBeDefined();
    if (descriptor === undefined) return;

    expect(descriptor.protocol).toBe('acp');
    expect(descriptor.quirks).toEqual(['grok']);
    expect(descriptor.auth.session).toEqual(['auth.json']);
    expect(descriptor.login?.command).toEqual(['grok', 'login', '--device-auth']);
    expect(descriptor.models).toEqual([{ id: 'default', name: 'Grok default', default: true }]);
    // `plan` is one of the values the CLI's own `--permission-mode` takes.
    expect(descriptor.capabilities.planMode).toBe(true);

    for (const os of ['windows', 'linux', 'macos'] as const) {
      const profile = descriptor.profiles[os];
      // Neither the model nor the effort is here: both go out as a
      // `session/set_model`, and the permission mode is spliced in at spawn.
      expect(profile?.launch?.args).toEqual(LAUNCH_ARGS);
      expect(profile?.isolation).toEqual({ GROK_HOME: '{isolationDir}' });
      expect(profile?.env).toEqual({ NO_COLOR: '1', GROK_FEEDBACK_ENABLED: '0' });
      // The eleven variables that could send the agent somewhere else.
      expect(profile?.unsetEnv).toEqual([
        'XAI_API_KEY',
        'GROK_AUTH_PROVIDER_COMMAND',
        'GROK_AUTH_TOKEN_TTL',
        'GROK_OIDC_ISSUER',
        'GROK_OIDC_CLIENT_ID',
        'GROK_CLI_CHAT_PROXY_BASE_URL',
        'GROK_MODELS_BASE_URL',
        'GROK_MODELS_LIST_URL',
        'GROK_AGENT',
        'GROK_SANDBOX',
        'GROK_DEPLOYMENT_KEY',
      ]);
      // `GROK_HOME` is not unset: on the default account the user's own one is
      // the login Boite is meant to read.
      expect(profile?.unsetEnv).not.toContain('GROK_HOME');
    }

    // The binary the CLI installs under the user's home, then PATH.
    const windows = descriptor.profiles.windows?.executable ?? [];
    expect(windows[0]?.kind).toBe('file');
    expect(windows[0]?.value.endsWith(join(homedir(), '.grok', 'bin', 'grok.exe'))).toBe(true);
    expect(windows[1]).toEqual({ kind: 'path', value: 'grok' });
  });

  test('a probe lists the models the agent sent, each with its own effort scale', async () => {
    const client = await startCore();
    const { accountId } = await grokAccount(client);

    const probed = client.next(
      'providers.probed',
      (event) => event.providerId === 'grok-fake' && event.accountId === accountId,
      20000,
    );
    const result = await client.call('providers.probe', { providerId: 'grok-fake', accountId });

    expect(result.models.map((model) => model.id)).toEqual(['default', 'grok-4.6', 'grok-4.5']);
    // The descriptor's own model stays first, never the default, and has no
    // effort: it means the agent keeps whatever it is configured with.
    expect(result.models[0]).toEqual({ id: 'default', name: 'Grok default', default: false });
    expect(result.models.find((model) => model.default === true)?.id).toBe('grok-4.6');

    // Unlike an ACP `thought_level`, the scale is the model's own.
    expect(result.models[1]?.effort).toEqual({
      levels: [
        { id: 'xhigh', label: 'Extra High Effort', description: 'Highest effort' },
        { id: 'high', label: 'High Effort', description: 'Extensive reasoning' },
        { id: 'medium', label: 'Medium Effort', description: 'Balanced' },
        { id: 'low', label: 'Low Effort', description: 'Quick' },
      ],
      default: 'high',
    });
    expect(result.models[2]?.effort?.levels.map((level) => level.id)).toEqual(['high', 'medium', 'low']);
    expect(result.models[2]?.effort?.default).toBe('high');
    expect(result.probedAt).toBeGreaterThan(0);
    expect((await probed).models.map((model) => model.id)).toEqual(['default', 'grok-4.6', 'grok-4.5']);

    // A probe has no thread and no mode: it launches the declared line and
    // chooses nothing.
    expect(loggedLines('argv:')).toEqual(['agent stdio']);
    expect(fakeLog()).not.toContain('set_model');

    // Nothing of the probe is left running.
    const probeThread = `probe:grok-fake:${accountId}`;
    await waitFor(() => harness?.core.procs.liveCount(probeThread) === 0);
    const trace = await client.call('trace.get', { threadId: probeThread });
    expect(trace.length).toBeGreaterThan(0);
    expect(trace.filter((record) => record.exitedAt === null)).toEqual([]);
  });

  test('the model and the effort go out as one session/set_model, never as a config option', async () => {
    const client = await startCore({ warmProcessMinutes: 0 });
    const threadId = await grokThread(client, 'grok-4.5', 'medium');

    await runTurn(client, threadId, 'hello');

    expect(loggedLines('set_model ')).toEqual(['grok-4.5 medium']);
    // Neither of them rides on the command line; the permission mode does.
    expect(loggedLines('argv:').at(-1)).toBe('--permission-mode default agent stdio');
    // Grok has no `session/set_config_option`; the fixture would log the call.
    expect(fakeLog()).not.toContain('set_config_option');

    // The account's home and the two fixed variables reach the agent, and the
    // user's own key does not.
    expect(loggedLines('env NO_COLOR=').at(-1)).toBe('1');
    expect(loggedLines('env GROK_FEEDBACK_ENABLED=').at(-1)).toBe('0');
    expect(loggedLines('env XAI_API_KEY=').at(-1)).toBe('');
  });

  test('a thread on the model "default" with no effort says nothing about models', async () => {
    const client = await startCore({ warmProcessMinutes: 0 });
    const threadId = await grokThread(client);
    expect((await client.call('threads.get', { threadId })).model).toBe('default');

    await runTurn(client, threadId, 'hello');
    // No probe on this path: the turn's process is the only one.
    expect(loggedLines('argv:')).toEqual(['--permission-mode default agent stdio']);
    expect(fakeLog()).not.toContain('set_model');
  });

  test('a model with no effort set is chosen on its own, with no _meta', async () => {
    const client = await startCore({ warmProcessMinutes: 0 });
    const threadId = await grokThread(client, 'grok-4.5');

    await runTurn(client, threadId, 'hello');
    expect(loggedLines('set_model ')).toEqual(['grok-4.5']);
  });

  test('the session already on that model and that effort is left alone', async () => {
    const client = await startCore({ warmProcessMinutes: 0 });
    // What the fixture answers with: `currentModelId` is grok-4.6 and that
    // model's own `_meta.reasoningEffort` is high.
    const threadId = await grokThread(client, 'grok-4.6', 'high');

    await runTurn(client, threadId, 'hello');
    expect(fakeLog()).not.toContain('set_model');
  });

  test('the permission mode is spliced onto the command line, all five of them', async () => {
    const client = await startCore({ warmProcessMinutes: 0 });
    const { projectId, accountId } = await grokAccount(client);

    const wanted: [PermissionMode, string][] = [
      ['default', '--permission-mode default agent stdio'],
      ['acceptEdits', '--permission-mode acceptEdits agent stdio'],
      ['plan', '--permission-mode plan agent stdio'],
      ['bypassPermissions', 'agent --always-approve stdio'],
      ['dontAsk', 'agent --always-approve stdio'],
    ];

    for (const [mode] of wanted) {
      const thread = await client.call('threads.create', {
        projectId,
        providerId: 'grok-fake',
        accountId,
        title: `grok ${mode}`,
        permissionMode: mode,
      });
      await client.call('threads.subscribe', { threadId: thread.id });
      await runTurn(client, thread.id, 'hello');
    }

    expect(loggedLines('argv:')).toEqual(wanted.map(([, argv]) => argv));
  });

  test('a mode changed on a warm thread drops the process, because it is on the argv', async () => {
    const client = await startCore({ warmProcessMinutes: 5 });
    const threadId = await grokThread(client);

    await runTurn(client, threadId, 'first');
    await client.call('threads.update', { threadId, permissionMode: 'plan' });
    await runTurn(client, threadId, 'second');

    expect(loggedLines('argv:')).toEqual([
      '--permission-mode default agent stdio',
      '--permission-mode plan agent stdio',
    ]);
  });

  test('two turns on a cold process: the second resumes through session/load', async () => {
    const client = await startCore({ warmProcessMinutes: 0 });
    const threadId = await grokThread(client, 'grok-4.6', 'xhigh');

    await runTurn(client, threadId, 'first');
    const first = await client.call('threads.get', { threadId });
    const sessionId = first.sessionId ?? '';
    expect(sessionId).not.toBe('');

    await runTurn(client, threadId, 'second');
    await waitFor(() => fakeLog().includes(`loaded:${sessionId}`));
    expect((await client.call('threads.get', { threadId })).sessionId).toBe(sessionId);
    // A process per turn plus the probe, every one of them on the same argv.
    const argv = loggedLines('argv:');
    expect(argv).toHaveLength(3);
    expect(argv.slice(1)).toEqual([
      '--permission-mode default agent stdio',
      '--permission-mode default agent stdio',
    ]);
    // A `session/load` says nothing about models, so the loaded session is put
    // on the thread's pair the same way the new one was.
    expect(loggedLines('set_model ')).toEqual(['grok-4.6 xhigh', 'grok-4.6 xhigh']);
  });

  test("the agent's own _x.ai notifications are ignored without a word", async () => {
    const client = await startCore();
    const logs: string[] = [];
    client.on('core.log', (entry) => {
      logs.push(`${entry.level} ${entry.message}`);
    });
    const threadId = await grokThread(client);

    await runTurn(client, threadId, 'hello');
    expect(logs.filter((line) => line.includes('_x.ai'))).toEqual([]);
    // The mode went out on the argv, so there is no call, and no warning about
    // an agent that lists no modes either.
    expect(fakeLog()).not.toContain('set_mode');
    expect(logs.filter((line) => line.includes('no session mode matches'))).toEqual([]);
  });

  test('a permission is asked and answered, and the tool call is drawn', async () => {
    const client = await startCore();
    const threadId = await grokThread(client);

    const requested = client.next('permission.requested', (request) => request.threadId === threadId, 20000);
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 20000);
    await client.call('turns.start', { threadId, prompt: '[permission]' });

    const request = await requested;
    expect(request.toolName).toBe('bash');
    await client.call('permissions.answer', { requestId: request.id, decision: 'allow' });
    expect((await finished).status).toBe('done');

    const thread = await client.call('threads.get', { threadId });
    const parts = thread.messages[thread.messages.length - 1]?.parts ?? [];
    const text = parts.find((part) => part.type === 'text');
    expect(text?.type === 'text' ? text.text : '').toBe('allowed');
    expect(parts.find((part) => part.type === 'permission')).toMatchObject({ toolName: 'bash', decision: 'allow' });
    expect(parts.some((part) => part.type === 'thinking')).toBe(true);
  });
});
