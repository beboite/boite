import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_ENV, virtualDesktopCommandError, virtualDesktopSizeError } from '@boite/contracts';
import { runCli } from '../src/cli.ts';
import { desktopCommand } from '../src/desktop-cli.ts';
import { parse } from '../src/cli-args.ts';
import { DESKTOP_MARK, desktopEnv, withDesktopEnv } from '../src/desktop/env.ts';
import { findDesktopTools, markedProcesses, VirtualDesktops, xauthority, type DesktopTools } from '../src/desktop/service.ts';
import { echoThread, startTestCore, type TestCore } from './harness.ts';
import { thrown } from './settle.ts';

test('the Xauthority file holds one cookie for any address and display, as libXau reads it', () => {
  const cookie = Uint8Array.from({ length: 16 }, (_, at) => at);
  const file = xauthority(cookie);
  // family FamilyWild, empty address, empty display number, then the name and the cookie, each with a big-endian length.
  expect([...file.subarray(0, 6)]).toEqual([0xff, 0xff, 0, 0, 0, 0]);
  expect(file.readUInt16BE(6)).toBe(18);
  expect(file.subarray(8, 26).toString()).toBe('MIT-MAGIC-COOKIE-1');
  expect(file.readUInt16BE(26)).toBe(16);
  expect([...file.subarray(28)]).toEqual([...cookie]);
});

test('a desktop program keeps the user\'s Wayland, session bus and sound out', () => {
  const env = withDesktopEnv({ PATH: '/bin', WAYLAND_DISPLAY: 'wayland-0', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus', NO_AT_BRIDGE: '1', HOME: '/home/u' },
    desktopEnv('/tmp/boite-desktop-x', ':7', 'unix:path=/tmp/boite-desktop-x/bus', 'abc'));
  expect(env).toMatchObject({ PATH: '/bin', DISPLAY: ':7', XAUTHORITY: '/tmp/boite-desktop-x/Xauthority', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/boite-desktop-x/bus',
    QT_ACCESSIBILITY: '1', ACCESSIBILITY_ENABLED: '1', PULSE_SERVER: 'unix:/tmp/boite-desktop-x/no-sound', AGENT_DESKTOP_HOME: '/tmp/boite-desktop-x/agent-desktop', [DESKTOP_MARK]: 'abc' });
  expect(env['WAYLAND_DISPLAY']).toBeUndefined();
  expect(env['NO_AT_BRIDGE']).toBeUndefined();
  // A single-instance app finds its lock in the desktop's own folders, never the one of the user's running copy.
  for (const key of ['HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR']) expect(env[key]).toStartWith('/tmp/boite-desktop-x/');
});

test('the tools a desktop needs are named by package, and only Linux has one', () => {
  expect(findDesktopTools('win32')).toMatchObject({ available: false });
  const none = findDesktopTools('linux', () => null, () => false);
  expect(none).toEqual({ available: false, missing: ['xvfb', 'dbus-daemon', 'at-spi2-core', 'openbox'], reason: 'missing xvfb, dbus-daemon, at-spi2-core, openbox: install them with the system\'s package manager (apt install xvfb dbus-daemon at-spi2-core openbox)' });
  const all = findDesktopTools('linux', name => name === 'dbus-send' ? null : `/usr/bin/${name}`, path => path === '/usr/lib/at-spi2-core/at-spi-bus-launcher');
  expect(all).toEqual({ xvfb: '/usr/bin/Xvfb', dbus: '/usr/bin/dbus-daemon', openbox: '/usr/bin/openbox', atspi: '/usr/lib/at-spi2-core/at-spi-bus-launcher', dbusSend: null });
});

test('desktop sizes and commands are checked before anything starts', () => {
  expect(virtualDesktopSizeError(undefined, undefined)).toBeNull();
  expect(virtualDesktopSizeError(1280, 800)).toBeNull();
  expect(virtualDesktopSizeError(100, 800)).toContain('320 to 3840');
  expect(virtualDesktopSizeError(1280.5, 800)).toContain('whole pixels');
  expect(virtualDesktopCommandError(['gedit', 'notes.txt'])).toBeNull();
  expect(virtualDesktopCommandError([])).toContain('1 to 256 words');
  expect(virtualDesktopCommandError([''])).toBe('command must start with a program');
  expect(virtualDesktopCommandError(['a\0b'])).toContain('no NUL');
});

test('every word after a desktop command is its own: agent-desktop flags and the program run takes', () => {
  expect(parse(['desktop', 'snapshot', '--app', 'gedit', '-i', '--json']).positional).toEqual(['desktop', 'snapshot', '--app', 'gedit', '-i', '--json']);
  expect(parse(['desktop', 'run', 'google-chrome', '--force-renderer-accessibility', '--', '--thread', 'x']).positional)
    .toEqual(['desktop', 'run', 'google-chrome', '--force-renderer-accessibility', '--', '--thread', 'x']);
  expect(parse(['--json', 'desktop', 'status']).json).toBe(true);
});

test('--help after -- is text to type, so the command still runs on the desktop', async () => {
  const asked: string[] = [];
  const client = { call: async (method: string) => { asked.push(method); return { session: null, support: { available: true } }; } } as unknown as Parameters<typeof desktopCommand>[2];
  expect(await thrown(desktopCommand(['type', '@e1', '--', '--help'], { cwd: '/', env: { PATH: '' }, out: () => {}, err: () => {} }, client, 'thr'))).toThrow('no desktop yet');
  expect(asked).toEqual(['desktop.status']);
});

/** A desktop whose four programs are fakes the test holds: Xvfb's readiness and openbox's stop wait on gates. */
function fakeStack() {
  const gate = () => { let open!: () => void; const opened = new Promise<void>(resolve => { open = resolve; }); return { opened, open }; };
  const thread = { id: 'thr_fake', archived: false };
  const spawned: { command: string; stopped: boolean; stopAsked: boolean }[] = [];
  const gates: { xvfb?: ReturnType<typeof gate>; openboxStop?: ReturnType<typeof gate> } = {};
  let pid = 4_000_000;
  const core = {
    threads: { require: () => thread },
    logs: { info: () => {} },
    procs: { protection: { policy: () => null }, spawn: (_scope: string, command: string) => {
      let stdout!: ReadableStreamDefaultController<Uint8Array>, stderr!: ReadableStreamDefaultController<Uint8Array>, exit!: (code: number) => void;
      const exited = new Promise<number>(resolve => { exit = resolve; });
      const entry = { command, stopped: false, stopAsked: false };
      spawned.push(entry);
      const stopGate = command === 'openbox' ? gates.openboxStop : undefined;
      const proc = { stdout: new ReadableStream<Uint8Array>({ start: c => { stdout = c; } }), stderr: new ReadableStream<Uint8Array>({ start: c => { stderr = c; } }) };
      const ready = { Xvfb: '99', 'dbus-daemon': 'unix:path=/nowhere', openbox: 'boite-desktop-ready' }[command];
      const say = () => { if (ready && !entry.stopped) stdout.enqueue(new TextEncoder().encode(`${ready}\n`)); };
      if (command === 'Xvfb' && gates.xvfb) void gates.xvfb.opened.then(say); else say();
      return { proc, exited, record: { pid: (pid += 1) }, stop: async () => {
        entry.stopAsked = true;
        await stopGate?.opened;
        if (entry.stopped) return;
        entry.stopped = true;
        stdout.close(); stderr.close(); exit(0);
      } };
    } },
  };
  const tools: DesktopTools = { xvfb: 'Xvfb', dbus: 'dbus-daemon', atspi: 'at-spi-bus-launcher', openbox: 'openbox', dbusSend: null };
  const desktops = new VirtualDesktops(core as unknown as ConstructorParameters<typeof VirtualDesktops>[0], { tools: () => tools });
  const live = () => spawned.filter(entry => !entry.stopped).length;
  const until = async (done: () => boolean) => { for (let at = 0; !done(); at += 1) { if (at > 2_000) throw new Error('timed out'); await Bun.sleep(1); } };
  return { desktops, thread, spawned, live, until, holdXvfb: () => (gates.xvfb = gate()), holdOpenboxStop: () => (gates.openboxStop = gate()) };
}

test('the core stopping while a desktop starts stops it at once, without waiting for it to be ready', async () => {
  const stack = fakeStack();
  // Xvfb never says it is ready: the stop must not wait out the start timeout.
  stack.holdXvfb();
  const start = thrown(stack.desktops.start({ threadId: stack.thread.id }));
  await stack.until(() => stack.spawned.length === 1);
  const began = performance.now();
  await stack.desktops.stopAll();
  expect(performance.now() - began).toBeLessThan(1_000);
  expect(await start).toThrow('archived or Boite is stopping');
  expect(stack.live()).toBe(0);
  expect(stack.desktops.status({ threadId: stack.thread.id }).session).toBeNull();
  expect(await thrown(stack.desktops.start({ threadId: stack.thread.id }))).toThrow('Boite is stopping');
});

test('a second stop waits for the first one to finish', async () => {
  const stack = fakeStack();
  const openbox = stack.holdOpenboxStop();
  await stack.desktops.start({ threadId: stack.thread.id });
  const first = stack.desktops.stop({ threadId: stack.thread.id });
  await stack.until(() => stack.spawned.some(entry => entry.stopAsked));
  let secondDone = false;
  const second = stack.desktops.stop({ threadId: stack.thread.id }).then(result => { secondDone = true; return result; });
  await Bun.sleep(20);
  expect(secondDone).toBe(false);
  openbox.open();
  expect(await second).toEqual({ stopped: true });
  await first;
  expect(stack.live()).toBe(0);
});

test('archiving while the desktop restarts stops the new one too', async () => {
  const stack = fakeStack();
  const openbox = stack.holdOpenboxStop();
  await stack.desktops.start({ threadId: stack.thread.id });
  const stop = stack.desktops.stop({ threadId: stack.thread.id });
  await stack.until(() => stack.spawned.some(entry => entry.stopAsked));
  const xvfb = stack.holdXvfb();
  // Settled at once: the cancel fails it while the test still waits on the first stop.
  const restart = thrown(stack.desktops.start({ threadId: stack.thread.id }));
  await stack.until(() => stack.spawned.length === 5);
  stack.thread.archived = true;
  stack.desktops.release(stack.thread.id);
  openbox.open();
  xvfb.open();
  await stop;
  expect(await restart).toThrow('archived');
  expect(stack.live()).toBe(0);
  expect(stack.desktops.status({ threadId: stack.thread.id }).session).toBeNull();
});

describe('boite desktop', () => {
  let harness: TestCore, threadId: string, cwd: string;

  const cli = async (...args: string[]) => cliOf(threadId, ...args);
  const cliOf = async (thread: string, ...args: string[]) => {
    let out = '', error = '';
    const code = await runCli(['desktop', ...args], { cwd,
      env: { PATH: process.env['PATH'], [AGENT_ENV.threadId]: thread, [AGENT_ENV.coreUrl]: harness.url, [AGENT_ENV.token]: harness.core.agents.tokenFor(thread) },
      out: text => { out += text; }, err: text => { error += text; } });
    return { code, out, error };
  };

  const useTools = (tools: () => ReturnType<typeof findDesktopTools>) => {
    const core = harness.core as { desktops: VirtualDesktops };
    core.desktops = new VirtualDesktops(harness.core, { tools, tempRoot: harness.dataDir });
  };

  beforeEach(async () => {
    harness = await startTestCore();
    const owner = await harness.connect();
    ({ threadId } = await echoThread(harness, owner));
    owner.close();
    cwd = realpathSync(harness.core.threads.require(threadId).cwd);
  });

  afterEach(async () => {
    await harness.stop();
  });

  test('a machine without the tools says what to install and starts nothing', async () => {
    useTools(() => findDesktopTools('linux', () => null, () => false));
    const status = await cli('status');
    expect(status.code).toBe(0);
    expect(status.out).toContain('no virtual desktop on this machine: missing xvfb, dbus-daemon, at-spi2-core, openbox');
    expect(status.out).toContain('desktop: not started');
    const run = await cli('run', 'gedit');
    expect(run.code).toBe(1);
    expect(run.error).toContain('no virtual desktop on this machine: missing xvfb');
    const snapshot = await cli('snapshot', '-i');
    expect(snapshot.error).toContain('error: no virtual desktop on this machine');
    expect((await cli('stop')).out).toContain('no desktop was running');
  });

  const tools = findDesktopTools();
  const real = 'xvfb' in tools ? tools as DesktopTools : null;

  test.skipIf(!real)('run starts a desktop of its own, its app reaches it, and archiving stops every process of it', async () => {
    useTools(() => real!);
    const run = await cli('run', 'sleep', '300');
    expect(run.error).toBe('');
    const pid = Number(/running as pid (\d+)/.exec(run.out)?.[1]);
    const status = await harness.core.desktops.status({ threadId });
    const session = status.session!;
    expect(session.display).toMatch(/^:\d+$/);
    expect(session.apps).toMatchObject([{ pid, command: 'sleep 300', exitCode: null }]);
    const environ = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
    expect(environ).toContain(`DISPLAY=${session.display}`);
    expect(environ).toContain(`XAUTHORITY=${session.env['XAUTHORITY']}`);
    expect(environ.some(entry => entry.startsWith('WAYLAND_DISPLAY='))).toBe(false);
    // Xvfb, dbus-daemon, the accessibility launcher with its own bus, openbox and the app.
    const mark = session.env[DESKTOP_MARK]!;
    expect(markedProcesses(mark).length).toBeGreaterThanOrEqual(5);
    // The display takes only clients holding its cookie: another account on the machine gets nothing.
    const opens = (xauthority: string) => Bun.spawnSync({
      cmd: [process.execPath, '-e', `const x = require('bun:ffi').dlopen('libX11.so.6', { XOpenDisplay: { args: ['ptr'], returns: 'ptr' } }); console.log(x.symbols.XOpenDisplay(null) ? 'open' : 'refused')`],
      env: { ...process.env, DISPLAY: session.display, XAUTHORITY: xauthority },
    }).stdout.toString().trim();
    expect(opens(session.env['XAUTHORITY']!)).toBe('open');
    expect(opens('/dev/null')).toBe('refused');
    // Nothing starts on demand on the desktop's bus: a keyring asking for a new password once covered the agent's app.
    if (real!.dbusSend) {
      const activatable = Bun.spawnSync({ cmd: [real!.dbusSend, '--session', '--print-reply', '--dest=org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus.ListActivatableNames'],
        env: withDesktopEnv(process.env, session.env) as Record<string, string> }).stdout.toString();
      expect(activatable).toContain('org.freedesktop.DBus');
      expect(activatable).not.toContain('org.freedesktop.secrets');
      expect(activatable).not.toContain('org.gnome.keyring');
    }
    const env = await cli('env');
    expect(env.out).toContain(`export DISPLAY=${session.display}\n`);
    expect(env.out).toContain('unset WAYLAND_DISPLAY\n');
    // A shell that evals these lines must not carry the mark, or the stop would kill its own `boite desktop stop`.
    expect(env.out).not.toContain(DESKTOP_MARK);
    // A second run joins the same desktop.
    await cli('run', 'sleep', '301');
    expect((await harness.core.desktops.status({ threadId })).session!.display).toBe(session.display);

    const owner = await harness.connect();
    await owner.call('threads.archive', { threadId });
    owner.close();
    const deadline = Date.now() + 10_000;
    // The archive answers first; the desktop stops behind it.
    while (harness.core.desktops.status({ threadId }).session && Date.now() < deadline) await Bun.sleep(100);
    expect(harness.core.desktops.status({ threadId }).session).toBeNull();
    expect(markedProcesses(mark)).toEqual([]);
    expect(existsSync(join(session.env['XAUTHORITY']!, '..'))).toBe(false);
  }, 30_000);

  test.skipIf(!real)('stop ends the desktop, and a program that exits at once reports its code and log', async () => {
    useTools(() => real!);
    const failed = await cli('run', 'sh', '-c', 'echo broken >&2; exit 3');
    expect(failed.out).toContain('exited at once with code 3');
    const log = /its output: (\S+)/.exec(failed.out)?.[1];
    expect(readFileSync(log!, 'utf8')).toBe('broken\n');
    const mark = (await harness.core.desktops.status({ threadId })).session!.env[DESKTOP_MARK]!;
    expect((await cli('stop')).out).toContain('desktop stopped');
    expect(markedProcesses(mark)).toEqual([]);
    expect((await cli('status')).out).toContain('desktop: not started');
  }, 30_000);

  // Opt-in: agent-desktop and Chrome from PATH, as an agent would use them.
  const live = real && process.env['BOITE_E2E_DESKTOP'] === '1' && Bun.which('agent-desktop') && Bun.which('google-chrome');
  test.skipIf(!live)('agent-desktop reads and clicks a Chrome page on the desktop, and each desktop has its own Chrome', async () => {
    useTools(() => real!);
    // No --user-data-dir: Chrome's profile, lock and socket come from the desktop's own XDG folders.
    const chrome = (title: string, body = '') => ['run', 'google-chrome', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=800,600', `data:text/html,<title>${title}</title>${body}`];
    await cli(...chrome('Proof', `<button onclick="document.title='clicked'">Valider</button>`));
    let ref: string | undefined;
    for (let attempt = 0; attempt < 20 && !ref; attempt += 1) {
      await Bun.sleep(500);
      const snapshot = await cli('snapshot', '--app', 'chrome', '-i', '--compact');
      ref = /"ref_id":"(@[^"]+)"[^{}]*"name":"Valider"|"name":"Valider"[^{}]*"ref_id":"(@[^"]+)"/.exec(snapshot.out)?.slice(1).find(Boolean);
    }
    expect(ref).toBeDefined();
    expect((await cli('click', ref!)).code).toBe(0);
    await Bun.sleep(500);
    expect((await cli('list-windows', '--app', 'chrome')).out).toContain('clicked - Google Chrome');

    // Another conversation's Chrome opens on its own desktop instead of handing its page to the first one.
    const owner = await harness.connect();
    const other = (await echoThread(harness, owner, 'second desktop')).threadId;
    owner.close();
    await cliOf(other, ...chrome('Second'));
    let second = '';
    for (let attempt = 0; attempt < 20 && !second.includes('Second - Google Chrome'); attempt += 1) {
      await Bun.sleep(500);
      second = (await cliOf(other, 'list-windows', '--app', 'chrome')).out;
    }
    expect(second).toContain('Second - Google Chrome');
    expect((await cli('list-windows', '--app', 'chrome')).out).not.toContain('Second');
  }, 90_000);
});
