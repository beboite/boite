import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { zipSync } from 'fflate';
import type { ProviderInstallState } from '@boite/contracts';
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
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/release.zip') return new Response(RELEASE);
      if (path === '/agent.exe') return new Response(EXE);
      if (path === '/release-2.zip') return new Response(RELEASE_V2);
      if (path === '/escaping.zip') return new Response(ESCAPING);
      if (path === '/tampered.zip') return new Response(tampered());
      // Two bytes short of what the descriptor promises.
      if (path === '/short.zip') return new Response(RELEASE.slice(0, RELEASE.byteLength - 2));
      if (path === '/slow.zip') {
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            await Bun.sleep(SLOW_CHUNK_MS);
            controller.enqueue(new Uint8Array(1024));
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
    await client.call('providers.install', { providerId: 'managed' });
    await waitFor(() => seen.some(state => state.state === 'installed' || state.state === 'failed'));
    expect(seen.at(-1)?.state).toBe('installed');
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

  test('an installed release names the version on offer, and an update lands beside the old one', async () => {
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

    // The new release sits beside the old directory, which nothing deleted: a
    // process of it may still be alive.
    expect(existsSync(agentDir('releases', '1.0.0'))).toBe(true);
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
