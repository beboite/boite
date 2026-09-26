import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { zipSync } from 'fflate';
import type { HarnessUpdate, ProviderInstallState } from '@boite/contracts';
import { Core } from '../src/core.ts';
import { newToken } from '../src/ids.ts';
import { echoThread, startTestCore, waitFor } from './harness.ts';
import type { TestCore } from './harness.ts';

/** A fake agent binary and one file beside it: enough to prove the sizes are checked. */
const EXE = new Uint8Array(4096).fill(0x42);
const NOTE = new TextEncoder().encode('the second file of the release\n');
const EXE_PATH = 'bin/agent.exe';
const NOTE_PATH = 'share/note.txt';

/** The next release: another size on the executable, so the files themselves say which one landed. */
const EXE_V2 = new Uint8Array(6144).fill(0x43);

const RELEASE = zipSync({ [EXE_PATH]: EXE, [NOTE_PATH]: NOTE });
const RELEASE_V2 = zipSync({ [EXE_PATH]: EXE_V2, [NOTE_PATH]: NOTE });
const ESCAPING = zipSync({ '../evil.txt': NOTE, [EXE_PATH]: EXE });

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
}

/** The same archive with one byte flipped: same length, another digest. */
function tampered(): Uint8Array {
  const copy = new Uint8Array(RELEASE);
  const last = copy.length - 1;
  copy[last] = (copy[last] ?? 0) ^ 0xff;
  return copy;
}

/** How long each chunk of `/slow.zip` waits, so a cancel always lands mid-download. */
const SLOW_CHUNK_MS = 80;

let harness: TestCore;
let server: ReturnType<typeof Bun.serve>;

/** A release big enough to be cut in half, so the flaky routes have something to resume. */
const BIG_EXE = new Uint8Array(512 * 1024).map((_, index) => (index * 31) % 251);
const BIG_RELEASE = zipSync({ [EXE_PATH]: BIG_EXE, [NOTE_PATH]: NOTE }, { level: 0 });
const HALF = Math.floor(BIG_RELEASE.byteLength / 2);
const ETAG = '"big-release-1"';

/** What the flaky routes saw: one `Range` header (or null) per request, and what they do next. */
let requests: (string | null)[] = [];
let ifRanges: (string | null)[] = [];
let served = 0;
/** How a flaky route answers after its first request: resume, whole file again, stall, or keep failing. */
let flaky: 'resume' | 'whole' | 'down' = 'resume';

/** Half of the archive, then the connection drops (or, with `stall`, nothing more ever comes). */
function halfThen(end: 'drop' | 'stall'): Response {
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(BIG_RELEASE.slice(0, HALF));
      if (end === 'stall') return;
      await Bun.sleep(50);
      controller.error(new Error('the test server drops the connection'));
    },
  });
  return new Response(body, { headers: { 'content-length': String(BIG_RELEASE.byteLength), etag: ETAG, 'accept-ranges': 'bytes' } });
}

function flakyRoute(request: Request, first: 'drop' | 'stall'): Response {
  const range = request.headers.get('range');
  requests.push(range);
  ifRanges.push(request.headers.get('if-range'));
  served += 1;
  if (served === 1) return halfThen(first);
  if (flaky === 'down') return new Response('busy', { status: 503 });
  const from = Number(/^bytes=(\d+)-$/.exec(range ?? '')?.[1] ?? Number.NaN);
  if (flaky === 'whole' || Number.isNaN(from)) return new Response(BIG_RELEASE, { headers: { etag: ETAG } });
  return new Response(BIG_RELEASE.slice(from), {
    status: 206,
    headers: { 'content-range': `bytes ${from}-${BIG_RELEASE.byteLength - 1}/${BIG_RELEASE.byteLength}`, etag: ETAG },
  });
}

function bigInstall(path: string): Record<string, unknown> {
  return {
    version: '1.0.0',
    url: url(path),
    sha256: sha256(BIG_RELEASE),
    archiveBytes: BIG_RELEASE.byteLength,
    files: [
      { path: EXE_PATH, bytes: BIG_EXE.byteLength },
      { path: NOTE_PATH, bytes: NOTE.byteLength },
    ],
  };
}

function url(path: string): string {
  return `${server.url.origin}${path}`;
}

function descriptor(install: Record<string, unknown>): Record<string, unknown> {
  const profile = {
    detect: {},
    executable: [{ kind: 'file', value: `{agentsDir}/${EXE_PATH}` }],
    isolation: { MANAGED_HOME: '{isolationDir}' },
    install,
  };
  return {
    id: 'managed',
    schemaVersion: 1,
    name: 'Managed',
    shortName: 'Managed',
    protocol: 'acp',
    roots: ['{agentsDir}', '{isolationDir}'],
    profiles: { windows: profile, linux: profile, macos: profile },
    auth: { kind: 'none' },
    models: [{ id: 'default', name: 'Managed default', default: true }],
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

function goodInstall(): Record<string, unknown> {
  return {
    version: '1.0.0',
    url: url('/release.zip'),
    sha256: sha256(RELEASE),
    archiveBytes: RELEASE.byteLength,
    files: [
      { path: EXE_PATH, bytes: EXE.byteLength },
      { path: NOTE_PATH, bytes: NOTE.byteLength },
    ],
  };
}

/** The same provider, one release later: what an update reads. */
function nextInstall(): Record<string, unknown> {
  return {
    version: '1.1.0',
    url: url('/release-2.zip'),
    sha256: sha256(RELEASE_V2),
    archiveBytes: RELEASE_V2.byteLength,
    files: [
      { path: EXE_PATH, bytes: EXE_V2.byteLength },
      { path: NOTE_PATH, bytes: NOTE.byteLength },
    ],
  };
}

/** Writes the descriptor and makes the core re-read it, the way a user would. */
async function loadDescriptor(install: Record<string, unknown>): Promise<void> {
  const dir = join(harness.dataDir, 'providers');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'managed.json'), JSON.stringify(descriptor(install), null, 2), 'utf8');
  const client = await harness.connect();
  const { rejected } = await client.call('providers.reload', {});
  expect(rejected).toEqual([]);
}

function agentDir(...parts: string[]): string {
  return join(harness.dataDir, 'agents', 'managed', ...parts);
}

beforeEach(async () => {
  requests = [];
  ifRanges = [];
  served = 0;
  flaky = 'resume';
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    idleTimeout: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/release.zip') return new Response(RELEASE);
      if (path === '/agent.exe') return new Response(EXE);
      if (path === '/release-2.zip') return new Response(RELEASE_V2);
      if (path === '/escaping.zip') return new Response(ESCAPING);
      if (path === '/tampered.zip') return new Response(tampered());
      // Two bytes short of what the descriptor promises.
      if (path === '/short.zip') return new Response(RELEASE.slice(0, RELEASE.byteLength - 2));
      // The next release, slowly enough for an update to be joined or cancelled on the way.
      if (path === '/slow-2.zip') {
        let offset = 0;
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            await Bun.sleep(25);
            controller.enqueue(RELEASE_V2.slice(offset, offset + 16));
            offset += 16;
            if (offset >= RELEASE_V2.byteLength) controller.close();
          },
        });
        return new Response(body);
      }
      if (path === '/drop.zip') return flakyRoute(request, 'drop');
      if (path === '/stall.zip') return flakyRoute(request, 'stall');
      // No length announced, and more bytes than the descriptor names.
      if (path === '/oversize.zip') {
        const body = new ReadableStream<Uint8Array>({
          pull(controller) { controller.enqueue(new Uint8Array(64 * 1024)); },
        });
        return new Response(body);
      }
      if (path === '/slow.zip') {
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            await Bun.sleep(SLOW_CHUNK_MS);
            // Eight bytes at a time: the archive is a few hundred, and a body
            // longer than the descriptor says is refused before the cancel lands.
            controller.enqueue(new Uint8Array(8));
          },
        });
        return new Response(body);
      }
      return new Response('no', { status: 404 });
    },
  });
  harness = await startTestCore();
});

afterEach(async () => {
  await harness.stop();
  await server.stop(true);
});

describe('managed installs', () => {
  test('an archive for another architecture is refused before download', async () => {
    const arch = process.arch === 'arm64' ? 'x64' : 'arm64';
    await loadDescriptor({ ...goodInstall(), arch });
    const client = await harness.connect();
    const provider = (await client.call('providers.list', {})).loaded.find(value => value.id === 'managed');
    expect(provider?.install).toEqual({ state: 'failed', version: '1.0.0', message: `managed requires ${arch}; this machine is ${process.arch}` });
    await expect(client.call('providers.install', { providerId: 'managed' })).rejects.toThrow(`requires ${arch}`);
    expect(existsSync(agentDir('downloads'))).toBe(false);
  });

  test('additional declared executables receive execute permission on POSIX', async () => {
    await loadDescriptor({ ...goodInstall(), files: [
      { path: EXE_PATH, bytes: EXE.byteLength },
      { path: NOTE_PATH, bytes: NOTE.byteLength, executable: true },
    ] });
    const client = await harness.connect();
    await client.call('providers.install', { providerId: 'managed' });
    await waitFor(() => existsSync(agentDir('current', '.install-complete.json')));
    if (process.platform !== 'win32') {
      expect(statSync(agentDir('current', EXE_PATH)).mode & 0o111).toBe(0o111);
      expect(statSync(agentDir('current', NOTE_PATH)).mode & 0o111).toBe(0o111);
    }
  });

  test('a binary with the wrong digest never becomes available', async () => {
    await loadDescriptor({ ...goodInstall(), format: 'binary', url: url('/agent.exe'),
      sha256: '0'.repeat(64), archiveBytes: EXE.byteLength, files: [{ path: EXE_PATH, bytes: EXE.byteLength }] });
    const client = await harness.connect();
    const seen: ProviderInstallState[] = [];
    client.on('providers.installProgress', state => { seen.push(state); });
    await client.call('providers.install', { providerId: 'managed' });
    await waitFor(() => seen.some(state => state.state === 'failed'));
    expect(existsSync(agentDir('current', EXE_PATH))).toBe(false);
    expect((await client.call('providers.list', {})).loaded.find(provider => provider.id === 'managed')?.available).toBe(false);
  });

  test('a binary download is verified, installed and removable without a zip', async () => {
    await loadDescriptor({ ...goodInstall(), format: 'binary', url: url('/agent.exe'),
      sha256: sha256(EXE), archiveBytes: EXE.byteLength, files: [{ path: EXE_PATH, bytes: EXE.byteLength }] });
    const client = await harness.connect();
    const seen: ProviderInstallState[] = [];
    client.on('providers.installProgress', state => { seen.push(state); });
    // The account the install brings has to be known before the provider reads
    // as available, or a client starts a sign-in the user's own login makes useless.
    const order: string[] = [];
    client.on('accounts.updated', account => { if (account.providerId === 'managed') order.push('account'); });
    client.on('providers.updated', ({ loaded }) => { if (loaded.some(provider => provider.id === 'managed' && provider.available)) order.push('provider'); });
    expect((await client.call('accounts.list', {})).some(account => account.providerId === 'managed')).toBe(false);
    await client.call('providers.install', { providerId: 'managed' });
    await waitFor(() => seen.some(state => state.state === 'installed' || state.state === 'failed'));
    expect(seen.at(-1)?.state).toBe('installed');
    await waitFor(() => order.includes('provider'));
    expect(order[0]).toBe('account');
    expect((await client.call('accounts.list', {})).filter(account => account.providerId === 'managed').length).toBe(1);
    expect(new Uint8Array(await Bun.file(agentDir('current', EXE_PATH)).arrayBuffer())).toEqual(EXE);
    expect((await client.call('providers.list', {})).loaded.find(provider => provider.id === 'managed')?.available).toBe(true);
    await client.call('providers.uninstall', { providerId: 'managed' });
    expect(existsSync(agentDir('current', EXE_PATH))).toBe(false);
  });

  test('a corrupt completion record stays visible as a failed install', async () => {
    await loadDescriptor(goodInstall());
    mkdirSync(agentDir('current'), { recursive: true });
    writeFileSync(agentDir('current', '.install-complete.json'), '{');
    const client = await harness.connect();
    const provider = (await client.call('providers.list', {})).loaded.find((entry) => entry.id === 'managed');
    expect(provider?.install?.state).toBe('failed');
    if (provider?.install?.state === 'failed') expect(provider.install.message).toContain('.install-complete.json');
  });
  test('a release is downloaded, checked, unpacked and pointed at by {agentsDir}', async () => {
    await loadDescriptor(goodInstall());
    const client = await harness.connect();

    const before = await client.call('providers.list', {});
    const absent = before.loaded.find((provider) => provider.id === 'managed');
    expect(absent?.available).toBe(false);
    expect(absent?.install).toEqual({
      state: 'absent',
      version: '1.0.0',
      archiveBytes: RELEASE.byteLength,
    });

    const seen: ProviderInstallState[] = [];
    client.on('providers.installProgress', (event) => {
      expect(event.providerId).toBe('managed');
      seen.push(event);
    });

    const started = await client.call('providers.install', { providerId: 'managed' });
    expect(started.state).toBe('downloading');
    await waitFor(() => seen.some((state) => state.state === 'installed'));

    expect(seen.map((state) => state.state)).toContain('downloading');
    expect(seen.map((state) => state.state)).toContain('verifying');
    expect(seen.map((state) => state.state)).toContain('extracting');

    const exe = agentDir('current', 'bin', 'agent.exe');
    expect(statSync(exe).size).toBe(EXE.byteLength);
    expect(statSync(agentDir('current', 'share', 'note.txt')).size).toBe(NOTE.byteLength);
    expect(existsSync(agentDir('current', '.install-complete.json'))).toBe(true);
    expect(existsSync(agentDir('downloads', '1.0.0.zip.part'))).toBe(false);

    const after = await client.call('providers.list', {});
    const installed = after.loaded.find((provider) => provider.id === 'managed');
    expect(installed?.available).toBe(true);
    expect(installed?.executable).toBe(exe);
    expect(installed?.install?.state).toBe('installed');
  });

  test('an installed release names the version on offer, and an update replaces the old one', async () => {
    await loadDescriptor(goodInstall());
    const client = await harness.connect();

    const states: ProviderInstallState[] = [];
    client.on('providers.installProgress', (event) => states.push(event));
    await client.call('providers.install', { providerId: 'managed' });
    await waitFor(() => states.some((state) => state.state === 'installed'));

    // Up to date: the version on disk and the one the descriptor offers are one.
    const first = await client.call('providers.list', {});
    expect(first.loaded.find((provider) => provider.id === 'managed')?.install).toEqual({
      state: 'installed',
      version: '1.0.0',
      installedAt: expect.any(Number),
      available: '1.0.0',
    });

    // The descriptor moves on: the provider stays installed and usable, and says
    // which release is waiting rather than reading as absent.
    await loadDescriptor(nextInstall());
    const waiting = await client.call('providers.list', {});
    const behind = waiting.loaded.find((provider) => provider.id === 'managed');
    expect(behind?.available).toBe(true);
    expect(behind?.install).toEqual({
      state: 'installed',
      version: '1.0.0',
      installedAt: expect.any(Number),
      available: '1.1.0',
    });

    states.length = 0;
    await client.call('providers.install', { providerId: 'managed' });
    await waitFor(() => states.some((state) => state.state === 'installed'));

    // Nothing ran out of the old release, so it is gone.
    expect(existsSync(agentDir('releases', '1.0.0'))).toBe(false);
    expect(existsSync(agentDir('releases', '1.1.0'))).toBe(true);
    expect(statSync(agentDir('current', 'bin', 'agent.exe')).size).toBe(EXE_V2.byteLength);

    const after = await client.call('providers.list', {});
    expect(after.loaded.find((provider) => provider.id === 'managed')?.install).toEqual({
      state: 'installed',
      version: '1.1.0',
      installedAt: expect.any(Number),
      available: '1.1.0',
    });
  });

  test('an old release a process still runs out of stays until that process ends', async () => {
    await loadDescriptor(goodInstall());
    const client = await harness.connect();
    const states: ProviderInstallState[] = [];
    client.on('providers.installProgress', (event) => states.push(event));
    await client.call('providers.install', { providerId: 'managed' });
    await waitFor(() => states.some((state) => state.state === 'installed'));

    const installs = harness.core.providers.installs;
    installs.acquire('managed');
    await loadDescriptor(nextInstall());
    states.length = 0;
    await client.call('providers.install', { providerId: 'managed' });
    await waitFor(() => states.some((state) => state.state === 'installed'));
    expect(existsSync(agentDir('releases', '1.0.0'))).toBe(true);

    installs.release('managed');
    await waitFor(() => !existsSync(agentDir('releases', '1.0.0')));
    expect(statSync(agentDir('current', 'bin', 'agent.exe')).size).toBe(EXE_V2.byteLength);
  });

  test('a core that starts removes releases and downloads nothing points at any more', async () => {
    await loadDescriptor(goodInstall());
    const client = await harness.connect();
    const states: ProviderInstallState[] = [];
    client.on('providers.installProgress', (event) => states.push(event));
    await client.call('providers.install', { providerId: 'managed' });
    await waitFor(() => states.some((state) => state.state === 'installed'));
    mkdirSync(agentDir('releases', '0.9.0'), { recursive: true });
    writeFileSync(agentDir('releases', '0.9.0', 'left.txt'), 'an older release');
    mkdirSync(agentDir('downloads'), { recursive: true });
    writeFileSync(agentDir('downloads', '0.9.0.zip.part'), 'old');
    writeFileSync(agentDir('downloads', '1.0.0.zip.part'), 'resumable');

    const second = new Core({ dataDir: harness.dataDir, token: newToken() });
    try {
      expect(existsSync(agentDir('releases', '0.9.0'))).toBe(false);
      expect(existsSync(agentDir('downloads', '0.9.0.zip.part'))).toBe(false);
      expect(existsSync(agentDir('downloads', '1.0.0.zip.part'))).toBe(true);
      expect(existsSync(agentDir('current', 'bin', 'agent.exe'))).toBe(true);
    } finally {
      await second.close();
    }
  });

  test('a version that is not one plain path segment is refused by field, and never reaches a delete', async () => {
    const dir = join(harness.dataDir, 'providers');
    mkdirSync(dir, { recursive: true });
    const victim = join(harness.dataDir, 'victim');
    mkdirSync(victim, { recursive: true });
    for (const version of ['../../../victim', '..', '.', 'a/b', 'C:x']) {
      writeFileSync(join(dir, 'managed.json'), JSON.stringify(descriptor({ ...goodInstall(), url: url('/missing.zip'), version })), 'utf8');
      const client = await harness.connect();
      const { rejected } = await client.call('providers.reload', {});
      expect(rejected.map((entry) => entry.field)).toEqual(['profiles.windows.install.version']);
    }
    const installs = harness.core.providers.installs;
    for (const version of ['..', '.', '../victim', 'a/b']) {
      expect(() => installs.releaseDir('managed', version)).toThrow('not a plain directory name');
      expect(() => installs.partFile('managed', `../${version}`)).toThrow('not a plain directory name');
    }
    expect(existsSync(victim)).toBe(true);
  });

  test('installing the version already on disk is refused as up to date', async () => {
    await loadDescriptor(goodInstall());
    const client = await harness.connect();

    const states: ProviderInstallState[] = [];
    client.on('providers.installProgress', (event) => states.push(event));
    await client.call('providers.install', { providerId: 'managed' });
    await waitFor(() => states.some((state) => state.state === 'installed'));

    let refusal = '';
    try {
      await client.call('providers.install', { providerId: 'managed' });
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    expect(refusal).toContain('up to date');
    expect(refusal).toContain('1.0.0');
  });

  test('a digest that does not match is refused with both hashes and leaves nothing behind', async () => {
    await loadDescriptor({ ...goodInstall(), url: url('/tampered.zip') });
    const client = await harness.connect();

    const states: ProviderInstallState[] = [];
    client.on('providers.installProgress', (event) => states.push(event));
    await client.call('providers.install', { providerId: 'managed' });
    await waitFor(() => states.some((state) => state.state === 'failed'));

    const failed = states.find((state) => state.state === 'failed');
    if (failed?.state !== 'failed') throw new Error('no failure was reported');
    expect(failed.message).toContain(sha256(RELEASE));
    expect(failed.message).toContain(sha256(tampered()));
    expect(existsSync(agentDir('current'))).toBe(false);
    expect(existsSync(agentDir('releases', '1.0.0'))).toBe(false);
    expect(existsSync(agentDir('downloads', '1.0.0.zip.part'))).toBe(false);

    const { loaded } = await client.call('providers.list', {});
    expect(loaded.find((provider) => provider.id === 'managed')?.install?.state).toBe('failed');
  });

  test('an archive of the wrong length is refused before it is even hashed', async () => {
    await loadDescriptor({ ...goodInstall(), url: url('/short.zip') });
    const client = await harness.connect();

    const states: ProviderInstallState[] = [];
    client.on('providers.installProgress', (event) => states.push(event));
    await client.call('providers.install', { providerId: 'managed' });
    await waitFor(() => states.some((state) => state.state === 'failed'));

    const failed = states.find((state) => state.state === 'failed');
    if (failed?.state !== 'failed') throw new Error('no failure was reported');
    expect(failed.message).toContain(String(RELEASE.byteLength));
    expect(failed.message).toContain(String(RELEASE.byteLength - 2));
    expect(existsSync(agentDir('current'))).toBe(false);
  });

  test('an archive entry that climbs out of the release directory is refused', async () => {
    await loadDescriptor({
      ...goodInstall(),
      url: url('/escaping.zip'),
      sha256: sha256(ESCAPING),
      archiveBytes: ESCAPING.byteLength,
    });
    const client = await harness.connect();

    const states: ProviderInstallState[] = [];
    client.on('providers.installProgress', (event) => states.push(event));
    await client.call('providers.install', { providerId: 'managed' });
    await waitFor(() => states.some((state) => state.state === 'failed'));

    const failed = states.find((state) => state.state === 'failed');
    if (failed?.state !== 'failed') throw new Error('no failure was reported');
    expect(failed.message).toContain('evil.txt');
    expect(existsSync(join(harness.dataDir, 'agents', 'managed', 'releases', 'evil.txt'))).toBe(false);
    expect(existsSync(agentDir('current'))).toBe(false);
  });

  test('a cancelled download leaves the provider absent and no partial file', async () => {
    await loadDescriptor({ ...goodInstall(), url: url('/slow.zip') });
    const client = await harness.connect();

    const states: ProviderInstallState[] = [];
    client.on('providers.installProgress', (event) => states.push(event));
    const started = await client.call('providers.install', { providerId: 'managed' });
    if (started.state !== 'downloading') throw new Error('the install did not start downloading');

    await waitFor(() => existsSync(agentDir('downloads', '1.0.0.zip.part')));
    await client.call('providers.installCancel', {
      providerId: 'managed',
      operationId: started.operationId,
    });
    await waitFor(() => states.some((state) => state.state === 'absent'));

    expect(existsSync(agentDir('downloads', '1.0.0.zip.part'))).toBe(false);
    const { loaded } = await client.call('providers.list', {});
    expect(loaded.find((provider) => provider.id === 'managed')?.install?.state).toBe('absent');
  });

  test('a second install while one runs is refused, and so is a cancel of another operation', async () => {
    await loadDescriptor({ ...goodInstall(), url: url('/slow.zip') });
    const client = await harness.connect();

    const started = await client.call('providers.install', { providerId: 'managed' });
    if (started.state !== 'downloading') throw new Error('the install did not start downloading');

    let refusal = '';
    try {
      await client.call('providers.install', { providerId: 'managed' });
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    expect(refusal).toContain('already running');

    let wrongOperation = '';
    try {
      await client.call('providers.installCancel', { providerId: 'managed', operationId: 'inst_nope' });
    } catch (error) {
      wrongOperation = error instanceof Error ? error.message : String(error);
    }
    expect(wrongOperation).toContain('not the one running');

    await client.call('providers.installCancel', {
      providerId: 'managed',
      operationId: started.operationId,
    });
  });

  test('uninstall is refused while a lease is held and removes everything once it is released', async () => {
    await loadDescriptor(goodInstall());
    const client = await harness.connect();

    const states: ProviderInstallState[] = [];
    client.on('providers.installProgress', (event) => states.push(event));
    await client.call('providers.install', { providerId: 'managed' });
    await waitFor(() => states.some((state) => state.state === 'installed'));

    const installs = harness.core.providers.installs;
    installs.acquire('managed');
    let refusal = '';
    try {
      await client.call('providers.uninstall', { providerId: 'managed' });
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    expect(refusal).toContain('1 process');
    expect(existsSync(agentDir('current'))).toBe(true);

    installs.release('managed');
    const removed = await client.call('providers.uninstall', { providerId: 'managed' });
    expect(removed.state).toBe('absent');
    expect(existsSync(agentDir())).toBe(false);

    const { loaded } = await client.call('providers.list', {});
    const managed = loaded.find((provider) => provider.id === 'managed');
    expect(managed?.available).toBe(false);
    expect(managed?.install?.state).toBe('absent');
  });

  test('a process a thread launches holds the lease for its whole life', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    const installs = harness.core.providers.installs;
    expect(installs.leaseCount('echo')).toBe(0);

    await client.call('threads.subscribe', { threadId });
    // Stay alive long enough to observe the lease on both hosts. `ver` was a
    // Windows-only command and could exit before the first polling sample.
    const command = `${process.platform === 'win32' ? '' : 'exec '}bun -e "setTimeout(()=>{},250)"`;
    await client.call('turns.start', { threadId, prompt: `go [spawn:${command}]` });
    await waitFor(() => installs.leaseCount('echo') > 0, 10_000);
    await waitFor(() => installs.leaseCount('echo') === 0, 10_000);
  });

  test('a core starting on the same data directory reads the install back off disk', async () => {
    await loadDescriptor(goodInstall());
    const client = await harness.connect();

    const states: ProviderInstallState[] = [];
    client.on('providers.installProgress', (event) => states.push(event));
    await client.call('providers.install', { providerId: 'managed' });
    await waitFor(() => states.some((state) => state.state === 'installed'));

    const second = new Core({ dataDir: harness.dataDir, token: newToken() });
    try {
      const managed = second.providers.list().loaded.find((provider) => provider.id === 'managed');
      expect(managed?.install?.state).toBe('installed');
      expect(managed?.available).toBe(true);
      expect(managed?.executable).toBe(agentDir('current', 'bin', 'agent.exe'));
    } finally {
      await second.close();
    }
  });
});

describe('managed updates', () => {
  /** 1.0.0 on disk, 1.1.0 on offer from `path`, and the update list read once. */
  async function behind(path: string): Promise<{ client: Awaited<ReturnType<TestCore['connect']>>; states: ProviderInstallState[]; updates: HarnessUpdate[][] }> {
    await loadDescriptor(goodInstall());
    const client = await harness.connect();
    const states: ProviderInstallState[] = [];
    client.on('providers.installProgress', (event) => states.push(event));
    await client.call('providers.install', { providerId: 'managed' });
    await waitFor(() => states.some((state) => state.state === 'installed'));
    await loadDescriptor({ ...nextInstall(), url: url(path) });
    harness.core.updates.only = new Set(['managed']);
    const updates: HarnessUpdate[][] = [];
    client.on('providers.updatesChanged', (list) => updates.push(list));
    const [entry] = await client.call('providers.updates', { refresh: true });
    expect(entry).toMatchObject({ providerId: 'managed', route: 'managed', current: '1.0.0', latest: '1.1.0', pending: true });
    states.length = 0;
    return { client, states, updates };
  }

  test('an update joins the download the install card started and waits for it to land', async () => {
    const { client, updates } = await behind('/slow-2.zip');
    await client.call('providers.install', { providerId: 'managed' });
    const started = await client.call('providers.update', { providerId: 'managed' });
    expect(started.state).toBe('updating');
    await waitFor(() => updates.at(-1)?.[0]?.state === 'idle' && updates.at(-1)?.[0]?.current === '1.1.0');
    expect(updates.at(-1)?.[0]?.pending).toBe(false);
  });

  test('a download cancelled under an update reads as failed, not as current', async () => {
    const { client, states, updates } = await behind('/slow-2.zip');
    await client.call('providers.update', { providerId: 'managed' });
    await waitFor(() => states.some((state) => state.state === 'downloading'));
    const downloading = states.find((state) => state.state === 'downloading');
    if (downloading?.state !== 'downloading') throw new Error('the update did not start downloading');
    await client.call('providers.installCancel', { providerId: 'managed', operationId: downloading.operationId });
    await waitFor(() => updates.at(-1)?.[0]?.state === 'failed');
    expect(updates.at(-1)?.[0]).toMatchObject({ current: '1.0.0', message: 'the download was cancelled', pending: true });
  });

  test('a restart on a build that pins a newer release offers it at once, and forgets a row whose agent is gone', async () => {
    await loadDescriptor(goodInstall());
    const client = await harness.connect();
    const states: ProviderInstallState[] = [];
    client.on('providers.installProgress', (event) => states.push(event));
    await client.call('providers.install', { providerId: 'managed' });
    await waitFor(() => states.some((state) => state.state === 'installed'));
    harness.core.updates.only = new Set(['managed']);
    const [current] = await client.call('providers.updates', { refresh: true });
    expect(current).toMatchObject({ providerId: 'managed', route: 'managed', current: '1.0.0', latest: '1.0.0', pending: false });

    // What the last run kept, plus a row for an agent this machine no longer has.
    const file = join(harness.dataDir, 'harness-versions.json');
    const kept = JSON.parse(readFileSync(file, 'utf8')) as { checkedAt: number; readings: Record<string, unknown> };
    kept.readings['claude'] = { route: 'self', current: '1.0.0', latest: '2.0.0', state: 'idle', message: null, checkedAt: kept.checkedAt };
    writeFileSync(file, JSON.stringify(kept));
    // The next build pins 1.1.0.
    writeFileSync(join(harness.dataDir, 'providers', 'managed.json'), JSON.stringify(descriptor(nextInstall()), null, 2), 'utf8');

    const second = new Core({ dataDir: harness.dataDir, token: newToken() });
    try {
      expect((await second.updates.list()).map((update) => [update.providerId, update.latest])).toEqual([['claude', '2.0.0'], ['managed', '1.0.0']]);
      second.updates.start();
      const [entry, ...rest] = await second.updates.list();
      expect(rest).toEqual([]);
      expect(entry).toMatchObject({ providerId: 'managed', route: 'managed', current: '1.0.0', latest: '1.1.0', pending: true, state: 'idle' });
      // Read off disk, not by running anything, and the scheduled check still waits out its six hours.
      expect(second.procs.liveCount('update:managed')).toBe(0);
      expect(second.updates.firstDelay()).toBeGreaterThan(5 * 60 * 60 * 1000);
      expect(JSON.parse(readFileSync(file, 'utf8')).readings).not.toHaveProperty('claude');
    } finally {
      await second.close();
    }
  });

  test('a release the install card lands clears its pending update without another check', async () => {
    const { client, states, updates } = await behind('/release-2.zip');
    await client.call('providers.install', { providerId: 'managed' });
    await waitFor(() => states.some((state) => state.state === 'installed'));
    await waitFor(() => updates.at(-1)?.[0]?.current === '1.1.0');
    const [entry] = await client.call('providers.updates', {});
    expect(entry).toMatchObject({ current: '1.1.0', latest: '1.1.0', pending: false, state: 'idle' });
  });
});

describe('managed installs on a bad connection', () => {
  /** Installs from `path` and waits for the run to settle, installed or failed. */
  async function installFrom(path: string): Promise<ProviderInstallState[]> {
    await loadDescriptor(bigInstall(path));
    const client = await harness.connect();
    const states: ProviderInstallState[] = [];
    client.on('providers.installProgress', (event) => states.push(event));
    await client.call('providers.install', { providerId: 'managed' });
    await waitFor(() => states.some((state) => state.state === 'installed' || state.state === 'failed'), 10_000);
    return states;
  }

  function quick(): void {
    const installs = harness.core.providers.installs;
    installs.retryDelaysMs = [0, 0];
    installs.idleTimeoutMs = 300;
  }

  test('a dropped connection resumes from the byte it reached, and the release lands whole', async () => {
    quick();
    const states = await installFrom('/drop.zip');
    expect(states.at(-1)?.state).toBe('installed');
    expect(requests).toEqual([null, `bytes=${HALF}-`]);
    expect(ifRanges[1]).toBe(ETAG);
    expect(new Uint8Array(await Bun.file(agentDir('current', EXE_PATH)).arrayBuffer())).toEqual(BIG_EXE);
    expect(existsSync(agentDir('downloads', '1.0.0.zip.part'))).toBe(false);
    expect(existsSync(agentDir('downloads', '1.0.0.zip.part.json'))).toBe(false);
  });

  test('a server that ignores the range sends the whole file again, and it is taken from the start', async () => {
    quick();
    flaky = 'whole';
    const states = await installFrom('/drop.zip');
    expect(states.at(-1)?.state).toBe('installed');
    expect(requests.length).toBe(2);
    expect(new Uint8Array(await Bun.file(agentDir('current', EXE_PATH)).arrayBuffer())).toEqual(BIG_EXE);
  });

  test('a download that goes silent is dropped after the idle timeout and resumed', async () => {
    quick();
    const states = await installFrom('/stall.zip');
    expect(states.at(-1)?.state).toBe('installed');
    expect(requests).toEqual([null, `bytes=${HALF}-`]);
  });

  test('once the retries run out the bytes stay, and the next install resumes from them', async () => {
    quick();
    flaky = 'down';
    const states = await installFrom('/drop.zip');
    const failed = states.at(-1);
    if (failed?.state !== 'failed') throw new Error(`expected a failure, saw ${failed?.state}`);
    expect(failed.message).toContain('install again to resume');
    expect(failed.message).not.toContain('verbose');
    expect(statSync(agentDir('downloads', '1.0.0.zip.part')).size).toBe(HALF);
    expect(requests.length).toBe(3);

    flaky = 'resume';
    requests = [];
    const client = await harness.connect();
    const again: ProviderInstallState[] = [];
    client.on('providers.installProgress', (event) => again.push(event));
    await client.call('providers.install', { providerId: 'managed' });
    await waitFor(() => again.some((state) => state.state === 'installed' || state.state === 'failed'), 10_000);
    expect(again.at(-1)?.state).toBe('installed');
    // The flaky route counts its first request as the one that drops: this one
    // is the second, and it asked only for the missing half.
    expect(requests).toEqual([`bytes=${HALF}-`]);
  });

  test('a body longer than the descriptor says is refused as soon as it overflows', async () => {
    quick();
    const states = await installFrom('/oversize.zip');
    const failed = states.at(-1);
    if (failed?.state !== 'failed') throw new Error(`expected a failure, saw ${failed?.state}`);
    expect(failed.message).toContain('sent more than');
    expect(existsSync(agentDir('downloads', '1.0.0.zip.part'))).toBe(false);
  });
});
