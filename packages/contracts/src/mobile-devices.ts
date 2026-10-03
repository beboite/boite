/**
 * Simulators and emulators on the machine that runs the core, which an agent
 * opens in a conversation's Device panel (docs/devices.md). "Mobile device"
 * keeps them apart from paired devices (`DEVICE_METHODS`), which are the
 * phones and browsers that watch a machine.
 */
export type MobilePlatform = 'android' | 'ios';

export const MOBILE_PLATFORMS: MobilePlatform[] = ['android', 'ios'];

/** The only host today: the machine the core runs on. Each connected machine has its own. */
export const LOCAL_DEVICE_HOST = 'local';

/** Whether a host can run a platform, and why not, phrased for the person who would install the SDK. */
export interface MobileHostPlatform {
  platform: MobilePlatform;
  available: boolean;
  reason?: string;
}

export interface MobileDeviceHost {
  id: string;
  name: string;
  platforms: MobileHostPlatform[];
}

export interface MobileDevice {
  /** An Android virtual device's name, a phone's adb serial or a simulator's UDID. */
  id: string;
  hostId: string;
  platform: MobilePlatform;
  name: string;
  kind: 'emulator' | 'simulator' | 'physical';
  state: 'stopped' | 'booting' | 'running';
  /** The OS the simulator runs, when the SDK says: `iOS 18.2`. */
  runtime?: string;
}

/** A device open in one conversation's Device panel. */
export interface MobileDeviceSession {
  deviceId: string;
  hostId: string;
  platform: MobilePlatform;
  name: string;
  state: 'booting' | 'ready' | 'failed';
  error?: string;
  /** Whether taps, swipes, text and keys reach it: Android emulators and phones do, iOS Simulators are view-only. */
  input: boolean;
  openedAt: number;
}

export interface MobileDeviceList {
  hosts: MobileDeviceHost[];
  devices: MobileDevice[];
  /** What this conversation's Device panel has open. */
  sessions: MobileDeviceSession[];
}

/** One JPEG of a device's screen. `width` and `height` are the screen's pixels, the space input coordinates use. */
export interface MobileDeviceFrame {
  id: string;
  deviceId: string;
  width: number;
  height: number;
  base64: string;
  at: number;
}

export const MOBILE_DEVICE_KEYS = ['back', 'home', 'recents', 'enter', 'backspace', 'power', 'rotate'] as const;
export type MobileDeviceKey = (typeof MOBILE_DEVICE_KEYS)[number];

/** Coordinates are screen pixels, as in a full-size screenshot. */
export type MobileDeviceInput =
  | { kind: 'tap'; x: number; y: number }
  | { kind: 'swipe'; from: { x: number; y: number }; to: { x: number; y: number }; durationMs?: number }
  | { kind: 'text'; text: string }
  | { kind: 'key'; key: MobileDeviceKey };

export const MOBILE_TEXT_MAX = 500;

export interface MobileDevicesRpcMethods {
  'devices.list': { params: { threadId: string }; result: MobileDeviceList };
  /**
   * Boots the device if needed and adds it to the conversation's panel. Returns
   * at once with a `booting` session; `devices.sessions` says when it is ready.
   * Without `deviceId` it takes the only running device, else the only one.
   */
  'devices.open': {
    params: { threadId: string; deviceId?: string; hostId?: string; platform?: MobilePlatform };
    result: { session: MobileDeviceSession };
  };
  /**
   * `control` is, per ready device, the command prefix that drives it (`adb -s <serial>`, `xcrun simctl`),
   * for the agent and the owner; a paired device is not sent host paths.
   */
  'devices.sessions': { params: { threadId: string }; result: { sessions: MobileDeviceSession[]; control?: Record<string, string[]> } };
  'devices.frame': { params: { threadId: string; deviceId: string; maxWidth?: number; quality?: number }; result: MobileDeviceFrame };
  'devices.input': { params: { threadId: string; deviceId: string; input: MobileDeviceInput }; result: { ok: true } };
  /** The full-size PNG. Without `deviceId`, the conversation's only open device. */
  'devices.screenshot': { params: { threadId: string; deviceId?: string; hostId?: string }; result: { deviceId: string; width: number; height: number; base64: string } };
  /** Removes the device from the panel; `shutdown` also powers it off, which closes it in every conversation. */
  'devices.close': { params: { threadId: string; deviceId?: string; hostId?: string; shutdown?: boolean }; result: { closed: string[] } };
}

export interface MobileDevicesRpcEvents {
  /** For the clients subscribed to the conversation: its Device panel's sessions now. */
  'devices.changed': { threadId: string; sessions: MobileDeviceSession[] };
}

const pixel = (n: unknown) => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 16384;
const point = (p: unknown) => typeof p === 'object' && p !== null && pixel((p as { x: unknown }).x) && pixel((p as { y: unknown }).y);

/** A device id as the SDKs print them. The core still acts only on a device it listed. */
export function mobileDeviceIdError(id: unknown): string | null {
  return typeof id === 'string' && /^[A-Za-z0-9._:@-]{1,200}$/.test(id) ? null : 'deviceId must be an id from `boite device list`';
}

export function mobileDeviceInputError(input: MobileDeviceInput): string | null {
  if (!input || typeof input !== 'object') return 'device input must be an object';
  switch (input.kind) {
    case 'tap': return pixel(input.x) && pixel(input.y) ? null : 'tap needs x and y in screen pixels, integers from 0 to 16384';
    case 'swipe': return point(input.from) && point(input.to) &&
      (input.durationMs === undefined || (Number.isInteger(input.durationMs) && input.durationMs >= 1 && input.durationMs <= 5000))
      ? null : 'swipe needs from and to in screen pixels and a durationMs from 1 to 5000';
    case 'text': return typeof input.text === 'string' && input.text.length > 0 && input.text.length <= MOBILE_TEXT_MAX && /^[\x20-\x7e]+$/.test(input.text)
      ? null : `device text must be 1 to ${MOBILE_TEXT_MAX} printable ASCII characters (adb input cannot type others)`;
    case 'key': return (MOBILE_DEVICE_KEYS as readonly string[]).includes(input.key) ? null : `device key must be one of ${MOBILE_DEVICE_KEYS.join(', ')}`;
    default: return 'unsupported device input';
  }
}
