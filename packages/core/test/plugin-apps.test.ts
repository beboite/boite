/*
 * Desktop-app plugins: the core starts the app with the owner's address and
 * token, never an agent's, keeps it running through crashes with a backoff,
 * and stops it whenever its binary or its core goes away. The app is a Bun
 * fixture standing in for the executable, as in plugins.test.ts.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { connect } from '../src/client.ts';
import { PluginStore } from '../src/plugins.ts';
import { RELAUNCH_DELAYS_MS, appEnv, desktopProblem, type AppClock } from '../src/plugins/apps.ts';
import { parseManifest, platformKey } from '../src/plugins/manifest.ts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';
import { thrown } from './settle.ts';

let harness: TestCore | undefined;
const restores: (() => void)[] = [];
afterEach(async () => {
  for (const restore of restores.splice(0)) restore();
  await harness?.stop(); harness = undefined;
});

const EXE = process.platform === 'win32' ? '.exe' : '';
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function manifest(version = '0.1.0', bytes = new Uint8Array([1])): Record<string, unknown> {
  return {
    schema: 1, id: 'bots', name: 'Bots', version,
    description: 'Little robots on your desktop.',
    homepage: 'https://plugins.example.invalid/bots',
    executable: 'bots',
    artifacts: { [platformKey()]: { url: `https://plugins.example.invalid/bots-${version}`, sha256: sha256(bytes) } },
    provides: { desktopApp: {} },
  };
}

/** Writes an installed Bots, as a finished install from the recommended list leaves it. */
function installBots(dataDir: string): string {
  const dir = join(dataDir, 'plugins', 'bots');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `bots${EXE}`), 'fixture');
  writeFileSync(join(dir, 'installed.json'), JSON.stringify({
    schema: 1, origin: 'recommended', installedAt: 1, source: null,
    manifest: manifest(),
  }));
  return dir;
}

/**
 * The app the core spawns: it records the variables it was given, then does
 * what `mode.txt` beside it says. Returns the fixture's directory, where its
 * mode and its record live, and the pids the core started. In `exit0` it is
 * the user who quits: the app exits 0 once `quit()` says so, never before.
 */
function fakeApp(h: TestCore): { home: string; pids: number[]; mode(value: 'exit0' | 'crash' | 'stay'): void; quit(): void } {
  const home = join(h.dataDir, 'app-fixture');
  mkdirSync(home, { recursive: true });
  const fixture = join(home, 'app.ts');
  writeFileSync(fixture, `
    import { existsSync, readFileSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const names = ['BOITE_CORE_URL', 'BOITE_TOKEN', 'BOITE_PLUGIN_ID', 'BOITE_THREAD_ID', 'BOITE_AGENT_TOKEN'];
    writeFileSync(join(import.meta.dir, 'seen.json'), JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), env: Object.fromEntries(names.map((name) => [name, process.env[name] ?? null])) }));
    const mode = readFileSync(join(import.meta.dir, 'mode.txt'), 'utf8');
    if (mode === 'crash') process.exit(3);
    // 'exit0' quits once the test says so; 'stay' runs until it is killed.
    const quit = join(import.meta.dir, 'quit');
    setInterval(() => { if (mode === 'exit0' && existsSync(quit)) process.exit(0); }, mode === 'exit0' ? 10 : 1000);
  `);
  const pids: number[] = [];
  const spawn = h.core.procs.spawn.bind(h.core.procs);
  const spy = spyOn(h.core.procs, 'spawn').mockImplementation((thread, command, args, options) => {
    if (!thread.endsWith(':app')) return spawn(thread, command, args, options);
    expect(options?.showWindow).toBe(true);
    const spawned = spawn(thread, process.execPath, [fixture, ...args], options);
    pids.push(spawned.record.pid);
    return spawned;
  });
  restores.push(() => spy.mockRestore());
  h.core.plugins.apps.desktop = () => null;
  return { home, pids, mode: (value) => writeFileSync(join(home, 'mode.txt'), value), quit: () => writeFileSync(join(home, 'quit'), '') };
}

/** Timers that fire when the test says so. */
function manualClock(): AppClock & { pending: { run: () => void; ms: number }[]; fire(): number } {
  let now = 1_000_000;
  const pending: { run: () => void; ms: number }[] = [];
  return {
    pending,
    now: () => now,
    setTimeout: (run, ms) => { const timer = { run, ms }; pending.push(timer); return timer; },
    clearTimeout: (handle) => { const at = pending.indexOf(handle as never); if (at >= 0) pending.splice(at, 1); },
    fire() { const timer = pending.shift()!; now += timer.ms; timer.run(); return timer.ms; },
  };
}

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const app = () => harness!.core.plugins.state('bots').app!;
/**
 * A test core whose own start pass, a 0 ms timer, has run and found no plugin.
 * Left for later, it could launch the app the test is about to install, once
 * more than the test counts, or one that quits before `start` answers.
 */
const startQuietCore = async (): Promise<TestCore> => { const core = await startTestCore(); await Bun.sleep(10); return core; };

test('the environment drops every agent variable and carries the owner token', () => {
  const env = appEnv({ PATH: '/bin', BOITE_THREAD_ID: 'thr', BOITE_AGENT_TOKEN: 'agent', BOITE_AGENT_SOMETHING: 'x', BOITE_CORE_URL: 'http://old' },
    { coreUrl: 'http://127.0.0.1:1', token: 'owner', pluginId: 'bots' });
  expect(env).toStrictEqual({ BOITE_THREAD_ID: undefined, BOITE_AGENT_TOKEN: undefined, BOITE_AGENT_SOMETHING: undefined, BOITE_CORE_URL: 'http://127.0.0.1:1', BOITE_TOKEN: 'owner', BOITE_PLUGIN_ID: 'bots' });
  expect(desktopProblem({}, 'linux')).toContain('DISPLAY');
  expect(desktopProblem({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux')).toBeNull();
  expect(desktopProblem({}, 'win32')).toBeNull();
});

describe('a desktop app', () => {
  test('starts with the core address and owner token, no agent variable, and a clean quit leaves it stopped', async () => {
    harness = await startQuietCore(); const client = await harness.connect();
    const dir = installBots(harness.dataDir);
    const fake = fakeApp(harness); fake.mode('exit0');
    const saved = { thread: process.env.BOITE_THREAD_ID, token: process.env.BOITE_AGENT_TOKEN };
    process.env.BOITE_THREAD_ID = 'thr_parent'; process.env.BOITE_AGENT_TOKEN = 'agent-secret';
    restores.push(() => {
      if (saved.thread === undefined) delete process.env.BOITE_THREAD_ID; else process.env.BOITE_THREAD_ID = saved.thread;
      if (saved.token === undefined) delete process.env.BOITE_AGENT_TOKEN; else process.env.BOITE_AGENT_TOKEN = saved.token;
    });
    expect(harness.core.plugins.state('bots').app).toMatchObject({ enabled: true, status: 'stopped', pid: null });
    expect(harness.core.plugins.state('bots').commands[0]).toBe('bots');

    // An app that quits by itself can be gone before `start` answers, and the
    // answer then rightly says stopped: a macOS runner saw its exit settled
    // before the reply. The user quits only once the app is seen running.
    const started = await client.call('plugins.app', { id: 'bots', action: 'start' });
    expect(started.app?.status).toBe('running');
    fake.quit();
    await waitFor(() => app().status === 'stopped');
    expect(app()).toMatchObject({ enabled: true, status: 'stopped', exitCode: 0, error: null, startedAt: null });
    const seen = JSON.parse(readFileSync(join(fake.home, 'seen.json'), 'utf8')) as { args: string[]; cwd: string; env: Record<string, string | null> };
    expect(seen.args).toEqual([]);
    // macOS reaches the temporary directory through /private/var, which /var links to.
    expect(realpathSync(seen.cwd).toLowerCase()).toBe(realpathSync(dir).toLowerCase());
    expect(seen.env).toEqual({ BOITE_CORE_URL: harness.core.baseUrl(), BOITE_TOKEN: harness.core.token, BOITE_PLUGIN_ID: 'bots', BOITE_THREAD_ID: null, BOITE_AGENT_TOKEN: null });
  });

  test('crashes relaunch after 2, 10 and 30 seconds, and a fourth within five minutes leaves it crashed', async () => {
    harness = await startQuietCore();
    installBots(harness.dataDir);
    const fake = fakeApp(harness); fake.mode('crash');
    const clock = manualClock(); harness.core.plugins.apps.clock = clock;
    await harness.core.plugins.app({ id: 'bots', action: 'start' });
    const waits: number[] = [];
    for (let crash = 1; crash <= 3; crash += 1) {
      await waitFor(() => clock.pending.length === 1);
      expect(app()).toMatchObject({ status: 'starting', exitCode: 3 });
      if (crash === 1) {
        // The core start's own pass, late: it leaves the wait and the count alone.
        harness.core.plugins.startApps();
        expect(clock.pending).toHaveLength(1);
        expect(fake.pids).toHaveLength(1);
      }
      waits.push(clock.fire());
    }
    await waitFor(() => app().status === 'crashed');
    expect(waits).toEqual([...RELAUNCH_DELAYS_MS]);
    expect(fake.pids).toHaveLength(4);
    expect(clock.pending).toHaveLength(0);
    expect(app()).toMatchObject({ status: 'crashed', exitCode: 3, enabled: true });
    expect(app().error).toContain('exited with code 3 4 times');

    // The owner starts it again: the count begins anew.
    fake.mode('stay');
    await harness.core.plugins.app({ id: 'bots', action: 'start' });
    expect(app().status).toBe('running');
  }, 20_000);

  test('a relaunch that finds the binary gone leaves it stopped, not starting for good', async () => {
    harness = await startQuietCore();
    const dir = installBots(harness.dataDir);
    const fake = fakeApp(harness); fake.mode('crash');
    const clock = manualClock(); harness.core.plugins.apps.clock = clock;
    await harness.core.plugins.app({ id: 'bots', action: 'start' });
    await waitFor(() => clock.pending.length === 1);
    rmSync(join(dir, `bots${EXE}`));
    clock.fire();
    expect(harness.core.plugins.apps.state('bots', dir)).toMatchObject({ status: 'stopped', error: null, pid: null, startedAt: null });
    expect(clock.pending).toHaveLength(0);
    expect(fake.pids).toHaveLength(1);
  });

  test('quick start, stop and restart calls run one after the other', async () => {
    harness = await startQuietCore(); const client = await harness.connect();
    const dir = installBots(harness.dataDir);
    const fake = fakeApp(harness); fake.mode('stay');
    const actions = ['start', 'stop', 'restart', 'stop', 'start', 'stop'] as const;
    await Promise.all(actions.map((action) => client.call('plugins.app', { id: 'bots', action })));
    expect(app()).toMatchObject({ enabled: false, status: 'stopped', pid: null, startedAt: null });
    expect(fake.pids).toHaveLength(3);
    expect(fake.pids.filter(alive)).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, 'app.json'), 'utf8'))).toEqual({ enabled: false, autostart: true });
  });

  test('stop keeps it off until a start, and the core start brings it back only while it starts with Boite', async () => {
    harness = await startQuietCore(); const client = await harness.connect();
    const dir = installBots(harness.dataDir);
    const fake = fakeApp(harness); fake.mode('stay');
    await client.call('plugins.app', { id: 'bots', action: 'start' });
    const first = fake.pids[0]!;
    const stopped = await client.call('plugins.app', { id: 'bots', action: 'stop' });
    expect(stopped.app).toMatchObject({ enabled: false, autostart: true, status: 'stopped', pid: null, startedAt: null });
    expect(alive(first)).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, 'app.json'), 'utf8'))).toEqual({ enabled: false, autostart: true });

    // Started with Boite: the next core start launches it, a stop or not.
    expect(new PluginStore(harness.core).state('bots').app).toMatchObject({ enabled: false, autostart: true });
    harness.core.plugins.startApps();
    await waitFor(() => fake.pids.length === 2 && app().status === 'running');

    // Turned off, nothing running changes, and the next core start leaves it alone.
    const off = await client.call('plugins.autostart', { id: 'bots', autostart: false });
    expect(off.app).toMatchObject({ autostart: false, status: 'running' });
    expect(JSON.parse(readFileSync(join(dir, 'app.json'), 'utf8'))).toEqual({ enabled: false, autostart: false });
    await client.call('plugins.app', { id: 'bots', action: 'stop' });
    harness.core.plugins.startApps();
    expect(fake.pids).toHaveLength(2);

    // A start makes it run without turning autostart back on.
    await client.call('plugins.app', { id: 'bots', action: 'restart' });
    expect(app()).toMatchObject({ enabled: true, autostart: false, status: 'running' });
    const second = app().pid!;
    await client.call('plugins.app', { id: 'bots', action: 'restart' });
    expect(alive(second)).toBe(false);
    expect(app().pid).not.toBe(second);
    expect(new PluginStore(harness.core).state('bots').app).toMatchObject({ enabled: true, autostart: false });
    expect(await thrown(client.call('plugins.app', { id: 'bots', action: 'pause' as 'stop' }))).toThrow('start, stop or restart');
    expect(await thrown(client.call('plugins.autostart', { id: 'bots', autostart: 'yes' as unknown as boolean }))).toThrow('autostart must be true or false');
    // A recommended plugin that is not installed has no app to start.
    const pools = parseManifest({ ...manifest(), id: 'pool-switcher', name: 'Pool switcher', executable: 'pool', provides: { accountPools: { providers: ['claude'] } } }, 'recommended.json[1]');
    harness.core.plugins.recommended = [...harness.core.plugins.recommended, pools];
    expect(await thrown(client.call('plugins.app', { id: 'pool-switcher', action: 'start' }))).toThrow('Install pool-switcher first');
    expect(await thrown(client.call('plugins.autostart', { id: 'pool-switcher', autostart: true }))).toThrow('Install pool-switcher first');

    const { grant } = await client.call('pairing.grant', {});
    const device = await connect(harness.url, '', { grant, client: { name: 'pwa', version: 'test' } });
    try {
      expect(await thrown(device.call('plugins.autostart', { id: 'bots', autostart: true }))).toThrow('plugins.autostart is for the owner only');
    } finally { device.close(); }
  });

  test('an app.json from before autostart starts with the core only if it was left enabled', async () => {
    harness = await startQuietCore();
    const dir = installBots(harness.dataDir);
    writeFileSync(join(dir, 'app.json'), JSON.stringify({ enabled: false }));
    expect(app()).toMatchObject({ enabled: false, autostart: false });
    writeFileSync(join(dir, 'app.json'), JSON.stringify({ enabled: true }));
    expect(app()).toMatchObject({ enabled: true, autostart: true });
  });

  test('the core start launches an enabled app, and close() kills it', async () => {
    harness = await startQuietCore();
    installBots(harness.dataDir);
    const fake = fakeApp(harness); fake.mode('stay');
    harness.core.plugins.startApps();
    expect(app().status).toBe('running');
    const pid = app().pid!;
    expect(alive(pid)).toBe(true);
    await harness.core.plugins.close();
    expect(alive(pid)).toBe(false);
    expect(app().status).toBe('stopped');
  });

  test('without a desktop it does not launch and says why', async () => {
    harness = await startQuietCore(); const client = await harness.connect();
    installBots(harness.dataDir);
    const fake = fakeApp(harness); fake.mode('stay');
    harness.core.plugins.apps.desktop = () => 'no desktop here';
    const state = await client.call('plugins.app', { id: 'bots', action: 'start' });
    expect(state.app).toMatchObject({ status: 'unavailable', error: 'no desktop here', enabled: true });
    expect(fake.pids).toHaveLength(0);
  });

  test('an install launches it, an update stops it before replacing the binary and starts it after, uninstall kills it', async () => {
    harness = await startQuietCore(); const client = await harness.connect();
    const fake = fakeApp(harness); fake.mode('stay');
    const v1 = new Uint8Array([1]); const v2 = new Uint8Array([2]);
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const bytes = url.endsWith('0.1.0') ? v1 : url.endsWith('0.2.0') ? v2 : null;
      return bytes === null ? new Response('missing', { status: 404 }) : new Response(bytes, { headers: { 'content-length': String(bytes.length) } });
    }) as typeof fetch);
    restores.push(() => fetchSpy.mockRestore());
    // Bots installs from the recommended list, as Settings > Plugins offers it first.
    harness.core.plugins.recommended = [parseManifest(manifest('0.1.0', v1), 'recommended.json[0]')];

    const [listed] = await client.call('plugins.list', {});
    expect(listed).toMatchObject({ id: 'bots', origin: 'recommended', status: 'not-installed', availableVersion: '0.1.0' });
    expect(listed?.commands).toEqual(['bots', 'environment: BOITE_CORE_URL=<this core> BOITE_TOKEN=<the owner token> BOITE_PLUGIN_ID=bots']);
    await client.call('plugins.install', { id: 'bots' });
    await waitFor(() => app().status === 'running');
    const first = app().pid!;

    // A Boite that recommends the next release updates it.
    harness.core.plugins.recommended = [parseManifest(manifest('0.2.0', v2), 'recommended.json[0]')];
    await client.call('plugins.install', { id: 'bots' });
    await waitFor(() => harness!.core.plugins.state('bots').status === 'installed' && app().status === 'running' && app().pid !== first);
    expect(alive(first)).toBe(false);
    expect(harness.core.plugins.state('bots').version).toBe('0.2.0');
    expect(new Uint8Array(readFileSync(join(harness.dataDir, 'plugins', 'bots', `bots${EXE}`)))).toEqual(v2);

    const second = app().pid!;
    const removed = await client.call('plugins.uninstall', { id: 'bots' });
    expect(removed.status).toBe('not-installed');
    expect(alive(second)).toBe(false);
    expect(existsSync(join(harness.dataDir, 'plugins', 'bots'))).toBe(false);
  }, 30_000);
});

describe('ui.reveal', () => {
  test('reaches owner windows only, and a device or an agent may not call it', async () => {
    harness = await startTestCore();
    const owner = await harness.connect();
    const second = await harness.connect();
    const { threadId } = await echoThread(harness, owner);
    const { grant } = await owner.call('pairing.grant', {});
    const device = await connect(harness.url, '', { grant, client: { name: 'pwa', version: 'test' } });
    const agent = await connect(harness.url, harness.core.agents.tokenFor(threadId));
    // A desktop-app plugin signs in with the owner token but shows none of Boite's windows.
    const plugin = await connect(harness.url, harness.core.token, { client: { name: 'plugin', version: 'test' } });
    try {
      const heard: string[] = [];
      owner.on('ui.reveal', (event) => heard.push(`owner:${event.target.kind}`));
      second.on('ui.reveal', (event) => heard.push(`second:${event.target.kind}`));
      device.onAny((name) => { if (name === 'ui.reveal') heard.push('device'); });
      agent.onAny((name) => { if (name === 'ui.reveal') heard.push('agent'); });
      plugin.onAny((name) => { if (name === 'ui.reveal') heard.push('plugin'); });

      expect(await owner.call('ui.reveal', { target: { kind: 'thread', threadId } })).toEqual({ delivered: 2 });
      expect(await plugin.call('ui.reveal', { target: { kind: 'agent', agentId: 'agent-1' } })).toEqual({ delivered: 2 });
      expect(await plugin.call('ui.reveal', { target: { kind: 'update' } })).toEqual({ delivered: 2 });
      await waitFor(() => heard.length === 6);
      await Bun.sleep(50);
      expect(heard.sort()).toEqual(['owner:agent', 'owner:thread', 'owner:update', 'second:agent', 'second:thread', 'second:update']);

      expect(await thrown(owner.call('ui.reveal', { target: { kind: 'thread', threadId: 'thr_missing' } }))).toThrow('is not a thread of this core');
      expect(await thrown(owner.call('ui.reveal', { target: { kind: 'window' } as never }))).toThrow('ui.reveal target must be');
      expect(await thrown(device.call('ui.reveal', { target: { kind: 'thread', threadId } }))).toThrow('ui.reveal is for the owner only');
      expect(await thrown(agent.call('ui.reveal', { target: { kind: 'thread', threadId } }))).toThrow('not one of the agent\'s methods');
      expect(await thrown(device.call('plugins.app', { id: 'bots', action: 'start' }))).toThrow('plugins.app is for the owner only');
      expect(await thrown(agent.call('plugins.app', { id: 'bots', action: 'start' }))).toThrow('not one of the agent\'s methods');
    } finally { device.close(); agent.close(); plugin.close(); second.close(); }
  });
});
