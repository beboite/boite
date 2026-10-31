import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'bun:test';
import type { HarnessUpdate } from '@boite/contracts';
import { DEFAULT_DELEGATION_CONFIG } from '@boite/contracts';
import type { CoreClient } from '../src/client.ts';
import { Core } from '../src/core.ts';
import { newToken } from '../src/ids.ts';
import { npmInstallOf } from '../src/providers/npm.ts';
import { resolveCommand } from '../src/providers/resolve.ts';
import { AptPackages } from '../src/providers/termux.ts';
import { compareVersions, inside, readVersion } from '../src/providers/updates.ts';
import type { ServerUpdatePlatform } from '../src/server-update/types.ts';
import { holdAccountTurns, echoThread, startTestCore, waitFor } from './harness.ts';
import type { TestCore } from './harness.ts';
import { thrown } from './settle.ts';

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

/**
 * Termux's layout under `<dataDir>/termux/usr`: the fixture installed by the
 * package `fake-agent`, as dpkg lists it, and an apt whose repository holds
 * 1.4.0. Each apt run is written to `log`; `apt-get install` installs 1.4.0.
 */
function termuxLayout(dataDir: string): { program: string; log: string; offline: string } {
  const prefix = join(dataDir, 'termux', 'usr');
  const bin = join(prefix, 'bin');
  const info = join(prefix, 'var', 'lib', 'dpkg', 'info');
  mkdirSync(bin, { recursive: true });
  mkdirSync(info, { recursive: true });
  const log = join(dataDir, 'apt.log');
  const state = join(dataDir, 'fake-version.txt');
  const offline = join(dataDir, 'offline');
  const script = (name: string, body: string): string => {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  };
  const program = script('fake-agent', `exec '${process.execPath}' "$@"`);
  // Offline, apt-get update warns, keeps the old index and still exits with zero.
  script('apt-get', [
    `if [ "$1" = install ]; then echo "apt-get $* $DEBIAN_FRONTEND" >> '${log}'; printf 1.4.0 > '${state}'; exit 0; fi`,
    `echo "apt-get $*" >> '${log}'`,
    `if [ -e '${offline}' ]; then echo "W: Failed to fetch https://packages-cf.termux.dev/apt/termux-main/dists/stable/InRelease  Something wicked happened resolving 'packages-cf.termux.dev:https' (7 - No address associated with hostname)" >&2; echo 'W: Some index files failed to download. They have been ignored, or old ones used instead.' >&2; fi`,
  ].join('\n'));
  script('apt-cache', `echo "apt-cache $*" >> '${log}'\nprintf 'fake-agent:\\n  Installed: 1.0.0\\n  Candidate: 1:1.4.0-2\\n  Version table:\\n'`);
  writeFileSync(join(info, 'other.list'), `/.\n${prefix}\n${bin}\n${join(bin, 'other')}\n`);
  writeFileSync(join(info, 'fake-agent.list'), `/.\n${prefix}\n${bin}\n${realpathSync(program)}\n`);
  return { program, log, offline };
}

async function start(
  source: 'command' | 'npm' | 'none',
  updater = 'update',
  updateEnv?: Record<string, string>,
  program?: (dataDir: string) => { kind: 'path' | 'file'; value: string },
  coreOptions?: Parameters<typeof startTestCore>[0],
): Promise<{ client: CoreClient; state: string }> {
  harness = await startTestCore(coreOptions);
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
      expect(npmInstallOf(link)).toEqual({ prefix, packageDir: join(prefix, 'lib', 'node_modules', '@boite-test', 'fake-agent'), name: '@boite-test/fake-agent' });
      expect(npmInstallOf('/usr/lib/node_modules/opencode-ai/bin/opencode.exe')).toEqual({ prefix: '/usr', packageDir: '/usr/lib/node_modules/opencode-ai', name: 'opencode-ai' });
      // pnpm and Bun keep their globals elsewhere, and a native install is no npm install.
      expect(npmInstallOf('/home/u/.bun/install/global/node_modules/x/bin/x')).toBeNull();
      expect(npmInstallOf('/home/u/.local/share/claude/versions/2.1.285')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform !== 'win32')('a Windows npm install is known by its shim in the prefix, a bare node_modules is not', () => {
    const dir = mkdtempSync(join(tmpdir(), 'boite-npm-'));
    try {
      const prefix = join(realpathSync(dir), 'npm');
      const packageDir = join(prefix, 'node_modules', '@boite-test', 'fake-agent');
      const program = join(packageDir, 'bin', 'fake-agent.exe');
      mkdirSync(dirname(program), { recursive: true });
      writeFileSync(program, '');
      writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: '@boite-test/fake-agent', bin: { 'fake-agent': 'bin/fake-agent.exe' } }));
      // pnpm's global store has the same shape and keeps its shims elsewhere.
      expect(npmInstallOf(program)).toBeNull();
      writeFileSync(join(prefix, 'fake-agent.cmd'), '@echo off');
      expect(npmInstallOf(program)).toEqual({ prefix, packageDir, name: '@boite-test/fake-agent' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === 'win32')('an npm install of the package the registry names is installed by npm at that version, not by the agent\'s updater', async () => {
    let layout!: ReturnType<typeof npmLayout>;
    // The agent's own updater fails, as `claude update` did when its five-second `npm view` ran out.
    const { client, state } = await start('npm', 'update-broken', undefined, (dataDir) => {
      layout = npmLayout(dataDir);
      return { kind: 'file', value: layout.link };
    });
    const calls = join(harness!.dataDir, 'npm-calls.txt');
    const cli = join(harness!.dataDir, 'npm-cli.js');
    writeFileSync(cli, [
      "const { appendFileSync, writeFileSync } = require('node:fs');",
      `appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args: process.argv.slice(2), prefix: process.env.npm_config_prefix }) + '\\n');`,
      `writeFileSync(${JSON.stringify(state)}, process.argv.at(-1).split('@').at(-1));`,
    ].join('\n'));
    harness!.core.updates.npmCli = () => ({ executable: process.execPath, script: cli });
    expect(only(await client.call('providers.updates', { refresh: true })).latest).toBe('1.1.0');
    const changed = client.next('providers.updatesChanged', (list) => list[0]?.state === 'idle' && list[0]?.current === '1.1.0', 20000);
    await client.call('providers.update', { providerId: 'update-fake' });
    await changed;
    const ran = readFileSync(calls, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { args: string[]; prefix: string });
    expect(ran).toEqual([{ args: ['install', '-g', '--allow-scripts=@boite-test/fake-agent', '@boite-test/fake-agent@1.1.0'], prefix: layout.prefix }]);
    await waitFor(() => harness?.core.procs.liveCount('update:update-fake') === 0);
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
    expect(await thrown(client.call('providers.update', { providerId: 'update-fake' }))).toThrow(/already on its newest known version/);

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

  test('an updater that cannot detect its install method reports the reason before its closing Failed line', async () => {
    const { client } = await start('npm', 'update-unknown-method');
    await client.call('providers.updates', { refresh: true });
    const failed = client.next('providers.updatesChanged', (list) => list[0]?.state === 'failed', 20000);
    await client.call('providers.update', { providerId: 'update-fake' });
    const update = only(await failed);
    expect(update.current).toBe('1.0.0');
    expect(update.message).toContain('exited with 1');
    expect(update.message).toContain('Could not detect the installation method. Pass --method');
    expect(update.message).not.toEndWith('Failed');
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

  test.skipIf(process.platform === 'win32' || !['x64', 'arm64'].includes(process.arch))('codex installed by Bun updates through the launcher that names its install, while its sessions skip that launcher', async () => {
    // `bun install -g @openai/codex`: the platform package hoisted beside the launcher, no `lib/node_modules`.
    const root = join(tmpdir(), `boite-bun-codex-${newToken().slice(0, 8)}`);
    const global = join(root, '.bun', 'install', 'global', 'node_modules', '@openai');
    const os = process.platform === 'darwin' ? 'darwin' : 'linux';
    const triple = `${process.arch === 'x64' ? 'x86_64' : 'aarch64'}-${os === 'darwin' ? 'apple-darwin' : 'unknown-linux-musl'}`;
    const launcher = join(global, 'codex', 'bin', 'codex.js');
    const binary = join(global, `codex-${os}-${process.arch}`, 'vendor', triple, 'bin', 'codex');
    const bin = join(root, '.bun', 'bin');
    for (const dir of [dirname(launcher), dirname(binary), bin]) mkdirSync(dir, { recursive: true });
    // The launcher tells the binary how it was installed; the binary alone cannot tell.
    writeFileSync(launcher, `#!/bin/sh\nFAKE_MANAGED_BY_NPM=1 exec '${process.execPath}' "$@"\n`);
    writeFileSync(binary, `#!/bin/sh\nexec '${process.execPath}' "$@"\n`);
    chmodSync(launcher, 0o755);
    chmodSync(binary, 0o755);
    symlinkSync('../install/global/node_modules/@openai/codex/bin/codex.js', join(bin, 'codex'));
    const saved = process.env['PATH'];
    process.env['PATH'] = [bin, saved].join(delimiter);
    try {
      const { client, state } = await start('command', 'update-launched', undefined, () => ({ kind: 'path', value: 'codex' }));
      expect(resolveCommand({ detect: {}, executable: [{ kind: 'path', value: 'codex' }], isolation: {} })?.executable).toBe(realpathSync(binary));
      await client.call('providers.updates', { refresh: true });
      const changed = client.next('providers.updatesChanged', (list) => list[0]?.state === 'failed' || (list[0]?.state === 'idle' && list[0]?.current === '1.2.0'), 20000);
      await client.call('providers.update', { providerId: 'update-fake' });
      expect(only(await changed)).toMatchObject({ state: 'idle', current: '1.2.0', message: null });
      expect(readFileSync(state, 'utf8')).toBe('1.2.0');
      await waitFor(() => harness?.core.procs.liveCount('update:update-fake') === 0);
    } finally {
      process.env['PATH'] = saved;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('two agents of one Termux prefix run apt one at a time, and one check fetches its index once', async () => {
    const apt = new AptPackages();
    const pkg = (name: string) => ({ prefix: '/termux/usr', name, aptGet: '/termux/usr/bin/apt-get', aptCache: '/termux/usr/bin/apt-cache' });
    let active = 0, most = 0;
    const calls: string[] = [];
    const run = async (args: string[]): Promise<string> => {
      most = Math.max(most, ++active);
      calls.push(args.join(' '));
      await Bun.sleep(5);
      active -= 1;
      return args[0] === 'policy' ? 'x:\n  Installed: 1.0.0\n  Candidate: 1.4.0-1\n' : '';
    };
    // A check reads two agents at once; apt refuses a second command while its lock is held.
    const read = await Promise.all([apt.latest(pkg('one'), '/termux/usr/bin/one', 0, 1000, run), apt.latest(pkg('two'), '/termux/usr/bin/two', 0, 1000, run)]);
    expect(read).toEqual(['1.4.0', '1.4.0']);
    expect(most).toBe(1);
    expect(calls).toEqual(['update', 'policy one', 'policy two']);
    calls.length = 0;
    await Promise.all([apt.upgrade(pkg('one'), '/termux/usr/bin/one', 1000, 1000, run), apt.upgrade(pkg('two'), '/termux/usr/bin/two', 1000, 1000, run)]);
    expect(most).toBe(1);
    expect(calls.filter((call) => call.startsWith('install')).length).toBe(2);
  });

  test.skipIf(process.platform === 'win32')('a copy Termux packaged is read and updated through its apt, not its own updater', async () => {
    let layout!: ReturnType<typeof termuxLayout>;
    // `update-launched` fails as `codex update` does on Termux's own package.
    const { client, state } = await start('npm', 'update-launched', undefined, (dataDir) => {
      layout = termuxLayout(dataDir);
      return { kind: 'file', value: layout.program };
    });
    // The repository trails npm: its release is the one offered.
    harness!.core.updates.npmLatest = async () => {
      throw new Error('the npm registry is not what installed this copy');
    };
    // An index apt could not fetch is no answer: the old one would say nothing is newer.
    writeFileSync(layout.offline, '');
    const offline = only(await client.call('providers.updates', { refresh: true }));
    expect(offline.state).toBe('failed');
    expect(offline.message).toContain("could not read the package index: W: Failed to fetch");
    rmSync(layout.offline);
    expect(only(await client.call('providers.updates', { refresh: true }))).toMatchObject({ route: 'self', current: '1.0.0', latest: '1.4.0', pending: true, state: 'idle' });

    const changed = client.next('providers.updatesChanged', (list) => list[0]?.state !== 'updating' && list[0]?.state !== 'checking' && list[0]?.checkedAt !== null, 20000);
    await client.call('providers.update', { providerId: 'update-fake' });
    expect(only(await changed)).toMatchObject({ state: 'idle', current: '1.4.0', latest: '1.4.0', pending: false, message: null });
    expect(readFileSync(state, 'utf8')).toBe('1.4.0');
    const calls = readFileSync(layout.log, 'utf8').trim().split('\n');
    expect(calls).toEqual([
      'apt-get update',
      'apt-get update',
      'apt-cache policy fake-agent',
      'apt-get update',
      'apt-cache policy fake-agent',
      'apt-get install --only-upgrade -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold fake-agent noninteractive',
      'apt-cache policy fake-agent',
    ]);
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

  test('an automatic update waits for the background work of an agent at rest before releasing it', async () => {
    const { client, state } = await start('command');
    const core = harness!.core;
    await client.call('providers.updates', { refresh: true });
    const project = await client.call('projects.add', { path: harness!.dataDir, name: 'updates' });
    const account = await client.call('accounts.add', { providerId: 'update-fake', label: 'Fake', useDefaultLocation: true });
    const thread = await client.call('threads.create', { projectId: project.id, providerId: 'update-fake', accountId: account.id, title: 'ci loop' });
    const turn = await client.call('turns.start', { threadId: thread.id, prompt: 'start the CI loop' });
    await waitFor(() => core.journal.getTurn(turn.id)?.status === 'done', 20000);
    // The turn ended on a checkpoint; the loop it started runs on in the agent's process.
    core.threads.agentState.noteBackground(thread.id, [{ id: 'bg-ci', kind: 'shell', description: 'CI loop', toolId: null, startedAt: Date.now() }]);
    const released: string[] = [];
    const release = core.threads.releaseAgent.bind(core.threads);
    core.threads.releaseAgent = (id) => { released.push(id); release(id); };

    const asked = await core.updates.update('update-fake', true);
    await new Promise((done) => setTimeout(done, 300));
    expect(released).toEqual([]);
    expect(asked.waitingFor).toBe(1);
    expect(readFileSync(state, 'utf8')).toBe('1.0.0');

    const updated = client.next('providers.updatesChanged', (list) => list[0]?.state === 'idle' && list[0]?.current === '1.2.0', 20000);
    const owner = { providerId: 'update-fake', sessionGeneration: core.threads.require(thread.id).sessionGeneration ?? 0, parentTurnId: null };
    core.threads.agentState.finishBackground(thread.id, 'bg-ci', owner, 'completed');
    await updated;
    expect(released).toContain(thread.id);
    // The work ended by itself: nothing was cut, nothing is resumed.
    expect(core.threads.resumes.retryOf(thread.id)).toBeNull();
    await waitFor(() => harness?.core.procs.liveCount('update:update-fake') === 0);
  }, 30000);

  test('past the background limit an automatic update goes on and resumes the agents whose work it ended', async () => {
    const { client, state } = await start('command');
    const core = harness!.core;
    core.updates.backgroundLimitMs = 400;
    await client.call('providers.updates', { refresh: true });
    const project = await client.call('projects.add', { path: harness!.dataDir, name: 'updates' });
    const account = await client.call('accounts.add', { providerId: 'update-fake', label: 'Fake', useDefaultLocation: true });
    const parent = await client.call('threads.create', { projectId: project.id, providerId: 'update-fake', accountId: account.id, title: 'parent' });
    await client.call('delegation.configure', { threadId: parent.id, config: { ...DEFAULT_DELEGATION_CONFIG, enabled: true, profiles: [{ id: 'worker', name: 'Worker', providerId: 'update-fake', accountId: account.id, model: 'default', effort: null }] } });
    // The child starts its CI loop in its first turn, which ends on that checkpoint: it stays open while the loop runs.
    const off = core.bus.onAny((name, payload) => {
      const turn = payload as { threadId: string };
      if (name !== 'turn.started' || core.threads.require(turn.threadId).parentThreadId !== parent.id) return;
      off();
      core.threads.agentState.noteBackground(turn.threadId, [{ id: 'bg-ci', kind: 'shell', description: 'CI loop', toolId: null, startedAt: Date.now() }]);
    });
    const child = (await client.call('delegation.spawn', { threadId: parent.id, profileId: 'worker', task: 'watch CI', requestId: 'ci' })).thread.id;
    const server = await client.call('threads.create', { projectId: project.id, providerId: 'update-fake', accountId: account.id, title: 'dev server' });
    const turn = await client.call('turns.start', { threadId: server.id, prompt: 'start the dev server' });
    await waitFor(() => core.journal.getTurn(turn.id)?.status === 'done' && core.journal.listTurns(child).at(-1)?.status === 'done', 20000);
    // The child's result wakes its parent: let that turn end too.
    await waitFor(() => core.journal.unfinishedTurns().length === 0, 20000);
    // The server's turn started its work before it ended on a checkpoint.
    const during = (threadId: string) => core.journal.listTurns(threadId).at(-1)!.finishedAt! - 1;
    core.threads.agentState.noteBackground(server.id, [{ id: 'bg-dev', kind: 'shell', description: 'dev server', toolId: null, startedAt: during(server.id) }]);
    const started = Date.now();

    expect((await core.updates.update('update-fake', true)).waitingFor).toBe(2);
    await client.next('providers.updatesChanged', (list) => list[0]?.state === 'idle' && list[0]?.current === '1.2.0', 20000);
    expect(readFileSync(state, 'utf8')).toBe('1.2.0');
    expect(Date.now() - started).toBeGreaterThanOrEqual(400);
    const notices = (threadId: string, turnId: string) => [...core.journal.walkTurnMessages(threadId, turnId)]
      .filter((message) => message.role === 'system').map((message) => message.parts[0]?.type === 'text' ? message.parts[0].displayText : null);
    const checkpoint = core.journal.listTurns(child)[0]!.id;
    expect(notices(child, checkpoint).at(-1)).toBe('Background work ended by the Fake updating agent update');
    expect(notices(server.id, turn.id)).toEqual(['Background work ended by the Fake updating agent update']);
    // The delegated agent gets the continuation `boite delegate resume` sends, on the new version.
    await waitFor(() => core.journal.listTurns(child).length === 2 && core.journal.listTurns(child).at(-1)?.status === 'done', 20000);
    expect(core.journal.db.query('SELECT 1 FROM delegation_messages WHERE recipient_id = ? AND request_id = ?').get(child, `resume:${checkpoint}`)).not.toBeNull();
    // The conversation of its own resumes like background work that ended without waking it.
    expect(core.threads.resumes.retryOf(server.id)).toMatchObject({ kind: 'auto-continue', turnId: turn.id });
    await waitFor(() => harness?.core.procs.liveCount('update:update-fake') === 0);
  }, 30000);

  test('a turn paused for an automatic update keeps its background work, and is told when a forced release ends it', async () => {
    const { client, state } = await start('command', 'update-gated');
    const core = harness!.core;
    await client.call('providers.updates', { refresh: true });
    const project = await client.call('projects.add', { path: harness!.dataDir, name: 'updates' });
    const account = await client.call('accounts.add', { providerId: 'update-fake', label: 'Fake', useDefaultLocation: true });
    const thread = await client.call('threads.create', { projectId: project.id, providerId: 'update-fake', accountId: account.id, title: 'thinking' });
    const turn = await client.call('turns.start', { threadId: thread.id, prompt: '[sleep:30000]never written' });
    await waitFor(() => core.threads.runner.handles.has(thread.id), 20000);
    core.threads.agentState.noteBackground(thread.id, [{ id: 'bg-ci', kind: 'shell', description: 'CI loop', toolId: null, startedAt: Date.now() }]);

    await core.updates.update('update-fake', true);
    await waitFor(() => core.threads.runner.isPaused(thread.id), 20000);
    await new Promise((done) => setTimeout(done, 400));
    expect(core.threads.agentState.background.get(thread.id)?.length).toBe(1);
    expect(existsSync(`${state}.running`)).toBe(false);

    // Asked by hand, the update goes on; the paused turn hears its loop ended.
    await client.call('providers.update', { providerId: 'update-fake' });
    await waitFor(() => existsSync(`${state}.running`), 20000);
    expect(core.threads.agentState.background.get(thread.id)).toBeUndefined();
    writeFileSync(`${state}.go`, '');
    await waitFor(() => core.journal.getTurn(turn.id)?.status === 'done', 20000);
    const answer = [...core.journal.walkTurnMessages(thread.id, turn.id)].filter((message) => message.role === 'assistant').at(-1)!.parts.map((part) => part.type === 'text' ? part.text : '').join('');
    expect(answer).toContain('An update of Fake updating agent ended your background work (CI loop)');
    await waitFor(() => harness?.core.procs.liveCount('update:update-fake') === 0);
  }, 30000);

  test('a Stop while the updater runs cancels the resume of the agents whose background work it ended', async () => {
    const { client, state } = await start('command', 'update-gated');
    const core = harness!.core;
    await client.call('providers.updates', { refresh: true });
    const project = await client.call('projects.add', { path: harness!.dataDir, name: 'updates' });
    const account = await client.call('accounts.add', { providerId: 'update-fake', label: 'Fake', useDefaultLocation: true });
    const parent = await client.call('threads.create', { projectId: project.id, providerId: 'update-fake', accountId: account.id, title: 'parent' });
    await client.call('delegation.configure', { threadId: parent.id, config: { ...DEFAULT_DELEGATION_CONFIG, enabled: true, profiles: [{ id: 'worker', name: 'Worker', providerId: 'update-fake', accountId: account.id, model: 'default', effort: null }] } });
    // The child starts its CI loop in its first turn, which ends on that checkpoint: it stays open while the loop runs.
    const off = core.bus.onAny((name, payload) => {
      const turn = payload as { threadId: string };
      if (name !== 'turn.started' || core.threads.require(turn.threadId).parentThreadId !== parent.id) return;
      off();
      core.threads.agentState.noteBackground(turn.threadId, [{ id: 'bg-ci', kind: 'shell', description: 'CI loop', toolId: null, startedAt: Date.now() }]);
    });
    const child = (await client.call('delegation.spawn', { threadId: parent.id, profileId: 'worker', task: 'watch CI', requestId: 'ci' })).thread.id;
    const server = await client.call('threads.create', { projectId: project.id, providerId: 'update-fake', accountId: account.id, title: 'dev server' });
    const turn = await client.call('turns.start', { threadId: server.id, prompt: 'start the dev server' });
    await waitFor(() => core.journal.getTurn(turn.id)?.status === 'done' && core.journal.listTurns(child).at(-1)?.status === 'done', 20000);
    await waitFor(() => core.journal.unfinishedTurns().length === 0, 20000);
    const during = (threadId: string) => core.journal.listTurns(threadId).at(-1)!.finishedAt! - 1;
    core.threads.agentState.noteBackground(server.id, [{ id: 'bg-dev', kind: 'shell', description: 'dev server', toolId: null, startedAt: during(server.id) }]);
    const childTurns = core.journal.listTurns(child).length;

    await client.call('providers.update', { providerId: 'update-fake' });
    await waitFor(() => existsSync(`${state}.running`), 20000);
    core.delegation.stop(parent.id, child);
    core.threads.stopTurn(server.id);
    writeFileSync(`${state}.go`, '');
    await waitFor(() => !core.updates.updating('update-fake'), 20000);
    await new Promise((done) => setTimeout(done, 800));
    // The continuation queued for the child was stopped with it and never ran.
    expect(core.journal.listTurns(child).slice(childTurns).map((entry) => [entry.status, entry.startedAt])).toEqual([['stopped', null]]);
    expect(core.threads.resumes.retryOf(server.id)).toBeNull();
    await waitFor(() => harness?.core.procs.liveCount('update:update-fake') === 0);
  }, 30000);

  test('a crash while the updater runs keeps the resume of a conversation whose background work it ended', async () => {
    const { client, state } = await start('command', 'update-gated');
    const h = harness!;
    const core = h.core;
    await client.call('providers.updates', { refresh: true });
    const project = await client.call('projects.add', { path: h.dataDir, name: 'updates' });
    const account = await client.call('accounts.add', { providerId: 'update-fake', label: 'Fake', useDefaultLocation: true });
    const thread = await client.call('threads.create', { projectId: project.id, providerId: 'update-fake', accountId: account.id, title: 'dev server' });
    const turn = await client.call('turns.start', { threadId: thread.id, prompt: 'start the dev server' });
    await waitFor(() => core.journal.getTurn(turn.id)?.status === 'done', 20000);
    core.threads.agentState.noteBackground(thread.id, [{ id: 'bg-dev', kind: 'shell', description: 'dev server', toolId: null, startedAt: core.journal.getTurn(turn.id)!.finishedAt! - 1 }]);
    await client.call('providers.update', { providerId: 'update-fake' });
    await waitFor(() => existsSync(`${state}.running`), 20000);

    // The core dies under the updater.
    client.close();
    core.journal.close();
    await h.server.stop();
    await core.close();
    writeFileSync(`${state}.go`, '');
    harness = null;
    const next = new Core({ dataDir: h.dataDir, token: h.token });
    try {
      expect(next.threads.resumes.retryOf(thread.id)).toMatchObject({ kind: 'auto-continue', turnId: turn.id });
    } finally {
      await next.close();
    }
  }, 30000);

  test('an update asked by hand while an automatic one waits on background work goes on at once', async () => {
    const { client, state } = await start('command');
    const core = harness!.core;
    await client.call('providers.updates', { refresh: true });
    const project = await client.call('projects.add', { path: harness!.dataDir, name: 'updates' });
    const account = await client.call('accounts.add', { providerId: 'update-fake', label: 'Fake', useDefaultLocation: true });
    const thread = await client.call('threads.create', { projectId: project.id, providerId: 'update-fake', accountId: account.id, title: 'dev server' });
    const turn = await client.call('turns.start', { threadId: thread.id, prompt: 'start the dev server' });
    await waitFor(() => core.journal.getTurn(turn.id)?.status === 'done', 20000);
    core.threads.agentState.noteBackground(thread.id, [{ id: 'bg-dev', kind: 'shell', description: 'dev server', toolId: null, startedAt: core.journal.getTurn(turn.id)!.finishedAt! - 1 }]);
    expect((await core.updates.update('update-fake', true)).waitingFor).toBe(1);
    await new Promise((done) => setTimeout(done, 200));
    expect(readFileSync(state, 'utf8')).toBe('1.0.0');

    const updated = client.next('providers.updatesChanged', (list) => list[0]?.state === 'idle' && list[0]?.current === '1.2.0', 20000);
    expect((await client.call('providers.update', { providerId: 'update-fake' })).state).toBe('updating');
    await updated;
    expect(core.threads.resumes.retryOf(thread.id)).toMatchObject({ kind: 'auto-continue', turnId: turn.id });
    await waitFor(() => harness?.core.procs.liveCount('update:update-fake') === 0);
  }, 30000);

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
    // The updater holds until the test opens its gate: "while the first runs" must not
    // depend on a real updater outlasting a turn start and a round trip, which a fast
    // runner's does not.
    const { client, state } = await start('npm', 'update-gated');
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
    expect(await thrown(client.call('providers.update', { providerId: 'update-fake' }))).toThrow(/already updating/);
    writeFileSync(`${state}.go`, '');
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

  test('one click starts every agent and Boite together, and Boite installs only once the agents are done', async () => {
    const root = mkdtempSync(join(tmpdir(), 'boite-update-everything-'));
    let stops = 0;
    let downloads = 0;
    const platform: ServerUpdatePlatform = {
      inspect: async () => ({ directory: join(root, 'install'), executable: join(root, 'install', 'boite-core'), service: 'test.service' }),
      launch: async (_run, _executable, plan) => { writeFileSync(join(dirname(plan), 'ready'), ''); },
      control: async () => undefined,
      mainPid: async () => process.pid,
      lock: () => () => undefined,
    };
    try {
      const { client, state } = await start('npm', 'update', undefined, undefined, {
        onShutdown: () => { stops++; },
        serverUpdates: { platform, pollMs: 5,
          findOffer: async () => ({ version: '2.0.0-beta.2', publishedAt: '2026-10-01T00:00:00Z', url: 'https://example.test/signed.zip', signature: 'signed' }),
          prepare: async () => { downloads++; return 'a'.repeat(64); } },
      });
      await client.call('providers.updates', { refresh: true });
      expect((await client.call('core.updateStatus', { refresh: true })).phase).toBe('available');

      // Bad requests are refused by field before anything starts.
      expect(await thrown(client.call('core.updateEverything', { agents: 'update-fake' as never, server: null }))).toThrow(/agents/);
      expect(await thrown(client.call('core.updateEverything', { agents: [], server: 7 as never }))).toThrow(/server/);

      // The registry read after the updater is the moment no process of the update runs:
      // held here, it is the gap an idle restart would slip into.
      let open = (): void => {};
      const registry = new Promise<void>((done) => (open = done));
      let asked = false;
      harness!.core.updates.npmLatest = async () => {
        asked = true;
        await registry;
        return '1.1.0';
      };
      const answer = await client.call('core.updateEverything', { agents: ['update-fake', 'not-a-provider' as never], server: '2.0.0-beta.2' });
      expect(answer.agents).toEqual(['update-fake']);
      expect(answer.failed.map((entry) => entry.providerId)).toEqual(['not-a-provider']);
      expect(answer.serverError).toBeNull();
      // The fixture's download is instant: by the answer it may already wait for the gate.
      expect(['downloading', 'waiting']).toContain(answer.server.phase);

      // The download ran beside the agent's update; the install waits for it to land.
      await waitFor(() => asked);
      expect(readFileSync(state, 'utf8')).toBe('1.2.0');
      expect(harness!.core.procs.liveCount('update:update-fake')).toBe(0);
      await waitFor(() => harness!.core.serverUpdates.snapshot().phase === 'waiting');
      expect(downloads).toBe(1);
      await Bun.sleep(60);
      expect(harness!.core.serverUpdates.snapshot().phase).toBe('waiting');
      expect(harness!.core.updates.updating('update-fake')).toBe(true);
      expect(stops).toBe(0);

      open();
      await waitFor(() => harness!.core.serverUpdates.snapshot().phase === 'installing', 20000);
      await waitFor(() => stops === 1);
      expect(harness!.core.updates.updating('update-fake')).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
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
    expect(await thrown(update)).toThrow('stopping');
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
