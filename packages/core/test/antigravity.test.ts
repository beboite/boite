/**
 * Antigravity's half of the ACP driver, on a fake that speaks the real
 * protocol: every account isolated, the seed file and the browser no-op written
 * before anything spawns, the environment the agent needs carried into the
 * child and the user's own Google variables stripped out of it, and a sign-in
 * that is an `authenticate` call rather than a CLI.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'bun:test';
import type { Attachment, Settings, ThreadId } from '@boite/contracts';
import { readAntigravityQuota, type Fetch } from '../src/antigravity-quota.ts';
import type { CoreClient } from '../src/client.ts';
import { probeTimeoutMs } from '../src/drivers/acp/probe.ts';
import { antigravityCertificates, antigravitySubagentBatch } from '../src/drivers/antigravity.ts';
import { shareProfile, variableHome } from '../src/profile-share.ts';
import { profileFor } from '../src/providers/resolve.ts';
import { LAUNCH_TEMP_DIR } from '../src/drivers/launch-temp.ts';
import { startTestCore, waitFor } from './harness.ts';
import type { TestCore } from './harness.ts';
import { thrown } from './settle.ts';

/** The fake Antigravity server: a real ACP process over stdio, run by bun. */
const FAKE_AGENT = fileURLToPath(new URL('./fixtures/antigravity-agent.ts', import.meta.url));
const SEED_FILE = join('antigravity-acp', 'settings.json');
const SEED_BODY = '{"auth":{"type":"oauth-personal"}}';

let harness: TestCore | null = null;
let logFile = '';

afterEach(async () => {
  const open = harness;
  harness = null;
  delete process.env['AGY_FAKE_LOG'];
  delete process.env['GEMINI_API_KEY'];
  if (open !== null) await open.stop();
});

async function startCore(settings?: Partial<Settings>): Promise<CoreClient> {
  const started = await startTestCore(settings === undefined ? {} : { settings });
  harness = started;
  logFile = join(started.dataDir, 'agy-fake.log');
  process.env['AGY_FAKE_LOG'] = logFile;
  // The variable a user set for their own Gemini login: the descriptor unsets it.
  process.env['GEMINI_API_KEY'] = 'the-users-own-key';
  return started.connect();
}

function fakeLog(): string {
  return existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
}

function loggedEnv(name: string): string | null {
  const line = fakeLog()
    .split('\n')
    .find((entry) => entry.startsWith(`env ${name}=`));
  return line === undefined ? null : line.slice(`env ${name}=`.length);
}

/** The shipped descriptor's shape, pointed at the fake instead of the release. */
function writeDescriptor(dataDir: string): void {
  const dir = join(dataDir, 'providers');
  mkdirSync(dir, { recursive: true });
  const profile = {
    detect: {},
    executable: [{ kind: 'path', value: 'bun' }],
    launch: { args: [FAKE_AGENT] },
    isolation: { GEMINI_HOME: '{isolationDir}' },
    env: {
      AGY_ACP_FORCE_FILE_STORAGE: '1',
      ANTIGRAVITY_HARNESS_PATH: '{agentsDir}/localharness_external',
      PYTHONUNBUFFERED: '1',
      ELECTRON_RUN_AS_NODE: '1',
      BROWSER: '{browserNoop}',
    },
    unsetEnv: ['GEMINI_API_KEY'],
  };
  writeFileSync(
    join(dir, 'agy-fake.json'),
    JSON.stringify({
      id: 'agy-fake',
      schemaVersion: 1,
      name: 'Fake Antigravity',
      shortName: 'AgyFake',
      protocol: 'acp',
      roots: ['{isolationDir}'],
      profiles: { windows: profile, linux: profile, macos: profile },
      auth: { kind: 'oauth-cli', session: ['antigravity-acp/acp_token.json'] },
      login: { acp: { methodId: 'oauth-personal' } },
      isolation: { alwaysIsolated: true },
      seedFiles: { 'antigravity-acp/settings.json': SEED_BODY },
      quirks: ['antigravity'],
      models: [{ id: 'default', name: 'Antigravity default', default: true }],
      capabilities: {
        approvals: true,
        hooks: false,
        checkpoint: false,
        images: true,
        planMode: false,
        resume: true,
      },
    }),
    'utf8',
  );
}

async function agyAccount(client: CoreClient): Promise<{ id: string; isolationDir: string }> {
  const dataDir = harness?.dataDir ?? '';
  writeDescriptor(dataDir);
  const loaded = await client.call('providers.reload', {});
  expect(loaded.rejected).toEqual([]);
  // The user asked for the provider's own location, which this descriptor refuses.
  const account = await client.call('accounts.add', {
    providerId: 'agy-fake',
    label: 'Antigravity',
    useDefaultLocation: true,
  });
  expect(account.isolationDir).not.toBeNull();
  return { id: account.id, isolationDir: account.isolationDir ?? '' };
}

/** A signed-in account and a thread on it, subscribed. */
async function agyThread(client: CoreClient): Promise<{ accountId: string; threadId: ThreadId }> {
  const account = await agyAccount(client);
  writeFileSync(join(account.isolationDir, 'antigravity-acp', 'acp_token.json'), JSON.stringify({ access_token: 'fake', expiry: 0 }), 'utf8');
  expect((await client.call('accounts.check', { accountId: account.id })).status).toBe('ok');
  const projectDir = join(harness!.dataDir, 'project');
  mkdirSync(projectDir, { recursive: true });
  const project = await client.call('projects.add', { path: projectDir, name: 'agy' });
  const thread = await client.call('threads.create', { projectId: project.id, providerId: 'agy-fake', accountId: account.id, cwd: projectDir, title: 'agy' });
  await client.call('threads.subscribe', { threadId: thread.id });
  return { accountId: account.id, threadId: thread.id };
}

async function runTurn(client: CoreClient, threadId: ThreadId, prompt: string, attachments: Attachment[] = []): Promise<void> {
  const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 20_000);
  await client.call('turns.start', { threadId, prompt, attachments });
  expect((await finished).error).toBeNull();
}

describe('antigravity', () => {
  test('removing an account waits for its ACP login process and drops the lease', async () => {
    const client = await startCore();
    const account = await agyAccount(client);
    await client.call('accounts.login', { accountId: account.id });
    await waitFor(() => fakeLog().includes('callback:'), 20_000);
    expect(harness!.core.providers.installs.leaseCount('agy-fake')).toBe(1);
    await client.call('accounts.remove', { accountId: account.id });
    expect(harness!.core.providers.installs.leaseCount('agy-fake')).toBe(0);
    expect(existsSync(account.isolationDir)).toBe(false);
    expect(await client.call('accounts.logins', {})).toEqual([]);
  });
  test('every account is isolated, and the seed file and the browser no-op are written before any spawn', async () => {
    const client = await startCore();
    const account = await agyAccount(client);

    // T3 Code never uses the user's own IDE login, and neither does Boite: the
    // account has a home of its own even though the user asked for the default.
    expect(account.isolationDir.length).toBeGreaterThan(0);
    const seed = join(account.isolationDir, SEED_FILE);
    expect(existsSync(seed)).toBe(true);
    expect(readFileSync(seed, 'utf8')).toBe(SEED_BODY);

    // The launcher `BROWSER` points at, so the agent opens no window here.
    const dataDir = harness?.dataDir ?? '';
    const noop = join(dataDir, process.platform === 'win32' ? 'browser-noop.cmd' : 'browser-noop.sh');
    expect(existsSync(noop)).toBe(true);

    // No token yet: this is the account the Accounts page offers a login on.
    const accounts = await client.call('accounts.list', {});
    expect(accounts.find((entry) => entry.id === account.id)?.status).toBe('unauthenticated');
  });

  test('the sign-in link streams back, the pasted redirect finishes it, and the account is rechecked', async () => {
    const client = await startCore();
    const account = await agyAccount(client);

    const lines: string[] = [];
    const urls: string[] = [];
    const states: string[] = [];
    client.on('account.login', (event) => {
      if (event.accountId !== account.id) return;
      lines.push(event.output);
      if (event.url !== null) urls.push(event.url);
      states.push(event.state);
    });

    await client.call('accounts.login', { accountId: account.id });
    // The link the agent printed on stdout, as a line that is not JSON: the
    // driver kept it out of the protocol stream and handed it to the client.
    await waitFor(() => urls.length > 0, 20000);
    expect(urls[0]).toContain('https://accounts.google.com/');
    // The whole link, whichever stream brought it first: one cut at 400
    // characters asked Google for the scope `https://www.googleapis.`.
    expect(new URL(urls[0] ?? '').searchParams.get('scope')).toBe(
      'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile',
    );
    expect(urls[0]).toEndWith('&access_type=offline');
    expect(lines.some((line) => line.startsWith('Open the following link'))).toBe(true);

    // The agent carries the account's home, the flags it needs and none of the
    // user's own Google variables.
    expect(loggedEnv('GEMINI_HOME')).toBe(account.isolationDir);
    expect(loggedEnv('AGY_ACP_FORCE_FILE_STORAGE')).toBe('1');
    expect(loggedEnv('ANTIGRAVITY_HARNESS_PATH')).toContain('localharness_external');
    expect(loggedEnv('BROWSER')).toContain('browser-noop');
    expect(loggedEnv('GEMINI_API_KEY')).toBe('');

    // A pasted code is what a CLI login takes; this one takes the redirect URL.
    expect(await thrown(client.call('accounts.loginInput', { accountId: account.id, text: '1234-5678' }))).toThrow(
      /redirect URL/,
    );

    const callback = fakeLog()
      .split('\n')
      .find((line) => line.startsWith('callback:'))
      ?.slice('callback:'.length);
    expect(callback).toContain('http://127.0.0.1:');

    // A loopback URL that is not the one the agent announced is refused before
    // anything is fetched. Without the check, a paste was a GET at any port on
    // the user's machine, sent from the core.
    const elsewhere = new URL(callback ?? '');
    const otherPort = String(Number(elsewhere.port) + 1);
    expect(await thrown(client.call('accounts.loginInput', { accountId: account.id, text: `http://127.0.0.1:${otherPort}/oauth2callback?code=x` }))).toThrow(/this login listens on/);
    expect(await thrown(client.call('accounts.loginInput', { accountId: account.id, text: `http://127.0.0.1:${elsewhere.port}/admin/shutdown` }))).toThrow(/this login listens on/);

    await client.call('accounts.loginInput', { accountId: account.id, text: callback ?? '' });

    // The core fetched it, the agent's own listener saw the hit and answered
    // `authenticate` once it had written its token.
    await waitFor(() => states.includes('done') || states.includes('failed'), 20000);
    expect(states.at(-1)).toBe('done');
    expect(fakeLog()).toContain('authenticated');
    expect(existsSync(join(account.isolationDir, 'antigravity-acp', 'acp_token.json'))).toBe(true);

    const accounts = await client.call('accounts.list', {});
    expect(accounts.find((entry) => entry.id === account.id)?.status).toBe('ok');
  }, 40000);

  test('the sign-in lists the models from its own process, which unpacks in a folder that goes with it', async () => {
    const client = await startCore();
    const account = await agyAccount(client);
    // What a core stopped mid-launch left in the account's launch folders.
    const stale = join(account.isolationDir, LAUNCH_TEMP_DIR, 'run-stale');
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, 'base_library.zip'), 'unpacked');

    const probed = client.next('providers.probed', (event) => event.accountId === account.id, 20_000);
    const states: string[] = [];
    let announced = false;
    client.on('account.login', (event) => {
      if (event.accountId !== account.id) return;
      states.push(event.state);
      if (event.url !== null) announced = true;
    });
    await client.call('accounts.login', { accountId: account.id });
    // The core takes a redirect only once it has the link the agent printed.
    await waitFor(() => announced && fakeLog().includes('callback:'), 20_000);
    const callback = fakeLog().split('\n').find((line) => line.startsWith('callback:'))?.slice('callback:'.length) ?? '';
    await client.call('accounts.loginInput', { accountId: account.id, text: callback });
    await waitFor(() => states.includes('done') || states.includes('failed'), 20_000);
    expect(states.at(-1)).toBe('done');

    // The models came from the sign-in, and a probe after it starts nothing:
    // on a slow machine one launch of the real agent is a minute of unpacking.
    const ids = ['default', 'gemini-3.8-flash-high', 'gemini-3.7-flash-high', 'gemini-pro-agent'];
    expect((await probed).models.map((model) => model.id)).toEqual(ids);
    const probe = await client.call('providers.probe', { providerId: 'agy-fake', accountId: account.id });
    expect(probe.models.map((model) => model.id)).toEqual(ids);
    expect(fakeLog().split('\n').filter((line) => line === 'initialize')).toHaveLength(1);

    // That session opened in an empty folder, not the account's home.
    const sessionCwd = fakeLog().split('\n').find((line) => line.startsWith('new:'))?.slice('new:'.length) ?? '';
    expect(sessionCwd.length).toBeGreaterThan(0);
    expect(sessionCwd).not.toBe(account.isolationDir);

    // Every name a temp folder is read from points at this launch's own
    // folder, and that folder, the session's and the stale one all go.
    const temp = loggedEnv('TEMP') ?? '';
    expect(temp.startsWith(join(account.isolationDir, LAUNCH_TEMP_DIR, 'run-'))).toBe(true);
    expect([loggedEnv('TMP'), loggedEnv('TMPDIR')]).toEqual([temp, temp]);
    await waitFor(() => !existsSync(temp) && !existsSync(sessionCwd) && !existsSync(stale), 10_000);
  }, 40000);

  test('a probe of a signed-in account unpacks in its own folder, gone once it answered', async () => {
    const client = await startCore();
    const account = await agyAccount(client);
    const token = join(account.isolationDir, 'antigravity-acp', 'acp_token.json');
    writeFileSync(token, JSON.stringify({ access_token: 'fake', expiry: 0 }), 'utf8');
    expect((await client.call('accounts.check', { accountId: account.id })).status).toBe('ok');

    const probe = await client.call('providers.probe', { providerId: 'agy-fake', accountId: account.id });
    expect(probe.models.map((model) => model.id)).toContain('gemini-pro-agent');
    const temp = loggedEnv('TEMP') ?? '';
    expect(temp.startsWith(join(account.isolationDir, LAUNCH_TEMP_DIR, 'run-'))).toBe(true);
    await waitFor(() => !existsSync(temp), 10_000);
  }, 30000);

  test('a turn unpacks in its own folder, which goes with the process', async () => {
    // No warm process: the session's process ends with its turn.
    const client = await startCore({ warmProcessMinutes: 0 });
    const account = await agyAccount(client);
    writeFileSync(join(account.isolationDir, 'antigravity-acp', 'acp_token.json'), JSON.stringify({ access_token: 'fake', expiry: 0 }), 'utf8');
    expect((await client.call('accounts.check', { accountId: account.id })).status).toBe('ok');
    const projectDir = join(harness!.dataDir, 'project');
    mkdirSync(projectDir, { recursive: true });
    const project = await client.call('projects.add', { path: projectDir, name: 'agy' });
    const thread = await client.call('threads.create', { projectId: project.id, providerId: 'agy-fake', accountId: account.id, cwd: projectDir, title: 'agy' });
    await client.call('threads.subscribe', { threadId: thread.id });

    const finished = client.next('turn.finished', (turn) => turn.threadId === thread.id, 20_000);
    await client.call('turns.start', { threadId: thread.id, prompt: 'ping' });
    const done = await finished;
    expect(done.error).toBeNull();
    expect(fakeLog()).toContain('prompt:');
    const temp = loggedEnv('TEMP') ?? '';
    expect(temp.startsWith(join(account.isolationDir, LAUNCH_TEMP_DIR, 'run-'))).toBe(true);
    await waitFor(() => !existsSync(temp), 10_000);
  }, 30000);

  test('an agent that unpacks itself first gets longer to list its models than one that starts at once', async () => {
    const client = await startCore();
    await agyAccount(client);
    const unpacking = harness!.core.providers.require('agy-fake');
    // The real one took 45 to 54 s before its server read a line on an 8 GB laptop.
    expect(probeTimeoutMs(unpacking)).toBeGreaterThanOrEqual(90_000);
    expect(probeTimeoutMs({ ...unpacking, quirks: [] })).toBe(20_000);
  });
  test('a start_subagent or invoke_subagent launch lists its batch, unknown once the turn ended since its children report nothing; a failed launch keeps its error', async () => {
    const client = await startCore();
    const { threadId } = await agyThread(client);
    await runTurn(client, threadId, 'review with readers scenario:subagents');
    const agents = (await client.call('delegation.get', { threadId })).nativeAgents.filter((agent) => agent.source !== 'process');
    // The launch said only what it launched: once the turn ended, nobody knows
    // how its children fared. The MCP tool of the same title is no launch.
    expect(agents.map(({ id, status, task, result }) => ({ id: id.slice(id.lastIndexOf(':') + 1), status, task, result }))).toEqual([
      { id: '2', status: 'unknown', task: 'Launch readers', result: undefined },
      { id: '3', status: 'error', task: undefined, result: 'Subagent exceeded its limit.' },
      { id: '5', status: 'unknown', task: 'Launch reviewers', result: undefined },
    ]);
    // While the turn runs, a launch that returned stays running: its output is no child's answer.
    expect(antigravitySubagentBatch('t:2', 'done', 'Launch readers')).toEqual({ id: 't:2', status: 'running', task: 'Launch readers' });
  }, 30000);

  test('a command that outlived its turn is background work that keeps the process, and Stop ends both', async () => {
    // No warm process: only the running command keeps it.
    const client = await startCore({ warmProcessMinutes: 0 });
    const { threadId } = await agyThread(client);
    const background = client.next('thread.background', (event) => event.threadId === threadId && event.tasks.length > 0, 20_000);
    await runTurn(client, threadId, 'build it scenario:command');
    const [command] = (await background).tasks;
    expect(command).toMatchObject({ kind: 'shell', description: 'sleep 600' });
    expect(fakeLog().split('\n').filter((line) => line === 'initialize')).toHaveLength(1);

    // Another turn of the thread, never focused, runs on the same process: the command goes on.
    await runTurn(client, threadId, 'meanwhile');
    expect(fakeLog().split('\n').filter((line) => line === 'initialize')).toHaveLength(1);
    const history = (await client.call('threads.get', { threadId })).backgroundHistory ?? [];
    expect(history.find((task) => task.id === command!.id)?.state).toBe('running');

    const cleared = client.next('thread.background', (event) => event.threadId === threadId && event.tasks.length === 0, 20_000);
    expect((await client.call('turns.stop', { threadId })).stopped).toBe(true);
    await cleared;
    // The process went with the command: the next turn starts another one.
    await runTurn(client, threadId, 'again');
    expect(fakeLog().split('\n').filter((line) => line === 'initialize').length).toBeGreaterThan(1);
  }, 40000);

  test('a command that ends after its turn leaves the background list on its own', async () => {
    const client = await startCore();
    const { threadId } = await agyThread(client);
    const background = client.next('thread.background', (event) => event.threadId === threadId && event.tasks.length > 0, 20_000);
    const cleared = client.next('thread.background', (event) => event.threadId === threadId && event.tasks.length === 0, 20_000);
    await runTurn(client, threadId, 'build it scenario:short-command');
    await background;
    await cleared;
    const history = (await client.call('threads.get', { threadId })).backgroundHistory ?? [];
    expect(history.map((task) => task.state)).toEqual(['completed']);
  }, 30000);

  test('a GIF, which the server takes no block of, goes as a saved file beside the native PNG', async () => {
    const client = await startCore();
    const { threadId } = await agyThread(client);
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const gif = 'R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
    await runTurn(client, threadId, 'look', [
      { kind: 'image', mimeType: 'image/png', data: png, name: 'shot.png' },
      { kind: 'image', mimeType: 'image/gif', data: gif, name: 'clip.gif' },
    ]);
    const lines = fakeLog().split('\n');
    expect(lines.filter((line) => line.startsWith('block:'))).toEqual(['block:image:image/png']);
    expect(lines).toContain('prompt names a saved file');
  }, 30000);

  test('the quota merges both endpoints, so Gemini limits show when one endpoint leaves them out', async () => {
    await startCore();
    const home = join(harness!.dataDir, 'agy-home');
    mkdirSync(join(home, 'antigravity-acp'), { recursive: true });
    writeFileSync(join(home, 'antigravity-acp', 'acp_token.json'), JSON.stringify({ client_id: 'c', client_secret: 's', refresh_token: 'merge-refresh' }), 'utf8');
    const bucket = (bucketId: string, remainingFraction: number) => ({ bucketId, window: 'weekly', remainingFraction });
    const fakeFetch: Fetch = async (url) => {
      if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'merge-access', expires_in: 3600 });
      if (!url.endsWith(':retrieveUserQuotaSummary')) return new Response('', { status: 404 });
      // The daily endpoint answers with the Claude and GPT group alone.
      return url.startsWith('https://daily-')
        ? Response.json({ groups: [{ displayName: 'Claude and GPT', buckets: [bucket('3p-weekly', 0.4)] }] })
        : Response.json({ groups: [{ displayName: 'Gemini', buckets: [bucket('gemini-weekly', 0.75)] }, { displayName: 'Claude and GPT', buckets: [bucket('3p-weekly', 0.9)] }] });
    };
    const windows = await readAntigravityQuota(home, fakeFetch);
    expect(windows.map((row) => [row.label, Math.round(row.usedPercent)])).toEqual([['Claude and GPT · Weekly', 60], ['Gemini · Weekly', 25]]);
  });

  test('on Linux the server is named a CA bundle that exists, unless the user names one', async () => {
    const exists = (path: string): boolean => path === '/etc/ssl/certs/ca-certificates.crt' || path === '/nix/store/ca.crt';
    expect(antigravityCertificates('linux', {}, exists)).toEqual({ SSL_CERT_FILE: '/etc/ssl/certs/ca-certificates.crt' });
    expect(antigravityCertificates('linux', { NIX_SSL_CERT_FILE: '/nix/store/ca.crt' }, exists)).toEqual({ SSL_CERT_FILE: '/nix/store/ca.crt' });
    expect(antigravityCertificates('linux', { NIX_SSL_CERT_FILE: 'relative.crt' }, exists)).toEqual({ SSL_CERT_FILE: '/etc/ssl/certs/ca-certificates.crt' });
    expect(antigravityCertificates('linux', { SSL_CERT_FILE: '/mine.pem' }, exists)).toEqual({});
    expect(antigravityCertificates('linux', { SSL_CERT_DIR: '/certs' }, exists)).toEqual({});
    expect(antigravityCertificates('windows', {}, exists)).toEqual({});
    expect(antigravityCertificates('linux', {}, () => false)).toEqual({});
    // The agent itself gets what this machine has.
    const client = await startCore();
    const { threadId } = await agyThread(client);
    await runTurn(client, threadId, 'ping');
    const os = process.platform === 'linux' ? 'linux' : 'other';
    expect(loggedEnv('SSL_CERT_FILE')).toBe(process.env['SSL_CERT_FILE'] ?? antigravityCertificates(os, process.env, existsSync)['SSL_CERT_FILE'] ?? '');
  }, 30000);
  test('the user\'s own skills under ~/.gemini reach every account, whose GEMINI_HOME is its own', async () => {
    await startCore();
    const shipped = harness!.core.providers.require('antigravity');
    const profile = profileFor(shipped);
    expect(profile).toBeDefined();
    const before = process.env['GEMINI_HOME'];
    delete process.env['GEMINI_HOME'];
    // Unset, the variable means the agent's own default.
    expect(variableHome('GEMINI_HOME')).toBe(join(homedir(), '.gemini'));
    const own = join(harness!.dataDir, 'own-gemini');
    const account = join(harness!.dataDir, 'accounts', 'acc_agy');
    mkdirSync(join(own, 'config', 'skills', 'review'), { recursive: true });
    mkdirSync(join(own, 'antigravity-cli', 'skills', 'deploy'), { recursive: true });
    writeFileSync(join(own, 'config', 'skills', 'review', 'SKILL.md'), 'review');
    writeFileSync(join(own, 'antigravity-cli', 'skills', 'deploy', 'SKILL.md'), 'deploy');
    // Neither the user's MCP servers nor anything else of that home is shared.
    writeFileSync(join(own, 'mcp_config.json'), '{}');
    mkdirSync(account, { recursive: true });
    process.env['GEMINI_HOME'] = own;
    try {
      expect(shareProfile(account, profile!, shipped.shared ?? [])).toEqual([]);
    } finally {
      if (before === undefined) delete process.env['GEMINI_HOME'];
      else process.env['GEMINI_HOME'] = before;
    }
    expect(readFileSync(join(account, 'config', 'skills', 'review', 'SKILL.md'), 'utf8')).toBe('review');
    expect(readFileSync(join(account, 'antigravity-cli', 'skills', 'deploy', 'SKILL.md'), 'utf8')).toBe('deploy');
    expect(existsSync(join(account, 'mcp_config.json'))).toBe(false);
  });
});
