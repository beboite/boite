import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { checkSettingsPatch, type PluginState, type SubscriptionProxy } from '@boite/contracts';
import type { CoreClient } from '../src/client.ts';
import { parseManifest, platformKey } from '../src/plugins/manifest.ts';
import { DOUANE_BINARY_ENV } from '../src/plugins/gateway.ts';
import { recommendedPlugins } from '../src/plugins.ts';
import { readSubscriptionProxyModels, subscriptionProxyEnv } from '../src/subscription-proxy.ts';
import { startTestCore, type TestCore } from './harness.ts';
import { thrown } from './settle.ts';

const FAKE = join(import.meta.dir, 'fixtures', 'fake-douane.ts');
const ENV = [DOUANE_BINARY_ENV, 'FAKE_DOUANE_VERSION', 'FAKE_DOUANE_CRASH_FILE', 'FAKE_DOUANE_IN_FLIGHT_FILE', 'FAKE_DOUANE_RUNS_FILE', 'BOITE_TOKEN'] as const;
const LOCAL: SubscriptionProxy = { enabled: true, kind: 'douane', mode: 'local', baseUrl: 'http://gateway.invalid', dashboardUrl: 'http://gateway.invalid/' };
const ARTIFACT = 'https://plugins.example.invalid/douane';
const realFetch = globalThis.fetch;

let harness: TestCore | undefined;
let fetchSpy: { mockRestore(): void } | undefined;
let held: { stop(force?: boolean): void }[] = [];
/** What the artifact URL serves, by version. */
let served = new Map<string, Uint8Array>();
beforeEach(() => { process.env[DOUANE_BINARY_ENV] = FAKE; });
afterEach(async () => {
  for (const socket of held) socket.stop(true);
  held = [];
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
  await harness?.stop();
  harness = undefined;
  served = new Map();
  for (const name of ENV) delete process.env[name];
});

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Douane's reviewed entry, pointed at a download this test serves. */
function douane(version: string, bytes: Uint8Array, executable = 'douane') {
  served.set(version, bytes);
  return parseManifest({
    schema: 1, id: 'douane', name: 'Douane', version,
    description: 'Subscription gateway.', homepage: 'https://github.com/mtsu-dev/douane', executable,
    artifacts: { [platformKey()]: { url: `${ARTIFACT}/${version}`, sha256: sha256(bytes) } },
    provides: { gateway: {} },
  }, 'recommended.json[1]');
}

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

/** A core whose recommended list is Douane alone, on a port of its own, its download served from memory. */
async function core(version = '0.3.0', bytes = new Uint8Array([1, 2, 3])): Promise<{ owner: CoreClient; port: number }> {
  harness = await startTestCore();
  harness.core.plugins.recommended = [douane(version, bytes)];
  harness.core.plugins.updateSources = {};
  harness.core.plugins.gateways.relaunchDelaysMs = [50, 50, 50];
  const port = freePort();
  harness.core.journal.setSetting('gateway-port:douane', port);
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(ARTIFACT)) {
      const bytes = served.get(url.slice(ARTIFACT.length + 1));
      return bytes ? new Response(bytes) : new Response('missing', { status: 404 });
    }
    return realFetch(input, init);
  }) as typeof fetch);
  return { owner: await harness.connect(), port };
}

const state = async (owner: CoreClient): Promise<PluginState> => (await owner.call('plugins.list', {})).find((plugin) => plugin.id === 'douane')!;
const gatewayIs = (owner: CoreClient, status: string, what = `the gateway ${status}`) =>
  until(() => state(owner), (plugin) => plugin.gateway?.status === status, what);
/** On Windows the job reports an exit a moment after it happened: wait for this count, never read it once after a stop. */
const live = () => harness!.core.procs.liveCount('plugin:douane:gateway');

test('the recommended list ships Douane as a gateway plugin with an update source', () => {
  const shipped = recommendedPlugins().find((manifest) => manifest.id === 'douane');
  expect(shipped?.provides).toEqual({ gateway: {} });
  expect(shipped?.homepage).toBe('https://github.com/mtsu-dev/douane');
  expect(() => parseManifest({ ...shipped, provides: { gateway: { port: 8787 } } }, 'boite-plugin.json')).toThrow('provides.gateway.port');
});

test('an installed gateway runs on loopback without the owner token, and the local proxy points at it', async () => {
  process.env.BOITE_TOKEN = 'inherited-owner-token';
  const { owner, port } = await core();
  await owner.call('plugins.install', { id: 'douane' });
  const plugin = await gatewayIs(owner, 'running');
  expect(plugin.gateway).toMatchObject({ enabled: true, port, version: '0.3.0', dataDir: join(harness!.dataDir, 'douane') });
  expect(live()).toBe(1);

  const env = await (await realFetch(`http://127.0.0.1:${port}/debug/env`)).json() as { token: boolean; thread: boolean; cwd: string };
  expect(env).toMatchObject({ token: false, thread: false });
  const data = join(harness!.dataDir, 'douane');
  expect(readFileSync(join(data, 'douane.toml'), 'utf8')).toContain(`listen = "127.0.0.1:${port}"`);
  expect(existsSync(join(data, 'auth'))).toBe(true);

  // Whatever the client sent, the stored URLs are the plugin's.
  const saved = await owner.call('subscriptionProxy.configure', { subscriptionProxy: LOCAL });
  expect(saved.subscriptionProxy).toEqual({ enabled: true, kind: 'douane', mode: 'local', baseUrl: `http://127.0.0.1:${port}/v1`, dashboardUrl: `http://127.0.0.1:${port}/admin/` });
  const claude = harness!.core.providers.require('claude');
  expect(subscriptionProxyEnv(harness!.core, claude).ANTHROPIC_BASE_URL).toBe(`http://127.0.0.1:${port}`);
  expect((await readSubscriptionProxyModels(harness!.core, claude))?.map((model) => model.id)).toEqual(['claude-sonnet-5']);

  // Moving logins from the plugin's row talks to the plugin, whatever the proxy points at.
  await owner.call('subscriptionProxy.configure', { subscriptionProxy: { enabled: true, kind: 'douane', mode: 'remote', baseUrl: 'https://gateway.example.invalid', dashboardUrl: 'https://gateway.example.invalid/admin/' } });
  expect((await owner.call('subscriptionProxy.movePlan', { target: 'plugin' })).origin).toBe(`http://127.0.0.1:${port}`);
  expect((await owner.call('subscriptionProxy.movePlan', {})).origin).toBe('https://gateway.example.invalid');
  await owner.call('plugins.gateway', { id: 'douane', action: 'stop' });
  expect((await owner.call('subscriptionProxy.movePlan', { target: 'plugin' })).origin).toBeNull();
  expect(await thrown(owner.call('subscriptionProxy.move', { ids: ['x'], target: 'plugin' }))).toThrow('start the Douane plugin first');
}, 30_000);

test('a crash starts it again; a core start runs it only while it starts with Boite; uninstall keeps its data', async () => {
  const { owner } = await core();
  const crash = join(harness!.dataDir, 'crash-once');
  writeFileSync(crash, '');
  process.env.FAKE_DOUANE_CRASH_FILE = crash;
  const seen: string[] = [];
  owner.on('plugins.updated', (plugin) => { if (plugin.gateway?.error) seen.push(plugin.gateway.error); });
  await owner.call('plugins.install', { id: 'douane' });
  await until(() => seen, (errors) => errors.some((error) => /exited with code 3.*starting it again/.test(error)), 'the crash and its relaunch');
  expect(existsSync(crash)).toBe(false);
  await gatewayIs(owner, 'running', 'running again');
  expect(live()).toBe(1);

  // Off, the running gateway stays; Stop then holds across a core start.
  const off = await owner.call('plugins.autostart', { id: 'douane', autostart: false });
  expect(off.gateway).toMatchObject({ status: 'running', autostart: false });
  const stopped = await owner.call('plugins.gateway', { id: 'douane', action: 'stop' });
  expect(stopped.gateway).toMatchObject({ status: 'stopped', enabled: false, autostart: false });
  await until(live, (count) => count === 0, 'no gateway process left');
  harness!.core.plugins.startApps();
  await Bun.sleep(200);
  expect((await state(owner)).gateway?.status).toBe('stopped');

  // On, the next core start runs it, the earlier Stop or not.
  expect((await owner.call('plugins.autostart', { id: 'douane', autostart: true })).gateway).toMatchObject({ status: 'stopped', autostart: true });
  harness!.core.plugins.startApps();
  await gatewayIs(owner, 'running', 'started with the core');
  expect((await state(owner)).gateway).toMatchObject({ enabled: false, autostart: true });

  await owner.call('plugins.uninstall', { id: 'douane' });
  await until(live, (count) => count === 0, 'no gateway process left');
  expect(existsSync(join(harness!.dataDir, 'plugins', 'douane'))).toBe(false);
  expect(existsSync(join(harness!.dataDir, 'douane', 'auth'))).toBe(true);
  expect(existsSync(join(harness!.dataDir, 'douane', 'douane.toml'))).toBe(true);
  expect(await state(owner)).toMatchObject({ status: 'not-installed', gateway: { status: 'stopped', pid: null } });
}, 30_000);

test('a taken port moves the gateway and the local proxy with it, and the new port is remembered', async () => {
  const { owner, port } = await core();
  await owner.call('subscriptionProxy.configure', { subscriptionProxy: LOCAL });
  held.push(Bun.listen({ hostname: '127.0.0.1', port, socket: { data() {} } }));
  await owner.call('plugins.install', { id: 'douane' });
  const moved = (await gatewayIs(owner, 'running')).gateway!.port;
  expect(moved).not.toBe(port);
  expect(harness!.core.journal.getSetting('gateway-port:douane')).toBe(moved);
  expect((await owner.call('settings.get', {})).subscriptionProxy?.baseUrl).toBe(`http://127.0.0.1:${moved}/v1`);

  for (const socket of held) socket.stop(true);
  held = [];
  expect((await owner.call('plugins.gateway', { id: 'douane', action: 'restart' })).gateway).toMatchObject({ status: 'running', port: moved });
}, 30_000);

test('proxy settings saved before the local mode still read as a remote gateway', async () => {
  const old = { enabled: true, kind: 'douane' as const, baseUrl: 'http://gateway.lan:8787', dashboardUrl: 'http://gateway.lan:8787/admin/#quotas' };
  harness = await startTestCore({ settings: { subscriptionProxy: old } });
  const owner = await harness.connect();
  expect((await owner.call('settings.get', {})).subscriptionProxy).toEqual(old);
  expect(checkSettingsPatch({ subscriptionProxy: old })).toEqual({ ok: true, patch: { subscriptionProxy: old } });
  expect(checkSettingsPatch({ subscriptionProxy: { ...old, kind: 'cliproxyapi', mode: 'local' } }).ok).toBe(false);
  expect(checkSettingsPatch({ subscriptionProxy: { ...old, mode: 'cloud' as never } }).ok).toBe(false);
});

/** A release whose executable is this shell script; Windows runs no shell script as a program. */
const program = (version: string) => new TextEncoder().encode(`#!/bin/sh\nFAKE_DOUANE_VERSION=${version} exec "${process.execPath}" "${FAKE}" "$@"\n`);

test.skipIf(process.platform === 'win32')('an update waits for the requests in flight, then swaps; a release that does not answer goes back', async () => {
  delete process.env[DOUANE_BINARY_ENV];
  const { owner } = await core('0.3.0', program('0.3.0'));
  const gateways = harness!.core.plugins.gateways;
  gateways.idlePollMs = 25;
  gateways.readyMs = 3_000;
  const inFlight = join(harness!.dataDir, 'in-flight');
  writeFileSync(inFlight, '1');
  process.env.FAKE_DOUANE_IN_FLIGHT_FILE = inFlight;
  await owner.call('plugins.install', { id: 'douane' });
  expect((await gatewayIs(owner, 'running')).gateway?.version).toBe('0.3.0');
  const binary = join(harness!.dataDir, 'plugins', 'douane', 'douane');

  harness!.core.plugins.recommended = [douane('0.4.0', program('0.4.0'))];
  await owner.call('plugins.install', { id: 'douane' });
  await gatewayIs(owner, 'updating', 'the update waiting for requests');
  // Still the old release, serving.
  expect(readFileSync(binary, 'utf8')).toContain('0.3.0');
  writeFileSync(inFlight, '0');
  const updated = await until(() => state(owner), (plugin) => plugin.status === 'installed' && plugin.gateway?.status === 'running' && plugin.gateway.version === '0.4.0', 'the new release running');
  expect(updated.version).toBe('0.4.0');
  expect(readdirSync(dirname(binary)).filter((name) => name.includes('.previous'))).toEqual([]);

  // A release that exits at once: the one that worked comes back, and the update says why.
  harness!.core.plugins.recommended = [douane('0.5.0', new TextEncoder().encode('#!/bin/sh\nexit 1\n'))];
  await owner.call('plugins.install', { id: 'douane' });
  const back = await until(() => state(owner), (plugin) => plugin.status === 'error' && plugin.gateway?.status === 'running', 'the previous release back');
  expect(back.version).toBe('0.4.0');
  expect(back.gateway?.version).toBe('0.4.0');
  expect(back.error).toMatch(/exited with code 1.*0\.4\.0 runs again/);
  expect(readFileSync(binary, 'utf8')).toContain('0.4.0');
  expect(live()).toBe(1);
}, 60_000);

test.skipIf(process.platform === 'win32')('an update that renames the gateway executable starts the new one before its record names it, with its saved settings', async () => {
  delete process.env[DOUANE_BINARY_ENV];
  const { owner } = await core('0.3.0', program('0.3.0'));
  harness!.core.plugins.gateways.readyMs = 3_000;
  await owner.call('plugins.install', { id: 'douane' });
  expect((await gatewayIs(owner, 'running')).gateway?.version).toBe('0.3.0');
  const dir = join(harness!.dataDir, 'plugins', 'douane');
  const data = join(harness!.dataDir, 'douane');
  // A setting Douane saved into its configuration.
  appendFileSync(join(data, 'douane.toml'), '\n[routing]\nsaved = "kept"\n');

  harness!.core.plugins.recommended = [douane('0.4.0', program('0.4.0'), 'douane-next')];
  await owner.call('plugins.install', { id: 'douane' });
  const updated = await until(() => state(owner), (plugin) => plugin.status !== 'installing' && plugin.gateway?.status === 'running', 'the update settled');
  expect(updated).toMatchObject({ status: 'installed', version: '0.4.0', error: null });
  expect(updated.gateway?.version).toBe('0.4.0');
  expect(existsSync(join(dir, 'douane-next'))).toBe(true);
  expect(existsSync(join(dir, 'douane'))).toBe(false);
  expect(readFileSync(join(data, 'douane-next.toml'), 'utf8')).toContain('saved = "kept"');
  // The previous name's file stays, for a release that goes back to it.
  expect(readFileSync(join(data, 'douane.toml'), 'utf8')).toContain('saved = "kept"');
  await until(live, (count) => count === 1, 'one gateway process');
}, 60_000);

test('an update whose release exits at once says so, even when its relaunch would come before the answer', async () => {
  const { owner } = await core();
  const runs = join(harness!.dataDir, 'runs');
  process.env.FAKE_DOUANE_RUNS_FILE = runs;
  await owner.call('plugins.install', { id: 'douane' });
  await gatewayIs(owner, 'running');

  // The new release exits; a relaunch at once would start one that is still silent when the update reads why it failed.
  harness!.core.plugins.gateways.relaunchDelaysMs = [0, 0, 0];
  writeFileSync(runs, 'exit\nlate\n');
  harness!.core.plugins.recommended = [douane('0.5.0', new Uint8Array([5]))];
  await owner.call('plugins.install', { id: 'douane' });
  const back = await until(() => state(owner), (plugin) => plugin.status === 'error' && plugin.gateway?.status === 'running', 'the previous release back');
  expect(back.version).toBe('0.3.0');
  expect(back.error).toBe('douane exited with code 1. 0.3.0 runs again.');
  await until(live, (count) => count === 1, 'one gateway process');
}, 30_000);

test('an update whose record cannot be written after its gateway answered puts the previous binary back and runs it', async () => {
  const { owner } = await core();
  await owner.call('plugins.install', { id: 'douane' });
  await gatewayIs(owner, 'running');
  const dir = join(harness!.dataDir, 'plugins', 'douane');
  const binary = join(dir, process.platform === 'win32' ? 'douane.exe' : 'douane');
  const realRename = fs.renameSync;
  // The commit fails, as a full disk would make it.
  const full = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (String(from).endsWith('installed.json.part')) throw new Error('ENOSPC: no space left on device');
    realRename(from, to);
  });
  harness!.core.plugins.recommended = [douane('0.5.0', new Uint8Array([5]))];
  let back: PluginState;
  try {
    await owner.call('plugins.install', { id: 'douane' });
    back = await until(() => state(owner), (plugin) => plugin.status === 'error' && plugin.gateway?.status === 'running', 'the previous release back');
  } finally { full.mockRestore(); }
  expect(back.version).toBe('0.3.0');
  expect(back.error).toMatch(/0\.3\.0 runs again\.$/);
  expect([...readFileSync(binary)]).toEqual([1, 2, 3]);
  expect(readdirSync(dirname(binary)).filter((name) => name.includes('.previous'))).toEqual([]);
  await until(live, (count) => count === 1, 'one gateway process');
}, 30_000);

test('an updated gateway that crashes later starts again', async () => {
  const { owner } = await core();
  await owner.call('plugins.install', { id: 'douane' });
  await gatewayIs(owner, 'running');

  // The new release answers, then crashes: the update kept it, so the crash relaunches it like any other.
  const crash = join(harness!.dataDir, 'crash-once');
  writeFileSync(crash, '');
  process.env.FAKE_DOUANE_CRASH_FILE = crash;
  const seen: string[] = [];
  owner.on('plugins.updated', (plugin) => { if (plugin.gateway?.error) seen.push(plugin.gateway.error); });
  harness!.core.plugins.recommended = [douane('0.5.0', new Uint8Array([5]))];
  await owner.call('plugins.install', { id: 'douane' });
  await until(() => state(owner), (plugin) => plugin.status === 'installed' && plugin.version === '0.5.0', 'the update kept');
  await until(() => seen, (errors) => errors.some((error) => /exited with code 3.*starting it again/.test(error)), 'the crash and its relaunch');
  await gatewayIs(owner, 'running', 'running again');
  await until(live, (count) => count === 1, 'one gateway process');
}, 30_000);
