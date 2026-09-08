import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
    expect(ids).toEqual(['claude', 'echo']);

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
