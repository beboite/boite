/*
 * Newer releases of a recommended plugin, found at the update source its
 * reviewed entry names. The source is read through a seam here, the store's
 * `readUpdateSource`, except in the one test that reads a real repository on
 * disk; downloads are answered from memory, so no test reaches the network.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { DEVICE_EVENTS, PLUGIN_MANIFEST_FILE } from '@boite/contracts';
import { connect } from '../src/client.ts';
import { ManifestRefused, parseManifest, platformKey } from '../src/plugins/manifest.ts';
import { CHECK_INTERVAL_MS, FIRST_CHECK_MS, PluginUpdateChecks, RETRY_FIRST_MS, parseRecommendedEntry, type UpdateHost } from '../src/plugins/updates.ts';
import { startTestCore, waitFor, type TestCore } from './harness.ts';
import { thrown } from './settle.ts';

let harness: TestCore | undefined;
let fetchSpy: { mockRestore(): void } | undefined;
afterEach(async () => {
  fetchSpy?.mockRestore(); fetchSpy = undefined;
  await harness?.stop(); harness = undefined;
});

const SOURCE = { url: 'https://updates.example.invalid/seat-pool', ref: 'main' };
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const BYTES: Record<string, Uint8Array> = { '1.0.0': new Uint8Array([1]), '1.1.0': new Uint8Array([2]), '1.2.0': new Uint8Array([3]) };

function release(version: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const bytes = BYTES[version] ?? new Uint8Array([9]);
  return {
    schema: 1, id: 'seat-pool', name: 'Seat pool', version,
    description: 'Switches OpenCode logins from a saved pool.',
    homepage: 'https://plugins.example.invalid/seat-pool',
    executable: 'seat-pool',
    artifacts: { [platformKey()]: { url: `https://plugins.example.invalid/seat-pool-${version}`, sha256: sha256(bytes) } },
    provides: { accountPools: { providers: ['opencode'] } },
    ...overrides,
  };
}

/** Every release's binary, answered from memory. */
function serveDownloads(): string[] {
  const asked: string[] = [];
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    asked.push(url);
    const version = Object.keys(BYTES).find((key) => url === `https://plugins.example.invalid/seat-pool-${key}`);
    if (version === undefined) return new Response('not found', { status: 404 });
    const bytes = BYTES[version]!;
    return new Response(bytes, { headers: { 'content-length': String(bytes.length) } });
  }) as typeof fetch);
  return asked;
}

/**
 * A core whose recommended list is seat-pool at `pinned`, with an update
 * source whose manifest is whatever `publish` last set. `clock` drives the
 * checks' backoff and their ten-second floor.
 */
async function setup(pinned = '1.0.0') {
  harness = await startTestCore();
  const client = await harness.connect();
  const store = harness.core.plugins;
  store.recommended = [parseManifest(release(pinned), 'recommended.json[0]')];
  store.updateSources = { 'seat-pool': SOURCE };
  let published: string | null | Error = null;
  let reads = 0;
  store.readUpdateSource = async (source) => {
    expect(source).toEqual(SOURCE);
    reads += 1;
    if (published instanceof Error) throw published;
    return { commit: 'c'.repeat(40), text: published };
  };
  const clock = { now: 5_000_000 };
  store.updates.now = () => clock.now;
  // What the server does once it listens; called again it changes nothing.
  store.startUpdateChecks();
  const asked = serveDownloads();
  return {
    client, store, clock, asked,
    reads: () => reads,
    publish(content: Record<string, unknown> | string | null | Error) {
      published = content === null || typeof content === 'string' || content instanceof Error ? content : JSON.stringify(content);
    },
    /** The owner's check, past the floor of the one before. */
    async check() {
      clock.now += 11_000;
      const [state] = await client.call('plugins.checkUpdates', { id: 'seat-pool' });
      return state!;
    },
    async installed(version: string) {
      await client.call('plugins.install', { id: 'seat-pool' });
      await waitFor(() => store.state('seat-pool').status !== 'installing');
      expect(store.state('seat-pool')).toMatchObject({ status: 'installed', version, error: null });
    },
  };
}

describe('an update source', () => {
  test('a newer release found there is offered, then installed, and installed.json keeps the manifest it came from', async () => {
    const t = await setup();
    await t.installed('1.0.0');
    t.publish(release('1.1.0', { description: 'Now with more seats.' }));
    const state = await t.check();
    expect(state).toMatchObject({ version: '1.0.0', availableVersion: '1.1.0', description: 'Now with more seats.' });
    expect(state.updates).toMatchObject({ source: SOURCE, checking: false, ignored: null, error: null, available: { version: '1.1.0', commit: 'c'.repeat(40) } });
    expect(state.artifact?.url).toBe('https://plugins.example.invalid/seat-pool-1.1.0');

    await t.installed('1.1.0');
    expect(t.asked).toEqual(['https://plugins.example.invalid/seat-pool-1.0.0', 'https://plugins.example.invalid/seat-pool-1.1.0']);
    const record = JSON.parse(readFileSync(join(harness!.dataDir, 'plugins', 'seat-pool', 'installed.json'), 'utf8')) as Record<string, unknown>;
    // The keys every older core reads: going back to one keeps the plugin listed.
    expect(Object.keys(record).sort()).toEqual(['installedAt', 'manifest', 'origin', 'schema', 'source']);
    expect(record).toMatchObject({ origin: 'recommended', source: null, manifest: { version: '1.1.0', description: 'Now with more seats.' } });
    // Installed, it is no longer an update; the list stays at the version on disk, never back to the pinned one.
    expect(t.store.state('seat-pool')).toMatchObject({ version: '1.1.0', availableVersion: '1.1.0', updates: { available: null } });
  }, 30_000);

  test('a first install reads the source before downloading, and a source that fails leaves the pinned entry', async () => {
    const t = await setup();
    t.publish(new Error('git fetch failed: could not resolve host'));
    await t.installed('1.0.0');
    expect(t.store.state('seat-pool').updates?.error).toBe('git fetch failed: could not resolve host');
    await t.client.call('plugins.uninstall', { id: 'seat-pool' });

    // Never checked while it was not installed, the source still names the release a first install brings.
    t.clock.now += 11_000;
    t.publish(release('1.1.0'));
    await t.installed('1.1.0');
    expect(t.reads()).toBe(2);
    expect(t.asked).toEqual(['https://plugins.example.invalid/seat-pool-1.0.0', 'https://plugins.example.invalid/seat-pool-1.1.0']);
  }, 30_000);

  test('the same or an older version is not offered, and an older one says why', async () => {
    const t = await setup();
    await t.installed('1.0.0');
    t.publish(release('1.0.0'));
    expect((await t.check()).updates).toMatchObject({ available: null, ignored: null, error: null });
    t.publish(release('0.9.0'));
    const older = await t.check();
    expect(older.availableVersion).toBe('1.0.0');
    expect(older.updates?.available).toBeNull();
    expect(older.updates?.ignored).toContain('0.9.0 found there, older than 1.0.0; Boite never goes back');
  }, 30_000);

  test('a release taken back at the source is no longer offered', async () => {
    const t = await setup();
    t.publish(release('1.1.0'));
    expect((await t.check()).updates?.available?.version).toBe('1.1.0');
    t.publish(release('1.0.0'));
    const state = await t.check();
    expect(state.updates?.available).toBeNull();
    expect(state.availableVersion).toBe('1.0.0');
  });

  test('a manifest for another plugin, or one that changes what the owner reviewed, is ignored', async () => {
    const t = await setup();
    const cases: [Record<string, unknown> | string | null, string][] = [
      [release('1.1.0', { id: 'bots' }), 'is for "bots", not "seat-pool"'],
      [release('1.1.0', { name: 'Official Boite security' }), 'changes name from "Seat pool"'],
      [release('1.1.0', { homepage: 'https://elsewhere.example.invalid' }), 'changes homepage'],
      [release('1.1.0', { executable: 'other' }), 'changes executable'],
      [release('1.1.0', { provides: { accountPools: { providers: ['opencode'] }, desktopApp: {} } }), 'asks for other features than the reviewed entry'],
      [release('1.1.0', { provides: { accountPools: { providers: ['opencode', 'claude'] } } }), 'asks for other features'],
      [null, `The source has no ${PLUGIN_MANIFEST_FILE}.`],
      ['{"schema": 1,', 'must be valid JSON'],
    ];
    for (const [content, reason] of cases) {
      t.publish(content);
      const state = await t.check();
      expect(state.updates?.ignored).toContain(reason);
      expect(state.updates?.available).toBeNull();
      expect(state.updates?.error).toBeNull();
      expect(state.availableVersion).toBe('1.0.0');
    }
  });

  test('an artifact over http or without a good digest is refused, and a digest that lies fails the install', async () => {
    const t = await setup();
    const key = platformKey();
    t.publish(release('1.1.0', { artifacts: { [key]: { url: 'http://plugins.example.invalid/seat-pool-1.1.0', sha256: sha256(BYTES['1.1.0']!) } } }));
    expect((await t.check()).updates?.ignored).toContain(`artifacts.${key}.url must be an https URL`);
    t.publish(release('1.1.0', { artifacts: { [key]: { url: 'https://plugins.example.invalid/seat-pool-1.1.0' } } }));
    expect((await t.check()).updates?.ignored).toContain(`artifacts.${key}.sha256`);
    t.publish(release('1.1.0', { artifacts: { [key]: { url: 'https://plugins.example.invalid/seat-pool-1.1.0', sha256: 'ab'.repeat(16) } } }));
    expect((await t.check()).updates?.ignored).toContain(`artifacts.${key}.sha256 must be 64 lowercase hexadecimal`);
    const elsewhere = key === 'linux-arm64' ? 'linux-x64' : 'linux-arm64';
    t.publish(release('1.1.0', { artifacts: { [elsewhere]: { url: 'https://plugins.example.invalid/a', sha256: 'b'.repeat(64) } } }));
    expect((await t.check()).updates?.ignored).toContain(`publishes nothing for ${key}`);

    await t.installed('1.0.0');
    // Well formed, but the binary served is not the one the digest names: the version that worked stays.
    t.publish(release('1.1.0', { artifacts: { [key]: { url: 'https://plugins.example.invalid/seat-pool-1.1.0', sha256: 'd'.repeat(64) } } }));
    expect((await t.check()).updates?.available?.version).toBe('1.1.0');
    await t.client.call('plugins.install', { id: 'seat-pool' });
    await waitFor(() => t.store.state('seat-pool').status !== 'installing');
    expect(t.store.state('seat-pool')).toMatchObject({ status: 'error', version: '1.0.0' });
    expect(t.store.state('seat-pool').error).toContain('sha256');
  }, 30_000);

  test('a source that cannot be read backs off, 15 minutes then twice as long, up to six hours, and a good read resets it', async () => {
    const t = await setup();
    t.publish(new Error('git fetch failed: could not resolve host'));
    const waits: number[] = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
      const state = await t.check();
      expect(state.updates?.error).toBe('git fetch failed: could not resolve host');
      expect(state.updates?.available).toBeNull();
      waits.push(state.updates!.nextCheckAt! - state.updates!.checkedAt!);
    }
    expect(waits).toEqual([1, 2, 4, 8, 16, 24, 24].map((quarters) => quarters * RETRY_FIRST_MS));
    t.publish(release('1.1.0'));
    const state = await t.check();
    expect(state.updates).toMatchObject({ error: null, available: { version: '1.1.0' } });
    expect(state.updates!.nextCheckAt! - state.updates!.checkedAt!).toBe(CHECK_INTERVAL_MS);
  });

  test('a manual check right after another, or during one, reads the source once', async () => {
    const t = await setup();
    t.publish(release('1.1.0'));
    await t.check();
    expect(t.reads()).toBe(1);
    await t.client.call('plugins.checkUpdates', {});
    expect(t.reads()).toBe(1);
    t.clock.now += 11_000;
    const both = await Promise.all([t.client.call('plugins.checkUpdates', {}), t.client.call('plugins.checkUpdates', { id: 'seat-pool' })]);
    expect(t.reads()).toBe(2);
    expect(both.map((states) => states.map((state) => state.id))).toEqual([['seat-pool'], ['seat-pool']]);
  });

  test('a newer pinned entry wins over the release found', async () => {
    const t = await setup();
    t.publish(release('1.1.0'));
    expect((await t.check()).updates?.available?.version).toBe('1.1.0');
    t.store.recommended = [parseManifest(release('1.2.0'), 'recommended.json[0]')];
    expect(t.store.state('seat-pool')).toMatchObject({ availableVersion: '1.2.0', updates: { available: null } });
    await t.installed('1.2.0');
    expect(t.asked).toEqual(['https://plugins.example.invalid/seat-pool-1.2.0']);
  }, 30_000);

  test('only a recommended plugin naming a source is checked, and a paired device reaches none of it', async () => {
    const t = await setup();
    expect(await thrown(t.client.call('plugins.checkUpdates', { id: 'pool-switcher' }))).toThrow('plugin pool-switcher has no update source');
    expect(t.store.state('seat-pool').updates?.source).toEqual(SOURCE);
    t.store.updateSources = {};
    expect(t.store.state('seat-pool').updates).toBeNull();
    expect(await t.client.call('plugins.checkUpdates', {})).toEqual([]);
    expect(t.reads()).toBe(0);

    const { grant } = await t.client.call('pairing.grant', {});
    const device = await connect(harness!.url, '', { grant, client: { name: 'pwa', version: 'test' } });
    try {
      expect(await thrown(device.call('plugins.checkUpdates', {}))).toThrow('plugins.checkUpdates is for the owner only');
      expect(DEVICE_EVENTS.has('plugins.updated')).toBe(false);
    } finally { device.close(); }
  });

  test('a real repository on disk is read through the git path plugins.inspect uses', async () => {
    harness = await startTestCore();
    const client = await harness.connect();
    const store = harness.core.plugins;
    store.allowLocalSources = true;
    const repo = join(harness.dataDir, 'repos', 'seat-pool');
    mkdirSync(repo, { recursive: true });
    const env = { ...process.env, GIT_AUTHOR_NAME: 'boite test', GIT_AUTHOR_EMAIL: 'test@boite.invalid', GIT_COMMITTER_NAME: 'boite test', GIT_COMMITTER_EMAIL: 'test@boite.invalid' };
    const git = (...args: string[]): string => {
      const run = Bun.spawnSync({ cmd: ['git', ...args], cwd: repo, env, stdout: 'pipe', stderr: 'pipe', windowsHide: true });
      if (!run.success) throw new Error(`git ${args.join(' ')} failed: ${run.stderr.toString()}`);
      return run.stdout.toString().trim();
    };
    git('init', '-q');
    writeFileSync(join(repo, PLUGIN_MANIFEST_FILE), JSON.stringify(release('1.1.0'), null, 2));
    git('add', '-A'); git('commit', '-q', '-m', 'release'); git('branch', '-M', 'main');
    store.recommended = [parseManifest(release('1.0.0'), 'recommended.json[0]')];
    store.updateSources = { 'seat-pool': { url: repo, ref: 'main' } };
    const [state] = await client.call('plugins.checkUpdates', { id: 'seat-pool' });
    expect(state?.updates).toMatchObject({ error: null, ignored: null, available: { version: '1.1.0', commit: git('rev-parse', 'HEAD') } });
  }, 30_000);
});

describe('the checks on their own', () => {
  function host(installed: string | null) {
    const reads: string[] = [];
    const pinned = parseManifest(release('1.0.0'), 'recommended.json[0]');
    const fake: UpdateHost = {
      source: () => SOURCE,
      ids: () => ['seat-pool'],
      pinned: () => pinned,
      installed: () => installed,
      read: async () => { reads.push('seat-pool'); return { commit: 'c'.repeat(40), text: JSON.stringify(release('1.1.0')) }; },
      changed: () => undefined,
      log: () => undefined,
    };
    return { fake, reads };
  }

  test('the first one waits a minute; due, an installed plugin is read and one not installed is not', async () => {
    for (const installed of ['1.0.0', null]) {
      const { fake, reads } = host(installed);
      const checks = new PluginUpdateChecks(fake);
      let now = 1_000_000;
      checks.now = () => now;
      checks.start();
      expect(checks.state('seat-pool')?.nextCheckAt).toBe(now + FIRST_CHECK_MS);
      now += FIRST_CHECK_MS;
      // Armed for a minute of real time; the clock moved, so the next arm fires in a second.
      (checks as unknown as { arm(): void }).arm();
      await Bun.sleep(1_300);
      expect(reads).toEqual(installed === null ? [] : ['seat-pool']);
      expect(checks.state('seat-pool')?.available?.version).toBe(installed === null ? undefined : '1.1.0');
      expect(checks.state('seat-pool')?.nextCheckAt).toBe(now + CHECK_INTERVAL_MS);
      await checks.close();
      expect(checks.state('seat-pool')?.nextCheckAt).toBeNull();
    }
  });
});

describe('the update field of a recommended entry', () => {
  const entry = (updates: unknown): Record<string, unknown> => ({ ...release('1.0.0'), updates });
  const refusal = (updates: unknown): ManifestRefused => {
    try { parseRecommendedEntry(entry(updates), 'recommended.json[0]'); } catch (error) { if (error instanceof ManifestRefused) return error; throw error; }
    throw new Error('accepted');
  };

  test('reads a repository and a ref, and an entry without one has no source', () => {
    expect(parseRecommendedEntry(entry({ repository: 'https://github.com/Skollheim/bots', ref: 'main' }), 'recommended.json[0]').updates).toEqual({ url: 'https://github.com/Skollheim/bots', ref: 'main' });
    expect(parseRecommendedEntry(release('1.0.0'), 'recommended.json[0]').updates).toBeNull();
  });

  test('refuses another field, an http or credentialed repository and a ref that is not one', () => {
    expect(refusal({ repository: 'https://github.com/Skollheim/bots', ref: 'main', manifest: 'x' }).rejected.field).toBe('updates.manifest');
    expect(refusal({ repository: 'http://github.com/Skollheim/bots', ref: 'main' }).rejected.field).toBe('updates.repository');
    expect(refusal({ repository: 'https://user:pass@github.com/Skollheim/bots', ref: 'main' }).rejected.field).toBe('updates.repository');
    expect(refusal({ repository: 'https://github.com/Skollheim/bots', ref: '--upload-pack=x' }).rejected.field).toBe('updates.ref');
    expect(refusal({ repository: 'https://github.com/Skollheim/bots' }).rejected.field).toBe('updates.ref');
    expect(refusal('https://github.com/Skollheim/bots').rejected.field).toBe('updates');
    // A plugin's own manifest may never carry it: the field belongs to Boite's list.
    expect(() => parseManifest(entry({ repository: 'https://github.com/Skollheim/bots', ref: 'main' }), PLUGIN_MANIFEST_FILE)).toThrow('updates must be one of');
  });
});
