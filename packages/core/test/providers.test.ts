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
  test('the shipped descriptors load', async () => {
    const client = await harness.connect();
    const { loaded, rejected } = await client.call('providers.list', {});
    expect(rejected).toEqual([]);
    const ids = loaded.map((provider) => provider.id).sort();
    expect(ids).toEqual(['claude', 'echo', 'gemini', 'opencode']);

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
    const profile = descriptor.profiles[process.platform === 'win32' ? 'windows' : 'linux'];
    expect(profile?.launch?.args).toEqual(['acp', '--port', '0']);
    expect(profile?.isolation).toEqual({ XDG_DATA_HOME: '{isolationDir}', XDG_CONFIG_HOME: '{isolationDir}' });
    expect(descriptor.auth).toEqual({ kind: 'oauth-cli', session: ['opencode/auth.json'] });
    expect(descriptor.login?.command).toEqual(['opencode', 'auth', 'login']);
  });

  test('{appdata} expands at load, so the windows candidate is a real absolute path', () => {
    const windows = harness.core.providers.require('opencode').profiles.windows;
    const candidate = windows?.executable[0];
    expect(candidate?.kind).toBe('file');
    expect(candidate?.value).not.toContain('{appdata}');
    if (process.platform === 'win32') {
      expect(candidate?.value.startsWith(process.env['APPDATA'] ?? '')).toBe(true);
    }
    expect(candidate?.value).toContain(`opencode-ai${sep}bin`);
    expect(candidate?.value.toLowerCase()).toEndWith('opencode.exe');
  });

  test('the shipped gemini descriptor loads and is launched as node with the cli entry', async () => {
    const client = await harness.connect();
    const { loaded, rejected } = await client.call('providers.list', {});
    expect(rejected).toEqual([]);

    const gemini = loaded.find((provider) => provider.id === 'gemini');
    expect(gemini?.source).toBe('shipped');
    expect(gemini?.protocol).toBe('acp');
    expect(gemini?.name).toBe('Gemini CLI');
    expect(gemini?.models).toEqual([{ id: 'default', name: 'Gemini default', default: true }]);

    const descriptor = harness.core.providers.require('gemini');
    // The CLI keeps everything under one home of its own, session file included.
    expect(descriptor.auth).toEqual({ kind: 'oauth-cli', session: ['.gemini/oauth_creds.json'] });
    // No login block: the first `gemini` run logs in, outside Boite.
    expect(descriptor.login).toBeUndefined();

    const profile = descriptor.profiles[process.platform === 'win32' ? 'windows' : 'linux'];
    expect(profile?.isolation).toEqual({ GEMINI_CLI_HOME: '{isolationDir}' });
    const args = profile?.launch?.args ?? [];
    expect(args.at(-1)).toBe('--experimental-acp');
    if (process.platform !== 'win32') {
      expect(args).toEqual(['--experimental-acp']);
      return;
    }
    // npm installs a `.cmd` shim Bun cannot spawn, so the entry is node plus the
    // bundle's own js, and `{appdata}` has to be a real path by the time it runs.
    expect(profile?.executable[0]).toEqual({ kind: 'path', value: 'node' });
    const entry = args[0] ?? '';
    expect(entry).not.toContain('{appdata}');
    expect(entry.startsWith(process.env['APPDATA'] ?? '')).toBe(true);
    expect(entry).toEndWith('gemini.js');

    if (gemini?.available !== true) {
      console.log('gemini cli is not installed here, the executable assertion is skipped');
      return;
    }
    expect(gemini.executable?.toLowerCase()).toContain('node');
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
