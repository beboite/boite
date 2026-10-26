import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_ENV, type MobileDeviceInput, type MobileDeviceStream } from '@boite/contracts';
import { runCli } from '../src/cli.ts';
import { connect, type CoreClient } from '../src/client.ts';
import { STREAM_REQUEST } from '../src/device-cli.ts';
import { MobileDevices, STREAM_OFF } from '../src/devices/control.ts';
import { avcCodec, CLIPBOARD_MAX_BYTES, DeviceMessageReader, scrollMessage, setClipboardMessage, textMessages, touchMessage, VideoReader } from '../src/devices/scrcpy.ts';
import type { SdkEnvironment } from '../src/devices/sdk.ts';
import { fakeSdk, SCRCPY_VIDEO, scrcpyPackets } from './fixtures/fake-sdk.ts';
import { echoThread, startTestCore, type TestCore, waitFor } from './harness.ts';
import { thrown } from './settle.ts';

const PHONE = 'R58M12345';
const linux = (root: string): SdkEnvironment => ({ os: 'linux', env: { PATH: '', ANDROID_HOME: root }, home: mkdtempSync(join(tmpdir(), 'boite-no-sdk-')) });

describe('the scrcpy wire format', () => {
  test('text splits at 300 UTF-8 bytes without cutting a character; touch, scroll and clipboard carry their fields', () => {
    const pieces = textMessages('é'.repeat(200));
    expect(pieces.map((piece) => new DataView(piece.buffer).getUint32(1))).toEqual([300, 100]);
    const touch = new DataView(touchMessage('up', 1, { x: 7, y: 9, width: 144, height: 320 }).buffer);
    expect([touch.byteLength, touch.getUint8(1), touch.getInt32(10), touch.getUint16(18), touch.getUint16(22)]).toEqual([32, 1, 7, 144, 0]);
    // A notch down scrolls the page down, which Android reads as a negative vscroll.
    expect(new DataView(scrollMessage({ x: 0, y: 0, width: 1, height: 1 }, 0, 16).buffer).getInt16(15)).toBe(-0x8000);
    expect(setClipboardMessage(3, 'é', true).length).toBe(14 + 2);
    expect(CLIPBOARD_MAX_BYTES).toBe((1 << 18) - 14);
  });

  test('the video reader joins split packets and refuses a stream that is not H.264', () => {
    const { config, frames } = scrcpyPackets();
    const head = (value: bigint, size: number) => { const view = new DataView(new ArrayBuffer(12)); view.setBigUint64(0, value); view.setUint32(8, size); return new Uint8Array(view.buffer); };
    const bytes = Buffer.concat([Buffer.from([0x68, 0x32, 0x36, 0x34]), head((1n << 63n) | 144n, 320), head(1n << 62n, config.length), config, head((1n << 61n) | 5n, frames[0]!.data.length), frames[0]!.data]);
    const reader = new VideoReader();
    const events = [...reader.push(bytes.subarray(0, 30)), ...reader.push(bytes.subarray(30))];
    expect(events.map((event) => (event.type === 'session' ? 'session' : `${event.config ? 'config' : event.key ? 'key' : 'delta'}:${event.data.length}`))).toEqual(['session', `config:${config.length}`, `key:${frames[0]!.data.length}`]);
    expect(avcCodec(config)).toBe('avc1.42c01e');
    expect(() => new VideoReader().push(Uint8Array.of(0, 0, 0, 0))).toThrow('scrcpy sent no stream');
    expect(new DeviceMessageReader().push(Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 0, 7))).toEqual([{ type: 'ack', sequence: 7 }]);
    // A clipboard longer than any scrcpy sends is refused at its header, before its bytes pile up.
    expect(() => new DeviceMessageReader().push(Uint8Array.of(0, 0x40, 0, 0, 0))).toThrow('the device sent a clipboard message of 1073741824 bytes');
  });
});

describe('the Device panel live stream', () => {
  let harness: TestCore, owner: CoreClient, agent: CoreClient, threadId: string;
  let sdk: ReturnType<typeof fakeSdk>;
  beforeEach(async () => {
    harness = await startTestCore();
    owner = await harness.connect();
    ({ threadId } = await echoThread(harness, owner));
    agent = await connect(harness.url, harness.core.agents.tokenFor(threadId), { client: { name: 'boite-cli', version: 'test' } });
    sdk = fakeSdk({ physical: [{ serial: PHONE, model: 'Galaxy_S23' }], clipboard: 'from the phone' });
    const env = linux(sdk.root);
    (harness.core as { devices: MobileDevices }).devices = new MobileDevices(harness.core, {
      sdk: () => env, pollMs: 50, bootTimeoutMs: 10_000,
      // Short enough that a test sees a session end once its viewers stop asking.
      stream: { viewerMs: 400, lingerMs: 300, waitMs: 200, failureMs: 60_000 },
    });
    await owner.call('threads.subscribe', { threadId });
    await open();
  });
  afterEach(async () => {
    mock.restore();
    agent.close();
    owner.close();
    await harness.stop();
  });

  const open = async () => {
    await agent.call('devices.open', { threadId, deviceId: PHONE });
    for (let tries = 0; tries < 200; tries++) {
      if ((await agent.call('devices.sessions', { threadId })).sessions.some((s) => s.deviceId === PHONE && s.state === 'ready')) return;
      await Bun.sleep(50);
    }
    throw new Error(`${PHONE} never became ready`);
  };
  /** Asks for the stream as the panel does, each answer's last chunk the next `after`, until stopped. */
  const watch = (client: CoreClient, maxSize?: number) => {
    const answers: MobileDeviceStream[] = [];
    let stopped = false;
    const loop = (async () => {
      let after: { id: string; seq: number } | undefined;
      while (!stopped) {
        const answer = await client.call('devices.stream', { threadId, deviceId: PHONE, maxSize, after }).catch(() => undefined);
        if (!answer) return;
        answers.push(answer);
        const last = answer.chunks.at(-1);
        if (answer.state === 'live' && answer.id && last) after = { id: answer.id, seq: last.seq };
        if (answer.state !== 'live' && answer.state !== 'starting') await Bun.sleep(50);
      }
    })();
    return {
      answers,
      live: async () => { await waitFor(() => answers.some((answer) => answer.state === 'live'), 15_000); return answers.find((answer) => answer.state === 'live')!; },
      stop: async () => { stopped = true; await loop; },
    };
  };
  const input = (client: CoreClient, value: MobileDeviceInput) => client.call('devices.input', { threadId, deviceId: PHONE, input: value });

  test('off by default: the panel and the CLI say how to ask, and only adb input runs', async () => {
    const list = await agent.call('devices.list', { threadId });
    expect(list.liveStream).toBe(false);
    expect(await owner.call('devices.stream', { threadId, deviceId: PHONE })).toEqual({ deviceId: PHONE, state: 'off', reason: STREAM_OFF, chunks: [] });
    expect(await thrown(agent.call('devices.stream', { threadId, deviceId: PHONE }))).toThrow('devices.stream is not one of the agent\'s methods');
    expect(await thrown(agent.call('devices.clipboard', { threadId, deviceId: PHONE }))).toThrow('devices.clipboard is not one of the agent\'s methods');
    expect(await thrown(owner.call('devices.clipboard', { threadId, deviceId: PHONE }))).toThrow(STREAM_OFF);
    expect(await thrown(input(owner, { kind: 'touch', action: 'down', x: 1, y: 1 }))).toThrow(`a touch needs the device's live stream (adb input cannot send it): ${STREAM_OFF}`);
    expect(await input(agent, { kind: 'tap', x: 5, y: 6 })).toEqual({ ok: true, via: 'adb' });
    expect(sdk.calls()).toContain(`adb -s ${PHONE} shell input tap 5 6`);
    expect(sdk.calls().some((call) => call.includes('reverse') || call.includes('push'))).toBe(false);

    const cwd = mkdtempSync(join(tmpdir(), 'boite-device-cli-'));
    const cli = async (...args: string[]) => {
      let out = '';
      await runCli(['device', ...args], { cwd,
        env: { [AGENT_ENV.threadId]: threadId, [AGENT_ENV.coreUrl]: harness.url, [AGENT_ENV.token]: harness.core.agents.tokenFor(threadId) },
        out: (text) => { out += text; }, err: () => {} });
      return out;
    };
    const hint = (await cli('list')).split('\n').filter((line) => line.includes(STREAM_REQUEST));
    expect(hint).toHaveLength(1);
    expect(hint[0]).toStartWith('hint: the live stream is off');
    expect(await cli('help')).toContain(STREAM_REQUEST);
    await owner.call('settings.set', { deviceStream: true });
    expect(await cli('list')).not.toContain(STREAM_REQUEST);
  });

  test('two viewers share one session, input goes through its control socket, and it ends after the last viewer', async () => {
    await owner.call('settings.set', { deviceStream: true });
    expect((await agent.call('devices.list', { threadId })).liveStream).toBe(true);
    const { grant } = await owner.call('pairing.grant', {});
    const phone = await connect(harness.url, '', { grant, client: { name: 'pwa', version: 'test' } });
    try {
      await phone.call('threads.subscribe', { threadId });
      const desk = watch(owner);
      const first = await desk.live();
      const { config, frames } = scrcpyPackets();
      expect(first).toMatchObject({ state: 'live', codec: avcCodec(config), width: SCRCPY_VIDEO.width, height: SCRCPY_VIDEO.height, screen: { width: 1080, height: 2400 } });
      // A viewer starts at a key frame that carries the SPS and PPS before it.
      const key = Buffer.from(first.chunks[0]!.base64, 'base64');
      expect(first.chunks[0]!.key).toBe(true);
      expect(key.subarray(0, config.length)).toEqual(Buffer.from(config));
      expect(key.length).toBe(config.length + frames.find((frame) => frame.key)!.data.length);
      expect(sdk.calls()).toEqual(expect.arrayContaining([
        expect.stringMatching(new RegExp(`^adb -s ${PHONE} push .*scrcpy-server-v5\\.0\\.1\\.jar /data/local/tmp/boite-scrcpy-server-v5\\.0\\.1\\.jar$`)),
        expect.stringMatching(/ reverse localabstract:scrcpy_[0-9a-f]{8} tcp:\d+$/),
        expect.stringMatching(/ shell CLASSPATH=\/data\/local\/tmp\/boite-scrcpy-server-v5\.0\.1\.jar app_process \/ com\.genymobile\.scrcpy\.Server 5\.0\.1 scid=[0-9a-f]{8} .*audio=false/),
      ]));
      // Once both sockets are in, the tunnel goes: nothing else can connect to the core's port.
      await waitFor(() => sdk.calls().some((call) => call.includes('reverse --remove')));

      const pocket = watch(phone);
      const shared = await pocket.live();
      expect(shared.id).toBe(first.id);
      await waitFor(() => desk.answers.length > 3);
      const later = desk.answers.at(-1)!;
      expect(later.chunks.every((chunk) => chunk.seq > first.chunks.at(-1)!.seq || later.id !== first.id)).toBe(true);
      expect(sdk.servers().filter((line) => line.startsWith('start'))).toHaveLength(1);

      expect(await input(owner, { kind: 'tap', x: 540, y: 1200 })).toEqual({ ok: true, via: 'stream' });
      await input(owner, { kind: 'touch', action: 'down', x: 0, y: 2400 });
      await input(owner, { kind: 'touch', action: 'move', x: 5000, y: 0 });
      await input(owner, { kind: 'touch', action: 'up', x: 1080, y: 0 });
      await input(phone, { kind: 'scroll', x: 540, y: 1200, dx: 0, dy: 2 });
      await input(agent, { kind: 'key', key: 'back' });
      await input(agent, { kind: 'text', text: 'hello' });
      await input(agent, { kind: 'text', text: 'héllo 👋' });
      await input(agent, { kind: 'swipe', from: { x: 540, y: 2000 }, to: { x: 540, y: 400 }, durationMs: 100 });
      expect((await owner.call('devices.clipboard', { threadId, deviceId: PHONE, copy: 'copy' })).text).toBe('héllo 👋');
      await input(phone, { kind: 'clipboard', text: 'copié' });
      expect((await phone.call('devices.clipboard', { threadId, deviceId: PHONE })).text).toBe('copié');
      // The second clipboard read may reach the device after the swipe's last moves: wait for it, not for a count of controls.
      await waitFor(() => sdk.controls().filter((control) => control.type === 'getClipboard').length >= 2);
      const controls = sdk.controls();
      const at = (x: number, y: number) => ({ x, y, width: 144, height: 320 });
      expect(controls.slice(0, 12)).toEqual([
        { type: 'touch', action: 0, pointer: 0, ...at(72, 160), pressure: 0xffff },
        { type: 'touch', action: 1, pointer: 0, ...at(72, 160), pressure: 0 },
        { type: 'touch', action: 0, pointer: 0, ...at(0, 319), pressure: 0xffff },
        // Outside the screen clamps to its edge, as a finger sliding off it.
        { type: 'touch', action: 2, pointer: 0, ...at(143, 0), pressure: 0xffff },
        { type: 'touch', action: 1, pointer: 0, ...at(143, 0), pressure: 0 },
        { type: 'scroll', ...at(72, 160), h: 0, v: -4096 },
        { type: 'key', action: 0, keycode: 4 },
        { type: 'key', action: 1, keycode: 4 },
        { type: 'text', text: 'hello' },
        // Beyond ASCII, text is pasted: the server's text injection only types what a keyboard maps.
        { type: 'setClipboard', sequence: expect.any(Number), paste: true, text: 'héllo 👋' },
        expect.objectContaining({ type: 'touch', action: 0, ...at(72, 267) }),
        expect.objectContaining({ type: 'touch', action: 2 }),
      ]);
      const rest = controls.slice(12);
      expect(rest.filter((control) => control.type !== 'touch')).toEqual([
        { type: 'getClipboard', copy: 1 },
        { type: 'setClipboard', sequence: expect.any(Number), paste: false, text: 'copié' },
        { type: 'getClipboard', copy: 0 },
      ]);
      expect(rest.filter((control) => control.type === 'touch').at(-1)).toMatchObject({ action: 1, ...at(72, 53) });

      // The phone leaves; the desk still watches, so the session stays.
      await pocket.stop();
      phone.close();
      await Bun.sleep(800);
      expect(sdk.servers().some((line) => line.startsWith('exit'))).toBe(false);
      await desk.stop();
      await waitFor(() => sdk.servers().some((line) => line.startsWith('exit')), 5000);
      // The tunnel is removed without waiting for adb.
      await waitFor(() => Object.keys(sdk.state().reverses ?? {}).length === 0, 5000);
      expect(await input(agent, { kind: 'tap', x: 1, y: 2 })).toEqual({ ok: true, via: 'adb' });
    } finally {
      phone.close();
    }
  }, 30_000);

  for (const loaded of [false, true]) test(`closing the panel refuses a stream call still awaiting its ${loaded ? 'loaded' : 'loading'} module`, async () => {
    await owner.call('settings.set', { deviceStream: true });
    if (loaded) await owner.call('devices.stream', { threadId, deviceId: PHONE });
    const starts = () => sdk.calls().filter((call) => call.includes('app_process')).length;
    const before = starts();
    const pending = thrown(harness.core.devices.stream({ threadId, deviceId: PHONE }));
    await harness.core.devices.close({ threadId, deviceId: PHONE });
    expect(await pending).toThrow('is not open in this conversation');
    expect(starts()).toBe(before);
  });

  test('closing the panel, turning the setting off, unplugging and stopping the core each end the session', async () => {
    sdk.set({ scrcpyExitDelayMs: 6000 });
    const spawn = harness.core.procs.spawn.bind(harness.core.procs);
    let servers = 0, exits = 0;
    spyOn(harness.core.procs, 'spawn').mockImplementation((...args) => {
      const child = spawn(...args);
      if (args[2].includes('com.genymobile.scrcpy.Server')) {
        servers++;
        void child.exited.then(() => { exits++; });
      }
      return child;
    });
    await owner.call('settings.set', { deviceStream: true });
    // A slow server may be killed before its final log: wait for the owned process instead.
    const ended = async (count: number) => waitFor(() => exits >= count, 5000);
    let desk = watch(owner);
    await desk.live();
    await agent.call('devices.close', { threadId, deviceId: PHONE });
    await ended(1);
    await desk.stop();

    await open();
    // The first server deleted its jar as it started: this session pushes it again.
    desk = watch(owner);
    await desk.live();
    await owner.call('settings.set', { deviceStream: false });
    await ended(2);
    await waitFor(() => desk.answers.at(-1)?.state === 'off');
    await desk.stop();

    await owner.call('settings.set', { deviceStream: true });
    desk = watch(owner);
    await desk.live();
    // Let the fake adb finish rewriting state before the test unplugs the phone.
    await waitFor(() => Object.keys(sdk.state().reverses ?? {}).length === 0);
    sdk.set({ physical: [] });
    await waitFor(() => desk.answers.at(-1)?.state === 'failed', 5000);
    expect(desk.answers.at(-1)!.reason).toContain('device offline');
    expect(sdk.servers()).toContainEqual(expect.stringMatching(/^unplugged /));
    await desk.stop();
    // Plugged back: the failure is remembered for the panel, which falls back to screenshots, until the device is closed and shown again.
    sdk.set({ physical: [{ serial: PHONE, model: 'Galaxy_S23' }] });
    await agent.call('devices.close', { threadId, deviceId: PHONE });
    await open();
    desk = watch(owner);
    await desk.live();
    await desk.stop();
    await harness.core.devices.stop();
    await ended(4);
    expect(servers).toBe(4);
    // Each tunnel was removed once, the unplugged phone's too (adb itself drops those when a device goes).
    const added = sdk.calls().flatMap((call) => /^adb -s \S+ reverse (\S+) tcp:\d+$/.exec(call)?.[1] ?? []);
    expect(added).toHaveLength(4);
    await waitFor(() => sdk.calls().filter((call) => call.includes('reverse --remove')).length >= 4);
    expect(sdk.calls().flatMap((call) => /^adb -s \S+ reverse --remove (\S+)$/.exec(call)?.[1] ?? [])).toEqual(added);
  }, 40_000);

  test('a server that cannot start fails the stream with its message, and input stays on adb', async () => {
    await owner.call('settings.set', { deviceStream: true });
    sdk.set({ scrcpyFails: '[server] ERROR: Could not create video encoder' });
    const desk = watch(owner);
    await waitFor(() => desk.answers.at(-1)?.state === 'failed', 15_000);
    await desk.stop();
    expect(desk.answers.at(-1)!.reason).toContain('Could not create video encoder');
    // The tunnel is removed without waiting for adb.
    await waitFor(() => Object.keys(sdk.state().reverses ?? {}).length === 0, 5000);
    expect(await input(agent, { kind: 'tap', x: 3, y: 4 })).toEqual({ ok: true, via: 'adb' });
    expect(await thrown(input(agent, { kind: 'text', text: 'ça' }))).toThrow('show the device in the Device panel to start it');
  }, 30_000);

  test('text the device had not confirmed when its session ended is refused, not reported as sent', async () => {
    await owner.call('settings.set', { deviceStream: true });
    sdk.set({ clipboardUnconfirmed: true });
    const desk = watch(owner);
    await desk.live();
    const pending = thrown(input(agent, { kind: 'text', text: 'café' }));
    await waitFor(() => sdk.controls().some((message) => message.type === 'setClipboard'), 5000);
    await agent.call('devices.close', { threadId, deviceId: PHONE });
    expect(await pending).toThrow('the live stream of Galaxy S23 ended before its clipboard was set');
    await desk.stop();
  }, 30_000);
});
