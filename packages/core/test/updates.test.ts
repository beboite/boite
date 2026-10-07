import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'bun:test';
import type { HarnessUpdate } from '@boite/contracts';
import type { CoreClient } from '../src/client.ts';
import { Core } from '../src/core.ts';
import { newToken } from '../src/ids.ts';
import { npmInstallOf } from '../src/providers/npm.ts';
import { compareVersions, inside, readVersion } from '../src/providers/updates.ts';
import { holdAccountTurns, echoThread, startTestCore, waitFor } from './harness.ts';
import type { TestCore } from './harness.ts';

const FAKE = fileURLToPath(new URL('./fixtures/update-agent.ts', import.meta.url));

let harness: TestCore | null = null;

afterEach(async () => {
  await harness?.stop();
  harness = null;
});

/** A user descriptor whose updater is the fixture, reading its newest version the way `source` says. */
function writeDescriptor(
  dataDir: string,
  source: 'command' | 'npm' | 'none',
  updater: string,
  updateEnv?: Record<string, string>,
  program: { kind: 'path' | 'file'; value: string } = { kind: 'path', value: 'bun' },
): string {
  const dir = join(dataDir, 'providers');
  mkdirSync(dir, { recursive: true });
  const state = join(dataDir, 'fake-version.txt');
  writeFileSync(state, '1.0.0');
  const profile = {
    detect: {},
    executable: [{ ...program, ...(updateEnv === undefined ? {} : { updateEnv }) }],
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
      // Turns run on the deterministic echo driver; the updater is the fixture's own.
      protocol: 'echo',
      roots: ['{isolationDir}'],
      profiles: { windows: profile, linux: profile, macos: profile },
      auth: { kind: 'none' },
      models: [{ id: 'default', name: 'Agent default', default: true }],
      capabilities: { approvals: true, hooks: false, checkpoint: false, images: false, planMode: false, resume: true },
    }),
    'utf8',
  );
  return state;
}

/**
 * A global npm install of the fixture under `<dataDir>/npm`, the Unix layout:
 * the package in `lib/node_modules/@boite-test/fake-agent`, its link in `bin`.
 * Returns the link, the program PATH would find, and the directories as the
 * core reads them: through their links, `/private/var` for macOS's `/var`.
 */
function npmLayout(dataDir: string): { prefix: string; scope: string; link: string } {
  const prefix = join(dataDir, 'npm');
  const scope = join(prefix, 'lib', 'node_modules', '@boite-test');
  const bin = join(scope, 'fake-agent', 'bin');
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(prefix, 'bin'), { recursive: true });
  const script = join(bin, 'agent');
  writeFileSync(script, `#!/bin/sh\nexec '${process.execPath}' "$@"\n`);
  chmodSync(script, 0o755);
  const link = join(prefix, 'bin', 'fake-agent');
  symlinkSync(script, link);
  return { prefix: realpathSync(prefix), scope: realpathSync(scope), link };
}

/** Unix permissions decide the writability tests; root writes through them. */
const unixUser = process.platform !== 'win32' && process.getuid?.() !== 0;

async function start(
  source: 'command' | 'npm' | 'none',
  updater = 'update',
  updateEnv?: Record<string, string>,
  program?: (dataDir: string) => { kind: 'path' | 'file'; value: string },
): Promise<{ client: CoreClient; state: string }> {
  harness = await startTestCore();
  // Only the fixture: a check must never run the agents of the machine the tests run on.
  harness.core.updates.only = new Set(['update-fake']);
  harness.core.updates.npmLatest = async (name) => {
    expect(name).toBe('@boite-test/fake-agent');
    return '1.1.0';
  };
  const state = writeDescriptor(harness.dataDir, source, updater, updateEnv, program?.(harness.dataDir));
  const client = await harness.connect();
  const loaded = await client.call('providers.reload', {});
  expect(loaded.rejected).toEqual([]);
  return { client, state };
}

/** Resolves when a tool card of that thread starts running, whether or not a client watches the thread. */
function toolRunning(threadId: string): Promise<void> {
  return new Promise((resolve) => {
    const off = harness!.core.bus.onAny((name, payload) => {
      const event = payload as { threadId?: string; part?: { type: string; status?: string } };
      if (name !== 'message.part' || event.threadId !== threadId || event.part?.type !== 'tool' || event.part.status !== 'running') return;
      off();
      resolve();
    });
  });
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

  test.skipIf(process.platform === 'win32')('a global npm install is found through its link, scoped or not', () => {
    const dir = mkdtempSync(join(tmpdir(), 'boite-npm-'));
    try {
      const { prefix, link } = npmLayout(dir);
      expect(npmInstallOf(link)).toEqual({ prefix, packageDir: join(prefix, 'lib', 'node_modules', '@boite-test', 'fake-agent') });
      expect(npmInstallOf('/usr/lib/node_modules/opencode-ai/bin/opencode.exe')).toEqual({ prefix: '/usr', packageDir: '/usr/lib/node_modules/opencode-ai' });
      // pnpm and Bun keep their globals elsewhere, and a native install is no npm install.
      expect(npmInstallOf('/home/u/.bun/install/global/node_modules/x/bin/x')).toBeNull();
      expect(npmInstallOf('/home/u/.local/share/claude/versions/2.1.285')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an agent that checks by itself is read, updated by its own updater, and traced', async () => {
    const { client, state } = await start('command');

    const before = only(await client.call('providers.updates', { refresh: true }));
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

    const before = only(await client.call('providers.updates', { refresh: true }));
    expect(before).toMatchObject({ route: 'self', current: '1.0.0', latest: null, pending: false, state: 'idle' });

    const changed = client.next('providers.updatesChanged', (list) => list[0]?.state === 'idle' && list[0]?.current === '1.2.0', 20000);
    expect((await client.call('providers.update', { providerId: 'update-fake' })).state).toBe('updating');
    // What the updater installed is its newest release until the next check reads again.
    expect(only(await changed)).toMatchObject({ current: '1.2.0', latest: '1.2.0', pending: false, message: null });
    expect(readFileSync(state, 'utf8')).toBe('1.2.0');
    await waitFor(() => harness?.core.procs.liveCount('update:update-fake') === 0);
    expect(only(await client.call('providers.updates', { refresh: true }))).toMatchObject({ current: '1.2.0', latest: null });
  });

  test.skipIf(process.platform === 'win32')('an updater that rewrites a program told apart by its major is read again, not reported gone', async () => {
    harness = await startTestCore();
    harness.core.updates.only = new Set(['gated-fake']);
    // A program that names its version and whose updater replaces its own file, as `opencode upgrade` does.
    const program = join(harness.dataDir, 'gated-agent');
    const script = (version: string): string => `#!/bin/sh\n# ${version} padded so the file changes size: ${'x'.repeat(version.length * 7)}\ncase "$1" in\n  --version) echo "gated-agent ${version}";;\n  update) cp "$0.next" "$0.tmp" && mv "$0.tmp" "$0"; echo "updated";;\nesac\n`;
    writeFileSync(program, script('1.0.0'));
    writeFileSync(`${program}.next`, script('1.12.0'));
    chmodSync(program, 0o755);
    chmodSync(`${program}.next`, 0o755);
    const profile = { detect: {}, executable: [{ kind: 'file', value: program, major: 1 }], update: { args: ['update'] }, isolation: {} };
    mkdirSync(join(harness.dataDir, 'providers'), { recursive: true });
    writeFileSync(join(harness.dataDir, 'providers', 'gated-fake.json'), JSON.stringify({
      id: 'gated-fake', schemaVersion: 1, name: 'Gated agent', shortName: 'Gated', protocol: 'acp', roots: ['{isolationDir}'],
      profiles: { linux: profile, macos: profile }, auth: { kind: 'none' },
      models: [{ id: 'default', name: 'Agent default', default: true }],
      capabilities: { approvals: true, hooks: false, checkpoint: false, images: false, planMode: false, resume: false },
    }));
    const client = await harness.connect();
    expect((await client.call('providers.reload', {})).loaded.find((provider) => provider.id === 'gated-fake')).toMatchObject({ available: true, executable: program });
    expect((await client.call('providers.updates', { refresh: true }))[0]).toMatchObject({ providerId: 'gated-fake', current: '1.0.0', state: 'idle' });

    // The file changed under the kept reading: the read that follows the updater waits for the new one.
    const changed = client.next('providers.updatesChanged', (list) => list[0]?.state !== 'updating' && list[0]?.state !== 'checking' && list[0]?.current !== '1.0.0', 20000);
    expect((await client.call('providers.update', { providerId: 'gated-fake' })).state).toBe('updating');
    expect((await changed)[0]).toMatchObject({ current: '1.12.0', state: 'idle', message: null });
    expect(harness.core.providers.summary('gated-fake')).toMatchObject({ available: true, executable: program });
    await waitFor(() => harness?.core.procs.liveCount('update:gated-fake') === 0);
  });

  test('an updater that finds nothing newer leaves the agent reading as current, not failed', async () => {
    const { client } = await start('none', 'update-current');

    only(await client.call('providers.updates', { refresh: true }));
    const changed = client.next('providers.updatesChanged', (list) => list[0]?.state === 'idle' && list[0]?.latest !== null, 20000);
    expect((await client.call('providers.update', { providerId: 'update-fake' })).state).toBe('updating');
    expect(only(await changed)).toMatchObject({ current: '1.0.0', latest: '1.0.0', pending: false, state: 'idle', message: null });
    await waitFor(() => harness?.core.procs.liveCount('update:update-fake') === 0);
  });

  test('the npm registry names the newest version, and a skipped one stays quiet until the next', async () => {
    const { client } = await start('npm');

    expect(only(await client.call('providers.updates', { refresh: true }))).toMatchObject({ current: '1.0.0', latest: '1.1.0', pending: true });

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
    await client.call('providers.updates', { refresh: true });

    const failed = client.next('providers.updatesChanged', (list) => list[0]?.state === 'failed', 20000);
    await client.call('providers.update', { providerId: 'update-fake' });
    const update = only(await failed);
    expect(update.current).toBe('1.0.0');
    expect(update.message).toContain('exited with 3');
    expect(update.message).toContain('the release server refused the download');
  });

  test('an updater that fails and exits with zero is failed with its own reason, not its closing line', async () => {
    const { client } = await start('npm', 'update-stuck');
    await client.call('providers.updates', { refresh: true });
    const failed = client.next('providers.updatesChanged', (list) => list[0]?.state === 'failed', 20000);
    await client.call('providers.update', { providerId: 'update-fake' });
    const update = only(await failed);
    expect(update.current).toBe('1.0.0');
    expect(update.message).toBe('Fake updating agent ran its updater and still reports 1.0.0: Upgrade failed for npm (exit code 1).');
  });

  test('npm permission failures report the denied path rather than progress or the log location', async () => {
    const { client } = await start('command', 'update-permission');
    await client.call('providers.updates', { refresh: true });
    const failed = client.next('providers.updatesChanged', (list) => list[0]?.state === 'failed', 20000);
    await client.call('providers.update', { providerId: 'update-fake' });
    const update = only(await failed);
    expect(update.current).toBe('1.0.0');
    expect(update.message).toContain('exited with 1');
    expect(update.message).toContain('EACCES: permission denied');
    expect(update.message).toContain('/usr/lib/node_modules/@boite-test');
    expect(update.message).not.toContain('/tmp/npm-debug.log');
  });

  test('an updater that reads how it was installed gets the environment its skipped launcher sets', async () => {
    const bare = await start('command', 'update-launched');
    await bare.client.call('providers.updates', { refresh: true });
    const failed = bare.client.next('providers.updatesChanged', (list) => list[0]?.state === 'failed', 20000);
    await bare.client.call('providers.update', { providerId: 'update-fake' });
    expect(only(await failed).message).toContain('Could not detect the installation method');
    await harness!.stop();

    const { client, state } = await start('command', 'update-launched', { FAKE_MANAGED_BY_NPM: '1' });
    await client.call('providers.updates', { refresh: true });
    const changed = client.next('providers.updatesChanged', (list) => list[0]?.state === 'idle' && list[0]?.current === '1.2.0', 20000);
    await client.call('providers.update', { providerId: 'update-fake' });
    expect(only(await changed)).toMatchObject({ current: '1.2.0', message: null });
    expect(readFileSync(state, 'utf8')).toBe('1.2.0');
    await waitFor(() => harness?.core.procs.liveCount('update:update-fake') === 0);
  });

  test.skipIf(!unixUser)('an npm install is updated into its own prefix, and one this user cannot write is refused before its updater runs', async () => {
    let layout!: ReturnType<typeof npmLayout>;
    const { client, state } = await start('command', 'update-npm', undefined, (dataDir) => {
      layout = npmLayout(dataDir);
      return { kind: 'file', value: layout.link };
    });
    const { prefix, scope } = layout;
    await client.call('providers.updates', { refresh: true });
    const changed = client.next('providers.updatesChanged', (list) => list[0]?.state === 'idle' && list[0]?.current === '1.2.0', 20000);
    await client.call('providers.update', { providerId: 'update-fake' });
    await changed;
    // npm's own configuration named another prefix, or none: the updater still targets this copy.
    expect(readFileSync(`${state}.prefix`, 'utf8')).toBe(prefix);

    writeFileSync(state, '1.0.0');
    rmSync(`${state}.prefix`);
    await client.call('providers.updates', { refresh: true });
    chmodSync(scope, 0o555);
    try {
      const failed = client.next('providers.updatesChanged', (list) => list[0]?.state === 'failed', 20000);
      await client.call('providers.update', { providerId: 'update-fake' });
      const update = only(await failed);
      expect(update.message).toContain(`installed under ${prefix}`);
      expect(update.message).toContain(`cannot write ${scope}`);
      expect(readFileSync(state, 'utf8')).toBe('1.0.0');
      expect(existsSync(`${state}.prefix`)).toBe(false);
    } finally {
      chmodSync(scope, 0o755);
    }
    await waitFor(() => harness?.core.procs.liveCount('update:update-fake') === 0);
  });

  test('a turn in flight pauses once its tool call ends, the agent updates, and the same turn goes on in its session', async () => {
    const { client, state } = await start('command', 'update-gated');
    const core = harness!.core;
    await client.call('providers.updates', { refresh: true });
    const project = await client.call('projects.add', { path: harness!.dataDir, name: 'updates' });
    const account = await client.call('accounts.add', { providerId: 'update-fake', label: 'Fake', useDefaultLocation: true });
    const thread = await client.call('threads.create', { projectId: project.id, providerId: 'update-fake', accountId: account.id, title: 'busy' });
    const other = await client.call('threads.create', { projectId: project.id, providerId: 'update-fake', accountId: account.id, title: 'later' });
    const running = toolRunning(thread.id);
    const turn = await client.call('turns.start', { threadId: thread.id, prompt: '[tool:1500][sleep:30000]never written' });
    await running;

    const asked = await client.call('providers.update', { providerId: 'update-fake' });
    expect(asked.state).toBe('updating');
    expect(asked.waitingFor).toBe(1);
    // The tool call runs to its end before anything is replaced.
    await new Promise((done) => setTimeout(done, 300));
    expect(existsSync(`${state}.running`)).toBe(false);
    await waitFor(() => existsSync(`${state}.running`), 20000);
    expect(core.journal.getTurn(turn.id)?.status).toBe('running');
    const tool = [...core.journal.walkTurnMessages(thread.id, turn.id)].flatMap((message) => message.parts).find((part) => part.type === 'tool');
    expect(tool?.type === 'tool' && tool.status).toBe('done');

    // A prompt sent while the updater runs waits in the queue instead of being refused.
    const queued = await client.call('turns.start', { threadId: other.id, prompt: 'after the update' });
    await new Promise((done) => setTimeout(done, 200));
    expect(core.journal.getTurn(queued.id)?.status).toBe('queued');

    writeFileSync(`${state}.go`, '');
    await client.next('providers.updatesChanged', (list) => list[0]?.state === 'idle' && list[0]?.current === '1.2.0', 20000);
    await waitFor(() => core.journal.getTurn(turn.id)?.status === 'done' && core.journal.getTurn(queued.id)?.status === 'done', 20000);

    expect(core.journal.listTurns(thread.id).map((entry) => entry.id)).toEqual([turn.id]);
    const messages = [...core.journal.walkTurnMessages(thread.id, turn.id)];
    const labels = messages.filter((message) => message.role === 'system').map((message) => message.parts[0]?.type === 'text' ? message.parts[0].displayText : null);
    expect(labels).toEqual(['Paused while Fake updating agent updates', 'Resumed after the Fake updating agent 1.2.0 update']);
    const answer = messages.filter((message) => message.role === 'assistant').at(-1)!.parts.map((part) => part.type === 'text' ? part.text : '').join('');
    expect(answer).toContain('from 1.0.0 to 1.2.0');
    expect(answer).not.toContain('never written');
    // The resumed run goes on in the session the paused one had.
    expect(core.threads.require(thread.id).sessionId).toBe(`echo-${thread.id}`);
    await waitFor(() => harness?.core.procs.liveCount('update:update-fake') === 0);
  }, 30000);

  test('turns that cannot pause in time let the paused ones go on, and the update waits for them to end', async () => {
    const { client } = await start('command');
    const core = harness!.core;
    core.updates.pauseLimitMs = 400;
    await client.call('providers.updates', { refresh: true });
    const project = await client.call('projects.add', { path: harness!.dataDir, name: 'updates' });
    const account = await client.call('accounts.add', { providerId: 'update-fake', label: 'Fake', useDefaultLocation: true });
    const quick = await client.call('threads.create', { projectId: project.id, providerId: 'update-fake', accountId: account.id, title: 'quick' });
    const asking = await client.call('threads.create', { projectId: project.id, providerId: 'update-fake', accountId: account.id, title: 'asking' });
    // A permission card holds its tool call open until the user answers.
    await client.call('turns.start', { threadId: asking.id, prompt: '[permission]' });
    await waitFor(() => core.threads.require(asking.id).status === 'waiting', 20000);
    const quickRunning = toolRunning(quick.id);
    const turn = await client.call('turns.start', { threadId: quick.id, prompt: '[tool:300][sleep:30000]never written' });
    await quickRunning;

    expect((await client.call('providers.update', { providerId: 'update-fake' })).waitingFor).toBe(2);
    await waitFor(() => core.journal.getTurn(turn.id)?.status === 'done', 20000);
    const labels = [...core.journal.walkTurnMessages(quick.id, turn.id)].filter((message) => message.role === 'system').map((message) => message.parts[0]?.type === 'text' ? message.parts[0].displayText : null);
    expect(labels).toEqual(['Paused while Fake updating agent updates', 'Resumed: the Fake updating agent update waits for other turns']);
    const waiting = only(await client.call('providers.updates', {}));
    expect(waiting.state).toBe('updating');
    expect(waiting.current).toBe('1.0.0');
    expect(waiting.waitingFor).toBe(1);

    // Stopping the last turn in flight lets the updater run.
    const updated = client.next('providers.updatesChanged', (list) => list[0]?.state === 'idle' && list[0]?.current === '1.2.0', 20000);
    await client.call('turns.stop', { threadId: asking.id });
    await updated;
    await waitFor(() => harness?.core.procs.liveCount('update:update-fake') === 0);
  }, 30000);

  test('a turn asked between two tool calls pauses at once, and a stop during the pause ends it as stopped while the update still lands', async () => {
    const { client, state } = await start('command', 'update-gated');
    const core = harness!.core;
    await client.call('providers.updates', { refresh: true });
    const project = await client.call('projects.add', { path: harness!.dataDir, name: 'updates' });
    const account = await client.call('accounts.add', { providerId: 'update-fake', label: 'Fake', useDefaultLocation: true });
    const thread = await client.call('threads.create', { projectId: project.id, providerId: 'update-fake', accountId: account.id, title: 'stopped' });
    // No tool call runs: the turn is between two of them, as a model writing its answer is.
    const turn = await client.call('turns.start', { threadId: thread.id, prompt: '[sleep:30000]never written' });
    await waitFor(() => core.threads.runner.handles.has(thread.id), 20000);
    await client.call('providers.update', { providerId: 'update-fake' });
    await waitFor(() => existsSync(`${state}.running`), 20000);
    expect(core.threads.runner.isPaused(thread.id)).toBe(true);

    expect(await client.call('turns.stop', { threadId: thread.id })).toEqual({ stopped: true });
    await waitFor(() => core.journal.getTurn(turn.id)?.status === 'stopped', 20000);
    expect(core.threads.require(thread.id).status).toBe('idle');
    writeFileSync(`${state}.go`, '');
    await client.next('providers.updatesChanged', (list) => list[0]?.state === 'idle' && list[0]?.current === '1.2.0', 20000);
    await waitFor(() => harness?.core.procs.liveCount('update:update-fake') === 0);
  }, 30000);

  test('a Boite restart during the pause hands the paused turn to the next core', async () => {
    const { client, state } = await start('command', 'update-gated');
    const core = harness!.core;
    await client.call('providers.updates', { refresh: true });
    const project = await client.call('projects.add', { path: harness!.dataDir, name: 'updates' });
    const account = await client.call('accounts.add', { providerId: 'update-fake', label: 'Fake', useDefaultLocation: true });
    const thread = await client.call('threads.create', { projectId: project.id, providerId: 'update-fake', accountId: account.id, title: 'restarting' });
    const turn = await client.call('turns.start', { threadId: thread.id, prompt: '[sleep:30000]never written' });
    await waitFor(() => core.threads.runner.handles.has(thread.id), 20000);
    await client.call('providers.update', { providerId: 'update-fake' });
    await waitFor(() => core.threads.runner.isPaused(thread.id), 20000);

    await core.threads.handoff.begin();
    expect(core.journal.getTurn(turn.id)?.status).toBe('stopped');
    expect((core.journal.getSetting('restart-handoff') as { turns: { turnId: string; was: string }[] }).turns).toEqual([expect.objectContaining({ turnId: turn.id, was: 'running' })]);
    writeFileSync(`${state}.go`, '');
    await waitFor(() => harness?.core.procs.liveCount('update:update-fake') === 0, 20000);
  }, 30000);

  test('a turn resumed on a fresh session reads its own work, and its resume note once', async () => {
    harness = await startTestCore();
    const client = await harness.connect();
    const core = harness.core;
    const { threadId } = await echoThread(harness, client);
    const turn = await client.call('turns.start', { threadId, prompt: 'build the release [tool]' });
    await waitFor(() => core.journal.getTurn(turn.id)?.status === 'done', 20000);
    // An agent with no session to resume: the history is the whole context.
    const thread = { ...core.threads.require(threadId), sessionId: null };
    const note = 'Boite paused this turn between two tool calls (test note).';
    const context = core.threads.contexts.makeContext(thread, core.providers.require(thread.providerId), core.accounts.require(thread.accountId), core.journal.getTurn(turn.id)!, { memory: '', deferred: '', letters: '' }, note);
    core.threads.noteSystem(threadId, turn.id, note, 'Resumed', 'turn.resumedAfterUpdate');
    const times = (text: string): number => text.split(note).length - 1;
    expect(context.prompt).toContain('build the release');
    expect(times(context.prompt)).toBe(1);
    // A driver that starts another fresh session later gets the same history, not the note again.
    expect(times(context.continuation!().prompt)).toBe(1);
  });

  test("an update releases the provider's idle threads and sweeps what their agents left", async () => {
    const { client } = await start('command');
    await client.call('providers.updates', {});
    const project = await client.call('projects.add', { path: harness!.dataDir, name: 'updates' });
    const account = await client.call('accounts.add', { providerId: 'update-fake', label: 'Fake', useDefaultLocation: true });
    const thread = await client.call('threads.create', { projectId: project.id, providerId: 'update-fake', accountId: account.id, title: 'idle' });
    const swept: string[] = [];
    harness!.core.procs.sweepSoon = (id: string): void => {
      swept.push(id);
    };

    const changed = client.next('providers.updatesChanged', (list) => list[0]?.state === 'idle' && list[0]?.current === '1.2.0', 20000);
    expect((await client.call('providers.update', { providerId: 'update-fake' })).state).toBe('updating');
    expect(swept).toEqual([thread.id]);
    await changed;
    await waitFor(() => harness?.core.procs.liveCount('update:update-fake') === 0);
  });

  test('an accepted turn waits for its provider\'s updater after the picker changes', async () => {
    const { client, state } = await start('command', 'update-gated');
    const core = harness!.core;
    await client.call('providers.updates', { refresh: true });
    const blocker = await echoThread(harness!, client);
    const account = await client.call('accounts.add', { providerId: 'update-fake', label: 'Fake', useDefaultLocation: true });
    const release = holdAccountTurns(harness!, account.id);
    const thread = await client.call('threads.create', { projectId: core.threads.require(blocker.threadId).projectId!, providerId: 'update-fake', accountId: account.id });
    const turn = await client.call('turns.start', { threadId: thread.id, prompt: 'queued on the old provider' });
    await client.call('threads.update', { threadId: thread.id, accountId: blocker.accountId });
    expect(core.threads.require(thread.id).providerId).toBe('echo');

    await client.call('providers.update', { providerId: 'update-fake' });
    await waitFor(() => existsSync(`${state}.running`), 20000);
    release();
    await new Promise((done) => setTimeout(done, 200));
    expect(core.journal.getTurn(turn.id)?.status).toBe('queued');
    writeFileSync(`${state}.go`, '');
    await waitFor(() => core.journal.getTurn(turn.id)?.status === 'done', 20000);
    expect(readFileSync(state, 'utf8')).toBe('1.2.0');
  });

  test('an update asked for during a check waits for it, and a second one is refused while the first runs', async () => {
    const { client } = await start('npm');
    await client.call('providers.updates', { refresh: true });

    const project = await client.call('projects.add', { path: harness!.dataDir, name: 'updates' });
    const account = await client.call('accounts.add', { providerId: 'update-fake', label: 'Fake', useDefaultLocation: true });
    const thread = await client.call('threads.create', { projectId: project.id, providerId: 'update-fake', accountId: account.id, title: 'gate' });

    let release = (): void => {};
    const gate = new Promise<void>((done) => (release = done));
    harness!.core.updates.npmLatest = async () => {
      await gate;
      return '1.1.0';
    };
    // Subscribe before each operation: a fast updater may finish before its RPC is awaited.
    const checking = client.next('providers.updatesChanged', (list) => list[0]?.state === 'checking', 20000);
    const changed = client.next('providers.updatesChanged', (list) => list[0]?.state === 'idle' && list[0]?.current === '1.2.0', 20000);
    const checked = client.call('providers.updates', { refresh: true });
    await checking;
    const started = client.call('providers.update', { providerId: 'update-fake' });
    await new Promise((done) => setTimeout(done, 50));
    release();

    expect((await started).state).toBe('updating');
    // A turn started now would run on a program half replaced: it waits for the updater.
    expect(harness!.core.updates.updating('update-fake')).toBe(true);
    const turn = await client.call('turns.start', { threadId: thread.id, prompt: 'hello' });
    await checked;
    await expect(client.call('providers.update', { providerId: 'update-fake' })).rejects.toThrow(/already updating/);
    const updated = only(await changed);
    await waitFor(() => harness?.core.journal.getTurn(turn.id)?.status === 'done', 20000);
    expect(harness!.core.journal.getTurn(turn.id)!.startedAt!).toBeGreaterThanOrEqual(updated.checkedAt!);
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

  test('a client that connects is answered from memory: nothing spawns and the registry is not asked', async () => {
    const { client } = await start('npm');
    let asked = 0;
    harness!.core.updates.npmLatest = async () => {
      asked += 1;
      return '1.1.0';
    };
    expect(await client.call('providers.updates', {})).toEqual([]);
    expect(asked).toBe(0);
    expect(await client.call('trace.get', { threadId: 'update:update-fake' })).toEqual([]);
    // The first automatic check waits ten minutes, not one.
    expect(harness!.core.updates.firstDelay()).toBe(10 * 60 * 1000);
  });

  test('a restart shows the last reading without running the agent, and waits out the six hours', async () => {
    const { client } = await start('npm');
    const checked = only(await client.call('providers.updates', { refresh: true }));
    expect(checked).toMatchObject({ current: '1.0.0', latest: '1.1.0', pending: true });

    const second = new Core({ dataDir: harness!.dataDir, token: newToken() });
    try {
      let asked = 0;
      second.updates.npmLatest = async () => {
        asked += 1;
        return '1.1.0';
      };
      const [remembered] = await second.updates.list();
      expect(remembered).toMatchObject({ providerId: 'update-fake', current: '1.0.0', latest: '1.1.0', pending: true, state: 'idle' });
      expect(asked).toBe(0);
      expect(second.procs.liveCount('update:update-fake')).toBe(0);
      const delay = second.updates.firstDelay();
      expect(delay).toBeGreaterThan(5 * 60 * 60 * 1000);
      expect(delay).toBeLessThanOrEqual(6 * 60 * 60 * 1000);
      // Seven hours later the reading is stale, and the check comes after the usual ten minutes.
      expect(second.updates.firstDelay(Date.now() + 7 * 60 * 60 * 1000)).toBe(10 * 60 * 1000);
    } finally {
      await second.close();
    }
  });

  test.skipIf(process.platform === 'win32')('a kept reading of another copy of the agent is dropped, and read at the usual first check', async () => {
    let layout!: ReturnType<typeof npmLayout>;
    const { client } = await start('npm', 'update', undefined, (dataDir) => {
      layout = npmLayout(dataDir);
      return { kind: 'file', value: layout.link };
    });
    expect(only(await client.call('providers.updates', { refresh: true }))).toMatchObject({ current: '1.0.0', latest: '1.1.0' });
    // The same path now leads to another copy, as `claude install` does to a link npm made.
    const native = join(harness!.dataDir, 'native-agent');
    writeFileSync(native, `#!/bin/sh\nexec '${process.execPath}' "$@"\n`);
    chmodSync(native, 0o755);
    rmSync(layout.link);
    symlinkSync(native, layout.link);

    const second = new Core({ dataDir: harness!.dataDir, token: newToken() });
    try {
      second.updates.refreshRestored();
      expect(await second.updates.list()).toEqual([]);
      expect(second.procs.liveCount('update:update-fake')).toBe(0);
      // The check a moment ago read the other copy: it no longer holds off the next one.
      expect(second.updates.firstDelay()).toBe(10 * 60 * 1000);
    } finally {
      await second.close();
    }
  });

  test('a version read whose launcher leaves a child on its pipes fails at its timeout with the whole tree gone', async () => {
    const { client } = await start('command', 'update', { FAKE_HANG: '1' });
    harness!.core.updates.versionTimeoutMs = 1000;
    const began = Date.now();
    const update = only(await client.call('providers.updates', { refresh: true }));
    expect(Date.now() - began).toBeLessThan(6000);
    expect(update).toMatchObject({ state: 'failed' });
    expect(update.message).toMatch(/did not answer `.*--version` within 1 s/);
    await waitFor(() => harness?.core.procs.liveCount('update:update-fake') === 0);
  }, 15000);
});
