import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LocalDouaneStatus, SubscriptionProxy } from '@boite/contracts';
import { checkSettingsPatch } from '@boite/contracts';
import { connect, type CoreClient } from '../src/client.ts';
import { DOUANE_BINARY_ENV, douanePlatform } from '../src/douane-local.ts';
import { readSubscriptionProxyModels, subscriptionProxyEnv } from '../src/subscription-proxy.ts';
import { startTestCore, type TestCore } from './harness.ts';

const FAKE = join(import.meta.dir, 'fixtures', 'fake-douane.ts');
const ENV = [DOUANE_BINARY_ENV, 'FAKE_DOUANE_VERSION', 'FAKE_DOUANE_CRASH_FILE', 'FAKE_DOUANE_IN_FLIGHT_FILE'] as const;
const LOCAL: SubscriptionProxy = { enabled: true, kind: 'douane', mode: 'local', baseUrl: 'http://gateway.invalid', dashboardUrl: 'http://gateway.invalid/' };

let harness: TestCore | undefined;
let held: { stop(force?: boolean): void }[] = [];
let releases: ReturnType<typeof Bun.serve> | undefined;
beforeEach(() => { process.env[DOUANE_BINARY_ENV] = FAKE; });
afterEach(async () => {
  for (const socket of held) socket.stop(true);
  held = [];
  releases?.stop(true);
  releases = undefined;
  await harness?.stop();
  harness = undefined;
  for (const name of ENV) delete process.env[name];
});

function freePort(): number {
  const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = probe.port;
  probe.stop(true);
  return port;
}

async function until<T>(read: () => T | Promise<T>, ok: (value: T) => boolean, what: string, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  let last = await read();
  while (!ok(last)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; last ${JSON.stringify(last)}`);
    await Bun.sleep(25);
    last = await read();
  }
  return last;
}

/** A core whose Douane will listen on a port of its own, never a real 8787. */
async function core(): Promise<{ owner: CoreClient; port: number }> {
  harness = await startTestCore();
  const port = freePort();
  harness.core.journal.setSetting('douane-local-port', port);
  return { owner: await harness.connect(), port };
}

const live = () => harness!.core.procs.liveCount('system:douane');
const running = (owner: CoreClient) => until(() => owner.call('douane.status', {}), (status) => status.state === 'running', 'Douane running');

test('local mode installs nothing in development, starts Douane on loopback and points the proxy at it', async () => {
  const { owner, port } = await core();
  const seen: LocalDouaneStatus['state'][] = [];
  owner.on('douane.updated', (status) => { seen.push(status.state); });
  expect((await owner.call('douane.status', {})).state).toBe('off');

  const saved = await owner.call('subscriptionProxy.configure', { subscriptionProxy: LOCAL });
  // Whatever the client sent, the stored URLs are this core's.
  expect(saved.subscriptionProxy).toEqual({ enabled: true, kind: 'douane', mode: 'local', baseUrl: `http://127.0.0.1:${port}/v1`, dashboardUrl: `http://127.0.0.1:${port}/admin/` });
  const status = await running(owner);
  expect(status).toMatchObject({ state: 'running', version: '0.3.0', port, development: true });
  expect(seen).toContain('starting');
  expect(live()).toBe(1);

  const dir = join(harness!.dataDir, 'douane');
  expect(readFileSync(join(dir, 'douane.toml'), 'utf8')).toContain(`listen = "127.0.0.1:${port}"`);
  expect(existsSync(join(dir, 'auth'))).toBe(true);
  const claude = harness!.core.providers.require('claude');
  expect(subscriptionProxyEnv(harness!.core, claude).ANTHROPIC_BASE_URL).toBe(`http://127.0.0.1:${port}`);
  expect((await readSubscriptionProxyModels(harness!.core, claude))?.map((model) => model.id)).toEqual(['claude-sonnet-5']);

  // A paired phone reads the state and changes nothing.
  const { grant } = await owner.call('pairing.grant', {});
  const phone = await connect(harness!.url, '', { grant, client: { name: 'pwa', version: 'test' } });
  try {
    expect((await phone.call('douane.status', {})).state).toBe('running');
    await expect(phone.call('douane.stop', {})).rejects.toThrow();
    await expect(phone.call('douane.update', {})).rejects.toThrow();
  } finally { phone.close(); }
  expect(live()).toBe(1);
}, 30_000);

test('a crash restarts Douane after a delay; Stop holds it, Start resumes it, remote mode stops it and keeps its data', async () => {
  const { owner } = await core();
  harness!.core.douane.restartDelaysMs = [50];
  const crash = join(harness!.dataDir, 'crash-once');
  writeFileSync(crash, '');
  process.env.FAKE_DOUANE_CRASH_FILE = crash;
  const seen: LocalDouaneStatus[] = [];
  owner.on('douane.updated', (status) => { seen.push(status); });

  await owner.call('subscriptionProxy.configure', { subscriptionProxy: LOCAL });
  await until(() => seen, (list) => list.some((status) => status.state === 'failed' && status.restartAt !== undefined), 'the crash and its restart time');
  expect(existsSync(crash)).toBe(false);
  await running(owner);
  expect(seen.find((status) => status.state === 'failed')?.message).toMatch(/exited with code 3/);
  expect(live()).toBe(1);

  expect((await owner.call('douane.stop', {})).state).toBe('stopped');
  expect(live()).toBe(0);
  await Bun.sleep(150);
  expect((await owner.call('douane.status', {})).state).toBe('stopped');
  expect(existsSync(join(harness!.dataDir, 'douane', 'auth'))).toBe(true);

  expect((await owner.call('douane.start', {})).state).toBe('running');
  expect(live()).toBe(1);

  const remote: SubscriptionProxy = { enabled: true, kind: 'douane', mode: 'remote', baseUrl: 'http://gateway.lan:8787', dashboardUrl: 'http://gateway.lan:8787/admin/' };
  expect((await owner.call('subscriptionProxy.configure', { subscriptionProxy: remote })).subscriptionProxy).toEqual(remote);
  await until(() => owner.call('douane.status', {}), (status) => status.state === 'off', 'Douane off');
  expect(live()).toBe(0);
  expect(existsSync(join(harness!.dataDir, 'douane', 'auth'))).toBe(true);
  expect(existsSync(join(harness!.dataDir, 'douane', 'douane.toml'))).toBe(true);
  await expect(owner.call('douane.start', {})).rejects.toThrow('local mode');
}, 30_000);

test('the remembered port is reused, and a taken one moves Douane and the proxy to another', async () => {
  const { owner, port } = await core();
  await owner.call('subscriptionProxy.configure', { subscriptionProxy: LOCAL });
  await running(owner);
  await owner.call('douane.stop', {});

  // Something else took the port while Douane was stopped.
  held.push(Bun.listen({ hostname: '127.0.0.1', port, socket: { data() {} } }));
  const moved = await owner.call('douane.start', {});
  expect(moved.state).toBe('running');
  expect(moved.port).not.toBe(port);
  expect(harness!.core.journal.getSetting('douane-local-port')).toBe(moved.port);
  expect((await owner.call('settings.get', {})).subscriptionProxy?.baseUrl).toBe(`http://127.0.0.1:${moved.port}/v1`);
  expect(readFileSync(join(harness!.dataDir, 'douane', 'douane.toml'), 'utf8')).toContain(`listen = "127.0.0.1:${moved.port}"`);

  // Freed again, the old port is not taken back: the remembered one stays.
  for (const socket of held) socket.stop(true);
  held = [];
  await owner.call('douane.stop', {});
  expect((await owner.call('douane.start', {})).port).toBe(moved.port);
}, 30_000);

test('proxy settings saved before the local mode still read as a remote gateway', async () => {
  const old = { enabled: true, kind: 'douane' as const, baseUrl: 'http://gateway.lan:8787', dashboardUrl: 'http://gateway.lan:8787/admin/#quotas' };
  harness = await startTestCore({ settings: { subscriptionProxy: old } });
  const owner = await harness.connect();
  expect((await owner.call('settings.get', {})).subscriptionProxy).toEqual(old);
  expect(await owner.call('douane.status', {})).toMatchObject({ state: 'off' });
  expect(live()).toBe(0);
  expect(checkSettingsPatch({ subscriptionProxy: old })).toEqual({ ok: true, patch: { subscriptionProxy: old } });
  expect(checkSettingsPatch({ subscriptionProxy: { ...old, kind: 'cliproxyapi', mode: 'local' } }).ok).toBe(false);
  expect(checkSettingsPatch({ subscriptionProxy: { ...old, mode: 'cloud' as never } }).ok).toBe(false);
});

test('an unpublished release reads as not available yet, and nothing crashes', async () => {
  delete process.env[DOUANE_BINARY_ENV];
  const { owner } = await core();
  const asked: string[] = [];
  harness!.core.douane.readRelease = async (url) => { asked.push(url); throw new Error(`${url} answered 404`); };
  await owner.call('subscriptionProxy.configure', { subscriptionProxy: LOCAL });
  const status = await until(() => owner.call('douane.status', {}), (value) => value.state === 'unavailable', 'the unavailable state');
  expect(status.message).toMatch(/no release for this machine .* yet/);
  expect(status.version).toBeNull();
  expect(asked[0]).toBe('https://github.com/beboite/douane/releases/latest/download/VERSION');
  expect((await owner.call('douane.start', {})).state).toBe('unavailable');
  await expect(owner.call('douane.update', {})).rejects.toThrow('no release');
  expect(live()).toBe(0);
}, 30_000);

// The installed program has to be an executable; a shell script stands for it where one runs.
test.skipIf(process.platform === 'win32')('installs the published release, and swaps a newer one in once no request is in flight', async () => {
  delete process.env[DOUANE_BINARY_ENV];
  const target = douanePlatform()!;
  const { owner } = await core();
  const inFlight = join(harness!.dataDir, 'in-flight');
  writeFileSync(inFlight, '0');
  process.env.FAKE_DOUANE_IN_FLIGHT_FILE = inFlight;
  const program = (version: string) => `#!/bin/sh\nFAKE_DOUANE_VERSION=${version} exec "${process.execPath}" "${FAKE}" "$@"\n`;
  releases = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const match = /^\/download\/v([^/]+)\/(.+)$/.exec(new URL(request.url).pathname);
    return match && match[2] === target.binary ? new Response(program(match[1]!)) : new Response('missing', { status: 404 });
  } });
  let newest = '0.3.0';
  const douane = harness!.core.douane;
  douane.releases = `http://127.0.0.1:${releases.port}`;
  douane.idlePollMs = 25;
  douane.readRelease = async (url) => {
    if (url.endsWith('/VERSION')) return `${newest}\n`;
    const bytes = Buffer.from(program(newest));
    return JSON.stringify({ version: newest, platforms: { [target.key]: { binary: target.binary, checksum: createHash('sha256').update(bytes).digest('hex'), size: bytes.byteLength } } });
  };

  await owner.call('subscriptionProxy.configure', { subscriptionProxy: LOCAL });
  expect(await running(owner)).toMatchObject({ version: '0.3.0', available: null });
  const releasesDir = join(harness!.dataDir, 'douane', 'program', 'releases');
  expect(readdirSync(releasesDir)).toEqual(['0.3.0']);

  newest = '0.4.0';
  expect((await owner.call('douane.check', {})).available).toBe('0.4.0');
  writeFileSync(inFlight, '1');
  const answer = await owner.call('core.updateEverything', { agents: [], server: null, douane: true });
  expect(answer.douaneError).toBeNull();
  await until(() => owner.call('douane.status', {}), (status) => status.state === 'updating', 'the update waiting for requests');
  // Both releases sit on disk while the old one still serves.
  await until(() => readdirSync(releasesDir).sort(), (names) => names.length === 2, 'the new release beside the old');
  expect((await owner.call('douane.status', {})).version).toBe('0.3.0');

  writeFileSync(inFlight, '0');
  expect(await until(() => owner.call('douane.status', {}), (status) => status.state === 'running' && status.version === '0.4.0', 'the new release running'))
    .toMatchObject({ available: null });
  await until(() => readdirSync(releasesDir), (names) => names.length === 1 && names[0] === '0.4.0', 'the old release pruned');
  expect(live()).toBe(1);
}, 30_000);
