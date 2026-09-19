import { currentOs } from '../src/paths.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { startTestCore } from './harness.ts';
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
    expect(ids).toEqual(['antigravity', 'claude', 'codex', 'echo', 'grok', 'opencode', 'pi']);

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

  test('{appdata} expands at load, so the windows candidate is a real absolute path', () => {
    const windows = harness.core.providers.require('opencode').profiles.windows;
    // Boite's own release is named first, the npm copy right behind it.
    const candidate = windows?.executable[1];
    expect(candidate?.kind).toBe('file');
    expect(candidate?.value).not.toContain('{appdata}');
    if (process.platform === 'win32') {
      expect(candidate?.value.startsWith(process.env['APPDATA'] ?? '')).toBe(true);
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
    // spawn, so the real vendored exe is named next, and `{appdata}` has to be a
    // real path by the time it runs.
    const candidate = profile?.executable[1];
    expect(candidate?.kind).toBe('file');
    expect(candidate?.value).not.toContain('{appdata}');
    expect(candidate?.value.startsWith(process.env['APPDATA'] ?? '')).toBe(true);
    expect(candidate?.value.toLowerCase()).toEndWith('codex.exe');
    expect(profile?.executable.at(-1)).toEqual({ kind: 'path', value: 'codex' });
    expect(profile?.close?.processes).toEqual(['codex.exe', 'codex-x86_64-pc-windows-msvc.exe']);

    if (codex?.available !== true) {
      console.log('codex is not installed here, the executable assertion is skipped');
      return;
    }
    expect(codex.executable?.toLowerCase()).toEndWith('codex.exe');
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
