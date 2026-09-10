/**
 * Antigravity's half of the ACP driver, on a fake that speaks the real
 * protocol: every account isolated, the seed file and the browser no-op written
 * before anything spawns, the environment the agent needs carried into the
 * child and the user's own Google variables stripped out of it, and a sign-in
 * that is an `authenticate` call rather than a CLI.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'bun:test';
import type { CoreClient } from '../src/client.ts';
import { startTestCore, waitFor } from './harness.ts';
import type { TestCore } from './harness.ts';

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

async function startCore(): Promise<CoreClient> {
  const started = await startTestCore();
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
    expect(lines.some((line) => line.startsWith('Open the following link'))).toBe(true);

    // The agent carries the account's home, the flags it needs and none of the
    // user's own Google variables.
    expect(loggedEnv('GEMINI_HOME')).toBe(account.isolationDir);
    expect(loggedEnv('AGY_ACP_FORCE_FILE_STORAGE')).toBe('1');
    expect(loggedEnv('ANTIGRAVITY_HARNESS_PATH')).toContain('localharness_external');
    expect(loggedEnv('BROWSER')).toContain('browser-noop');
    expect(loggedEnv('GEMINI_API_KEY')).toBe('');

    // A pasted code is what a CLI login takes; this one takes the redirect URL.
    await expect(client.call('accounts.loginInput', { accountId: account.id, text: '1234-5678' })).rejects.toThrow(
      /redirect URL/,
    );

    const callback = fakeLog()
      .split('\n')
      .find((line) => line.startsWith('callback:'))
      ?.slice('callback:'.length);
    expect(callback).toContain('http://127.0.0.1:');
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
});
