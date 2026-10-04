import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_ENV } from '@boite/contracts';
import { runCli } from '../src/cli.ts';
import { connect, type CoreClient } from '../src/client.ts';
import { MobileDevices } from '../src/devices/control.ts';
import {
  adbText,
  findAndroidSdk,
  findXcrun,
  IOS_NEEDS_MAC,
  NO_ANDROID_SDK,
  NO_XCODE,
  parseAdbDevices,
  parseAvdList,
  parseAvdName,
  parseSimctlList,
  pngSize,
  type SdkEnvironment,
} from '../src/devices/sdk.ts';
import { fakeSdk, png, SCREEN } from './fixtures/fake-sdk.ts';
import { echoThread, startTestCore, type TestCore } from './harness.ts';

const empty = () => mkdtempSync(join(tmpdir(), 'boite-no-sdk-'));
const linux = (env: Record<string, string | undefined> = {}): SdkEnvironment => ({ os: 'linux', env: { PATH: '', ...env }, home: empty() });

describe('what the SDK tools print', () => {
  test('adb devices -l keeps the serial, the state and the model', () => {
    const output = '* daemon not running; starting now at tcp:5037\n* daemon started successfully\nList of devices attached\n' +
      'emulator-5554\tdevice product:sdk_gphone64 model:sdk_gphone64_x86_64 device:emu64x transport_id:1\n' +
      'R58M12345\tunauthorized usb:1-1 transport_id:2\n192.168.1.20:5555 device model:Pixel_7 transport_id:3\r\n\r\n';
    expect(parseAdbDevices(output)).toEqual([
      { serial: 'emulator-5554', state: 'device', model: 'sdk_gphone64_x86_64' },
      { serial: 'R58M12345', state: 'unauthorized' },
      { serial: '192.168.1.20:5555', state: 'device', model: 'Pixel_7' },
    ]);
    expect(parseAdbDevices('List of devices attached\n\n')).toEqual([]);
  });

  test('emulator -list-avds skips its log lines; emu avd name drops the OK', () => {
    expect(parseAvdList('INFO    | Storing crashdata in: C:\\Temp\\emu-crash.db\r\nPixel_8_API_35\r\nTablet.10-inch\r\n\r\n')).toEqual(['Pixel_8_API_35', 'Tablet.10-inch']);
    expect(parseAvdName('Pixel_8_API_35\r\nOK\r\n')).toBe('Pixel_8_API_35');
    expect(parseAvdName('KO: unknown command\r\n')).toBeUndefined();
  });

  test('simctl list -j keeps available iOS simulators with their runtime', () => {
    const output = JSON.stringify({
      devices: {
        'com.apple.CoreSimulator.SimRuntime.iOS-18-2': [
          { udid: 'A1B2-C3', name: 'iPhone 16', state: 'Booted', isAvailable: true },
          { udid: 'D4E5-F6', name: 'iPad Air', state: 'Shutdown', isAvailable: true },
          { udid: 'GONE-01', name: 'iPhone 8', state: 'Shutdown', isAvailable: false },
        ],
        'com.apple.CoreSimulator.SimRuntime.watchOS-11-0': [{ udid: 'W-1', name: 'Apple Watch', state: 'Shutdown', isAvailable: true }],
      },
    });
    expect(parseSimctlList(output, 'local')).toEqual([
      { id: 'A1B2-C3', hostId: 'local', platform: 'ios', name: 'iPhone 16', kind: 'simulator', state: 'running', runtime: 'iOS 18.2' },
      { id: 'D4E5-F6', hostId: 'local', platform: 'ios', name: 'iPad Air', kind: 'simulator', state: 'stopped', runtime: 'iOS 18.2' },
    ]);
    expect(parseSimctlList('xcrun: error: unable to find utility "simctl"', 'local')).toEqual([]);
  });

  test('a PNG gives its size; text reaches adb input quoted for the device shell', () => {
    expect(pngSize(png(320, 640))).toEqual({ width: 320, height: 640 });
    expect(pngSize(new TextEncoder().encode('error: closed'))).toBeUndefined();
    expect(adbText("it's here")).toBe(`'it'\\''s%shere'`);
  });
});

describe('which platforms this machine runs', () => {
  test('no SDK and no Mac say so, without a crash', () => {
    expect(findAndroidSdk(linux()).status).toEqual({ platform: 'android', available: false, reason: NO_ANDROID_SDK });
    expect(findXcrun(linux()).status).toEqual({ platform: 'ios', available: false, reason: IOS_NEEDS_MAC });
    expect(findXcrun({ os: 'darwin', env: { PATH: '' }, home: empty() }).status.reason).toBe(NO_XCODE);
    const missing = join(empty(), 'nowhere');
    expect(findAndroidSdk(linux({ ANDROID_HOME: missing })).status.reason).toBe(`${NO_ANDROID_SDK} ${missing} does not exist.`);
  });

  test('ANDROID_HOME, then ANDROID_SDK_ROOT, then the default folder, then adb on PATH', () => {
    const sdk = fakeSdk();
    expect(findAndroidSdk(linux({ ANDROID_HOME: sdk.root })).tools?.root).toBe(sdk.root);
    expect(findAndroidSdk(linux({ ANDROID_SDK_ROOT: sdk.root })).tools?.root).toBe(sdk.root);
    expect(findAndroidSdk(linux({ PATH: join(sdk.root, 'platform-tools') })).tools?.root).toBe(sdk.root);
    const local = empty();
    mkdirSync(join(local, 'Android', 'Sdk'), { recursive: true });
    const windows = findAndroidSdk({ os: 'win32', env: { LOCALAPPDATA: local, PATH: '' }, home: empty() });
    expect(windows.status.reason).toBe(`Android SDK Platform-Tools are missing from ${join(local, 'Android', 'Sdk')}.`);
    const home = empty();
    mkdirSync(join(home, 'Library', 'Android', 'sdk'), { recursive: true });
    expect(findAndroidSdk({ os: 'darwin', env: { PATH: '' }, home }).status.reason).toContain(join(home, 'Library', 'Android', 'sdk'));
  });

  test('an SDK without the Emulator package still lists phones', () => {
    const sdk = fakeSdk({}, { emulator: false });
    const found = findAndroidSdk(linux({ ANDROID_HOME: sdk.root }));
    expect(found.tools?.emulator).toBeUndefined();
    expect(found.status).toEqual({ platform: 'android', available: true, reason: `Android Emulator is missing from ${sdk.root}; only connected phones and running emulators are listed.` });
  });
});

describe('the Device panel over RPC', () => {
  let harness: TestCore, owner: CoreClient, agent: CoreClient, threadId: string;
  let sdkEnv: SdkEnvironment;
  beforeEach(async () => {
    harness = await startTestCore();
    owner = await harness.connect();
    ({ threadId } = await echoThread(harness, owner));
    agent = await connect(harness.url, harness.core.agents.tokenFor(threadId), { client: { name: 'boite-cli', version: 'test' } });
    sdkEnv = linux();
    // The core reads the SDK through this seam; a fresh one keeps each test's fake SDK and fast polling.
    (harness.core as { devices: MobileDevices }).devices = new MobileDevices(harness.core, { sdk: () => sdkEnv, pollMs: 50, bootTimeoutMs: 10_000 });
  });
  afterEach(async () => {
    agent.close();
    owner.close();
    await harness.stop();
  });

  const ready = async (deviceId: string) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const { sessions } = await agent.call('devices.sessions', { threadId });
      const session = sessions.find((s) => s.deviceId === deviceId);
      if (session && session.state !== 'booting') return session;
      await Bun.sleep(50);
    }
    throw new Error(`${deviceId} still booting`);
  };

  test('without an SDK, list explains each platform and open refuses with the same reason', async () => {
    const list = await agent.call('devices.list', { threadId });
    expect(list.devices).toEqual([]);
    expect(list.hosts[0]!.platforms).toEqual([
      { platform: 'android', available: false, reason: NO_ANDROID_SDK },
      { platform: 'ios', available: false, reason: IOS_NEEDS_MAC },
    ]);
    await expect(agent.call('devices.open', { threadId, platform: 'android' })).rejects.toThrow(NO_ANDROID_SDK);
    await expect(agent.call('devices.open', { threadId, hostId: 'mac-mini' })).rejects.toThrow('unknown device host');
  });

  test('an agent boots an emulator, the owner watches it, and close or shutdown ends it', async () => {
    const sdk = fakeSdk({ avds: ['Pixel_8', 'Small_Phone'], physical: [{ serial: 'R58M12345', model: 'Galaxy_S23' }] });
    sdkEnv = linux({ ANDROID_HOME: sdk.root });
    await owner.call('threads.subscribe', { threadId });
    const list = await agent.call('devices.list', { threadId });
    expect(list.hosts[0]!.platforms[0]).toEqual({ platform: 'android', available: true });
    expect(list.devices.map((d) => [d.id, d.kind, d.state])).toEqual([
      ['R58M12345', 'physical', 'running'],
      ['Pixel_8', 'emulator', 'stopped'],
      ['Small_Phone', 'emulator', 'stopped'],
    ]);
    // A connected phone is the only running device, so it is what a bare open takes.
    await expect(agent.call('devices.open', { threadId, platform: 'ios' })).rejects.toThrow(IOS_NEEDS_MAC);
    await expect(agent.call('devices.open', { threadId, deviceId: 'Pixel_9' })).rejects.toThrow('no device Pixel_9');

    const changed = owner.next('devices.changed', (event) => event.sessions.some((s) => s.state === 'ready'));
    const opened = await agent.call('devices.open', { threadId, deviceId: 'Pixel_8' });
    expect(opened.session).toMatchObject({ deviceId: 'Pixel_8', name: 'Pixel 8', state: 'booting', input: true });
    expect((await changed).threadId).toBe(threadId);
    await ready('Pixel_8');
    const { control } = await agent.call('devices.sessions', { threadId });
    expect(control?.['Pixel_8']?.slice(1)).toEqual(['-s', 'emulator-5554']);
    expect(sdk.calls()).toContain('emulator -avd Pixel_8 -no-boot-anim');

    const frame = await owner.call('devices.frame', { threadId, deviceId: 'Pixel_8', maxWidth: 160, quality: 50 });
    expect([frame.width, frame.height]).toEqual([SCREEN.width, SCREEN.height]);
    expect(Buffer.from(frame.base64, 'base64').subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    await owner.call('devices.input', { threadId, deviceId: 'Pixel_8', input: { kind: 'tap', x: 10, y: 20 } });
    await agent.call('devices.input', { threadId, deviceId: 'Pixel_8', input: { kind: 'key', key: 'back' } });
    await agent.call('devices.input', { threadId, deviceId: 'Pixel_8', input: { kind: 'swipe', from: { x: 50, y: 200 }, to: { x: 50, y: 40 } } });
    await expect(agent.call('devices.input', { threadId, deviceId: 'Pixel_8', input: { kind: 'text', text: 'héllo' } })).rejects.toThrow('printable ASCII');
    await expect(agent.call('devices.input', { threadId, deviceId: 'Small_Phone', input: { kind: 'tap', x: 1, y: 1 } })).rejects.toThrow('not open');
    expect(sdk.calls()).toEqual(expect.arrayContaining([
      'adb -s emulator-5554 shell input tap 10 20',
      'adb -s emulator-5554 shell input keyevent 4',
      'adb -s emulator-5554 shell input swipe 50 200 50 40 300',
    ]));

    const shot = await agent.call('devices.screenshot', { threadId });
    expect(shot).toMatchObject({ deviceId: 'Pixel_8', width: SCREEN.width, height: SCREEN.height });
    expect(pngSize(Buffer.from(shot.base64, 'base64'))).toEqual(SCREEN);

    // Closing keeps the emulator running; opening it again needs no boot.
    await agent.call('devices.close', { threadId });
    expect((await agent.call('devices.sessions', { threadId })).sessions).toEqual([]);
    expect((await agent.call('devices.list', { threadId })).devices.find((d) => d.id === 'Pixel_8')?.state).toBe('running');
    await agent.call('devices.open', { threadId, deviceId: 'Pixel_8' });
    expect((await ready('Pixel_8')).state).toBe('ready');
    expect(sdk.calls().filter((call) => call.startsWith('emulator -avd'))).toHaveLength(1);

    await expect(agent.call('devices.close', { threadId, deviceId: 'R58M12345', shutdown: true })).rejects.toThrow('not open');
    await agent.call('devices.close', { threadId, deviceId: 'Pixel_8', shutdown: true });
    expect(sdk.calls()).toContain('adb -s emulator-5554 emu kill');
    expect(sdk.state().running).toEqual({});
    expect((await agent.call('devices.list', { threadId })).devices.find((d) => d.id === 'Pixel_8')?.state).toBe('stopped');
  });

  test('powering off a device still booting stops it, and its old boot readies nothing', async () => {
    const sdk = fakeSdk({ avds: ['Pixel_8'], bootMs: 1500 });
    sdkEnv = linux({ ANDROID_HOME: sdk.root });
    await agent.call('devices.open', { threadId, deviceId: 'Pixel_8' });
    const deadline = Date.now() + 5000;
    while (!sdk.calls().some((call) => call.startsWith('adb -s emulator-5554 shell getprop')) && Date.now() < deadline) await Bun.sleep(20);
    await agent.call('devices.close', { threadId, shutdown: true });
    expect(sdk.calls()).toContain('adb -s emulator-5554 emu kill');
    expect(sdk.state().running).toEqual({});
    // Opened again at once: a boot of its own, not the retired one that would wait on a gone serial.
    await agent.call('devices.open', { threadId, deviceId: 'Pixel_8' });
    expect((await ready('Pixel_8')).state).toBe('ready');
    expect(sdk.calls().filter((call) => call.startsWith('emulator -avd'))).toHaveLength(2);
  });

  test('an emulator that cannot start fails its session with the reason', async () => {
    const sdk = fakeSdk({ avds: ['Pixel_8'], emulatorFails: 'PANIC: Missing emulator engine program for x86 CPU.' });
    sdkEnv = linux({ ANDROID_HOME: sdk.root });
    await agent.call('devices.open', { threadId });
    const session = await ready('Pixel_8');
    expect(session.state).toBe('failed');
    expect(session.error).toContain('PANIC: Missing emulator engine');
    await expect(owner.call('devices.frame', { threadId, deviceId: 'Pixel_8' })).rejects.toThrow('PANIC');
  });

  test('an iOS Simulator boots, streams view-only and shuts down on a Mac', async () => {
    const sdk = fakeSdk({ sims: [{ udid: 'A1B2-C3D4', name: 'iPhone 16', runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-18-2', state: 'Shutdown' }] }, { adb: false, emulator: false, xcrun: true });
    sdkEnv = { os: 'darwin', env: { PATH: sdk.xcode }, home: empty() };
    const list = await agent.call('devices.list', { threadId });
    expect(list.hosts[0]!.platforms[1]).toEqual({ platform: 'ios', available: true });
    expect(list.devices).toEqual([{ id: 'A1B2-C3D4', hostId: 'local', platform: 'ios', name: 'iPhone 16', kind: 'simulator', state: 'stopped', runtime: 'iOS 18.2' }]);
    const { session } = await agent.call('devices.open', { threadId, platform: 'ios' });
    expect(session.input).toBe(false);
    expect((await ready('A1B2-C3D4')).state).toBe('ready');
    const frame = await owner.call('devices.frame', { threadId, deviceId: 'A1B2-C3D4' });
    expect(frame.width).toBe(SCREEN.width);
    await expect(agent.call('devices.input', { threadId, deviceId: 'A1B2-C3D4', input: { kind: 'tap', x: 1, y: 1 } })).rejects.toThrow('view-only');
    await agent.call('devices.close', { threadId, shutdown: true });
    expect(sdk.calls()).toEqual(expect.arrayContaining(['xcrun simctl boot A1B2-C3D4', 'xcrun simctl bootstatus A1B2-C3D4', 'xcrun simctl shutdown A1B2-C3D4']));
  });

  test('a paired phone watches only a conversation it subscribed to, and archiving closes the panel', async () => {
    const sdk = fakeSdk({ avds: ['Pixel_8'] });
    sdkEnv = linux({ ANDROID_HOME: sdk.root });
    const { grant } = await owner.call('pairing.grant', {});
    const phone = await connect(harness.url, '', { grant, client: { name: 'pwa', version: 'test' } });
    try {
      await expect(phone.call('devices.list', { threadId })).rejects.toThrow('subscribe');
      await phone.call('threads.subscribe', { threadId });
      const seen = phone.next('devices.changed', (event) => event.threadId === threadId);
      await phone.call('devices.open', { threadId });
      expect((await seen).sessions[0]?.deviceId).toBe('Pixel_8');
      await ready('Pixel_8');
      expect((await phone.call('devices.sessions', { threadId })).control).toBeUndefined();
      expect((await phone.call('devices.frame', { threadId, deviceId: 'Pixel_8' })).deviceId).toBe('Pixel_8');
      const released = phone.next('devices.changed', (event) => event.threadId === threadId && event.sessions.length === 0);
      await owner.call('threads.archive', { threadId });
      await released;
      await expect(phone.call('devices.frame', { threadId, deviceId: 'Pixel_8' })).rejects.toThrow('active conversation');
      // Archiving leaves the emulator itself running, like closing without shutdown.
      expect(Object.values(sdk.state().running).map((e) => e.avd)).toEqual(['Pixel_8']);
    } finally {
      phone.close();
      sdk.stopEmulators();
    }
  });

  test('boite device opens, captures, drives and closes like the agent tools', async () => {
    const sdk = fakeSdk({ avds: ['Pixel_8'] });
    sdkEnv = linux({ ANDROID_HOME: sdk.root });
    const cwd = mkdtempSync(join(tmpdir(), 'boite-device-cli-'));
    const run = async (...args: string[]) => {
      let out = '', error = '';
      const code = await runCli(['device', ...args], { cwd,
        env: { [AGENT_ENV.threadId]: threadId, [AGENT_ENV.coreUrl]: harness.url, [AGENT_ENV.token]: harness.core.agents.tokenFor(threadId) },
        out: (text) => { out += text; }, err: (text) => { error += text; } });
      return { code, out, error };
    };
    const listed = await run('list');
    expect(listed.out).toContain('android: available');
    expect(listed.out).toContain('ios: unavailable - iOS Simulators need macOS with Xcode.');
    expect(listed.out).toContain('Pixel_8 android emulator stopped (Pixel 8)');
    const opened = await run('open', '--platform', 'android');
    expect(opened.code).toBe(0);
    expect(opened.out).toContain('Pixel_8 android ready (Pixel 8)');
    expect(opened.out).toMatch(/control: .*adb.* -s emulator-5554/);
    const shot = await run('screenshot', '--output', 'screen.png', '--json');
    expect(JSON.parse(shot.out)).toMatchObject({ deviceId: 'Pixel_8', width: SCREEN.width, path: join(cwd, 'screen.png') });
    expect(pngSize(readFileSync(join(cwd, 'screen.png')))).toEqual(SCREEN);
    expect((await run('screenshot', '--output', 'screen.png')).code).not.toBe(0);
    expect((await run('tap', '12', '34')).out).toContain('ok: tap on Pixel_8');
    expect((await run('key', 'home')).code).toBe(0);
    expect((await run('type', 'hello')).code).toBe(0);
    expect((await run('key', 'menu')).error).toContain('device key must be one of');
    expect(sdk.calls()).toEqual(expect.arrayContaining(['adb -s emulator-5554 shell input tap 12 34', 'adb -s emulator-5554 shell input keyevent 3', "adb -s emulator-5554 shell input text 'hello'"]));
    expect((await run('close', '--shutdown')).out).toContain('closed: Pixel_8 (powered off)');
    expect((await run('help')).out).toContain('view-only');
  });});
