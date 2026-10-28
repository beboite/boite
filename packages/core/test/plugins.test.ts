import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { PLUGIN_MANIFEST_FILE, type Account, type PluginManifest } from '@boite/contracts';
import { connect } from '../src/client.ts';
import { getDriver } from '../src/drivers/index.ts';
import { parsePluginPool, verifyPluginDownload } from '../src/plugins.ts';
import { ACTIVATION_FILE } from '../src/plugins/activation.ts';
import { fetchManifest } from '../src/plugins/source.ts';
import type { SpawnedProcess } from '../src/procs.ts';
import { parseManifest, platformKey } from '../src/plugins/manifest.ts';
import { startTestCore, waitFor, type TestCore } from './harness.ts';
import { thrown } from './settle.ts';

let harness: TestCore | undefined;
let fetchSpy: { mockRestore(): void } | undefined;
afterEach(async () => {
  fetchSpy?.mockRestore(); fetchSpy = undefined;
  await harness?.stop(); harness = undefined;
});

const EXE = process.platform === 'win32' ? '.exe' : '';
const FIXTURE_GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'boite test',
  GIT_AUTHOR_EMAIL: 'test@boite.invalid',
  GIT_COMMITTER_NAME: 'boite test',
  GIT_COMMITTER_EMAIL: 'test@boite.invalid',
};

function git(cwd: string, ...args: string[]): string {
  const run = Bun.spawnSync({ cmd: ['git', ...args], cwd, env: FIXTURE_GIT_ENV, stdout: 'pipe', stderr: 'pipe', windowsHide: true });
  if (!run.success) throw new Error(`git ${args.join(' ')} failed: ${run.stderr.toString()}`);
  return run.stdout.toString().trim();
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const POOL_URL = 'https://plugins.example.invalid/pool-switcher-2.0.1';

/** A recommended plugin with account pools, as a reviewed entry would list it; `bytes` is what its download serves. */
function poolSwitcher(bytes = new Uint8Array([1, 2, 3, 4])): PluginManifest {
  return parseManifest({
    schema: 1,
    id: 'pool-switcher',
    name: 'Pool switcher',
    version: '2.0.1',
    description: 'Switches Claude, Codex and Antigravity logins from saved pools.',
    homepage: 'https://plugins.example.invalid/pool-switcher',
    executable: 'pool',
    artifacts: { [platformKey()]: { url: POOL_URL, sha256: sha256(bytes) } },
    provides: { accountPools: { providers: ['claude', 'codex', 'antigravity'] } },
  }, 'recommended.json[0]');
}

/** A core whose recommended list is the pool switcher alone. */
async function startPoolCore(bytes?: Uint8Array<ArrayBuffer>): Promise<TestCore> {
  harness = await startTestCore();
  harness.core.plugins.recommended = [poolSwitcher(bytes)];
  return harness;
}

/** Writes an installed pool switcher, as a finished install from the recommended list leaves it. */
function installPool(dataDir: string): string {
  const dir = join(dataDir, 'plugins', 'pool-switcher');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `pool${EXE}`), 'fixture');
  writeFileSync(join(dir, 'installed.json'), JSON.stringify({ schema: 1, origin: 'recommended', installedAt: 1, source: null, manifest: poolSwitcher() }));
  return dir;
}

/** Every download answered from memory: tests never reach the network. */
function serveDownloads(files: Record<string, Uint8Array | number>): string[] {
  const asked: string[] = [];
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    asked.push(url);
    const file = files[url];
    if (file === undefined) return new Response('not found', { status: 404 });
    if (typeof file === 'number') return new Response('refused', { status: file });
    return new Response(file, { headers: { 'content-length': String(file.length) } });
  }) as typeof fetch);
  return asked;
}

function manifest(overrides: Record<string, unknown> = {}, bytes = new Uint8Array([7, 7, 7])): Record<string, unknown> {
  return {
    schema: 1,
    id: 'seat-pool',
    name: 'Seat pool',
    version: '1.4.0',
    description: 'Switches OpenCode logins from a saved pool.',
    homepage: 'https://plugins.example.invalid/seat-pool',
    executable: 'seat-pool',
    artifacts: { [platformKey()]: { url: 'https://plugins.example.invalid/seat-pool-1.4.0', sha256: sha256(bytes) } },
    provides: { accountPools: { providers: ['opencode'] } },
    ...overrides,
  };
}

/** A plugin repository with one commit, inside the test's data directory. */
function repository(name: string, content: Record<string, unknown> | string | null, tag?: string): { path: string; commit: string } {
  const path = join(harness!.dataDir, 'repos', name);
  mkdirSync(path, { recursive: true });
  git(path, 'init', '-q');
  writeFileSync(join(path, 'README.md'), `${name}\n`);
  if (content !== null) writeFileSync(join(path, PLUGIN_MANIFEST_FILE), typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  git(path, 'add', '-A');
  git(path, 'commit', '-q', '-m', 'plugin');
  if (tag !== undefined) git(path, 'tag', tag);
  return { path, commit: git(path, 'rev-parse', 'HEAD') };
}

function commitManifest(path: string, content: Record<string, unknown>): string {
  writeFileSync(join(path, PLUGIN_MANIFEST_FILE), JSON.stringify(content, null, 2));
  git(path, 'commit', '-q', '-am', 'update');
  return git(path, 'rev-parse', 'HEAD');
}

test('pool JSON maps live and unknown quotas without inventing reset times', () => {
  const pool = parsePluginPool('codex', JSON.stringify({ pool: 'Codex', accounts: [
    { email: 'user@example.com', live: true, fiveHour: 0, sevenDay: null, checkedSecondsAgo: 19, readyAt: '2026-09-13T12:00:00Z', file: 'must-not-leave-core' },
  ] }));
  expect(pool.accounts[0]).toEqual({ email: 'user@example.com', active: true, checkedSecondsAgo: 19,
    windows: [{ id: 'fiveHour', label: '5 hours', usedPercent: 0, resetsAt: null }] });
  expect(() => parsePluginPool('codex', '{}')).toThrow('accounts array');
  expect(() => verifyPluginDownload(new Uint8Array([1,2,3]), 'wrong')).toThrow('sha256');
});
test('plugin RPC refuses unknown IDs and unavailable installs, uninstall keeps account pools', async () => {
  harness = await startPoolCore(); const client = await harness.connect();
  expect(await thrown(client.call('plugins.install', { id: '../escape' }))).toThrow('unknown plugin');
  expect(await thrown(client.call('plugins.install', { id: 'never-added' }))).toThrow('unknown plugin');
  expect(await thrown(client.call('plugins.accounts', { id: 'pool-switcher' }))).toThrow('Install pool-switcher first');
  const pool = join(harness.dataDir, 'saved-logins'); mkdirSync(pool); writeFileSync(join(pool, 'keep'), 'fixture');
  const state = await client.call('plugins.uninstall', { id: 'pool-switcher' });
  expect(state.status).toBe('not-installed'); expect(existsSync(join(pool, 'keep'))).toBe(true);
});
test('plugin state accepts a missing directory but refuses a dangling directory link', async () => {
  harness = await startPoolCore();
  expect(harness.core.plugins.state('pool-switcher').status).toBe('not-installed');
  const root = join(harness.dataDir, 'plugins');
  mkdirSync(root, { recursive: true });
  const dir = join(root, 'pool-switcher');
  symlinkSync(join(harness.dataDir, 'missing-plugin'), dir, 'junction');
  expect(existsSync(dir)).toBe(false);
  expect(() => harness!.core.plugins.state('pool-switcher')).toThrow('must not be a symbolic link');
});

test('a truncated manifest is an error on the card, not a Plugins page that will not open', async () => {
  harness = await startPoolCore(); const client = await harness.connect();
  const dir = join(harness.dataDir, 'plugins', 'pool-switcher'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `pool${EXE}`), 'fixture');
  // What a power loss during an install leaves: the binary is there, the
  // manifest is half written. `JSON.parse` used to throw out of `state()`, so
  // `plugins.list` failed and the page had no way to reinstall.
  writeFileSync(join(dir, 'installed.json'), '{"schema":');
  const poolOf = async () => (await client.call('plugins.list', {})).find((plugin) => plugin.id === 'pool-switcher');
  const broken = await poolOf();
  expect(broken?.status).toBe('error');
  expect(broken?.version).toBeNull();
  expect(broken?.error).toContain('installed.json');
  expect(broken?.error).toContain('Reinstall pool-switcher.');

  // A record without a schema, the version alone, is no longer read as an install.
  writeFileSync(join(dir, 'installed.json'), '{"version":"2.0.1"}');
  const versionOnly = await poolOf();
  expect(versionOnly?.status).toBe('rejected');
  expect(versionOnly?.version).toBeNull();
  expect(versionOnly?.rejected?.field).toBe('version');

  // And the page can still act: uninstall clears both the files and the error.
  const cleared = await client.call('plugins.uninstall', { id: 'pool-switcher' });
  expect(cleared.status).toBe('not-installed');
  expect(cleared.error).toBeNull();
});
test('the adapter runs the v2 pool flags through the process registry and normalizes JSON', async () => {
  harness = await startPoolCore();
  const dir = installPool(harness.dataDir);
  const fixture = join(dir, 'fixture.ts');
  writeFileSync(fixture, `const args = process.argv.slice(2); if(args[0] !== 'list' || !['-claude','-codex','-antigravity'].includes(args[1]) || args[2] !== '-Json') process.exit(3); console.log(JSON.stringify({accounts:[{email:'fixture@example.com', live:true, fiveHour:12, sevenDay:65, checkedSecondsAgo:0}]}));`);
  const spawn = harness.core.procs.spawn.bind(harness.core.procs);
  const replacement = spyOn(harness.core.procs, 'spawn').mockImplementation((thread, _cmd, args, options) => spawn(thread, process.execPath, [fixture, ...args], options));
  try {
    expect(harness.core.plugins.state('pool-switcher')).toMatchObject({ status: 'installed', version: '2.0.1', origin: 'recommended' });
    const result = await harness.core.plugins.accounts('pool-switcher');
    expect(result.map((pool) => pool.provider)).toEqual(['claude', 'codex', 'antigravity']);
    expect(result[0]?.accounts[0]?.windows[1]?.usedPercent).toBe(65);
    expect(replacement).toHaveBeenCalledTimes(3);
    await harness.core.plugins.accounts('pool-switcher'); expect(replacement).toHaveBeenCalledTimes(3);
  } finally { replacement.mockRestore(); }
});

test('a plugin login switch announces the default account and drops its probed models, even when its status stays the same', async () => {
  harness = await startPoolCore();
  const dir = installPool(harness.dataDir);
  const fixture = join(dir, 'fixture.ts');
  writeFileSync(fixture, `const args = process.argv.slice(2); if (args[0] === 'list') console.log(JSON.stringify({accounts:[{email:'next@example.com', live:true, fiveHour:1, sevenDay:2, checkedSecondsAgo:0}]})); else if (args[0] !== 'switch') process.exit(3);`);
  const spawn = harness.core.procs.spawn.bind(harness.core.procs);
  const replacement = spyOn(harness.core.procs, 'spawn').mockImplementation((thread, _cmd, args, options) => spawn(thread, process.execPath, [fixture, ...args], options));
  const account = harness.core.accounts.add({ providerId: 'claude', label: 'Default', useDefaultLocation: true });
  expect(account.isolationDir).toBeNull();
  const announced: string[] = [];
  const off = harness.core.bus.onAny((name, payload) => { const next = payload as Account; if (name === 'accounts.updated' && next.id === account.id) announced.push(next.status); });
  const forget = spyOn(getDriver('claude-sdk'), 'forgetProbes');
  try {
    // A plain check that finds the same status stays silent: that is what the switch must not rely on.
    harness.core.accounts.check(account.id);
    expect(announced).toEqual([]);
    await harness.core.plugins.accountAction({ id: 'pool-switcher', provider: 'claude', action: 'switch', email: 'next@example.com' });
    expect(announced).toEqual([account.status]);
    expect(forget).toHaveBeenCalledWith({ providerId: 'claude', accountId: account.id });
  } finally { off(); forget.mockRestore(); replacement.mockRestore(); }
});

describe('recommended plugins', () => {
  test('a recommended plugin with account pools is listed and installs through the manifest path, its download checked and recorded', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    harness = await startPoolCore(bytes); const client = await harness.connect();
    const asked = serveDownloads({ [POOL_URL]: bytes });

    const [listed] = await client.call('plugins.list', {});
    expect(listed).toMatchObject({ id: 'pool-switcher', origin: 'recommended', status: 'not-installed', version: null, availableVersion: '2.0.1', source: null, pools: ['claude', 'codex', 'antigravity'] });
    expect(listed?.artifact?.url).toBe(POOL_URL);
    expect(listed?.commands).toContain('pool switch -<pool> -Email <email> -Yes');

    const started = await client.call('plugins.install', { id: 'pool-switcher' });
    expect(started.status).toBe('installing');
    await waitFor(() => harness!.core.plugins.state('pool-switcher').status !== 'installing');
    const state = harness.core.plugins.state('pool-switcher');
    expect(state).toMatchObject({ status: 'installed', version: '2.0.1', error: null });
    expect(asked).toEqual([POOL_URL]);
    const dir = join(harness.dataDir, 'plugins', 'pool-switcher');
    expect(new Uint8Array(readFileSync(join(dir, `pool${EXE}`)))).toEqual(bytes);
    const record = JSON.parse(readFileSync(join(dir, 'installed.json'), 'utf8')) as Record<string, unknown>;
    expect(record).toMatchObject({ schema: 1, origin: 'recommended', source: null });
    expect((record['manifest'] as { id: string }).id).toBe('pool-switcher');
    expect(readdirSync(dir).sort()).toEqual(['installed.json', `pool${EXE}`]);

    await client.call('plugins.uninstall', { id: 'pool-switcher' });
    expect(existsSync(dir)).toBe(false);
  });

  test('a download whose digest differs from the pinned one installs nothing', async () => {
    harness = await startPoolCore(new Uint8Array([1, 2, 3, 4])); const client = await harness.connect();
    serveDownloads({ [POOL_URL]: new Uint8Array([9, 9, 9]) });
    await client.call('plugins.install', { id: 'pool-switcher' });
    await waitFor(() => harness!.core.plugins.state('pool-switcher').status !== 'installing');
    const state = harness.core.plugins.state('pool-switcher');
    expect(state.status).toBe('error');
    expect(state.error).toContain('sha256 does not match');
    expect(existsSync(join(harness.dataDir, 'plugins', 'pool-switcher'))).toBe(false);
  });
});

describe('one operation at a time on a plugin', () => {
  test('an install or a pool listing asked for while an uninstall stops the plugin is refused, and the uninstall leaves nothing', async () => {
    harness = await startPoolCore(); const client = await harness.connect();
    const dir = installPool(harness.dataDir);
    serveDownloads({ [POOL_URL]: new Uint8Array([1, 2, 3, 4]) });
    const stopped = Promise.withResolvers<void>();
    const forget = spyOn(harness.core.plugins.apps, 'forget').mockImplementation(() => stopped.promise);
    try {
      const uninstall = client.call('plugins.uninstall', { id: 'pool-switcher' });
      await waitFor(() => forget.mock.calls.length === 1);
      expect(await thrown(client.call('plugins.install', { id: 'pool-switcher' }))).toThrow('Wait for the current plugin operation');
      expect(await thrown(client.call('plugins.accounts', { id: 'pool-switcher' }))).toThrow('Wait for pool-switcher to be uninstalled');
      stopped.resolve();
      expect((await uninstall).status).toBe('not-installed');
      expect(existsSync(dir)).toBe(false);
      expect(harness.core.plugins.state('pool-switcher').status).toBe('not-installed');
    } finally { stopped.resolve(); forget.mockRestore(); }
  });

  test('an update whose record cannot be written keeps the binary and the record that worked together', async () => {
    harness = await startPoolCore(); const client = await harness.connect();
    const dir = installPool(harness.dataDir);
    const before = readFileSync(join(dir, 'installed.json'), 'utf8');
    serveDownloads({ [POOL_URL]: new Uint8Array([1, 2, 3, 4]) });
    const realOpen = fs.openSync;
    // Staging the record fails, as a full disk would make it.
    const full = spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      const path = args[0];
      if (String(path).endsWith('installed.json.part')) throw new Error('ENOSPC: no space left on device');
      return realOpen(...args);
    });
    try {
      await client.call('plugins.install', { id: 'pool-switcher' });
      await waitFor(() => harness!.core.plugins.state('pool-switcher').status !== 'installing');
    } finally { full.mockRestore(); }
    expect(harness.core.plugins.state('pool-switcher')).toMatchObject({ status: 'error', version: '2.0.1' });
    expect(readFileSync(join(dir, `pool${EXE}`), 'utf8')).toBe('fixture');
    expect(readFileSync(join(dir, 'installed.json'), 'utf8')).toBe(before);
    // Nothing of the update stays beside them.
    expect(readdirSync(dir).sort()).toEqual(['installed.json', `pool${EXE}`]);
  });

  test('an update whose previous binary is still locked after the commit is installed, and the leftover goes on a later read', async () => {
    harness = await startPoolCore(); const client = await harness.connect();
    const dir = installPool(harness.dataDir);
    serveDownloads({ [POOL_URL]: new Uint8Array([1, 2, 3, 4]) });
    const kept = () => readdirSync(dir).filter((name) => name.startsWith(`pool${EXE}.previous-`));
    const realRm = fs.rmSync;
    // Windows holds a file a process still has open: removing the previous binary fails once the record is in.
    const rm = spyOn(fs, 'rmSync').mockImplementation((path, options) => {
      if (String(path).includes('.previous-') && existsSync(path)) throw new Error('EBUSY: resource busy or locked');
      realRm(path, options);
    });
    try {
      await client.call('plugins.install', { id: 'pool-switcher' });
      await waitFor(() => harness!.core.plugins.state('pool-switcher').status !== 'installing');
      expect(harness.core.plugins.state('pool-switcher')).toMatchObject({ status: 'installed', error: null });
      expect([...readFileSync(join(dir, `pool${EXE}`))]).toEqual([1, 2, 3, 4]);
      expect(kept()).toHaveLength(1);
    } finally { rm.mockRestore(); }
    expect(harness.core.plugins.state('pool-switcher').status).toBe('installed');
    expect(readdirSync(dir).sort()).toEqual(['installed.json', `pool${EXE}`]);
  });

  test.each([
    { stage: 'before its record committed', committed: false },
    { stage: 'after its record committed', committed: true },
  ])('an activation a stopped core left $stage settles to one whole release', async ({ committed }) => {
    harness = await startPoolCore();
    const dir = installPool(harness.dataDir);
    const record = readFileSync(join(dir, 'installed.json'), 'utf8');
    const next = JSON.stringify({ ...JSON.parse(record), installedAt: 2 });
    // What the activation leaves between moving the binaries and dropping the kept one.
    const kept = `pool${EXE}.previous-0123456789ab`;
    renameSync(join(dir, `pool${EXE}`), join(dir, kept));
    writeFileSync(join(dir, `pool${EXE}`), 'new-binary');
    writeFileSync(join(dir, committed ? 'installed.json' : 'installed.json.part'), next);
    writeFileSync(join(dir, ACTIVATION_FILE), JSON.stringify({ previous: `pool${EXE}`, binary: `pool${EXE}`, kept }));
    expect(harness.core.plugins.state('pool-switcher').status).toBe('installed');
    expect(readFileSync(join(dir, `pool${EXE}`), 'utf8')).toBe(committed ? 'new-binary' : 'fixture');
    expect(readFileSync(join(dir, 'installed.json'), 'utf8')).toBe(committed ? next : record);
    expect(readdirSync(dir).sort()).toEqual(['installed.json', `pool${EXE}`]);
  });
});

describe('a plugin download on a slow link', () => {
  /** One recommended plugin whose download trickles `bytes` in pieces `gapMs` apart, then stalls forever when `stall` is set. */
  async function trickle(gapMs: number, stall: boolean): Promise<{ client: Awaited<ReturnType<TestCore['connect']>>; bytes: Uint8Array<ArrayBuffer> }> {
    const bytes = new Uint8Array(8).map((_, index) => index + 1);
    harness = await startPoolCore(bytes); const client = await harness.connect();
    harness.core.plugins.downloadIdleMs = 300;
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (_input: string | URL | Request) => new Response(new ReadableStream<Uint8Array>({
      async start(controller) {
        for (let at = 0; at < bytes.length; at += 2) {
          if (stall && at === 4) return;
          controller.enqueue(bytes.slice(at, at + 2));
          await Bun.sleep(gapMs);
        }
        controller.close();
      },
    }), { headers: { 'content-length': String(bytes.length) } })) as typeof fetch);
    return { client, bytes };
  }

  test('a download that keeps receiving finishes, however long it takes in all', async () => {
    const { client, bytes } = await trickle(150, false);
    await client.call('plugins.install', { id: 'pool-switcher' });
    await waitFor(() => harness!.core.plugins.state('pool-switcher').status !== 'installing');
    expect(harness!.core.plugins.state('pool-switcher')).toMatchObject({ status: 'installed', error: null });
    expect(new Uint8Array(readFileSync(join(harness!.dataDir, 'plugins', 'pool-switcher', `pool${EXE}`)))).toEqual(bytes);
  });

  test('a download that goes silent stops after the idle wait and says it stalled', async () => {
    const { client } = await trickle(10, true);
    await client.call('plugins.install', { id: 'pool-switcher' });
    await waitFor(() => harness!.core.plugins.state('pool-switcher').status !== 'installing', 3_000);
    const state = harness!.core.plugins.state('pool-switcher');
    expect(state.status).toBe('error');
    expect(state.error).toMatch(/stalled: no data for \d+ seconds after 4 bytes/);
    expect(existsSync(join(harness!.dataDir, 'plugins', 'pool-switcher'))).toBe(false);
  });
});

describe('plugins from a git URL', () => {
  // Every inspection runs five gits through the registry. On Windows runners the id test
  // takes 2.0 to 2.3 s, but one inspection took 19.2 s and two tests passed 30 s while
  // spawn-heavy files (procs, prepared-drivers) ran beside them.
  const GIT_URL_TEST_MS = 90_000;
  test('inspect reads the manifest at the commit, add installs it, uninstall takes back everything it wrote', async () => {
    harness = await startTestCore(); const client = await harness.connect();
    harness.core.plugins.allowLocalSources = true;
    const bytes = new Uint8Array([7, 7, 7]);
    const repo = repository('seat-pool', manifest({}, bytes), 'v1.4.0');
    const asked = serveDownloads({ 'https://plugins.example.invalid/seat-pool-1.4.0': bytes });

    const preview = await client.call('plugins.inspect', { url: repo.path, ref: 'v1.4.0' });
    expect(preview.rejected).toBeNull();
    expect(preview.previewId).toMatch(/^[0-9a-f]{64}$/);
    expect(preview.source).toEqual({ url: repo.path, ref: 'v1.4.0', commit: repo.commit });
    expect(preview.manifest?.id).toBe('seat-pool');
    expect(preview.artifact?.url).toBe('https://plugins.example.invalid/seat-pool-1.4.0');
    expect(preview.commands).toHaveLength(5);
    expect(preview.replaces).toBeNull();
    // Inspecting downloads nothing and leaves nothing: the fetch directory is gone.
    expect(asked).toEqual([]);
    expect(readdirSync(join(harness.dataDir, 'plugins'))).toEqual([]);

    const started = await client.call('plugins.add', { previewId: preview.previewId! });
    expect(started).toMatchObject({ id: 'seat-pool', origin: 'url', status: 'installing' });
    await waitFor(() => harness!.core.plugins.state('seat-pool').status !== 'installing');
    const installed = harness.core.plugins.state('seat-pool');
    expect(installed).toMatchObject({ status: 'installed', version: '1.4.0', pools: ['opencode'], error: null });
    expect(installed.source).toEqual({ url: repo.path, ref: 'v1.4.0', commit: repo.commit });
    const dir = join(harness.dataDir, 'plugins', 'seat-pool');
    const record = JSON.parse(readFileSync(join(dir, 'installed.json'), 'utf8')) as { source: { commit: string } };
    expect(record.source.commit).toBe(repo.commit);
    expect((await client.call('plugins.list', {})).map((plugin) => plugin.id)).toEqual(['bots', 'douane', 'seat-pool']);

    // A preview is used once.
    expect(await thrown(client.call('plugins.add', { previewId: preview.previewId! }))).toThrow('unknown or expired');

    // The same URL again is an update, and the preview says what it replaces.
    const bytes2 = new Uint8Array([8, 8]);
    const next = commitManifest(repo.path, manifest({ version: '1.5.0', artifacts: { [platformKey()]: { url: 'https://plugins.example.invalid/seat-pool-1.5.0', sha256: sha256(bytes2) } } }));
    fetchSpy?.mockRestore();
    serveDownloads({ 'https://plugins.example.invalid/seat-pool-1.5.0': bytes2 });
    const update = await client.call('plugins.inspect', { url: repo.path });
    expect(update.source).toEqual({ url: repo.path, ref: 'HEAD', commit: next });
    expect(update.replaces).toBe('1.4.0');
    await client.call('plugins.add', { previewId: update.previewId! });
    await waitFor(() => harness!.core.plugins.state('seat-pool').status !== 'installing');
    expect(harness.core.plugins.state('seat-pool')).toMatchObject({ status: 'installed', version: '1.5.0' });
    expect(harness.core.plugins.state('seat-pool').source?.commit).toBe(next);

    const removed = await client.call('plugins.uninstall', { id: 'seat-pool' });
    expect(removed.status).toBe('not-installed');
    expect(existsSync(dir)).toBe(false);
    expect((await client.call('plugins.list', {})).map((plugin) => plugin.id)).toEqual(['bots', 'douane']);
    expect(await thrown(client.call('plugins.install', { id: 'seat-pool' }))).toThrow('unknown plugin');
  }, GIT_URL_TEST_MS);

  test('a refused manifest comes back as a preview with the file, the field and what was expected, never installable', async () => {
    harness = await startTestCore(); const client = await harness.connect();
    harness.core.plugins.allowLocalSources = true;

    const extra = repository('extra', manifest({ scripts: { postinstall: 'sh' } }));
    const refused = await client.call('plugins.inspect', { url: extra.path });
    expect(refused.previewId).toBeNull();
    expect(refused.rejected).toMatchObject({ file: 'boite-plugin.json', field: 'scripts' });
    expect(refused.source.commit).toBe(extra.commit);

    const missing = repository('missing', null);
    expect((await client.call('plugins.inspect', { url: missing.path })).rejected?.field).toBe('(file)');

    const broken = repository('broken', '{"schema": 1,');
    expect((await client.call('plugins.inspect', { url: broken.path })).rejected?.expected).toBe('valid JSON');

    const squat = repository('squat', manifest({ id: 'bots' }));
    const squatted = await client.call('plugins.inspect', { url: squat.path });
    expect(squatted.rejected?.field).toBe('id');
    expect(squatted.rejected?.expected).toContain('no recommended plugin uses');

    const elsewhere = repository('elsewhere', manifest({ artifacts: { 'darwin-arm64': { url: 'https://plugins.example.invalid/a', sha256: 'b'.repeat(64) } } }));
    const foreign = platformKey() === 'darwin-arm64' ? null : await client.call('plugins.inspect', { url: elsewhere.path });
    if (foreign !== null) expect(foreign.rejected).toMatchObject({ field: 'artifacts', expected: `an artifact for ${platformKey()}, this machine` });

    expect(await thrown(client.call('plugins.inspect', { url: extra.path, ref: '--upload-pack=touch' }))).toThrow('plugin ref must be');
    expect(await thrown(client.call('plugins.inspect', { url: extra.path, ref: 'no-such-branch' }))).toThrow('could not fetch');
    expect(await thrown(client.call('plugins.add', { previewId: 'f'.repeat(64) }))).toThrow('unknown or expired');

    // With the test door shut, a path is refused before git runs.
    harness.core.plugins.allowLocalSources = false;
    expect(await thrown(client.call('plugins.inspect', { url: extra.path }))).toThrow('plugin url must be an https URL');
    expect(readdirSync(join(harness.dataDir, 'plugins'))).toEqual([]);
  }, GIT_URL_TEST_MS);

  test('the next inspection sweeps a fetch directory left behind, and leaves a running one alone', async () => {
    harness = await startTestCore(); const client = await harness.connect();
    harness.core.plugins.allowLocalSources = true;
    const root = join(harness.dataDir, 'plugins');
    const stale = join(root, '.fetch-stale');
    const running = join(root, '.fetch-running');
    for (const dir of [stale, running]) mkdirSync(join(dir, 'objects'), { recursive: true });
    const hourAgo = new Date(Date.now() - 60 * 60_000);
    utimesSync(stale, hourAgo, hourAgo);

    await client.call('plugins.inspect', { url: repository('sweep', manifest({})).path });
    expect(readdirSync(root).sort()).toEqual(['.fetch-running']);
  }, GIT_URL_TEST_MS);

  test('an id added from one URL is not taken over by another', async () => {
    harness = await startTestCore(); const client = await harness.connect();
    harness.core.plugins.allowLocalSources = true;
    const bytes = new Uint8Array([7, 7, 7]);
    serveDownloads({ 'https://plugins.example.invalid/seat-pool-1.4.0': bytes });
    const first = repository('first', manifest({}, bytes));
    await client.call('plugins.add', { previewId: (await client.call('plugins.inspect', { url: first.path })).previewId! });
    await waitFor(() => harness!.core.plugins.state('seat-pool').status !== 'installing');
    const second = repository('second', manifest({}, bytes));
    const preview = await client.call('plugins.inspect', { url: second.path });
    expect(preview.previewId).toBeNull();
    expect(preview.rejected?.field).toBe('id');
    expect(preview.rejected?.expected).toContain(`already used by the plugin from ${first.path}`);
  }, GIT_URL_TEST_MS);

  test('a first install that fails leaves no files, stays listed with its error, and retries or goes', async () => {
    harness = await startTestCore(); const client = await harness.connect();
    harness.core.plugins.allowLocalSources = true;
    const bytes = new Uint8Array([7, 7, 7]);
    serveDownloads({ 'https://plugins.example.invalid/seat-pool-1.4.0': 503 });
    const repo = repository('seat-pool', manifest({}, bytes));
    await client.call('plugins.add', { previewId: (await client.call('plugins.inspect', { url: repo.path })).previewId! });
    await waitFor(() => harness!.core.plugins.state('seat-pool').status !== 'installing');
    expect(harness.core.plugins.state('seat-pool')).toMatchObject({ status: 'error', version: null, error: 'seat-pool download returned HTTP 503.' });
    expect(existsSync(join(harness.dataDir, 'plugins', 'seat-pool'))).toBe(false);
    expect((await client.call('plugins.list', {})).map((plugin) => plugin.id)).toContain('seat-pool');

    fetchSpy?.mockRestore();
    serveDownloads({ 'https://plugins.example.invalid/seat-pool-1.4.0': bytes });
    await client.call('plugins.install', { id: 'seat-pool' });
    await waitFor(() => harness!.core.plugins.state('seat-pool').status !== 'installing');
    expect(harness.core.plugins.state('seat-pool')).toMatchObject({ status: 'installed', source: { commit: repo.commit } });
    await client.call('plugins.uninstall', { id: 'seat-pool' });
    expect((await client.call('plugins.list', {})).map((plugin) => plugin.id)).toEqual(['bots', 'douane']);
  }, GIT_URL_TEST_MS);

  test('an installed.json the core no longer accepts is listed as rejected: it can be removed, never run', async () => {
    harness = await startTestCore(); const client = await harness.connect();
    const dir = join(harness.dataDir, 'plugins', 'pool-legacy'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `pool-legacy${EXE}`), 'fixture');
    writeFileSync(join(dir, 'installed.json'), JSON.stringify({
      schema: 1, origin: 'url', installedAt: 1,
      source: { url: 'https://plugins.example.invalid/pool-legacy', ref: 'HEAD', commit: 'c'.repeat(40) },
      manifest: { ...manifest({ id: 'pool-legacy', executable: 'pool-legacy' }), schema: 0 },
    }));
    const listed = (await client.call('plugins.list', {})).find((plugin) => plugin.id === 'pool-legacy');
    expect(listed?.status).toBe('rejected');
    expect(listed?.rejected).toMatchObject({ field: 'manifest.schema', expected: '1' });
    expect(listed?.rejected?.file).toEndWith('installed.json');
    expect(await thrown(client.call('plugins.accounts', { id: 'pool-legacy' }))).toThrow('pool-legacy was refused');
    expect(await thrown(client.call('plugins.install', { id: 'pool-legacy' }))).toThrow('Remove it, then add it again');
    await client.call('plugins.uninstall', { id: 'pool-legacy' });
    expect(existsSync(dir)).toBe(false);
  });

  test('an installed.json whose pool names the retired Antigravity CLI still loads, without that provider', async () => {
    harness = await startTestCore(); const client = await harness.connect();
    const install = (id: string, providers: string[]) => {
      const dir = join(harness!.dataDir, 'plugins', id); mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${id}${EXE}`), 'fixture');
      writeFileSync(join(dir, 'installed.json'), JSON.stringify({
        schema: 1, origin: 'url', installedAt: 1,
        source: { url: `https://plugins.example.invalid/${id}`, ref: 'HEAD', commit: 'c'.repeat(40) },
        manifest: manifest({ id, executable: id, provides: { accountPools: { providers } } }),
      }));
    };
    install('pool-agy', ['antigravity-cli', 'opencode']);
    install('pool-unknown', ['opencode', 'not-a-provider']);
    const listed = await client.call('plugins.list', {});
    expect(listed.find((plugin) => plugin.id === 'pool-agy')).toMatchObject({ status: 'installed', pools: ['opencode'], rejected: null });
    // Any other id the core does not know still refuses the manifest.
    expect(listed.find((plugin) => plugin.id === 'pool-unknown')).toMatchObject({ status: 'rejected', rejected: { field: 'manifest.provides.accountPools.providers[1]' } });
  });

  test('a paired device reaches none of it', async () => {
    harness = await startTestCore(); const owner = await harness.connect();
    const { grant } = await owner.call('pairing.grant', {});
    const device = await connect(harness.url, '', { grant, client: { name: 'pwa', version: 'test' } });
    try {
      expect(await thrown(device.call('plugins.inspect', { url: 'https://github.com/owner/repo' }))).toThrow('plugins.inspect is for the owner only');
      expect(await thrown(device.call('plugins.add', { previewId: 'f'.repeat(64) }))).toThrow('plugins.add is for the owner only');
      expect(await thrown(device.call('plugins.install', { id: 'bots' }))).toThrow('plugins.install is for the owner only');
      expect(await thrown(device.call('plugins.list', {}))).toThrow('plugins.list is for the owner only');
    } finally { device.close(); }
  });
});

describe('plugin git ignores the caller gitconfig', () => {
  test('every git is pinned to https, with ext and the inherited config turned off', async () => {
    harness = await startTestCore();
    const seen: { args: string[]; env: Record<string, string | undefined> }[] = [];
    const empty = (): ReadableStream<Uint8Array> => new ReadableStream({ start(controller) { controller.close(); } });
    harness.core.procs.spawn = (threadId, command, args, opts) => {
      seen.push({ args: [...args], env: { ...(opts?.env ?? {}) } });
      const record: SpawnedProcess['record'] = {
        pid: 0,
        parentPid: null,
        threadId,
        exe: command,
        commandLine: [command, ...args].join(' '),
        startedAt: 0,
        exitedAt: null,
        exitCode: null,
        cpuMs: null,
        peakMemoryBytes: null,
        ioBytes: null,
      };
      return {
        record,
        proc: { stdout: empty(), stderr: empty(), pid: 0 } as SpawnedProcess['proc'],
        exited: Promise.resolve(args.includes('init') ? 0 : 1),
        stop: () => Promise.resolve(),
      };
    };
    const emptyConfig = process.platform === 'win32' ? 'NUL' : '/dev/null';
    const assertPinned = (allowFile: boolean): void => {
      expect(seen.length).toBeGreaterThan(0);
      for (const call of seen) {
        expect(call.args).toContain('protocol.ext.allow=never');
        expect(call.args).toContain(allowFile ? 'protocol.file.allow=always' : 'protocol.file.allow=never');
        expect(call.args).toContain('core.fsmonitor=');
        expect(call.env.GIT_CONFIG_COUNT).toBe('0');
        expect(call.env.GIT_CONFIG_PARAMETERS).toBe('');
        expect(call.env.GIT_CONFIG_NOSYSTEM).toBe('1');
        expect(call.env.GIT_CONFIG_GLOBAL).toBe(emptyConfig);
        expect(call.env.GIT_CONFIG_SYSTEM).toBe(emptyConfig);
      }
    };
    expect(await thrown(fetchManifest(harness.core, 'https://example.invalid/plugin.git', 'HEAD'))).toThrow(/could not fetch/);
    assertPinned(false);
    seen.length = 0;
    expect(await thrown(fetchManifest(harness.core, harness.dataDir, 'HEAD', { allowLocal: true }))).toThrow(/could not fetch/);
    assertPinned(true);
  });
});
