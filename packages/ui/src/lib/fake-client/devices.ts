import { LOCAL_DEVICE_HOST, mobileDeviceIdError, mobileDeviceInputError, type MobileDevice, type MobileDeviceSession } from '@boite/contracts';
import { fakeDeviceScreen } from './device-screen';
import { refusal } from './shared';
import type { FakeContext, FakeMethods } from './context';

type Methods = 'devices.list' | 'devices.open' | 'devices.sessions' | 'devices.frame' | 'devices.input' | 'devices.screenshot' | 'devices.close';

const SCREEN = { width: 1080, height: 2400 };
/** How long a fake emulator takes to boot: long enough to see the starting state. */
export const FAKE_BOOT_MS = 1500;

/**
 * Mirrors packages/core/src/devices/control.ts on a machine with an Android SDK
 * and two emulators but no Xcode. Frames are one still home screen.
 */
export function devicesMethods(ctx: FakeContext): Pick<FakeMethods, Methods> {
  const devices: MobileDevice[] = [
    { id: 'Pixel_8_API_35', hostId: LOCAL_DEVICE_HOST, platform: 'android', name: 'Pixel 8 API 35', kind: 'emulator', state: 'stopped' },
    { id: 'Pixel_Tablet_API_34', hostId: LOCAL_DEVICE_HOST, platform: 'android', name: 'Pixel Tablet API 34', kind: 'emulator', state: 'stopped' }
  ];
  const sessions = new Map<string, Map<string, MobileDeviceSession>>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const list = (threadId: string) => [...(sessions.get(threadId)?.values() ?? [])].map(session => ({ ...session }));
  const changed = (threadId: string) => ctx.emitToThread(threadId, 'devices.changed', { threadId, sessions: list(threadId) });
  const release = (threadId: string) => { if (sessions.delete(threadId)) changed(threadId); };
  ctx.bus.on('thread.updated', thread => { if (thread.archived) release(thread.id); });
  ctx.bus.on('thread.removed', ({ threadId }) => release(threadId));
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
        sessions: list(threadId)
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
    'devices.frame': async ({ threadId, deviceId, maxWidth, quality }) => {
      if (maxWidth !== undefined && !(Number.isInteger(maxWidth) && maxWidth >= 160 && maxWidth <= 3840)) throw refusal('device frame maxWidth must be an integer from 160 to 3840');
      if (quality !== undefined && !(Number.isInteger(quality) && quality >= 20 && quality <= 90)) throw refusal('device frame quality must be an integer from 20 to 90');
      ready(threadId, deviceId);
      return { id: crypto.randomUUID(), deviceId, ...SCREEN, base64: fakeDeviceScreen(), at: Date.now() };
    },
    'devices.input': async ({ threadId, deviceId, input }) => {
      const problem = mobileDeviceInputError(input);
      if (problem) throw refusal(problem);
      ready(threadId, deviceId);
      return { ok: true };
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
