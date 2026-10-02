import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { CoreClient } from '../src/client.ts';
import { Core } from '../src/core.ts';
import { setDriver } from '../src/drivers/index.ts';
import { startTestCore, waitFor } from './harness.ts';
import type { TestCore } from './harness.ts';

const ECHO_LOGIN_SCRIPT = fileURLToPath(new URL('../src/providers/shipped/echo-login.ts', import.meta.url));
// A Claude login on macOS may be in the Keychain, so a missing file proves nothing there.
const CLAUDE_SIGNED_OUT = process.platform === 'darwin' ? 'unknown' : 'unauthenticated';

/**
 * The shipped echo provider needs no login (`auth.kind` is "none"), so it can
 * never be unauthenticated. This user descriptor is the same fake agent with a
 * session file to earn: it is what the login flow is proved on, and it drives
 * the same script `echo.json` names.
 */
async function addLoginProvider(harness: TestCore, client: CoreClient): Promise<string> {
  const dir = join(harness.dataDir, 'providers');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'echo-auth.json'),
    JSON.stringify({
      id: 'echo-auth',
      schemaVersion: 1,
      name: 'Echo with a login',
      shortName: 'EchoAuth',
      protocol: 'echo',
      roots: ['{isolationDir}'],
      profiles: {
        windows: { detect: {}, executable: [], isolation: { BOITE_ECHO_CONFIG_DIR: '{isolationDir}' } },
        linux: { detect: {}, executable: [], isolation: { BOITE_ECHO_CONFIG_DIR: '{isolationDir}' } },
        macos: { detect: {}, executable: [], isolation: { BOITE_ECHO_CONFIG_DIR: '{isolationDir}' } },
      },
      auth: { kind: 'oauth-cli', session: ['.credentials.json'] },
      login: { command: ['bun', ECHO_LOGIN_SCRIPT] },
      models: [{ id: 'echo', name: 'Echo', default: true }],
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
  const loaded = await client.call('providers.reload', {});
  expect(loaded.rejected).toEqual([]);
  expect(loaded.loaded.some((provider) => provider.id === 'echo-auth')).toBe(true);
  return 'echo-auth';
}

let harness: TestCore;

beforeEach(async () => {
  harness = await startTestCore();
});

afterEach(async () => {
  await harness.stop();
});

describe('accounts', () => {
  test('removing an account stops discovery processes that still use its directory', async () => {
    const client = await harness.connect();
    const providerId = await addLoginProvider(harness, client);
    const account = await client.call('accounts.add', { providerId, label: 'Failed account' });
    const restore = setDriver('echo', {
      protocol: 'echo',
      startTurn: () => { throw new Error('not a turn'); },
      probe: async ctx => {
        const child = ctx.spawnChild(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: account.isolationDir! });
        await new Promise<void>(resolve => child.once('close', () => resolve()));
        return { models: [], probedAt: Date.now() };
      },
    });
    const probing = client.call('providers.probe', { providerId, accountId: account.id }).then(() => 'completed', () => 'refused');
    try {
      await waitFor(() => harness.core.procs.liveCount(`probe:${providerId}:${account.id}`) === 1);
      await client.call('accounts.remove', { accountId: account.id });
      expect(harness.core.procs.liveCount(`probe:${providerId}:${account.id}`)).toBe(0);
      expect(await probing).toBe('refused');
      expect(existsSync(account.isolationDir!)).toBe(false);
    } finally {
      await harness.core.procs.stopAndWait(`probe:${providerId}:${account.id}`);
      restore();
    }
  });

  test('piped sign-in links and output contain no terminal control sequences', async () => {
    const client = await harness.connect();
    const providerId = await addLoginProvider(harness, client);
    const script = join(harness.dataDir, 'colored-login.ts');
    writeFileSync(script, `console.log('\\x1b[4mhttps://example.invalid/device\\x1b[0m');`);
    harness.core.providers.require(providerId).login = { command: [process.execPath, script] };
    const account = await client.call('accounts.add', { providerId, label: 'Colored login' });
    const line = client.next('account.login', event => event.accountId === account.id && event.url !== null);
    await client.call('accounts.login', { accountId: account.id });
    expect(await line).toMatchObject({ url: 'https://example.invalid/device', output: 'https://example.invalid/device' });
  });

  test('a refused Claude sign-in releases the account without waiting for an auth check', async () => {
    const client = await harness.connect();
    const providerId = await addLoginProvider(harness, client);
    const descriptor = harness.core.providers.require(providerId);
    descriptor.protocol = 'claude-sdk';
    const login = join(harness.dataDir, 'refused-login.ts');
    const status = join(harness.dataDir, 'waiting-status.ts');
    writeFileSync(login, "console.error('Sign-in denied'); process.exit(1);");
    writeFileSync(status, 'setInterval(() => {}, 1000);');
    descriptor.login = { command: [process.execPath, login] };
    for (const profile of Object.values(descriptor.profiles)) {
      if (profile) { profile.executable = [{ kind: 'file', value: process.execPath }]; profile.launch = { args: [status] }; }
    }
    const account = await client.call('accounts.add', { providerId, label: 'Refused login' });
    const finished = client.next('account.login', event => event.accountId === account.id && event.state === 'failed', 5000);
    await client.call('accounts.login', { accountId: account.id });
    expect(await finished).toMatchObject({ output: 'Sign-in denied', exitCode: 1 });
    expect(await client.call('accounts.logins', {})).toEqual([]);
    await client.call('accounts.remove', { accountId: account.id });
    expect(existsSync(account.isolationDir!)).toBe(false);
    expect(harness.core.providers.installs.leaseCount(providerId)).toBe(0);
  });

  test('a fresh Claude check reads the CLI login and email instead of trusting a session file', async () => {
    const client = await harness.connect();
    const providerId = await addLoginProvider(harness, client);
    const descriptor = harness.core.providers.require(providerId);
    descriptor.protocol = 'claude-sdk';
    const script = join(harness.dataDir, 'claude-auth-status.ts');
    writeFileSync(script, `console.log(JSON.stringify({ loggedIn: process.argv.includes('--json'), email: 'work@example.com' }));`);
    for (const profile of Object.values(descriptor.profiles)) {
      if (profile) { profile.executable = [{ kind: 'path', value: 'bun' }]; profile.launch = { args: [script] }; }
    }
    const account = await client.call('accounts.add', { providerId, label: 'Claude check' });
    expect(account.status).toBe('unauthenticated');
    expect(await client.call('accounts.check', { accountId: account.id, refresh: true })).toMatchObject({ status: 'ok', identity: 'work@example.com' });
    harness.core.accounts.authenticationFailed(account.id);
    expect((await client.call('accounts.check', { accountId: account.id })).status).toBe('unauthenticated');
    expect(await client.call('accounts.check', { accountId: account.id, refresh: true })).toMatchObject({ status: 'ok', identity: 'work@example.com' });
    // The fresh CLI answer also clears the persisted refusal for later passive reads.
    writeFileSync(join(account.isolationDir!, '.credentials.json'), '{}');
    expect((await client.call('accounts.check', { accountId: account.id })).status).toBe('ok');
    expect(harness.core.procs.liveCount(`check:${account.id}`)).toBe(0);
    expect(harness.core.providers.installs.leaseCount(providerId)).toBe(0);
  });

  test('renaming preserves the account and broadcasts the trimmed label', async () => {
    const client = await harness.connect();
    const account = await client.call('accounts.add', { providerId: 'echo', label: 'Before' });
    const updated = client.next('accounts.updated', entry => entry.id === account.id && entry.label === 'Work');
    expect(await client.call('accounts.rename', { accountId: account.id, label: ' Work ' })).toEqual({ ...account, label: 'Work' });
    expect((await updated).label).toBe('Work');
    await expect(client.call('accounts.rename', { accountId: account.id, label: ' ' })).rejects.toThrow('label');
    expect(harness.core.accounts.require(account.id).label).toBe('Work');
  });

  test('first start creates one default account per available provider', async () => {
    const client = await harness.connect();
    const accounts = await client.call('accounts.list', {});
    const echo = accounts.find((account) => account.providerId === 'echo');
    expect(echo).toBeDefined();
    expect(echo?.label).toBe('Default');
    expect(echo?.isolationDir).toBeNull();
    expect(echo?.status).toBe('ok');
  });

  test('a removed terminal default stays removed even when its CLI signs in later', async () => {
    const client = await harness.connect();
    const providerId = await addLoginProvider(harness, client);
    const provider = harness.core.providers.require(providerId);
    for (const profile of Object.values(provider.profiles)) {
      if (profile) profile.executable = [{ kind: 'path', value: 'bun' }];
    }
    const own = join(harness.dataDir, 'own-cli');
    const defaultLocation = harness.core.accounts.defaultLocation.bind(harness.core.accounts);
    harness.core.accounts.defaultLocation = entry => entry.id === providerId ? own : defaultLocation(entry);
    harness.core.accounts.ensureDefaults();
    expect(harness.core.accounts.list().filter(account => account.providerId === providerId)).toEqual([]);
    provider.login!.terminal = true;
    harness.core.accounts.ensureDefaults();
    const account = harness.core.accounts.list().find(entry => entry.providerId === providerId)!;
    expect(account).toMatchObject({ label: 'Default', isolationDir: null, status: 'unauthenticated' });
    await client.call('accounts.remove', { accountId: account.id });
    provider.login!.terminal = false;
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, '.credentials.json'), '{}');
    harness.core.accounts.ensureDefaults();
    harness.core.accounts.ensureDefaults();
    expect(harness.core.accounts.list().filter(entry => entry.providerId === providerId)).toEqual([]);
    expect(readFileSync(join(own, '.credentials.json'), 'utf8')).toBe('{}');
    const isolated = await client.call('accounts.add', { providerId, label: 'New sign-in' });
    expect(isolated.isolationDir).not.toBeNull();
    await client.call('accounts.remove', { accountId: isolated.id });
    harness.core.accounts.ensureDefaults();
    expect(harness.core.accounts.list().filter(entry => entry.providerId === providerId)).toEqual([]);
    const restored = await client.call('accounts.add', { providerId, label: 'My CLI', useDefaultLocation: true });
    expect(restored).toMatchObject({ isolationDir: null, status: 'ok' });
    harness.core.accounts.ensureDefaults();
    expect(harness.core.accounts.list().filter(entry => entry.providerId === providerId)).toEqual([restored]);
  });

  test('removing a default survives provider reloads and core restart without disabling other providers', async () => {
    const client = await harness.connect();
    const account = harness.core.accounts.list().find(entry => entry.providerId === 'echo')!;
    await client.call('accounts.remove', { accountId: account.id });
    for (let i = 0; i < 2; i++) await client.call('providers.reload', {});
    expect(harness.core.accounts.list().filter(entry => entry.providerId === 'echo')).toEqual([]);
    expect(harness.core.providers.available().some(provider => provider.id === 'echo')).toBe(true);
    const providerId = await addLoginProvider(harness, client);
    const provider = harness.core.providers.require(providerId);
    provider.auth = { kind: 'none' };
    for (const profile of Object.values(provider.profiles)) {
      if (profile) profile.executable = [{ kind: 'file', value: process.execPath }];
    }
    harness.core.accounts.ensureDefaults();
    const other = harness.core.accounts.list().find(entry => entry.providerId === providerId)!;
    expect(other).toMatchObject({ label: 'Default', isolationDir: null, status: 'ok' });

    await harness.core.close();
    const restarted = new Core({ dataDir: harness.dataDir, token: harness.token });
    try {
      expect(restarted.accounts.list().filter(entry => entry.providerId === 'echo')).toEqual([]);
      const restored = restarted.accounts.add({ providerId: 'echo', label: 'Use echo again', useDefaultLocation: true });
      restarted.accounts.ensureDefaults();
      expect(restarted.accounts.list().filter(entry => entry.providerId === 'echo')).toEqual([restored]);
      expect(restarted.accounts.require(other.id)).toEqual(other);
    } finally { await restarted.close(); }
  });

  test('the default opencode account reads its own login, an isolated one reads unauthenticated', async () => {
    const client = await harness.connect();
    const isolated = await client.call('accounts.add', {
      providerId: 'opencode',
      label: 'Isolated opencode',
      useDefaultLocation: false,
    });
    // XDG_DATA_HOME points at the account directory, so opencode would write
    // its auth.json under <isolationDir>/opencode/, and nothing is there yet.
    expect(isolated.status).toBe('unauthenticated');
    expect(harness.core.accounts.accountEnv(harness.core.accounts.require(isolated.id), harness.core.providers.require('opencode'))).toEqual({
      XDG_DATA_HOME: isolated.isolationDir ?? '',
      XDG_CONFIG_HOME: isolated.isolationDir ?? '',
    });

    const accounts = await client.call('accounts.list', {});
    const fallback = accounts.find((entry) => entry.providerId === 'opencode' && entry.isolationDir === null);
    const authFile = join(homedir(), '.local', 'share', 'opencode', 'auth.json');
    if (fallback === undefined || !existsSync(authFile)) {
      console.log(`no opencode login at ${authFile}, the default account assertion is skipped`);
      return;
    }
    expect(fallback.status).toBe('ok');
  });

  test('an isolated account gets its own directory and is unauthenticated until the session file exists', async () => {
    const client = await harness.connect();
    const account = await client.call('accounts.add', {
      providerId: 'claude',
      label: 'Second',
      useDefaultLocation: false,
    });
    expect(account.isolationDir).toBe(join(harness.dataDir, 'accounts', account.id));

    const before = await client.call('accounts.check', { accountId: account.id });
    expect(before.status).toBe(CLAUDE_SIGNED_OUT);

    writeFileSync(join(account.isolationDir ?? '', '.credentials.json'), '{"fake":true}', 'utf8');
    const after = await client.call('accounts.check', { accountId: account.id });
    expect(after.status).toBe('ok');
  });

  test('a check that finds the same status writes nothing and tells nobody, and a changed one does both', async () => {
    const client = await harness.connect();
    const account = await client.call('accounts.add', { providerId: 'claude', label: 'Checked', useDefaultLocation: false });
    const updated: string[] = [];
    client.on('accounts.updated', (event) => updated.push(event.status));
    const rows = harness.core.journal.countEvents('account.checked');

    for (let index = 0; index < 3; index += 1) {
      expect((await client.call('accounts.check', { accountId: account.id })).status).toBe(CLAUDE_SIGNED_OUT);
    }
    expect(harness.core.journal.countEvents('account.checked')).toBe(rows);

    writeFileSync(join(account.isolationDir ?? '', '.credentials.json'), '{"fake":true}', 'utf8');
    expect((await client.call('accounts.check', { accountId: account.id })).status).toBe('ok');
    await waitFor(() => updated.length === 1);
    expect(updated).toEqual(['ok']);
    expect(harness.core.journal.countEvents('account.checked')).toBe(rows + 1);
  });

  test('a profile whose login lives outside any file reads unknown rather than unauthenticated', async () => {
    const client = await harness.connect();
    const providerId = await addLoginProvider(harness, client);
    const os = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
    const file = join(harness.dataDir, 'providers', 'echo-auth.json');
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { profiles: Record<string, Record<string, unknown>> };
    raw.profiles[os]!['session'] = [];
    writeFileSync(file, JSON.stringify(raw), 'utf8');
    expect((await client.call('providers.reload', {})).rejected).toEqual([]);

    const account = await client.call('accounts.add', { providerId, label: 'Keychain', useDefaultLocation: false });
    expect(account.status).toBe('unknown');
    expect((await client.call('accounts.check', { accountId: account.id })).status).toBe('unknown');
    // A session file still proves the login.
    writeFileSync(join(account.isolationDir ?? '', '.credentials.json'), '{}', 'utf8');
    expect((await client.call('accounts.check', { accountId: account.id })).status).toBe('ok');

    // Claude on macOS keeps its login in the Keychain, not in .credentials.json.
    const shipped = JSON.parse(readFileSync(join(import.meta.dir, '../src/providers/shipped/claude.json'), 'utf8')) as {
      profiles: Record<string, { session?: string[] }>;
    };
    expect(shipped.profiles['macos']?.session).toEqual([]);
    expect(shipped.profiles['windows']?.session).toBeUndefined();
  });

  test('a profile session list that is not an array of strings is refused with the file and the field', async () => {
    const client = await harness.connect();
    await addLoginProvider(harness, client);
    const file = join(harness.dataDir, 'providers', 'echo-auth.json');
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { profiles: Record<string, Record<string, unknown>> };
    raw.profiles['linux']!['session'] = 'keychain';
    writeFileSync(file, JSON.stringify(raw), 'utf8');
    const loaded = await client.call('providers.reload', {});
    expect(loaded.rejected[0]).toMatchObject({ file, field: 'profiles.linux.session' });
  });

  test('the isolation environment substitutes the account directory', async () => {
    const client = await harness.connect();
    const account = await client.call('accounts.add', {
      providerId: 'claude',
      label: 'Isolated',
      useDefaultLocation: false,
    });
    const provider = harness.core.providers.require('claude');
    const env = harness.core.accounts.accountEnv(
      harness.core.accounts.require(account.id),
      provider,
    );
    expect(env['CLAUDE_CONFIG_DIR']).toBe(account.isolationDir ?? '');

    const shared = harness.core.accounts.accountEnv(
      { ...harness.core.accounts.require(account.id), isolationDir: null },
      provider,
    );
    expect(shared).toEqual({});
  });

  test('accounts.updated reaches a connected client', async () => {
    const client = await harness.connect();
    const seen = client.next('accounts.updated', (account) => account.label === 'Watched');
    await client.call('accounts.add', { providerId: 'echo', label: 'Watched', useDefaultLocation: true });
    expect((await seen).label).toBe('Watched');
  });

  test('removing an account drops it from the list', async () => {
    const client = await harness.connect();
    const account = await client.call('accounts.add', { providerId: 'echo', label: 'Doomed' });
    await client.call('accounts.remove', { accountId: account.id });
    const accounts = await client.call('accounts.list', {});
    expect(accounts.some((entry) => entry.id === account.id)).toBe(false);
    expect(existsSync(account.isolationDir ?? '')).toBe(false);
  });

  test('an account used by a thread cannot be removed', async () => {
    const client = await harness.connect();
    const account = await client.call('accounts.add', { providerId: 'echo', label: 'Used' });
    const project = await client.call('projects.add', { path: harness.dataDir });
    await client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: account.id });
    await expect(client.call('accounts.remove', { accountId: account.id })).rejects.toThrow('used by');
    expect(existsSync(account.isolationDir ?? '')).toBe(true);
  });

  test('a running login can be listed and cancelled', async () => {
    const client = await harness.connect();
    const providerId = await addLoginProvider(harness, client);
    const account = await client.call('accounts.add', { providerId, label: 'Cancel login' });
    await client.call('accounts.login', { accountId: account.id });
    const state = await client.call('accounts.logins', {});
    expect(harness.core.providers.installs.leaseCount(providerId)).toBe(1);
    expect(state.some((run) => run.accountId === account.id && run.state === 'running')).toBe(true);
    await client.call('accounts.loginCancel', { accountId: account.id });
    expect(await client.call('accounts.logins', {})).toEqual([]);
    expect(harness.core.providers.installs.leaseCount(providerId)).toBe(0);
    await waitFor(() => harness.core.procs.liveCount(`login:${account.id}`) === 0);
  });

  test('CLI login strips unsetEnv before spawning the real child', async () => {
    const client = await harness.connect();
    const providerId = await addLoginProvider(harness, client);
    const descriptor = harness.core.providers.require(providerId);
    for (const profile of Object.values(descriptor.profiles)) {
      if (profile) profile.unsetEnv = ['BOITE_TEST_UNSET'];
    }
    const script = join(harness.dataDir, 'check-login-env.ts');
    writeFileSync(script, "console.log(process.env.BOITE_TEST_UNSET === undefined ? 'environment isolated' : 'environment leaked');");
    descriptor.login = { command: [process.execPath, script] };
    const account = await client.call('accounts.add', { providerId, label: 'Environment' });
    process.env.BOITE_TEST_UNSET = 'test-only-sentinel';
    try {
      const finished = client.next('account.login', (event) => event.accountId === account.id && event.state !== 'running');
      await client.call('accounts.login', { accountId: account.id });
      expect((await finished).output).toBe('environment isolated');
    } finally { delete process.env.BOITE_TEST_UNSET; }
  });

  test('accounts.login runs the provider command, takes a pasted code and leaves the account ok', async () => {
    const client = await harness.connect();
    const providerId = await addLoginProvider(harness, client);
    const account = await client.call('accounts.add', {
      providerId,
      label: 'To log in',
      useDefaultLocation: false,
    });
    expect(account.status).toBe('unauthenticated');

    const lines: string[] = [];
    client.on('account.login', (event) => {
      if (event.accountId === account.id && event.output.length > 0) lines.push(event.output);
    });
    const started = client.next('account.login', (event) => event.accountId === account.id);
    const withUrl = client.next(
      'account.login',
      (event) => event.accountId === account.id && event.url !== null,
    );
    const withSignIn = client.next(
      'account.login',
      (event) => event.accountId === account.id && event.url !== null && event.url.includes('/login'),
    );

    expect(await client.call('accounts.login', { accountId: account.id })).toEqual({ ok: true });
    expect((await started).state).toBe('running');
    // The terms page is printed first and gives way to the link that signs in.
    expect((await withUrl).url).toBe('https://example.invalid/terms');
    const link = await withSignIn;
    expect(link.url).toBe('https://example.invalid/login?code=echo');
    expect(link.output).toContain('https://example.invalid/login?code=echo');

    const finished = client.next('account.login', (event) => event.accountId === account.id && event.state !== 'running');
    const updated = client.next('accounts.updated', (entry) => entry.id === account.id && entry.status === 'ok');
    await client.call('accounts.loginInput', { accountId: account.id, text: 'pasted-code' });

    const exit = await finished;
    expect(exit.state).toBe('done');
    expect(exit.exitCode).toBe(0);
    expect((await updated).status).toBe('ok');
    expect(existsSync(join(account.isolationDir ?? '', '.credentials.json'))).toBe(true);
    expect(lines.some((line) => line.includes('Paste the code'))).toBe(true);

    // The login process is a traced process of its own synthetic thread.
    await waitFor(() => harness.core.journal.listProcesses(`login:${account.id}`, 10).length > 0);
    const traced = await client.call('trace.get', { threadId: `login:${account.id}` });
    expect(traced.length).toBe(1);
    expect(traced[0]?.commandLine).toContain('echo-login.ts');
  });

  test('a second login while one runs is refused, and so is one on the default account', async () => {
    const client = await harness.connect();
    const providerId = await addLoginProvider(harness, client);
    const account = await client.call('accounts.add', {
      providerId,
      label: 'Busy',
      useDefaultLocation: false,
    });

    await client.call('accounts.login', { accountId: account.id });
    let refusal = '';
    try {
      await client.call('accounts.login', { accountId: account.id });
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    expect(refusal).toContain('already running');

    // The shipped echo descriptor resolves `{shippedDir}` to the script beside it.
    const echo = harness.core.providers.require('echo');
    expect(echo.login?.command?.[0]).toBe('bun');
    expect(existsSync(echo.login?.command?.[1] ?? '')).toBe(true);

    const accounts = await client.call('accounts.list', {});
    const fallback = accounts.find((entry) => entry.providerId === 'echo' && entry.isolationDir === null);
    expect(fallback).toBeDefined();
    let onDefault = '';
    try {
      await client.call('accounts.login', { accountId: fallback?.id ?? '' });
    } catch (error) {
      onDefault = error instanceof Error ? error.message : String(error);
    }
    expect(onDefault).toContain('own Echo CLI, outside Boite');
  });

  test('a login command with no argv is refused at load, with the file and the field', async () => {
    const client = await harness.connect();
    const dir = join(harness.dataDir, 'providers');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'broken-login.json');
    writeFileSync(
      file,
      JSON.stringify({
        id: 'broken-login',
        schemaVersion: 1,
        name: 'Broken',
        shortName: 'Broken',
        protocol: 'echo',
        roots: ['{isolationDir}'],
        profiles: { windows: { detect: {}, executable: [], isolation: {} } },
        auth: { kind: 'none' },
        login: { command: [] },
        models: [{ id: 'echo', name: 'Echo', default: true }],
        capabilities: {
          approvals: false,
          hooks: false,
          checkpoint: false,
          images: false,
          planMode: false,
          resume: false,
        },
      }),
      'utf8',
    );

    const loaded = await client.call('providers.reload', {});
    const rejected = loaded.rejected.find((entry) => entry.file === file);
    expect(rejected?.field).toBe('login.command');
    expect(rejected?.message).toContain('must name an executable');
  });
});
