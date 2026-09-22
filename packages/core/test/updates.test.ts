import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'bun:test';
import type { HarnessUpdate } from '@boite/contracts';
import type { CoreClient } from '../src/client.ts';
import { compareVersions, inside, readVersion } from '../src/providers/updates.ts';
import { echoThread, startTestCore, waitFor } from './harness.ts';
import type { TestCore } from './harness.ts';

const FAKE = fileURLToPath(new URL('./fixtures/update-agent.ts', import.meta.url));

let harness: TestCore | null = null;

afterEach(async () => {
  await harness?.stop();
  harness = null;
});

/** A user descriptor whose updater is the fixture, reading its newest version the way `source` says. */
function writeDescriptor(dataDir: string, source: 'command' | 'npm' | 'none', updater: string): string {
  const dir = join(dataDir, 'providers');
  mkdirSync(dir, { recursive: true });
  const state = join(dataDir, 'fake-version.txt');
  writeFileSync(state, '1.0.0');
  const profile = {
    detect: {},
    executable: [{ kind: 'path', value: 'bun' }],
    update: {
      versionArgs: [FAKE, state, '--version'],
      ...(source === 'command' ? { latestArgs: [FAKE, state, 'check'] } : source === 'npm' ? { latestNpm: '@boite-test/fake-agent' } : {}),
      args: [FAKE, state, updater],
    },
    isolation: {},
  };
  writeFileSync(
    join(dir, 'update-fake.json'),
    JSON.stringify({
      id: 'update-fake',
      schemaVersion: 1,
      name: 'Fake updating agent',
      shortName: 'UpFake',
      protocol: 'acp',
      roots: ['{isolationDir}'],
      profiles: { windows: profile, linux: profile, macos: profile },
      auth: { kind: 'none' },
      models: [{ id: 'default', name: 'Agent default', default: true }],
      capabilities: { approvals: true, hooks: false, checkpoint: false, images: false, planMode: false, resume: false },
    }),
    'utf8',
  );
  return state;
}

async function start(source: 'command' | 'npm' | 'none', updater = 'update'): Promise<{ client: CoreClient; state: string }> {
  harness = await startTestCore();
  // Only the fixture: a check must never run the agents of the machine the tests run on.
  harness.core.updates.only = new Set(['update-fake']);
  harness.core.updates.npmLatest = async (name) => {
    expect(name).toBe('@boite-test/fake-agent');
    return '1.1.0';
  };
  const state = writeDescriptor(harness.dataDir, source, updater);
  const client = await harness.connect();
  const loaded = await client.call('providers.reload', {});
  expect(loaded.rejected).toEqual([]);
  return { client, state };
}

function only(list: HarnessUpdate[]): HarnessUpdate {
  expect(list.map((update) => update.providerId)).toEqual(['update-fake']);
  return list[0]!;
}

describe('harness updates', () => {
  test('versions compare by their numbers, a pre-release older than its release', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1);
    expect(compareVersions('2.1.278', '2.1.278')).toBe(0);
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBe(-1);
    expect(compareVersions('0.85.1', '0.86.1')).toBe(-1);
    expect(compareVersions('1.0.0-beta.10', '1.0.0-beta.2')).toBe(1);
    expect(readVersion('codex-cli 0.155.1')).toBe('0.155.1');
    expect(readVersion('grok 1.0.34 (3736acbc8658) [stable]')).toBe('1.0.34');
    expect(readVersion('nothing here')).toBeNull();
    expect(inside(join('a', 'codex'), join('a', 'codex', 'bin', 'agent'))).toBe(true);
    expect(inside(join('a', 'codex'), join('a', 'codex-other', 'agent'))).toBe(false);
  });

  test('an agent that checks by itself is read, updated by its own updater, and traced', async () => {
    const { client, state } = await start('command');

    const before = only(await client.call('providers.updates', {}));
    expect(before).toMatchObject({ route: 'self', current: '1.0.0', latest: '1.2.0', pending: true, state: 'idle', skipped: null });

    const changed = client.next('providers.updatesChanged', (list) => list[0]?.state === 'idle' && list[0]?.current === '1.2.0', 20000);
    const started = await client.call('providers.update', { providerId: 'update-fake' });
    expect(started.state).toBe('updating');
    expect(only(await changed)).toMatchObject({ current: '1.2.0', latest: '1.2.0', pending: false, message: null });
    expect(readFileSync(state, 'utf8')).toBe('1.2.0');

    // Nothing newer is left, and the refusal says so.
    await expect(client.call('providers.update', { providerId: 'update-fake' })).rejects.toThrow(/already on its newest known version/);

    // Every run of the agent went through the process registry.
    const trace = await client.call('trace.get', { threadId: 'update:update-fake' });
    expect(trace.length).toBeGreaterThanOrEqual(4);
    await waitFor(() => harness?.core.procs.liveCount('update:update-fake') === 0);
  });

  test('an agent that cannot name its newest version announces nothing and still runs its updater when asked', async () => {
    const { client, state } = await start('none');

    const before = only(await client.call('providers.updates', {}));
    expect(before).toMatchObject({ route: 'self', current: '1.0.0', latest: null, pending: false, state: 'idle' });

    const changed = client.next('providers.updatesChanged', (list) => list[0]?.state === 'idle' && list[0]?.current === '1.2.0', 20000);
    expect((await client.call('providers.update', { providerId: 'update-fake' })).state).toBe('updating');
    expect(only(await changed)).toMatchObject({ current: '1.2.0', latest: null, pending: false, message: null });
    expect(readFileSync(state, 'utf8')).toBe('1.2.0');
    await waitFor(() => harness?.core.procs.liveCount('update:update-fake') === 0);
  });

  test('the npm registry names the newest version, and a skipped one stays quiet until the next', async () => {
    const { client } = await start('npm');

    expect(only(await client.call('providers.updates', {}))).toMatchObject({ current: '1.0.0', latest: '1.1.0', pending: true });

    const skipped = await client.call('providers.updateSkip', { providerId: 'update-fake', version: '1.1.0' });
    expect(skipped).toMatchObject({ pending: false, skipped: '1.1.0' });
    expect(only(await client.call('providers.updates', { refresh: true })).pending).toBe(false);
    expect(JSON.parse(readFileSync(join(harness!.dataDir, 'harness-updates.json'), 'utf8'))).toEqual({ skipped: { 'update-fake': '1.1.0' } });

    harness!.core.updates.npmLatest = async () => '1.3.0';
    expect(only(await client.call('providers.updates', { refresh: true }))).toMatchObject({ latest: '1.3.0', pending: true, skipped: '1.1.0' });

    const forgotten = await client.call('providers.updateSkip', { providerId: 'update-fake', version: null });
    expect(forgotten.skipped).toBeNull();
  });

  test('an updater that fails says why, and the version stays what it was', async () => {
    const { client } = await start('command', 'update-broken');
    await client.call('providers.updates', {});

    const failed = client.next('providers.updatesChanged', (list) => list[0]?.state === 'failed', 20000);
    await client.call('providers.update', { providerId: 'update-fake' });
    const update = only(await failed);
    expect(update.current).toBe('1.0.0');
    expect(update.message).toContain('exited with 3');
    expect(update.message).toContain('the release server refused the download');
  });

  test('a provider with a turn in flight is not updated under it', async () => {
    const { client } = await start('command');
    await client.call('providers.updates', {});
    const project = await client.call('projects.add', { path: harness!.dataDir, name: 'updates' });
    const account = await client.call('accounts.add', { providerId: 'update-fake', label: 'Fake', useDefaultLocation: true });
    const thread = await client.call('threads.create', { projectId: project.id, providerId: 'update-fake', accountId: account.id, title: 'busy' });
    harness!.core.journal.putThread({ ...harness!.core.journal.getThread(thread.id)!, status: 'running' });

    await expect(client.call('providers.update', { providerId: 'update-fake' })).rejects.toThrow(/1 turn in flight/);
  });

  test('an accepted turn still protects its provider after the picker changes', async () => {
    const { client, state } = await start('command');
    const core = harness!.core;
    await client.call('providers.updates', {});
    await client.call('settings.set', { maxConcurrentTurns: 1 });
    const blocker = await echoThread(harness!, client);
    await client.call('turns.start', { threadId: blocker.threadId, prompt: '[sleep:60000]' });
    const account = await client.call('accounts.add', { providerId: 'update-fake', label: 'Fake', useDefaultLocation: true });
    const thread = await client.call('threads.create', { projectId: core.threads.require(blocker.threadId).projectId, providerId: 'update-fake', accountId: account.id });
    await client.call('turns.start', { threadId: thread.id, prompt: 'queued on the old provider' });
    await client.call('threads.update', { threadId: thread.id, accountId: blocker.accountId });
    expect(core.threads.require(thread.id).providerId).toBe('echo');
    try {
      await expect(client.call('providers.update', { providerId: 'update-fake' })).rejects.toThrow(/1 turn in flight/);
      expect(readFileSync(state, 'utf8')).toBe('1.0.0');
    } finally { await client.call('turns.stop', { threadId: thread.id }); }
  });

  test('an update asked for during a check waits for it, and a second one is refused while the first runs', async () => {
    const { client } = await start('npm');
    await client.call('providers.updates', {});

    const project = await client.call('projects.add', { path: harness!.dataDir, name: 'updates' });
    const account = await client.call('accounts.add', { providerId: 'update-fake', label: 'Fake', useDefaultLocation: true });
    const thread = await client.call('threads.create', { projectId: project.id, providerId: 'update-fake', accountId: account.id, title: 'gate' });

    let release = (): void => {};
    const gate = new Promise<void>((done) => (release = done));
    harness!.core.updates.npmLatest = async () => {
      await gate;
      return '1.1.0';
    };
    const checked = client.call('providers.updates', { refresh: true });
    await client.next('providers.updatesChanged', (list) => list[0]?.state === 'checking', 20000);
    const started = client.call('providers.update', { providerId: 'update-fake' });
    await new Promise((done) => setTimeout(done, 50));
    release();

    expect((await started).state).toBe('updating');
    // A turn started now would run on a program half replaced.
    expect(harness!.core.updates.updating('update-fake')).toBe(true);
    await expect(client.call('turns.start', { threadId: thread.id, prompt: 'hello' })).rejects.toThrow(/is updating/);
    await checked;
    await expect(client.call('providers.update', { providerId: 'update-fake' })).rejects.toThrow(/already updating/);
    await client.next('providers.updatesChanged', (list) => list[0]?.state === 'idle' && list[0]?.current === '1.2.0', 20000);
    await waitFor(() => harness?.core.procs.liveCount('update:update-fake') === 0);
  });

  test('a descriptor whose update block is wrong is refused by field', async () => {
    harness = await startTestCore();
    const dir = join(harness.dataDir, 'providers');
    writeDescriptor(harness.dataDir, 'npm', 'update');
    const file = join(dir, 'update-fake.json');
    const descriptor = JSON.parse(readFileSync(file, 'utf8'));
    descriptor.profiles.windows.update.latestNpm = '../../etc/passwd';
    descriptor.profiles.linux.update.latestNpm = '../../etc/passwd';
    descriptor.profiles.macos.update.latestNpm = '../../etc/passwd';
    writeFileSync(file, JSON.stringify(descriptor));
    const client = await harness.connect();
    const loaded = await client.call('providers.reload', {});
    expect(loaded.rejected).toHaveLength(1);
    expect(loaded.rejected[0]?.field).toContain('update.latestNpm');
  });

  test('an updater waiting on a check cannot start after the store closes', async () => {
    const { state } = await start('npm');
    const updates = harness!.core.updates;
    await updates.check();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const checking = new Promise<void>(resolve => { entered = resolve; });
    updates.npmLatest = async () => { entered(); await gate; return '1.1.0'; };
    const checked = updates.check();
    await checking;
    const update = updates.update('update-fake');
    updates.close();
    release();
    await checked;
    await expect(update).rejects.toThrow('stopping');
    expect(readFileSync(state, 'utf8')).toBe('1.0.0');
  });
});
