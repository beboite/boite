import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderRejected } from '@boite/contracts';
import { countEvents, readSource } from '../src/hooks.ts';
import { Rejection, validateDescriptor } from '../src/providers/validate.ts';
import { removeDir, startTestCore } from './harness.ts';
import type { TestCore } from './harness.ts';

function descriptor(extra: Record<string, unknown>, hooks = true): Record<string, unknown> {
  const profile = { detect: {}, executable: [{ kind: 'path', value: 'mine' }], isolation: { MINE_HOME: '{isolationDir}', XDG_CONFIG_HOME: '{isolationDir}/config' } };
  return {
    id: 'mine',
    schemaVersion: 1,
    name: 'Mine',
    shortName: 'Mine',
    protocol: 'acp',
    roots: ['{isolationDir}'],
    profiles: { windows: profile, linux: profile, macos: profile },
    auth: { kind: 'oauth-cli', session: ['auth.json', 'config/mine/token.json'] },
    seedFiles: { 'seeded/settings.json': '{}' },
    models: [{ id: 'mine-1', name: 'Mine 1', default: true }],
    capabilities: { approvals: true, hooks, checkpoint: false, images: false, planMode: false, resume: true },
    ...extra,
  };
}

function refusal(raw: Record<string, unknown>): ProviderRejected {
  try {
    validateDescriptor(raw, 'mine.json', new Set(), tmpdir());
  } catch (error) {
    if (error instanceof Rejection) return error.rejected;
    throw error;
  }
  throw new Error('the descriptor was accepted');
}

describe('hook descriptors', () => {
  test('shares and hook sources load as written', () => {
    const loaded = validateDescriptor(descriptor({
      shared: [{ variable: 'MINE_HOME', paths: ['settings.json', 'hooks'], retarget: { 'settings.json': ['hooks'] } }],
      hookSources: [{ variable: 'MINE_HOME', path: 'hooks', format: 'events' }, { path: '~/.claude/settings.json', format: 'events' }],
    }), 'mine.json', new Set(), tmpdir());
    expect(loaded.shared).toEqual([{ variable: 'MINE_HOME', paths: ['settings.json', 'hooks'], retarget: { 'settings.json': ['hooks'] } }]);
    expect(loaded.hookSources).toHaveLength(2);
  });

  test('a share that would hand out a login or fight a seed file is refused by name', () => {
    expect(refusal(descriptor({ shared: [{ variable: 'MINE_HOME', paths: ['auth.json'] }] }))).toMatchObject({ field: 'shared[0].paths[0]' });
    // XDG_CONFIG_HOME sits under `config/`, where the token lives.
    expect(refusal(descriptor({ shared: [{ variable: 'XDG_CONFIG_HOME', paths: ['mine'] }] })).message).toContain('config/mine/token.json');
    expect(refusal(descriptor({ shared: [{ variable: 'MINE_HOME', paths: ['seeded'] }] })).message).toContain('seeded/settings.json');
  });

  test('a share or source outside its directory, or naming what no profile isolates, is refused', () => {
    expect(refusal(descriptor({ shared: [{ variable: 'MINE_HOME', paths: ['../elsewhere'] }] }))).toMatchObject({ field: 'shared[0].paths[0]' });
    expect(refusal(descriptor({ shared: [{ variable: 'MINE_HOME', paths: ['C:/Users'] }] }))).toMatchObject({ field: 'shared[0].paths[0]' });
    expect(refusal(descriptor({ shared: [{ variable: 'OTHER_HOME', paths: ['x'] }] }))).toMatchObject({ field: 'shared[0].variable' });
    expect(refusal(descriptor({ shared: [{ variable: 'MINE_HOME', paths: ['a'], retarget: { b: ['a'] } }] }))).toMatchObject({ field: 'shared[0].retarget.b' });
    expect(refusal(descriptor({ hookSources: [{ path: '/etc/hooks.json', format: 'events' }] }))).toMatchObject({ field: 'hookSources[0].path' });
    expect(refusal(descriptor({ hookSources: [{ variable: 'MINE_HOME', path: 'hooks', format: 'yaml' }] }))).toMatchObject({ field: 'hookSources[0].format' });
  });

  test('hook sources need an agent that runs hooks', () => {
    expect(refusal(descriptor({ hookSources: [{ variable: 'MINE_HOME', path: 'hooks', format: 'events' }] }, false)))
      .toMatchObject({ field: 'hookSources', expected: 'capabilities.hooks set to true' });
  });
});

describe('hook sources', () => {
  let root: string;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'boite-hooks-'));
    saved = { MINE_HOME: process.env.MINE_HOME, BOITE_HOST_AGENTS: process.env.BOITE_HOST_AGENTS };
    process.env.MINE_HOME = root;
    process.env.BOITE_HOST_AGENTS = '1';
  });

  afterEach(async () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await removeDir(root);
  });

  test('an events file counts each inner hook, a directory every JSON file in it', () => {
    expect(countEvents({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{}, {}] }], Stop: [{ hooks: [{}] }, { command: 'x' }] } })).toBe(4);
    expect(countEvents({ model: 'x' })).toBe(0);

    writeFileSync(join(root, 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{}, {}] }] } }));
    expect(readSource({ variable: 'MINE_HOME', path: 'settings.json', format: 'events' })).toMatchObject({ count: 2, error: null });

    mkdirSync(join(root, 'hooks'));
    writeFileSync(join(root, 'hooks', 'a.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{}] }] } }));
    writeFileSync(join(root, 'hooks', 'b.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{}, {}] }] } }));
    writeFileSync(join(root, 'hooks', 'notes.md'), 'ignored');
    expect(readSource({ variable: 'MINE_HOME', path: 'hooks', format: 'events' })).toMatchObject({ count: 3, error: null });

    writeFileSync(join(root, 'hooks', 'c.json'), '{ not json');
    expect(readSource({ variable: 'MINE_HOME', path: 'hooks', format: 'events' }).error).toContain('not valid JSON');
    expect(readSource({ variable: 'MINE_HOME', path: 'missing.json', format: 'events' })).toMatchObject({ count: null, error: null });
    // Under a file: ENOENT on Windows, ENOTDIR on Linux and macOS, missing either way.
    expect(readSource({ variable: 'MINE_HOME', path: 'settings.json/hooks.json', format: 'events' })).toMatchObject({ count: null, error: null });
  });

  test('a modules directory counts scripts and packages, never dotfiles or notes', () => {
    mkdirSync(join(root, 'plugins', 'a-package'), { recursive: true });
    mkdirSync(join(root, 'plugins', '.cache'));
    writeFileSync(join(root, 'plugins', 'guard.ts'), '');
    writeFileSync(join(root, 'plugins', 'notify.mjs'), '');
    writeFileSync(join(root, 'plugins', 'README.md'), '');
    expect(readSource({ variable: 'MINE_HOME', path: 'plugins', format: 'modules' })).toMatchObject({ count: 3, error: null });
  });

  test('a test core reads nothing of the profile it would count', () => {
    process.env.BOITE_HOST_AGENTS = '0';
    writeFileSync(join(root, 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{}] }] } }));
    expect(readSource({ variable: 'MINE_HOME', path: 'settings.json', format: 'events' })).toMatchObject({ count: null, error: null });
  });
});

describe('hook ledger', () => {
  let harness: TestCore;

  beforeEach(async () => {
    harness = await startTestCore();
  });

  afterEach(async () => {
    await harness.stop();
  });

  test('passing runs only count, the others are kept newest first and announced, a skip once', async () => {
    const client = await harness.connect();
    const ledger = harness.core.hooks;
    const where = { providerId: 'echo', accountId: null, threadId: null };
    ledger.record(where, { event: 'Stop', name: 'Stop', outcome: 'ok', message: null });
    const changed = client.next('hooks.changed', () => true);
    ledger.record(where, { event: 'PreToolUse', name: 'PreToolUse:Bash', outcome: 'blocked', message: ' no bash here ' });
    await changed;
    ledger.record(where, { event: 'Stop', name: 'Stop', outcome: 'failed', message: 'x'.repeat(900) });
    ledger.record(where, { event: 'preToolUse', name: '~/.codex/hooks.json', outcome: 'skipped', message: 'not reviewed yet' });
    ledger.record(where, { event: 'preToolUse', name: '~/.codex/hooks.json', outcome: 'skipped', message: 'not reviewed yet' });
    ledger.record(where, { event: 'stop', name: '~/.codex/hooks.json', outcome: 'skipped', message: 'not reviewed yet' });

    const status = await client.call('hooks.status', {});
    expect(status.providers.find((provider) => provider.providerId === 'echo'))
      .toMatchObject({ runsHooks: false, reports: false, sources: [], accounts: [], runs: 3, blocked: 1, failed: 1, skipped: 2 });
    expect(status.recent.map((run) => run.outcome)).toEqual(['skipped', 'skipped', 'failed', 'blocked']);
    expect(status.recent[2]?.message).toHaveLength(500);
    expect(status.recent[3]?.message).toBe('no bash here');

    for (let index = 0; index < 60; index += 1) ledger.record(where, { event: 'Stop', name: 'Stop', outcome: 'failed', message: String(index) });
    const capped = ledger.status().recent;
    expect(capped).toHaveLength(50);
    expect(capped[0]?.message).toBe('59');
  });
});
