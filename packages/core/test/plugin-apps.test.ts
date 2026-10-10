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
import { PLUGIN_MANIFEST_FILE } from '@boite/contracts';
import { connect } from '../src/client.ts';
import { PluginStore } from '../src/plugins.ts';
import { RELAUNCH_DELAYS_MS, appEnv, desktopProblem, type AppClock } from '../src/plugins/apps.ts';
import { platformKey } from '../src/plugins/manifest.ts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';

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

/** Writes an installed Bots, as a finished install leaves it. */
function installBots(dataDir: string): string {
  const dir = join(dataDir, 'plugins', 'bots');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `bots${EXE}`), 'fixture');
  writeFileSync(join(dir, 'installed.json'), JSON.stringify({
    schema: 1, origin: 'url', installedAt: 1,
    source: { url: 'https://plugins.example.invalid/bots', ref: 'HEAD', commit: 'c'.repeat(40) },
    manifest: manifest(),
  }));
  return dir;
}

/**
 * The app the core spawns: it records the variables it was given, then does
 * what `mode.txt` beside it says. Returns the fixture's directory, where its
 * mode and its record live, and the pids the core started.
 */
function fakeApp(h: TestCore): { home: string; pids: number[]; mode(value: 'exit0' | 'crash' | 'stay'): void } {
  const home = join(h.dataDir, 'app-fixture');
  mkdirSync(home, { recursive: true });
  const fixture = join(home, 'app.ts');
  writeFileSync(fixture, `
    import { readFileSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const names = ['BOITE_CORE_URL', 'BOITE_TOKEN', 'BOITE_PLUGIN_ID', 'BOITE_THREAD_ID', 'BOITE_AGENT_TOKEN'];
    writeFileSync(join(import.meta.dir, 'seen.json'), JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), env: Object.fromEntries(names.map((name) => [name, process.env[name] ?? null])) }));
    const mode = readFileSync(join(import.meta.dir, 'mode.txt'), 'utf8');
    if (mode === 'exit0') process.exit(0);
    if (mode === 'crash') process.exit(3);
    setInterval(() => undefined, 1000);
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
  return { home, pids, mode: (value) => writeFileSync(join(home, 'mode.txt'), value) };
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
 * Left for later, it could launch a second copy of a crashing app mid-test.
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
    harness = await startTestCore(); const client = await harness.connect();
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

    const started = await client.call('plugins.app', { id: 'bots', action: 'start' });
    expect(started.app?.status).toBe('running');
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
    harness = await startTestCore(); const client = await harness.connect();
    const dir = installBots(harness.dataDir);
    const fake = fakeApp(harness); fake.mode('stay');
    const actions = ['start', 'stop', 'restart', 'stop', 'start', 'stop'] as const;
    await Promise.all(actions.map((action) => client.call('plugins.app', { id: 'bots', action })));
    expect(app()).toMatchObject({ enabled: false, status: 'stopped', pid: null, startedAt: null });
    expect(fake.pids).toHaveLength(3);
    expect(fake.pids.filter(alive)).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, 'app.json'), 'utf8'))).toEqual({ enabled: false });
  });

  test('stop disables it for good, start and restart bring it back, and the choice survives a new store', async () => {
    harness = await startTestCore(); const client = await harness.connect();
    const dir = installBots(harness.dataDir);
    const fake = fakeApp(harness); fake.mode('stay');
    await client.call('plugins.app', { id: 'bots', action: 'start' });
    const first = fake.pids[0]!;
    const stopped = await client.call('plugins.app', { id: 'bots', action: 'stop' });
    expect(stopped.app).toMatchObject({ enabled: false, status: 'stopped', pid: null, startedAt: null });
    expect(alive(first)).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, 'app.json'), 'utf8'))).toEqual({ enabled: false });

    // What the next core start reads: nothing launches.
    const fresh = new PluginStore(harness.core);
    expect(fresh.state('bots').app?.enabled).toBe(false);
    harness.core.plugins.startApps();
    expect(fake.pids).toHaveLength(1);

    await client.call('plugins.app', { id: 'bots', action: 'restart' });
    expect(app()).toMatchObject({ enabled: true, status: 'running' });
    const second = app().pid!;
    await client.call('plugins.app', { id: 'bots', action: 'restart' });
    expect(alive(second)).toBe(false);
    expect(app().pid).not.toBe(second);
    expect(new PluginStore(harness.core).state('bots').app?.enabled).toBe(true);
    await expect(client.call('plugins.app', { id: 'bots', action: 'pause' as 'stop' })).rejects.toThrow('start, stop or restart');
    await expect(client.call('plugins.app', { id: 'kebacc-switcher', action: 'start' })).rejects.toThrow('Install kebacc-switcher first');
  });

  test('the core start launches an enabled app, and close() kills it', async () => {
    harness = await startTestCore();
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
    harness = await startTestCore(); const client = await harness.connect();
    installBots(harness.dataDir);
    const fake = fakeApp(harness); fake.mode('stay');
    harness.core.plugins.apps.desktop = () => 'no desktop here';
    const state = await client.call('plugins.app', { id: 'bots', action: 'start' });
    expect(state.app).toMatchObject({ status: 'unavailable', error: 'no desktop here', enabled: true });
    expect(fake.pids).toHaveLength(0);
  });

  test('an install launches it, an update stops it before replacing the binary and starts it after, uninstall kills it', async () => {
    harness = await startTestCore(); const client = await harness.connect();
    harness.core.plugins.allowLocalSources = true;
    const fake = fakeApp(harness); fake.mode('stay');
    const repo = join(harness.dataDir, 'repos', 'bots');
    mkdirSync(repo, { recursive: true });
    const git = (...args: string[]) => {
      const run = Bun.spawnSync({ cmd: ['git', ...args], cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@boite.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@boite.invalid' }, stdout: 'pipe', stderr: 'pipe', windowsHide: true });
      if (!run.success) throw new Error(run.stderr.toString());
    };
    const v1 = new Uint8Array([1]); const v2 = new Uint8Array([2]);
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const bytes = url.endsWith('0.1.0') ? v1 : url.endsWith('0.2.0') ? v2 : null;
      return bytes === null ? new Response('missing', { status: 404 }) : new Response(bytes, { headers: { 'content-length': String(bytes.length) } });
    }) as typeof fetch);
    restores.push(() => fetchSpy.mockRestore());
    git('init', '-q');
    writeFileSync(join(repo, PLUGIN_MANIFEST_FILE), JSON.stringify(manifest('0.1.0', v1)));
    git('add', '-A'); git('commit', '-q', '-m', 'v1');

    const preview = await client.call('plugins.inspect', { url: repo });
    expect(preview.commands).toEqual(['bots', 'environment: BOITE_CORE_URL=<this core> BOITE_TOKEN=<the owner token> BOITE_PLUGIN_ID=bots']);
    await client.call('plugins.add', { previewId: preview.previewId! });
    await waitFor(() => app().status === 'running');
    const first = app().pid!;

    writeFileSync(join(repo, PLUGIN_MANIFEST_FILE), JSON.stringify(manifest('0.2.0', v2)));
    git('commit', '-q', '-am', 'v2');
    const update = await client.call('plugins.inspect', { url: repo });
    await client.call('plugins.add', { previewId: update.previewId! });
    await waitFor(() => harness!.core.plugins.state('bots').status === 'installed' && app().status === 'running' && app().pid !== first);
    expect(alive(first)).toBe(false);
    expect(harness.core.plugins.state('bots').version).toBe('0.2.0');
    expect(new Uint8Array(readFileSync(join(harness.dataDir, 'plugins', 'bots', `bots${EXE}`)))).toEqual(v2);

    const second = app().pid!;
    const removed = await client.call('plugins.uninstall', { id: 'bots' });
    expect(removed.status).toBe('not-installed');
    expect(alive(second)).toBe(false);
    expect(existsSync(join(harness.dataDir, 'plugins', 'bots'))).toBe(false);
    rmSync(repo, { recursive: true, force: true });
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
      await waitFor(() => heard.length === 4);
      await Bun.sleep(50);
      expect(heard.sort()).toEqual(['owner:agent', 'owner:thread', 'second:agent', 'second:thread']);

      await expect(owner.call('ui.reveal', { target: { kind: 'thread', threadId: 'thr_missing' } })).rejects.toThrow('is not a thread of this core');
      await expect(owner.call('ui.reveal', { target: { kind: 'window' } as never })).rejects.toThrow('ui.reveal target must be');
      await expect(device.call('ui.reveal', { target: { kind: 'thread', threadId } })).rejects.toThrow('ui.reveal is for the owner only');
      await expect(agent.call('ui.reveal', { target: { kind: 'thread', threadId } })).rejects.toThrow('not one of the agent\'s methods');
      await expect(device.call('plugins.app', { id: 'bots', action: 'start' })).rejects.toThrow('plugins.app is for the owner only');
      await expect(agent.call('plugins.app', { id: 'bots', action: 'start' })).rejects.toThrow('not one of the agent\'s methods');
    } finally { device.close(); agent.close(); plugin.close(); second.close(); }
  });
});
