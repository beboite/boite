import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { PLUGIN_MANIFEST_FILE } from '@boite/contracts';
import { connect } from '../src/client.ts';
import { RECOMMENDED, parsePluginPool, verifyPluginDownload } from '../src/plugins.ts';
import { platformKey } from '../src/plugins/manifest.ts';
import { startTestCore, waitFor, type TestCore } from './harness.ts';

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

test('kebacc v2 JSON maps live and unknown quotas without inventing reset times', () => {
  const pool = parsePluginPool('codex', JSON.stringify({ pool: 'Codex', accounts: [
    { email: 'user@example.com', live: true, fiveHour: 0, sevenDay: null, checkedSecondsAgo: 19, readyAt: '2026-09-13T12:00:00Z', file: 'must-not-leave-core' },
  ] }));
  expect(pool.accounts[0]).toEqual({ email: 'user@example.com', active: true, checkedSecondsAgo: 19,
    windows: [{ id: 'fiveHour', label: '5 hours', usedPercent: 0, resetsAt: null }] });
  expect(() => parsePluginPool('codex', '{}')).toThrow('accounts array');
  expect(() => verifyPluginDownload(new Uint8Array([1,2,3]), 'wrong')).toThrow('sha256');
});
test('plugin RPC refuses unknown IDs and unavailable installs, uninstall keeps account pools', async () => {
  harness = await startTestCore(); const client = await harness.connect();
  await expect(client.call('plugins.install', { id: '../escape' })).rejects.toThrow('unknown plugin');
  await expect(client.call('plugins.install', { id: 'never-added' })).rejects.toThrow('unknown plugin');
  await expect(client.call('plugins.accounts', { id: 'kebacc-switcher' })).rejects.toThrow('Install kebacc-switcher first');
  const pool = join(harness.dataDir, 'saved-logins'); mkdirSync(pool); writeFileSync(join(pool, 'keep'), 'fixture');
  const state = await client.call('plugins.uninstall', { id: 'kebacc-switcher' });
  expect(state.status).toBe('not-installed'); expect(existsSync(join(pool, 'keep'))).toBe(true);
});
test('a truncated manifest is an error on the card, not a Plugins page that will not open', async () => {
  harness = await startTestCore(); const client = await harness.connect();
  const dir = join(harness.dataDir, 'plugins', 'kebacc-switcher'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `kebacc${EXE}`), 'fixture');
  // What a power loss during an install leaves: the binary is there, the
  // manifest is half written. `JSON.parse` used to throw out of `state()`, so
  // `plugins.list` failed and the page had no way to reinstall.
  writeFileSync(join(dir, 'installed.json'), '{"version":');
  const [broken] = await client.call('plugins.list', {});
  expect(broken?.status).toBe('error');
  expect(broken?.version).toBeNull();
  expect(broken?.error).toContain('installed.json');
  expect(broken?.error).toContain('Reinstall kebacc-switcher.');

  // A manifest that parses but carries the wrong type says so just as plainly.
  writeFileSync(join(dir, 'installed.json'), '{"version":2}');
  const [typed] = await client.call('plugins.list', {});
  expect(typed?.status).toBe('error');
  expect(typed?.error).toContain('must carry a "version" string, found number');

  // And the page can still act: uninstall clears both the files and the error.
  const cleared = await client.call('plugins.uninstall', { id: 'kebacc-switcher' });
  expect(cleared.status).toBe('not-installed');
  expect(cleared.error).toBeNull();
});
test('the adapter runs the v2 pool flags through the process registry and normalizes JSON', async () => {
  harness = await startTestCore();
  const dir = join(harness.dataDir, 'plugins', 'kebacc-switcher'); mkdirSync(dir, { recursive: true });
  // The record kebacc-switcher wrote before manifests still reads as installed.
  writeFileSync(join(dir, 'installed.json'), '{"version":"2.0.1"}');
  writeFileSync(join(dir, `kebacc${EXE}`), 'fixture');
  const fixture = join(dir, 'fixture.ts');
  writeFileSync(fixture, `const args = process.argv.slice(2); if(args[0] !== 'list' || !['-claude','-codex','-antigravity'].includes(args[1]) || args[2] !== '-Json') process.exit(3); console.log(JSON.stringify({accounts:[{email:'fixture@example.com', live:true, fiveHour:12, sevenDay:65, checkedSecondsAgo:0}]}));`);
  const spawn = harness.core.procs.spawn.bind(harness.core.procs);
  const replacement = spyOn(harness.core.procs, 'spawn').mockImplementation((thread, _cmd, args, options) => spawn(thread, process.execPath, [fixture, ...args], options));
  try {
    expect(harness.core.plugins.state('kebacc-switcher')).toMatchObject({ status: 'installed', version: '2.0.1', origin: 'recommended' });
    const result = await harness.core.plugins.accounts('kebacc-switcher');
    expect(result.map((pool) => pool.provider)).toEqual(['claude', 'codex', 'antigravity']);
    expect(result[0]?.accounts[0]?.windows[1]?.usedPercent).toBe(65);
    expect(replacement).toHaveBeenCalledTimes(3);
    await harness.core.plugins.accounts('kebacc-switcher'); expect(replacement).toHaveBeenCalledTimes(3);
  } finally { replacement.mockRestore(); }
});

describe('recommended plugins', () => {
  test('kebacc-switcher is listed and installs through the manifest path, its download checked and recorded', async () => {
    harness = await startTestCore(); const client = await harness.connect();
    const kebacc = RECOMMENDED[0]!;
    const published = kebacc.artifacts[platformKey() as keyof typeof kebacc.artifacts]!;
    const bytes = new Uint8Array([1, 2, 3, 4]);
    // Same URL as the release; only the digest follows the fixture's bytes.
    harness.core.plugins.recommended = [{ ...kebacc, artifacts: { [platformKey()]: { url: published.url, sha256: sha256(bytes) } } }];
    const asked = serveDownloads({ [published.url]: bytes });

    const [listed] = await client.call('plugins.list', {});
    expect(listed).toMatchObject({ id: 'kebacc-switcher', origin: 'recommended', status: 'not-installed', version: null, availableVersion: '2.0.1', source: null, pools: ['claude', 'codex', 'antigravity'] });
    expect(listed?.artifact?.url).toBe(published.url);
    expect(listed?.commands).toContain('kebacc switch -<pool> -Email <email> -Yes');

    const started = await client.call('plugins.install', { id: 'kebacc-switcher' });
    expect(started.status).toBe('installing');
    await waitFor(() => harness!.core.plugins.state('kebacc-switcher').status !== 'installing');
    const state = harness.core.plugins.state('kebacc-switcher');
    expect(state).toMatchObject({ status: 'installed', version: '2.0.1', error: null });
    expect(asked).toEqual([published.url]);
    const dir = join(harness.dataDir, 'plugins', 'kebacc-switcher');
    expect(new Uint8Array(readFileSync(join(dir, `kebacc${EXE}`)))).toEqual(bytes);
    const record = JSON.parse(readFileSync(join(dir, 'installed.json'), 'utf8')) as Record<string, unknown>;
    expect(record).toMatchObject({ schema: 1, origin: 'recommended', source: null });
    expect((record['manifest'] as { id: string }).id).toBe('kebacc-switcher');
    expect(readdirSync(dir).sort()).toEqual(['installed.json', `kebacc${EXE}`]);

    await client.call('plugins.uninstall', { id: 'kebacc-switcher' });
    expect(existsSync(dir)).toBe(false);
  });

  test('a download whose digest differs from the pinned one installs nothing', async () => {
    harness = await startTestCore(); const client = await harness.connect();
    const url = RECOMMENDED[0]!.artifacts[platformKey() as keyof typeof RECOMMENDED[0]['artifacts']]!.url;
    serveDownloads({ [url]: new Uint8Array([9, 9, 9]) });
    await client.call('plugins.install', { id: 'kebacc-switcher' });
    await waitFor(() => harness!.core.plugins.state('kebacc-switcher').status !== 'installing');
    const state = harness.core.plugins.state('kebacc-switcher');
    expect(state.status).toBe('error');
    expect(state.error).toContain('sha256 does not match');
    expect(existsSync(join(harness.dataDir, 'plugins', 'kebacc-switcher'))).toBe(false);
  });
});

describe('plugins from a git URL', () => {
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
    expect((await client.call('plugins.list', {})).map((plugin) => plugin.id)).toEqual(['kebacc-switcher', 'jev-browser', 'seat-pool']);

    // A preview is used once.
    await expect(client.call('plugins.add', { previewId: preview.previewId! })).rejects.toThrow('unknown or expired');

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
    expect((await client.call('plugins.list', {})).map((plugin) => plugin.id)).toEqual(['kebacc-switcher', 'jev-browser']);
    await expect(client.call('plugins.install', { id: 'seat-pool' })).rejects.toThrow('unknown plugin');
  }, 30_000);

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

    const squat = repository('squat', manifest({ id: 'kebacc-switcher' }));
    const squatted = await client.call('plugins.inspect', { url: squat.path });
    expect(squatted.rejected?.field).toBe('id');
    expect(squatted.rejected?.expected).toContain('no recommended plugin uses');

    const elsewhere = repository('elsewhere', manifest({ artifacts: { 'darwin-arm64': { url: 'https://plugins.example.invalid/a', sha256: 'b'.repeat(64) } } }));
    const foreign = platformKey() === 'darwin-arm64' ? null : await client.call('plugins.inspect', { url: elsewhere.path });
    if (foreign !== null) expect(foreign.rejected).toMatchObject({ field: 'artifacts', expected: `an artifact for ${platformKey()}, this machine` });

    await expect(client.call('plugins.inspect', { url: extra.path, ref: '--upload-pack=touch' })).rejects.toThrow('plugin ref must be');
    await expect(client.call('plugins.inspect', { url: extra.path, ref: 'no-such-branch' })).rejects.toThrow('could not fetch');
    await expect(client.call('plugins.add', { previewId: 'f'.repeat(64) })).rejects.toThrow('unknown or expired');

    // With the test door shut, a path is refused before git runs.
    harness.core.plugins.allowLocalSources = false;
    await expect(client.call('plugins.inspect', { url: extra.path })).rejects.toThrow('plugin url must be an https URL');
    expect(readdirSync(join(harness.dataDir, 'plugins'))).toEqual([]);
  }, 30_000);

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
  }, 30_000);

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
  }, 30_000);

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
    expect((await client.call('plugins.list', {})).map((plugin) => plugin.id)).toEqual(['kebacc-switcher', 'jev-browser']);
  }, 30_000);

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
    await expect(client.call('plugins.accounts', { id: 'pool-legacy' })).rejects.toThrow('pool-legacy was refused');
    await expect(client.call('plugins.install', { id: 'pool-legacy' })).rejects.toThrow('Remove it, then add it again');
    await client.call('plugins.uninstall', { id: 'pool-legacy' });
    expect(existsSync(dir)).toBe(false);
  });

  test('a paired device reaches none of it', async () => {
    harness = await startTestCore(); const owner = await harness.connect();
    const { grant } = await owner.call('pairing.grant', {});
    const device = await connect(harness.url, '', { grant, client: { name: 'pwa', version: 'test' } });
    try {
      await expect(device.call('plugins.inspect', { url: 'https://github.com/owner/repo' })).rejects.toThrow('plugins.inspect is for the owner only');
      await expect(device.call('plugins.add', { previewId: 'f'.repeat(64) })).rejects.toThrow('plugins.add is for the owner only');
      await expect(device.call('plugins.install', { id: 'kebacc-switcher' })).rejects.toThrow('plugins.install is for the owner only');
      await expect(device.call('plugins.list', {})).rejects.toThrow('plugins.list is for the owner only');
    } finally { device.close(); }
  });
});
