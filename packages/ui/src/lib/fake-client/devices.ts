import { isAdbText, LOCAL_DEVICE_HOST, MOBILE_STREAM_SIZE, mobileDeviceIdError, mobileDeviceInputError, type MobileDevice, type MobileDeviceSession } from '@boite/contracts';
import { fakeDeviceScreen } from './device-screen';
import { FAKE_STREAM, FAKE_STREAM_FRAMES } from './device-stream';
import { refusal } from './shared';
import type { FakeContext, FakeMethods } from './context';

type Methods = 'devices.list' | 'devices.open' | 'devices.sessions' | 'devices.frame' | 'devices.input' | 'devices.screenshot' | 'devices.close' | 'devices.stream' | 'devices.clipboard';

const SCREEN = { width: 1080, height: 2400 };
/** The core's answer while the deviceStream setting is off (control.ts STREAM_OFF). */
const STREAM_OFF = 'the live stream is off: the owner turns it on in Settings > Experiments, or an agent asks with `boite settings request deviceStream true --why "..."`';
/** How long a viewer stays counted after its last answer, as the core's stream.ts iewerMs. */
const VIEWER_MS = 5000;
/** How long a fake emulator takes to boot: long enough to see the starting state. */
export const FAKE_BOOT_MS = 1500;

/**
 * Mirrors packages/core/src/devices/control.ts on a machine with an Android SDK
 * and two emulators but no Xcode. Frames are one still home screen; an input
 * counts as a change, so the next frame gets a new id instead of `unchanged`.
 * With the deviceStream setting on, the live stream loops four H.264 frames at
 * 10 per second and input goes through it, as the core's scrcpy session does.
 */
export function devicesMethods(ctx: FakeContext): Pick<FakeMethods, Methods> {
  const devices: MobileDevice[] = [
    { id: 'Pixel_8_API_35', hostId: LOCAL_DEVICE_HOST, platform: 'android', name: 'Pixel 8 API 35', kind: 'emulator', state: 'stopped' },
    { id: 'Pixel_Tablet_API_34', hostId: LOCAL_DEVICE_HOST, platform: 'android', name: 'Pixel Tablet API 34', kind: 'emulator', state: 'stopped' }
  ];
  const sessions = new Map<string, Map<string, MobileDeviceSession>>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const screens = new Map<string, number>();
  // When each device last answered a stream poll, and what its clipboard holds.
  const watched = new Map<string, number>(), clipboards = new Map<string, string>();
  const live = (deviceId: string) => ctx.settings.deviceStream === true && Date.now() - (watched.get(deviceId) ?? 0) < VIEWER_MS;
  const list = (threadId: string) => [...(sessions.get(threadId)?.values() ?? [])].map(session => ({ ...session }));
  const changed = (threadId: string) => ctx.emitToThread(threadId, 'devices.changed', { threadId, sessions: list(threadId) });
  const release = (threadId: string) => { if (sessions.delete(threadId)) changed(threadId); };
  ctx.bus.observe('thread.updated', thread => { if (thread.archived) release(thread.id); });
  ctx.bus.observe('thread.removed', ({ threadId }) => release(threadId));
  const thread = (threadId: string) => {
    if (ctx.thread(threadId).archived) throw refusal('the Device panel needs an active conversation', { threadId });
    if (!ctx.bus.subscribed.has(threadId)) throw refusal('subscribe to the conversation before using its Device panel', { threadId });
  };
  const host = (hostId: string | undefined) => {
    if (hostId !== undefined && hostId !== LOCAL_DEVICE_HOST) throw refusal(`unknown device host ${hostId.slice(0, 80)}; this machine's host is ${LOCAL_DEVICE_HOST}`, { hostId });
  };
  const only = (threadId: string, deviceId: string | undefined) => {
    if (deviceId !== undefined) {
      const problem = mobileDeviceIdError(deviceId);
      if (problem) throw refusal(problem, { deviceId });
      if (!sessions.get(threadId)?.has(deviceId)) throw refusal(`${deviceId} is not open in this conversation`, { deviceId });
      return deviceId;
    }
    const open = [...(sessions.get(threadId)?.keys() ?? [])];
    if (open.length === 1) return open[0]!;
    throw refusal(open.length === 0 ? 'no device is open in this conversation' : `several devices are open; name one: ${open.join(', ')}`, { threadId });
  };
  const ready = (threadId: string, deviceId: string) => {
    thread(threadId);
    const problem = mobileDeviceIdError(deviceId);
    if (problem) throw refusal(problem, { deviceId });
    const session = sessions.get(threadId)?.get(deviceId);
    if (!session) throw refusal(`${deviceId} is not open in this conversation; open it first`, { deviceId });
    if (session.state === 'booting') throw refusal(`${session.name} is still starting`, { deviceId });
    if (session.state === 'failed') throw refusal(session.error ?? `${session.name} failed to start`, { deviceId });
    return session;
  };
  const settle = (deviceId: string) => {
    const device = devices.find(one => one.id === deviceId);
    if (!device || device.state !== 'booting') return;
    device.state = 'running';
    for (const [threadId, open] of sessions) {
      const session = open.get(deviceId);
      if (session?.state === 'booting') { session.state = 'ready'; changed(threadId); }
    }
  };
  const methods: ReturnType<typeof devicesMethods> = {
    'devices.list': async ({ threadId }) => {
      thread(threadId);
      return {
        hosts: [{ id: LOCAL_DEVICE_HOST, name: 'This computer', platforms: [{ platform: 'android', available: true }, { platform: 'ios', available: false, reason: 'iOS Simulators need macOS with Xcode.' }] }],
        devices: devices.map(device => ({ ...device })),
        sessions: list(threadId),
        liveStream: ctx.settings.deviceStream === true
      };
    },
    'devices.sessions': async ({ threadId }) => {
      thread(threadId);
      const control: Record<string, string[]> = {};
      for (const session of list(threadId)) if (session.state === 'ready') control[session.deviceId] = ['adb', '-s', 'emulator-5554'];
      return { sessions: list(threadId), control };
    },
    'devices.open': async ({ threadId, deviceId, hostId, platform }) => {
      thread(threadId);
      host(hostId);
      if (deviceId !== undefined) { const problem = mobileDeviceIdError(deviceId); if (problem) throw refusal(problem, { deviceId }); }
      if (platform === 'ios') throw refusal('iOS Simulators need macOS with Xcode.', { platform });
      const running = devices.filter(device => device.state !== 'stopped');
      const device = deviceId !== undefined ? devices.find(one => one.id === deviceId)
        : running.length === 1 ? running[0] : devices.length === 1 ? devices[0] : undefined;
      if (deviceId !== undefined && !device) throw refusal(`no device ${deviceId} on this machine; \`boite device list\` names the ones it has`, { deviceId });
      if (!device) throw refusal(`several devices are available; name one: ${devices.map(one => one.id).join(', ')}`, { platform });
      const open = sessions.get(threadId) ?? new Map<string, MobileDeviceSession>();
      const existing = open.get(device.id);
      if (existing) return { session: { ...existing } };
      if (open.size >= 4) throw refusal('a conversation shows at most 4 devices; close one first', { threadId });
      const session: MobileDeviceSession = {
        deviceId: device.id, hostId: LOCAL_DEVICE_HOST, platform: device.platform, name: device.name,
        state: device.state === 'running' ? 'ready' : 'booting', input: true, openedAt: Date.now()
      };
      open.set(device.id, session);
      sessions.set(threadId, open);
      changed(threadId);
      if (device.state === 'stopped') {
        device.state = 'booting';
        const timer = setTimeout(() => { timers.delete(timer); settle(device.id); }, FAKE_BOOT_MS);
        timers.add(timer);
      }
      return { session: { ...session } };
    },
    'devices.frame': async ({ threadId, deviceId, maxWidth, quality = 60, previous }) => {
      if (maxWidth !== undefined && !(Number.isInteger(maxWidth) && maxWidth >= 160 && maxWidth <= 3840)) throw refusal('device frame maxWidth must be an integer from 160 to 3840');
      if (!(Number.isInteger(quality) && quality >= 20 && quality <= 90)) throw refusal('device frame quality must be an integer from 20 to 90');
      if (previous !== undefined && !(typeof previous === 'string' && previous.length <= 100)) throw refusal('device frame previous must be the id of a frame this device sent');
      ready(threadId, deviceId);
      const id = `frame-${deviceId}-${screens.get(deviceId) ?? 0}-${maxWidth ?? 0}-${quality}`;
      if (previous === id) return { id, deviceId, ...SCREEN, unchanged: true, at: Date.now() };
      return { id, deviceId, ...SCREEN, base64: fakeDeviceScreen(), at: Date.now() };
    },
    'devices.input': async ({ threadId, deviceId, input }) => {
      const problem = mobileDeviceInputError(input);
      if (problem) throw refusal(problem);
      ready(threadId, deviceId);
      if (live(deviceId)) {
        if (input.kind === 'clipboard') clipboards.set(deviceId, input.text);
        return { ok: true, via: 'stream' };
      }
      const streamOnly = input.kind === 'touch' ? 'a touch' : input.kind === 'scroll' ? 'a scroll' : input.kind === 'clipboard' ? 'the device clipboard'
        : input.kind === 'text' && !isAdbText(input.text) ? 'text beyond printable ASCII' : undefined;
      if (streamOnly) throw refusal(`${streamOnly} needs the device's live stream (adb input cannot send it): ${ctx.settings.deviceStream === true ? 'show the device in the Device panel to start it' : STREAM_OFF}`, { deviceId });
      screens.set(deviceId, (screens.get(deviceId) ?? 0) + 1);
      return { ok: true, via: 'adb' };
    },
    'devices.stream': async ({ threadId, deviceId, maxSize, after }) => {
      if (maxSize !== undefined && !(Number.isInteger(maxSize) && maxSize >= MOBILE_STREAM_SIZE.min && maxSize <= MOBILE_STREAM_SIZE.max)) {
        throw refusal(`device stream maxSize must be an integer from ${MOBILE_STREAM_SIZE.min} to ${MOBILE_STREAM_SIZE.max}`);
      }
      if (after !== undefined && !(typeof after === 'object' && after !== null && typeof after.id === 'string' && after.id.length <= 100 && Number.isInteger(after.seq) && after.seq >= 0)) {
        throw refusal('device stream after must be the id and seq of a chunk this device sent');
      }
      const session = ready(threadId, deviceId);
      if (ctx.settings.deviceStream !== true) return { deviceId, state: 'off', reason: STREAM_OFF, chunks: [] };
      if (session.platform !== 'android') return { deviceId, state: 'unavailable', reason: 'iOS Simulators have no live stream; the panel shows their screenshots', chunks: [] };
      const id = `fake-${deviceId}`;
      // The first answer starts at the key frame; each later one waits a frame's time and sends the next.
      const seq = after?.id === id ? after.seq + 1 : 1;
      if (seq > 1) await new Promise(resolve => setTimeout(resolve, 100));
      watched.set(deviceId, Date.now());
      const index = (seq - 1) % FAKE_STREAM_FRAMES.length;
      return {
        deviceId, state: 'live', id, codec: FAKE_STREAM.codec, width: FAKE_STREAM.width, height: FAKE_STREAM.height, screen: { ...SCREEN },
        chunks: [{ seq, key: index === 0, pts: seq * 100_000, base64: FAKE_STREAM_FRAMES[index]! }]
      };
    },
    'devices.clipboard': async ({ threadId, deviceId, copy }) => {
      if (copy !== undefined && copy !== 'copy' && copy !== 'cut') throw refusal('device clipboard copy must be copy or cut');
      ready(threadId, deviceId);
      if (!live(deviceId)) throw refusal(`the device clipboard needs the live stream: ${ctx.settings.deviceStream === true ? 'show the device in the Device panel to start it' : STREAM_OFF}`, { deviceId });
      return { text: clipboards.get(deviceId) ?? 'Copied on the fake phone' };
    },
    'devices.screenshot': async ({ threadId, deviceId, hostId }) => {
      thread(threadId);
      host(hostId);
      const id = only(threadId, deviceId);
      ready(threadId, id);
      return { deviceId: id, ...SCREEN, base64: fakeDeviceScreen() };
    },
    'devices.close': async ({ threadId, deviceId, hostId, shutdown }) => {
      thread(threadId);
      host(hostId);
      const id = only(threadId, deviceId);
      if (shutdown === true) {
        const device = devices.find(one => one.id === id);
        if (device) device.state = 'stopped';
        for (const [other, open] of sessions) if (open.delete(id)) changed(other);
      } else {
        sessions.get(threadId)?.delete(id);
        changed(threadId);
      }
      return { closed: [id] };
    }
  };
  return methods;
}
