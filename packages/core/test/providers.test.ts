import { currentOs } from '../src/paths.ts';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import type { Account } from '@boite/contracts';
import { assertDriverRunnable } from '../src/drivers/index.ts';
import { resolveCommand } from '../src/providers/resolve.ts';
import { globalRoots } from '../src/providers/npm.ts';
import { delimiter, join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { startTestCore, waitFor } from './harness.ts';
import type { TestCore } from './harness.ts';

let harness: TestCore;

function writeUserDescriptor(name: string, body: unknown): string {
  const dir = join(harness.dataDir, 'providers');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, JSON.stringify(body, null, 2), 'utf8');
  return file;
}

function validDescriptor(): Record<string, unknown> {
  return {
    id: 'mine',
    schemaVersion: 1,
    name: 'Mine',
    shortName: 'Mine',
    protocol: 'acp',
    roots: ['{isolationDir}'],
    profiles: {
      windows: {
        detect: {},
        executable: [{ kind: 'path', value: 'mine' }],
        isolation: { MINE_HOME: '{isolationDir}' },
        close: { processes: ['mine.exe'] },
      },
      linux: { detect: {}, executable: [{ kind: 'path', value: 'mine' }], isolation: { MINE_HOME: '{isolationDir}' } },
      macos: { detect: {}, executable: [{ kind: 'path', value: 'mine' }], isolation: { MINE_HOME: '{isolationDir}' } },
    },
    auth: { kind: 'none' },
    models: [{ id: 'mine-1', name: 'Mine 1', default: true }],
    capabilities: {
      approvals: true,
      hooks: false,
      checkpoint: false,
      images: false,
      planMode: false,
      resume: true,
    },
  };
}

beforeEach(async () => {
  harness = await startTestCore();
});

afterEach(async () => {
  await harness.stop();
});

describe('providers', () => {
  test('a directory cannot mask a runnable fallback executable', () => {
    const directory = join(harness.dataDir, 'not-an-executable');
    mkdirSync(directory);
    expect(resolveCommand({ detect: {}, executable: [
      { kind: 'file', value: directory },
      { kind: 'file', value: process.execPath },
    ], isolation: {} })?.executable).toBe(process.execPath);
  });

  test.skipIf(process.platform !== 'win32')('an npm launcher script on PATH is not an agent to start, but a program behind it is', () => {
    const shims = join(harness.dataDir, 'npm-prefix');
    const programs = join(harness.dataDir, 'programs');
    mkdirSync(shims);
    mkdirSync(programs);
    writeFileSync(join(shims, 'fakeagent.cmd'), '@echo off\r\n');
    const saved = process.env['PATH'];
    try {
      process.env['PATH'] = shims;
      const profile = { detect: {}, executable: [{ kind: 'path' as const, value: 'fakeagent' }], isolation: {} };
      // node's spawn refuses a .cmd with EINVAL: the agent is missing, and its install is offered.
      expect(resolveCommand(profile)).toBeNull();

      writeFileSync(join(programs, 'fakeagent.exe'), 'MZ');
      process.env['PATH'] = [shims, programs].join(delimiter);
      expect(resolveCommand(profile)?.executable.toLowerCase()).toBe(join(programs, 'fakeagent.exe').toLowerCase());

      // A profile that names a launcher script itself maps one to its program, as Muse does.
      process.env['PATH'] = shims;
      const scripted = { ...profile, executable: [{ kind: 'file' as const, value: join(programs, 'missing.cmd') }, ...profile.executable] };
      expect(resolveCommand(scripted)?.executable.toLowerCase()).toBe(join(shims, 'fakeagent.cmd').toLowerCase());
    } finally {
      process.env['PATH'] = saved;
    }
  });

  test.skipIf(process.platform !== 'win32')('a detect.command that finds only a launcher script reads unavailable, and a program later on PATH makes it available', async () => {
    const shims = join(harness.dataDir, 'detect-shims');
    const programs = join(harness.dataDir, 'detect-programs');
    mkdirSync(shims);
    mkdirSync(programs);
    writeFileSync(join(shims, 'fakedetect.cmd'), '@echo off\r\n');
    const descriptor = validDescriptor();
    descriptor['id'] = 'detected';
    (descriptor['profiles'] as Record<string, unknown>)['windows'] = { detect: { command: 'fakedetect' }, executable: [], isolation: {} };
    writeUserDescriptor('detected.json', descriptor);
    const saved = process.env['PATH'];
    try {
      process.env['PATH'] = shims;
      const client = await harness.connect();
      const { loaded, rejected } = await client.call('providers.reload', {});
      expect(rejected).toEqual([]);
      expect(loaded.find((provider) => provider.id === 'detected')?.available).toBe(false);

      writeFileSync(join(programs, 'fakedetect.exe'), 'MZ');
      process.env['PATH'] = [shims, programs].join(delimiter);
      expect(harness.core.providers.summary('detected')?.available).toBe(true);
    } finally {
      process.env['PATH'] = saved;
    }
  });

  test.skipIf(process.platform !== 'win32')('an {npmRoot} candidate finds the program an npm package vendors under the prefix whose shim is on PATH', async () => {
    // A custom prefix, as nvm-windows, fnm or scoop make one: the shim in it, the package under its node_modules.
    const prefix = join(harness.dataDir, 'custom-prefix');
    const vendored = join(prefix, 'node_modules', 'fake-npm-agent', 'bin');
    mkdirSync(vendored, { recursive: true });
    writeFileSync(join(prefix, 'npmagent.cmd'), '@echo off\r\n');
    const exe = join(vendored, 'npmagent.exe');
    writeFileSync(exe, 'MZ');
    const descriptor = validDescriptor();
    descriptor['id'] = 'npm-rooted';
    (descriptor['profiles'] as Record<string, unknown>)['windows'] = {
      detect: {},
      executable: [
        { kind: 'file', value: '{npmRoot}/fake-npm-agent/bin/npmagent.exe' },
        { kind: 'path', value: 'npmagent' },
      ],
      isolation: {},
    };
    writeUserDescriptor('npm-rooted.json', descriptor);
    const saved = process.env['PATH'];
    try {
      process.env['PATH'] = prefix;
      const client = await harness.connect();
      const { loaded, rejected } = await client.call('providers.reload', {});
      expect(rejected).toEqual([]);
      const found = loaded.find((provider) => provider.id === 'npm-rooted');
      expect(found?.available).toBe(true);
      expect(found?.executable?.toLowerCase()).toBe(exe.toLowerCase());
      expect(harness.core.providers.launcherScriptOnly('npm-rooted')).toBeNull();

      // Without the vendored program only the shim is left: missing, and a turn says why.
      rmSync(exe);
      const summary = harness.core.providers.summary('npm-rooted');
      expect(summary?.available).toBe(false);
      const script = harness.core.providers.launcherScriptOnly('npm-rooted');
      expect(script?.toLowerCase()).toBe(join(prefix, 'npmagent.cmd').toLowerCase());
      const account: Account = { id: 'acc_x', providerId: 'npm-rooted', label: 'Default', isolationDir: null, status: 'ok', identity: null, createdAt: 0 };
      expect(() => assertDriverRunnable('acp', summary, account, () => harness.core.providers.launcherScriptOnly('npm-rooted')))
        .toThrow(`PATH has only the launcher script ${script}, which Boite cannot start`);
    } finally {
      process.env['PATH'] = saved;
    }
  });

  test('{npmRoot} is refused anywhere but the start of a file candidate', async () => {
    const client = await harness.connect();
    const placements = [
      { kind: 'path', value: '{npmRoot}/agent' },
      { kind: 'file', value: '{home}/{npmRoot}/agent.exe' },
      { kind: 'file', value: '{npmRoot}agent.exe' },
    ];
    for (const [index, candidate] of placements.entries()) {
      const descriptor = validDescriptor();
      descriptor['id'] = `npm-misplaced-${index}`;
      (descriptor['profiles'] as Record<string, unknown>)['linux'] = { detect: {}, executable: [candidate], isolation: {} };
      writeUserDescriptor(`npm-misplaced-${index}.json`, descriptor);
    }
    const { rejected } = await client.call('providers.reload', {});
    const refused = rejected.filter((entry) => entry.file.includes('npm-misplaced-'));
    expect(refused.length).toBe(3);
    for (const entry of refused) {
      expect(entry.field).toBe('profiles.linux.executable[0].value');
      expect(entry.expected).toContain('{npmRoot} only at the start of a file candidate');
    }
  });

  test('a PATH lookup is remembered: a burst of resolutions walks PATH once, a reload or a vanished program reads again', () => {
    const programs = join(harness.dataDir, 'cached-programs');
    mkdirSync(programs);
    const exe = join(programs, process.platform === 'win32' ? 'cachedagent.exe' : 'cachedagent');
    const write = (): void => {
      writeFileSync(exe, process.platform === 'win32' ? 'MZ' : '#!/bin/sh\n');
      if (process.platform !== 'win32') chmodSync(exe, 0o755);
    };
    write();
    const saved = process.env['PATH'];
    const which = spyOn(Bun, 'which');
    try {
      process.env['PATH'] = programs;
      const profile = { detect: { command: 'cachedagent' }, executable: [{ kind: 'path' as const, value: 'cachedagent' }], isolation: {} };
      expect(resolveCommand(profile)?.executable.toLowerCase()).toBe(exe.toLowerCase());
      const walks = which.mock.calls.length;
      for (let index = 0; index < 20; index += 1) resolveCommand(profile);
      expect(which.mock.calls.length).toBe(walks);

      // A remembered program that is gone is looked up again, never handed to a spawn.
      rmSync(exe);
      expect(resolveCommand(profile)).toBeNull();
      // A miss stays a miss for a while; a reload forgets it.
      write();
      expect(resolveCommand(profile)).toBeNull();
      harness.core.providers.load();
      expect(resolveCommand(profile)?.executable.toLowerCase()).toBe(exe.toLowerCase());
    } finally {
      which.mockRestore();
      process.env['PATH'] = saved;
    }
  });

  test.skipIf(process.platform === 'win32')('a non-executable file cannot mask a runnable fallback on POSIX', () => {
    const file = join(harness.dataDir, 'not-executable');
    writeFileSync(file, '#!/bin/sh\nexit 0\n');
    chmodSync(file, 0o644);
    expect(resolveCommand({ detect: {}, executable: [
      { kind: 'file', value: file },
      { kind: 'file', value: process.execPath },
    ], isolation: {} })?.executable).toBe(process.execPath);
  });

  test('reload discovers a newly installed provider account once and broadcasts it', async () => {
    const body = validDescriptor();
    body.profiles = Object.fromEntries(['windows', 'linux', 'macos'].map((os) => [os, {
      detect: {}, executable: [{ kind: 'file', value: process.execPath }], isolation: {},
    }]));
    writeUserDescriptor('new-agent.json', body);
    const client = await harness.connect();
    const updates: string[] = [];
    client.on('accounts.updated', (account) => { updates.push(account.providerId); });
    await client.call('providers.reload', {});
    await client.call('providers.reload', {});
    const accounts = await client.call('accounts.list', {});
    expect(accounts.filter((account) => account.providerId === 'mine')).toHaveLength(1);
    expect(updates).toContain('mine');
  });

  test('a reload that changes nothing broadcasts nothing, and a changed descriptor still does', async () => {
    const client = await harness.connect();
    const broadcasts: number[] = [];
    client.on('providers.updated', (result) => { broadcasts.push(result.loaded.length); });
    await client.call('providers.reload', {});
    const settled = broadcasts.length;
    for (let index = 0; index < 3; index += 1) {
      expect((await client.call('providers.reload', {})).loaded.length).toBeGreaterThan(0);
    }
    // A later event proves the unchanged reloads had their chance to arrive.
    await client.call('settings.set', { asyncQuestions: false });
    expect(broadcasts.length).toBe(settled);

    const body = validDescriptor();
    body.profiles = Object.fromEntries(['windows', 'linux', 'macos'].map((os) => [os, {
      detect: {}, executable: [{ kind: 'file', value: process.execPath }], isolation: {},
    }]));
    writeUserDescriptor('changed.json', body);
    await client.call('providers.reload', {});
    await waitFor(() => broadcasts.length === settled + 1);
  });

  test('an unsupported executable resolver is rejected at its field', () => {
    const body = validDescriptor();
    body.profiles = { windows: { detect: {}, executable: [{ kind: 'registry', value: 'anything' }], isolation: {} } };
    writeUserDescriptor('unsupported.json', body);
    harness.core.providers.load();
    const rejected = harness.core.providers.list().rejected;
    expect(JSON.stringify(rejected)).toContain('profiles.windows.executable[0].kind');
  });
  test('the shipped descriptors load', async () => {
    const client = await harness.connect();
    const { loaded, rejected } = await client.call('providers.list', {});
    expect(rejected).toEqual([]);
    const ids = loaded.map((provider) => provider.id).sort();
    expect(ids).toEqual(['antigravity', 'antigravity-cli', 'claude', 'codex', 'echo', 'grok', 'muse', 'opencode', 'pi']);

    const echo = loaded.find((provider) => provider.id === 'echo');
    expect(echo?.source).toBe('shipped');
    expect(echo?.protocol).toBe('echo');
    expect(echo?.available).toBe(true);
    expect(echo?.executable).toBeNull();

    const claude = loaded.find((provider) => provider.id === 'claude');
    expect(claude?.protocol).toBe('claude-sdk');
    expect(claude?.models[0]?.id).toBe('claude-fable-5-1');
    expect(claude?.models.find((model) => model.default)?.id).toBe('claude-sonnet-5');
    expect(claude?.models.some((model) => model.legacy)).toBe(true);
    expect(claude?.capabilities.planMode).toBe(true);
  });

  test('a test core resolves none of the agents installed on the machine', async () => {
    expect(process.env.BOITE_HOST_AGENTS).toBe('0');
    const client = await harness.connect();
    const { loaded } = await client.call('providers.list', {});
    for (const provider of loaded.filter((entry) => entry.id !== 'echo')) {
      expect({ id: provider.id, available: provider.available, executable: provider.executable }).toEqual({ id: provider.id, available: false, executable: null });
    }
    expect(await client.call('providers.updates', { refresh: true })).toEqual([]);
  });

  test('the shipped opencode descriptor loads, resolves its executable and offers one model', async () => {
    const client = await harness.connect();
    const { loaded, rejected } = await client.call('providers.list', {});
    expect(rejected).toEqual([]);

    const opencode = loaded.find((provider) => provider.id === 'opencode');
    expect(opencode?.source).toBe('shipped');
    expect(opencode?.protocol).toBe('acp');
    expect(opencode?.name).toBe('OpenCode');
    expect(opencode?.models).toEqual([{ id: 'default', name: 'OpenCode default', default: true }]);
    expect(opencode?.capabilities).toEqual({
      approvals: true,
      hooks: false,
      checkpoint: false,
      images: false,
      planMode: false,
      resume: true,
    });

    // OpenCode is installed on this machine; elsewhere the descriptor still loads,
    // it is just not available, and the test says which of the two it saw.
    if (opencode?.available !== true) {
      console.log('opencode is not installed here, the executable assertion is skipped');
      return;
    }
    expect(opencode.executable?.toLowerCase()).toEndWith(process.platform === 'win32' ? 'opencode.exe' : 'opencode');
  });

  test('the opencode profile carries the acp launch arguments and the xdg isolation', async () => {
    const descriptor = harness.core.providers.require('opencode');
    const profile = descriptor.profiles[currentOs()];
    expect(profile?.launch?.args).toEqual(['acp', '--port', '0']);
    expect(profile?.isolation).toEqual({ XDG_DATA_HOME: '{isolationDir}', XDG_CONFIG_HOME: '{isolationDir}' });
    expect(descriptor.auth).toEqual({ kind: 'oauth-cli', session: ['opencode/auth.json'] });
    expect(descriptor.login?.command).toEqual(['opencode', 'auth', 'login']);
  });

  test('the windows npm copy is looked for under every global npm root, the default %APPDATA% one included', () => {
    const windows = harness.core.providers.require('opencode').profiles.windows;
    // Boite's own release is named first, the npm copy right behind it.
    const candidate = windows?.executable[1];
    expect(candidate?.kind).toBe('file');
    expect(candidate?.value).toStartWith('{npmRoot}');
    if (process.platform === 'win32') {
      expect(globalRoots(null)).toContain(join(process.env['APPDATA'] ?? '', 'npm', 'node_modules'));
    }
    expect(candidate?.value).toContain(`opencode-ai${sep}bin`);
    expect(candidate?.value.toLowerCase()).toEndWith('opencode.exe');
  });

  test('the shipped antigravity descriptor carries its release, its environment and its acp login', async () => {
    const client = await harness.connect();
    const { loaded, rejected } = await client.call('providers.list', {});
    expect(rejected).toEqual([]);

    const antigravity = loaded.find((provider) => provider.id === 'antigravity');
    expect(antigravity?.source).toBe('shipped');
    expect(antigravity?.protocol).toBe('acp');
    expect(antigravity?.name).toBe('Antigravity');
    // `default` is Boite's own spelling for "the agent keeps its own model": the
    // real list comes from the agent, through the probe.
    expect(antigravity?.models).toEqual([{ id: 'default', name: 'Antigravity default', default: true }]);
    // Unsupported native architectures must show a reason instead of offering
    // an archive that cannot run on this machine.
    const requiredArch = currentOs() === 'macos' ? 'arm64' : 'x64';
    if (process.arch === requiredArch) {
      expect(antigravity?.install?.state).toBe('absent');
    } else {
      expect(antigravity?.install).toEqual({ state: 'failed', version: 'agy_acp_server_1.1.1',
        message: `antigravity requires ${requiredArch}; this machine is ${process.arch}` });
    }
    expect(antigravity?.install?.version).toBe('agy_acp_server_1.1.1');
    expect(antigravity?.available).toBe(false);

    const descriptor = harness.core.providers.require('antigravity');
    expect(descriptor.auth).toEqual({ kind: 'oauth-cli', session: ['antigravity-acp/acp_token.json'] });
    // The login is an ACP call, not a command: `authenticate` with this method.
    expect(descriptor.login).toEqual({ acp: { methodId: 'oauth-personal' } });
    // T3 Code never uses the user's own IDE login, and neither does Boite.
    expect(descriptor.isolation).toEqual({ alwaysIsolated: true });
    expect(descriptor.seedFiles).toEqual({ 'antigravity-acp/settings.json': '{"auth":{"type":"oauth-personal"}}' });
    expect(descriptor.quirks).toEqual(['antigravity']);

    const windows = descriptor.profiles['windows'];
    expect(windows?.install?.url).toContain('dl.google.com');
    expect(windows?.install?.sha256).toHaveLength(64);
    expect(windows?.install?.archiveBytes).toBe(468238392);
    expect(windows?.install?.files.map((file) => file.path)).toEqual([
      'agy_acp_server.exe',
      'localharness_external.exe',
    ]);
    expect(windows?.isolation).toEqual({ GEMINI_HOME: '{isolationDir}' });

    const profile = descriptor.profiles[currentOs()];
    // Every process of this provider carries these, the default account's too.
    const env = profile?.env ?? {};
    expect(env['AGY_ACP_FORCE_FILE_STORAGE']).toBe('1');
    expect(env['PYTHONUNBUFFERED']).toBe('1');
    expect(env['ELECTRON_RUN_AS_NODE']).toBe('1');
    // Both are load-time tokens, so they are real paths by the time a spawn reads them.
    expect(env['ANTIGRAVITY_HARNESS_PATH']).toContain('localharness_external');
    expect(env['ANTIGRAVITY_HARNESS_PATH']).not.toContain('{agentsDir}');
    expect(env['BROWSER']).not.toContain('{browserNoop}');
    expect(env['BROWSER']).toContain('browser-noop');
    // A variable the user set for their own Gemini or Cloud login cannot redirect this agent.
    expect(profile?.unsetEnv).toContain('GEMINI_API_KEY');
    expect(profile?.unsetEnv).toContain('GOOGLE_APPLICATION_CREDENTIALS');
    expect(profile?.unsetEnv).toContain('GEMINI_HOME');

    const executable = profile?.executable[0];
    expect(executable?.kind).toBe('file');
    // `{agentsDir}` resolves under the data directory, so nothing outside it is ever launched.
    expect(executable?.value.startsWith(join(harness.dataDir, 'agents', 'antigravity'))).toBe(true);
    if (process.platform === 'linux') {
      expect(profile?.launch?.args).toEqual(['--uid=']);
    } else {
      expect(profile?.launch?.args).toEqual([]);
    }
  });

  test('the shipped antigravity cli descriptor runs the installed agy on the user s own login', async () => {
    const client = await harness.connect();
    const { loaded, rejected } = await client.call('providers.list', {});
    expect(rejected).toEqual([]);

    const cli = loaded.find((provider) => provider.id === 'antigravity-cli');
    expect(cli?.source).toBe('shipped');
    expect(cli?.protocol).toBe('agy');
    expect(cli?.name).toBe('Antigravity CLI');
    expect(cli?.shortName).toBe('agy');
    expect(cli?.models).toEqual([{ id: 'default', name: 'Antigravity CLI default', default: true }]);
    // Print mode has no approval gate, and a plan mode behind `--mode plan`.
    expect(cli?.capabilities.approvals).toBe(false);
    expect(cli?.capabilities.planMode).toBe(true);
    // Nothing to download: the user installs agy, so there is no install state.
    expect(cli?.install).toBeNull();

    const descriptor = harness.core.providers.require('antigravity-cli');
    // The token sits in the system keyring and nothing moves the config
    // directory, so there is no session file to read and no isolation to offer.
    expect(descriptor.auth).toEqual({ kind: 'none' });
    expect(descriptor.login).toBeUndefined();
    expect(descriptor.isolation).toBeUndefined();

    const profile = descriptor.profiles[currentOs()];
    expect(profile?.isolation).toEqual({});
    expect(profile?.launch).toBeUndefined();
    expect(profile?.unsetEnv).toBeUndefined();
    // Never a process closed by name: the user's own agy runs beside Boite's.
    expect(profile?.close?.processes).toEqual([]);
    expect(profile?.env?.['BROWSER']).toBe(join(harness.dataDir, currentOs() === 'windows' ? 'browser-noop.cmd' : 'browser-noop.sh'));

    const windows = descriptor.profiles['windows'];
    expect(windows?.executable[0]).toEqual({ kind: 'path', value: 'agy' });
    expect(windows?.executable[1]?.kind).toBe('file');
    expect(windows?.executable[1]?.value.endsWith(join('AppData', 'Local', 'agy', 'bin', 'agy.exe'))).toBe(true);
    expect(windows?.executable[1]?.value).not.toContain('{home}');
  });

  test('the shipped codex descriptor loads and is launched as the app-server', async () => {
    const client = await harness.connect();
    const { loaded, rejected } = await client.call('providers.list', {});
    expect(rejected).toEqual([]);

    const codex = loaded.find((provider) => provider.id === 'codex');
    expect(codex?.source).toBe('shipped');
    expect(codex?.protocol).toBe('codex-appserver');
    expect(codex?.name).toBe('Codex');
    // One model, "the agent keeps its own"; the rest comes from `model/list`.
    expect(codex?.models).toEqual([{ id: 'default', name: 'Codex default', default: true }]);
    expect(codex?.capabilities).toEqual({
      approvals: true,
      hooks: false,
      checkpoint: false,
      images: true,
      planMode: true,
      resume: true,
    });

    const descriptor = harness.core.providers.require('codex');
    // `CODEX_HOME` is the whole home Codex works from, `auth.json` right under it.
    expect(descriptor.auth).toEqual({ kind: 'oauth-cli', session: ['auth.json'] });
    // The device-code login prints a link and a code instead of opening a browser.
    expect(descriptor.login?.command).toEqual(['codex', 'login', '--device-auth']);

    const profile = descriptor.profiles[currentOs()];
    expect(profile?.launch?.args).toEqual(['app-server']);
    expect(profile?.isolation).toEqual({ CODEX_HOME: '{isolationDir}' });

    if (process.platform !== 'win32') {
      expect(profile?.executable).toEqual([{ kind: 'path', value: 'codex' }]);
      return;
    }
    // Boite's own release is named first. npm installs a `.cmd` shim Bun cannot
    // spawn, so the real vendored exe is named next, under whichever global npm
    // root holds the package.
    const candidate = profile?.executable[1];
    expect(candidate?.kind).toBe('file');
    expect(candidate?.value).toStartWith('{npmRoot}');
    expect(candidate?.value.toLowerCase()).toEndWith('codex.exe');
    expect(profile?.executable.at(-1)).toEqual({ kind: 'path', value: 'codex' });
    expect(profile?.close?.processes).toEqual(['codex.exe', 'codex-x86_64-pc-windows-msvc.exe']);

    if (codex?.available !== true) {
      console.log('codex is not installed here, the executable assertion is skipped');
      return;
    }
    expect(codex.executable?.toLowerCase()).toEndWith('codex.exe');
  });

  test('the shipped muse descriptor loads and is launched as a session host', async () => {
    const client = await harness.connect();
    const { loaded, rejected } = await client.call('providers.list', {});
    expect(rejected).toEqual([]);

    const muse = loaded.find((provider) => provider.id === 'muse');
    expect(muse?.source).toBe('shipped');
    expect(muse?.protocol).toBe('muse');
    expect(muse?.name).toBe('Muse Code');
    expect(muse?.models).toEqual([{ id: 'default', name: 'Muse default', default: true }]);
    expect(muse?.capabilities.planMode).toBe(true);

    const descriptor = harness.core.providers.require('muse');
    // The three XDG homes are Muse's whole state, its login under `muse/`.
    expect(descriptor.auth).toEqual({ kind: 'oauth-cli', session: ['muse/auth.json'] });
    expect(descriptor.login?.command).toEqual(['muse', 'login']);
    const profile = descriptor.profiles[currentOs()];
    expect(profile?.launch?.args).toEqual(['serve', '--trust-workspace']);
    expect(Object.keys(profile?.isolation ?? {})).toEqual(['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']);
    // Boite pins the version it installs, and an API key never overrides the account.
    expect(profile?.env).toEqual({ MUSE_NO_AUTO_UPDATE: '1' });
    expect(profile?.unsetEnv).toEqual(['META_API_KEY']);

    if (process.platform !== 'win32') return;
    expect(profile?.install?.url).toContain('muse-x86-windows.exe');
    expect(profile?.install?.sha256).toHaveLength(64);
    expect(profile?.install?.files.map((file) => file.path)).toEqual(['muse.exe']);
    // Boite's own download first, then the official installer's launcher, which
    // the driver swaps for the versioned binary beside it.
    expect(profile?.executable[1]?.value.toLowerCase().replaceAll('\\', '/')).toEndWith(
      '/appdata/local/programs/muse/muse.cmd',
    );
  });

  test('the shipped pi descriptor loads and finds the npm package wherever it was installed', async () => {
    const client = await harness.connect();
    const { loaded, rejected } = await client.call('providers.list', {});
    expect(rejected).toEqual([]);

    const pi = loaded.find((provider) => provider.id === 'pi');
    expect(pi?.source).toBe('shipped');
    expect(pi?.protocol).toBe('pi');
    expect(pi?.name).toBe('pi');
    expect(pi?.models).toEqual([{ id: 'default', name: 'pi default', default: true }]);
    // pi has no approval gate in rpc mode, so the descriptor says so.
    expect(pi?.capabilities.approvals).toBe(false);

    const descriptor = harness.core.providers.require('pi');
    // One variable moves pi's whole config directory, `auth.json` included.
    expect(descriptor.auth).toEqual({ kind: 'oauth-cli', session: ['auth.json'] });
    // No login block: `/login` is a slash command inside the tui, not a cli one.
    expect(descriptor.login).toBeUndefined();

    const profile = descriptor.profiles[currentOs()];
    expect(profile?.isolation).toEqual({ PI_CODING_AGENT_DIR: '{isolationDir}' });
    expect(profile?.launch?.args).toEqual(['--mode', 'rpc']);
    // npm installs a `.ps1` and a `.cmd` shim Bun cannot spawn, so the package
    // is named rather than a shim, under both scopes pi has shipped from.
    const packages = profile?.executable.filter((candidate) => candidate.kind === 'npm').map((candidate) => candidate.value);
    expect(packages).toEqual(['@earendil-works/pi-coding-agent#pi', '@mariozechner/pi-coding-agent#pi']);
    if (process.platform === 'win32') expect(profile?.executable.some((candidate) => candidate.kind === 'path')).toBe(false);

    if (pi?.available !== true) {
      console.log('pi is not installed here, the executable assertion is skipped');
      return;
    }
    // The summary shows the script a person recognises, not the Node running it.
    expect(pi.executable).toMatch(/pi-coding-agent/);
  });

  test('an npm candidate is refused on a protocol that cannot take a script argument', async () => {
    const body = validDescriptor();
    body.protocol = 'codex-appserver';
    (body.profiles as Record<string, { executable: unknown }>)['windows']!.executable = [{ kind: 'npm', value: '@scope/tool#tool' }];
    writeUserDescriptor('npm-codex.json', body);
    const client = await harness.connect();
    const { rejected } = await client.call('providers.reload', {});
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.field).toBe('profiles.windows.executable[0].kind');
    expect(rejected[0]?.message).toContain('pi or acp');
  });

  test('an npm candidate that is not a package name is refused', async () => {
    const body = validDescriptor();
    (body.profiles as Record<string, { executable: unknown }>)['linux']!.executable = [{ kind: 'npm', value: '../../escape' }];
    writeUserDescriptor('npm-bad.json', body);
    const client = await harness.connect();
    const { rejected } = await client.call('providers.reload', {});
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.field).toBe('profiles.linux.executable[0].value');
  });

  test('the shipped models carry the reasoning effort scale they are meant to', async () => {
    const client = await harness.connect();
    const { loaded } = await client.call('providers.list', {});
    const models = loaded.find((provider) => provider.id === 'claude')?.models ?? [];

    const sonnet = models.find((model) => model.id === 'claude-sonnet-5');
    expect(sonnet?.effort?.default).toBe('high');
    expect(sonnet?.effort?.levels.map((level) => level.id)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultrathink',
    ]);
    expect(sonnet?.effort?.levels.find((level) => level.id === 'xhigh')?.label).toBe('Extra high');
    expect(sonnet?.effort?.levels.find((level) => level.id === 'ultrathink')?.description).toBe(
      'Extended thinking, asked for in the prompt',
    );

    const legacy = models.find((model) => model.id === 'claude-sonnet-4-6');
    expect(legacy?.effort?.levels.map((level) => level.id)).toEqual(['low', 'medium', 'high']);

    // Haiku has no scale at all, so the picker shows no Reasoning row for it.
    expect(models.find((model) => model.id === 'claude-haiku-4-5-20251001')?.effort).toBeUndefined();

    const echo = loaded.find((provider) => provider.id === 'echo')?.models[0];
    expect(echo?.effort).toEqual({
      levels: [
        { id: 'low', label: 'Low' },
        { id: 'high', label: 'High' },
      ],
      default: 'high',
    });
  });

  test('a user descriptor with a well formed effort scale loads', async () => {
    const models = [
      {
        id: 'mine-1',
        name: 'Mine 1',
        default: true,
        effort: {
          levels: [
            { id: 'low', label: 'Low' },
            { id: 'high', label: 'High', description: 'The slow one' },
          ],
          default: 'low',
        },
      },
    ];
    writeUserDescriptor('effort-ok.json', { ...validDescriptor(), models });
    const client = await harness.connect();
    const { loaded, rejected } = await client.call('providers.reload', {});
    expect(rejected).toEqual([]);
    expect(loaded.find((provider) => provider.id === 'mine')?.models[0]?.effort).toEqual(models[0]!.effort);
  });

  test('an empty effort level list is refused', async () => {
    const model = { id: 'mine-1', name: 'Mine 1', default: true, effort: { levels: [], default: 'low' } };
    writeUserDescriptor('effort-empty.json', { ...validDescriptor(), models: [model] });
    const client = await harness.connect();
    const { rejected } = await client.call('providers.reload', {});
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.field).toBe('models[0].effort.levels');
    expect(rejected[0]?.expected).toBe('at least one level');
  });

  test('two effort levels with the same id are refused', async () => {
    const model = {
      id: 'mine-1',
      name: 'Mine 1',
      default: true,
      effort: {
        levels: [
          { id: 'low', label: 'Low' },
          { id: 'low', label: 'Low again' },
        ],
        default: 'low',
      },
    };
    writeUserDescriptor('effort-dup.json', { ...validDescriptor(), models: [model] });
    const client = await harness.connect();
    const { rejected } = await client.call('providers.reload', {});
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.field).toBe('models[0].effort.levels[1].id');
    expect(rejected[0]?.message).toContain('twice');
  });

  test('an effort level with an empty label is refused', async () => {
    const model = { id: 'mine-1', name: 'Mine 1', default: true, effort: { levels: [{ id: 'low', label: '' }], default: 'low' } };
    writeUserDescriptor('effort-label.json', { ...validDescriptor(), models: [model] });
    const client = await harness.connect();
    const { rejected } = await client.call('providers.reload', {});
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.field).toBe('models[0].effort.levels[0].label');
    expect(rejected[0]?.expected).toBe('a non-empty string');
  });

  test('an effort default that names no level is refused with the level ids', async () => {
    const model = {
      id: 'mine-1',
      name: 'Mine 1',
      default: true,
      effort: { levels: [{ id: 'low', label: 'Low' }], default: 'turbo' },
    };
    writeUserDescriptor('effort-default.json', { ...validDescriptor(), models: [model] });
    const client = await harness.connect();
    const { rejected } = await client.call('providers.reload', {});
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.field).toBe('models[0].effort.default');
    expect(rejected[0]?.expected).toBe('one of: low');
    expect(rejected[0]?.message).toContain('turbo');
  });

  test('an unknown field inside an effort level is refused with its name', async () => {
    const model = {
      id: 'mine-1',
      name: 'Mine 1',
      default: true,
      effort: { levels: [{ id: 'low', label: 'Low', colour: 'green' }], default: 'low' },
    };
    writeUserDescriptor('effort-field.json', { ...validDescriptor(), models: [model] });
    const client = await harness.connect();
    const { rejected } = await client.call('providers.reload', {});
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.field).toBe('models[0].effort.levels[0].colour');
  });

  test('an unknown field is refused with its name', async () => {
    writeUserDescriptor('bad-field.json', { ...validDescriptor(), mysteryField: 'nope' });
    const client = await harness.connect();
    const { rejected } = await client.call('providers.reload', {});
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.field).toBe('mysteryField');
    expect(rejected[0]?.message).toContain('mysteryField');
  });

  test('a root with a .. segment is refused', async () => {
    writeUserDescriptor('bad-root.json', { ...validDescriptor(), roots: ['{isolationDir}/../elsewhere'] });
    const client = await harness.connect();
    const { rejected } = await client.call('providers.reload', {});
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.field).toBe('roots[0]');
    expect(rejected[0]?.expected).toContain('..');
  });

  test('a user file cannot take a shipped id', async () => {
    writeUserDescriptor('steal.json', { ...validDescriptor(), id: 'claude' });
    const client = await harness.connect();
    const { loaded, rejected } = await client.call('providers.reload', {});
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.field).toBe('id');
    const claude = loaded.find((provider) => provider.id === 'claude');
    expect(claude?.source).toBe('shipped');
  });

  test('dryRun validates and returns the plan without loading', async () => {
    const file = writeUserDescriptor('dry.json', validDescriptor());
    const client = await harness.connect();
    const result = await client.call('providers.dryRun', { file });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('the descriptor was refused');
    expect(result.summary.id).toBe('mine');
    expect(result.plan.roots).toEqual(['{isolationDir}']);
    expect(result.plan.env).toEqual(['MINE_HOME']);
    expect(result.plan.closes).toEqual(process.platform === 'win32' ? ['mine.exe'] : []);
  });

  test('dryRun reads the providers directory and nothing else on the machine', async () => {
    const client = await harness.connect();
    const outside = join(harness.dataDir, 'core.json');
    const expected = `a .json file under ${join(harness.dataDir, 'providers')}`;
    // A path the caller names used to be read and parsed: the parse error came
    // back with a line of the file in it, which turned dryRun into a way to
    // read the machine one message at a time.
    for (const file of [outside, join(harness.dataDir, 'providers', '..', '..', 'core.json'), 'C:\\Windows\\win.ini']) {
      const result = await client.call('providers.dryRun', { file });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error(`${file} should have been refused`);
      expect(result.rejected.expected).toBe(expected);
      expect(result.rejected.message).toBe(
        'a descriptor is read from the providers directory of the data directory, nowhere else',
      );
    }

    // Inside the directory, but not a descriptor file: refused the same way.
    mkdirSync(join(harness.dataDir, 'providers'), { recursive: true });
    const notJson = join(harness.dataDir, 'providers', 'notes.txt');
    writeFileSync(notJson, 'not a descriptor', 'utf8');
    const refused = await client.call('providers.dryRun', { file: notJson });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('notes.txt should have been refused');
    expect(refused.rejected.expected).toBe(expected);
  });

  test('dryRun reports the refusal with file, field and expected', async () => {
    const file = writeUserDescriptor('dry-bad.json', { ...validDescriptor(), protocol: 'smoke-signals' });
    const client = await harness.connect();
    const result = await client.call('providers.dryRun', { file });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('the descriptor should have been refused');
    expect(result.rejected.file).toBe(file);
    expect(result.rejected.field).toBe('protocol');
    expect(result.rejected.expected).toContain('claude-sdk');
  });
});
