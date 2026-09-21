import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { CoreClient } from '../src/client.ts';
import { startTestCore, waitFor } from './harness.ts';
import type { TestCore } from './harness.ts';

const ECHO_LOGIN_SCRIPT = fileURLToPath(new URL('../src/providers/shipped/echo-login.ts', import.meta.url));

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
  test('first start creates one default account per available provider', async () => {
    const client = await harness.connect();
    const accounts = await client.call('accounts.list', {});
    const echo = accounts.find((account) => account.providerId === 'echo');
    expect(echo).toBeDefined();
    expect(echo?.label).toBe('Default');
    expect(echo?.isolationDir).toBeNull();
    expect(echo?.status).toBe('ok');
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
    expect(before.status).toBe('unauthenticated');

    writeFileSync(join(account.isolationDir ?? '', '.credentials.json'), '{"fake":true}', 'utf8');
    const after = await client.call('accounts.check', { accountId: account.id });
    expect(after.status).toBe('ok');
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
